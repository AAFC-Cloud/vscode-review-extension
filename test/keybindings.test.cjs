'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const manifest = require('../package.json');

const isStageCommand = command => /^review\.stageAndNext(?:\.|$)/.test(command);
const bindings = manifest.contributes.keybindings.filter(item => isStageCommand(item.command));
const stageCommands = manifest.contributes.commands.filter(item => isStageCommand(item.command));

/** Evaluate the boolean/equality subset of VS Code when clauses used here. */
function matches(expression = '', context) {
  if (!expression) return true;
  const tokens = expression.match(/&&|\|\||==|!=|[!()]|[^\s!()=&|]+/g);
  let position = 0;
  const value = token => token === 'true' ? true : token === 'false' ? false
    : /^\d+$/.test(token) ? Number(token) : token;
  function atom() {
    if (tokens[position] === '!') {
      position++;
      return !atom();
    }
    if (tokens[position] === '(') {
      position++;
      const result = or();
      assert.equal(tokens[position++], ')', expression);
      return result;
    }
    const left = context[tokens[position++]];
    const operator = tokens[position];
    if (operator === '==' || operator === '!=') {
      position++;
      const equal = left === value(tokens[position++]);
      return operator === '==' ? equal : !equal;
    }
    return Boolean(left);
  }
  function and() {
    let result = atom();
    while (tokens[position] === '&&') {
      position++;
      const right = atom();
      result = result && right;
    }
    return result;
  }
  function or() {
    let result = and();
    while (tokens[position] === '||') {
      position++;
      const right = and();
      result = result || right;
    }
    return result;
  }
  const result = or();
  assert.equal(position, tokens.length, `Unparsed when clause: ${expression}`);
  return result;
}

const enabled = { 'config.git.enabled': true, gitOpenRepositoryCount: 1, 'config.stageAndNext.enabled': true };
const viewOrders = [
  {},
  { scmViewMode: 'list', scmViewSortKey: 'name' },
  { scmViewMode: 'list', scmViewSortKey: 'path' },
  { scmViewMode: 'list', scmViewSortKey: 'status' },
  { scmViewMode: 'tree', scmViewSortKey: 'path' }
];
const plainEditor = {
  activeEditor: 'workbench.editors.text', resourceLangId: 'markdown',
  editorAreaFocus: true, editorTextFocus: true, inputFocus: true, isInDiffEditor: false
};
const activeBindings = context => bindings.filter(binding => matches(binding.when, { ...enabled, ...context }));

test('stage shortcuts leave ordinary Markdown typing and ordinary editor focus alone', () => {
  assert.ok(bindings.length > 0);
  for (const order of viewOrders) {
    assert.equal(activeBindings({ ...plainEditor, ...order }).length, 0, JSON.stringify(order));
    assert.equal(activeBindings({ ...plainEditor, ...order, inputFocus: false }).length, 0, JSON.stringify(order));
    assert.equal(activeBindings({ ...plainEditor, ...order, editorTextFocus: false, inputFocus: false }).length, 0, JSON.stringify(order));
  }
});

test('stage shortcuts remain available in diffs, reviewed plain files, an empty editor area, and the SCM list for every sort', () => {
  for (const order of viewOrders) {
    for (const context of [
      { ...plainEditor, isInDiffEditor: true },
      { ...plainEditor, 'stageAndNext.reviewEditor': true },
      { editorAreaFocus: true, editorTextFocus: false, inputFocus: false },
      { focusedView: 'workbench.scm', listFocus: true, inputFocus: false, activeEditor: 'workbench.editors.text' }
    ]) {
      assert.ok(activeBindings({ ...context, ...order }).length > 0, JSON.stringify({ context, order }));
    }
  }
});

test('terminal, quick input, and text fields outside diffs do not trigger stage shortcuts', () => {
  for (const order of viewOrders) {
    for (const context of [
      { terminalFocus: true, inputFocus: true },
      { inQuickOpen: true, inputFocus: true },
      { inQuickOpen: true, inputFocus: true, 'stageAndNext.reviewEditor': true },
      { focusedView: 'workbench.scm', listFocus: true, inputFocus: true },
      { editorTextFocus: true, inputFocus: true, isInDiffEditor: false }
    ]) assert.equal(activeBindings({ ...context, ...order }).length, 0, JSON.stringify({ context, order }));
  }
});

test('review shortcuts require focus in the main editor area rather than an embedded sidebar editor', () => {
  for (const order of viewOrders) {
    const reviewed = { ...plainEditor, ...order, 'stageAndNext.reviewEditor': true };
    assert.ok(activeBindings(reviewed).length > 0, JSON.stringify(order));
    assert.equal(activeBindings({ ...reviewed, editorAreaFocus: false }).length, 0, JSON.stringify(order));
    assert.equal(activeBindings({ ...reviewed, editorAreaFocus: false, focusedView: 'workbench.scm' }).length, 0, JSON.stringify(order));
  }
});

test('disabling Stage and Next releases every contributed stage shortcut', () => {
  for (const binding of bindings) {
    assert.match(binding.when, /\bconfig\.stageAndNext\.enabled\b/, binding.command);
    for (const order of viewOrders) {
      for (const context of [
        { ...plainEditor, isInDiffEditor: true },
        { ...plainEditor, 'stageAndNext.reviewEditor': true },
        { editorAreaFocus: true },
        { focusedView: 'workbench.scm', listFocus: true }
      ]) assert.equal(matches(binding.when, { ...enabled, ...context, ...order, 'config.stageAndNext.enabled': false }), false);
    }
  }
});

test('the enabled setting defaults to true and disables all stage commands without restricting manual use to diffs', () => {
  const configuration = manifest.contributes.configuration;
  const properties = Object.assign({}, ...(Array.isArray(configuration) ? configuration : [configuration]).map(item => item.properties));
  assert.equal(properties['stageAndNext.enabled'].type, 'boolean');
  assert.equal(properties['stageAndNext.enabled'].default, true);
  assert.equal(properties['stageAndNext.enabled'].scope, 'application', 'A workspace override must not prevent the global escape hatch from disabling shortcuts');
  assert.ok(stageCommands.length > 0);
  for (const command of stageCommands) {
    assert.equal(matches(command.enablement, { ...enabled, ...plainEditor }), true, command.command);
    assert.equal(matches(command.enablement, { ...enabled, ...plainEditor, 'config.stageAndNext.enabled': false }), false, command.command);
  }
});

test('the palette toggle stays available when the extension or Git is disabled', () => {
  const toggle = manifest.contributes.commands.find(command => command.command === 'review.toggleEnabled');
  assert.ok(toggle, 'The escape hatch must be a contributed command');
  const visibility = manifest.contributes.menus.commandPalette?.filter(item => item.command === toggle.command) || [];
  const context = { 'config.stageAndNext.enabled': false, 'config.git.enabled': false, gitOpenRepositoryCount: 0 };
  assert.equal(matches(toggle.enablement, context), true);
  assert.ok(visibility.length === 0 || visibility.some(item => matches(item.when, context)));
});
