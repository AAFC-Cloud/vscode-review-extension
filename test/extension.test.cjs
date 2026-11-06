'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Load the entrypoint with only the VS Code boundaries replaced. */
function fixture({ enabled, gitEnabled = true } = {}) {
  const handlers = new Map();
  const updates = [];
  const messages = [];
  const stages = [];
  const contextCalls = [];
  const navigationCalls = [];
  const reviewContext = { markActiveEditor() {} };
  const navigation = {};
  let gitLookups = 0;
  let setting = enabled;
  const api = {};
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { parse: value => value },
    ConfigurationTarget: { Global: 1 },
    env: { language: 'en' },
    extensions: {
      all: [],
      getExtension() {
        gitLookups++;
        return { async activate() { return { enabled: gitEnabled, getAPI: () => api }; } };
      }
    },
    workspace: {
      registerTextDocumentContentProvider: disposable,
      getConfiguration(section) {
        return {
          get(key, fallback) { return section === 'stageAndNext' && key === 'enabled' ? setting ?? fallback : fallback; },
          async update(key, value, target) {
            updates.push({ section, key, value, target });
            if (section === 'stageAndNext' && key === 'enabled') setting = value;
          }
        };
      }
    },
    window: {
      activeTextEditor: { document: { languageId: 'markdown' } },
      setStatusBarMessage(message) { messages.push(message); return disposable(); },
      showInformationMessage(message) { messages.push(message); },
      showErrorMessage(message) { assert.fail(message); }
    },
    commands: {
      registerCommand(command, handler) { handlers.set(command, handler); return disposable(); }
    }
  };
  const dependencies = {
    vscode,
    './review.cjs': { async stageAndNext(...args) { stages.push(args); } },
    './navigation.cjs': {
      createReviewNavigation(...args) { navigationCalls.push(args); return navigation; }
    },
    './review-context.cjs': {
      createReviewContext(...args) { contextCalls.push(args); return reviewContext; }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.cjs'), 'utf8');
  const module = { exports: {} };
  const evaluate = vm.runInNewContext(`(function(require, module, exports) { ${source}\n})`, { Buffer, setTimeout, clearTimeout });
  evaluate(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  const context = { subscriptions: [] };
  module.exports.activate(context);
  return { vscode, context, handlers, updates, messages, stages, api, contextCalls, navigationCalls,
    reviewContext, navigation, get gitLookups() { return gitLookups; } };
}

test('the palette toggle persists disable and re-enable without looking up Git', async () => {
  const state = fixture({ gitEnabled: false });
  const toggle = state.handlers.get('review.toggleEnabled');
  assert.equal(typeof toggle, 'function');
  await toggle();
  await toggle();
  assert.deepEqual(state.updates, [
    { section: 'stageAndNext', key: 'enabled', value: false, target: state.vscode.ConfigurationTarget.Global },
    { section: 'stageAndNext', key: 'enabled', value: true, target: state.vscode.ConfigurationTarget.Global }
  ]);
  assert.equal(state.gitLookups, 0);
  assert.equal(state.stages.length, 0);
  assert.ok(state.messages.some(message => /disabled/i.test(message)));
  assert.ok(state.messages.some(message => /enabled/i.test(message)));
});

test('all stage entrypoints honor the disabled setting, including programmatic invocation', async () => {
  const state = fixture({ enabled: false });
  const stageHandlers = [...state.handlers].filter(([command]) => /^review\.stageAndNext(?:\.|$)/.test(command));
  assert.equal(stageHandlers.length, 5);
  for (const [, handler] of stageHandlers) await handler();
  assert.equal(state.gitLookups, 0);
  assert.equal(state.stages.length, 0);

  await state.handlers.get('review.toggleEnabled')();
  await state.handlers.get('review.stageAndNext')();
  assert.equal(state.gitLookups, 1);
  assert.equal(state.stages.length, 1);
});

test('manual stage invocation remains available from a plain editor when enabled by default', async () => {
  const state = fixture();
  await state.handlers.get('review.stageAndNext')();
  assert.equal(state.stages.length, 1);
});

test('the review context persists across actions and is passed to navigation', async () => {
  const state = fixture();
  assert.deepEqual(state.contextCalls, [[state.vscode, state.context]]);
  await state.handlers.get('review.stageAndNext')();
  await state.handlers.get('review.stageAndNext.name')();
  assert.equal(state.contextCalls.length, 1, 'Reviewed tabs must remain marked between command invocations');
  assert.equal(state.navigationCalls.length, 2);
  for (const call of state.navigationCalls) assert.deepEqual(call, [state.vscode, state.api, state.reviewContext]);
  for (const call of state.stages) assert.equal(call[4], state.navigation);
});
