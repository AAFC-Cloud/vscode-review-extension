'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createReviewContext } = require('../src/review-context.cjs');

class TabInputText {
  constructor(uri) { this.uri = uri; }
}
class TabInputTextDiff {
  constructor(original, modified) { this.original = original; this.modified = modified; }
}

function fixture() {
  const calls = [];
  const values = new Map();
  const subscriptions = [];
  const listeners = { tabs: new Set(), groups: new Set(), editor: new Set() };
  const subscribe = name => listener => {
    listeners[name].add(listener);
    return { dispose() { listeners[name].delete(listener); } };
  };
  const group = { activeTab: undefined, tabs: [] };
  const vscode = {
    TabInputText,
    TabInputTextDiff,
    commands: {
      async executeCommand(...args) {
        calls.push(args);
        assert.equal(args[0], 'setContext');
        values.set(args[1], args[2]);
      }
    },
    window: {
      tabGroups: {
        activeTabGroup: group,
        all: [group],
        onDidChangeTabs: subscribe('tabs'),
        onDidChangeTabGroups: subscribe('groups')
      },
      onDidChangeActiveTextEditor: subscribe('editor'),
      activeTextEditor: undefined
    }
  };
  const context = { subscriptions };
  const reviewContext = createReviewContext(vscode, context);
  const plainTab = (uri = 'file:/new.md') => ({ input: new TabInputText(uri) });
  const fire = async (name, value = {}) => {
    await Promise.all([...listeners[name]].map(listener => listener(value)));
  };
  const focus = async (tab, event = 'tabs') => {
    group.activeTab = tab;
    if (tab && !group.tabs.includes(tab)) group.tabs.push(tab);
    vscode.window.activeTextEditor = tab?.input instanceof TabInputText
      ? { document: { uri: tab.input.uri } } : undefined;
    await fire(event, event === 'editor' ? vscode.window.activeTextEditor : {});
  };
  return { vscode, calls, values, listeners, subscriptions, group, reviewContext, plainTab, focus, fire,
    enabled: () => values.get('stageAndNext.reviewEditor') };
}

test('ordinary Markdown and unmarked Git documents leave the review shortcut inactive', async () => {
  const state = fixture();
  assert.equal(state.enabled(), false);
  await state.focus(state.plainTab('file:/notes.md'));
  assert.equal(state.enabled(), false);
  await state.focus(state.plainTab('git:/notes.md?ref=HEAD'));
  assert.equal(state.enabled(), false);
});

test('an opened review file becomes eligible before marking finishes', async () => {
  const state = fixture();
  await state.focus(state.plainTab());
  await state.reviewContext.markActiveEditor();
  assert.equal(state.enabled(), true);
  assert.ok(state.calls.some(call => call[1] === 'stageAndNext.reviewEditor' && call[2] === true));
});

test('a delayed review open cannot mark an unrelated file that became active meanwhile', async () => {
  const state = fixture();
  const unrelated = state.plainTab('file:/notes.md');
  const reviewed = state.plainTab('file:/reviewed.md');
  await state.focus(unrelated);
  await state.reviewContext.markActiveEditor(reviewed.input.uri);
  assert.equal(state.enabled(), false);
  await state.focus(reviewed);
  assert.equal(state.enabled(), false, 'A mismatched expected URI must not mark any inactive tab');
  await state.reviewContext.markActiveEditor(reviewed.input.uri);
  assert.equal(state.enabled(), true);
  await state.focus(unrelated);
  assert.equal(state.enabled(), false);
});

test('switching away clears the context and revisiting the same reviewed tab restores it', async () => {
  const state = fixture();
  const reviewed = state.plainTab();
  await state.focus(reviewed);
  await state.reviewContext.markActiveEditor();
  await state.focus(state.plainTab('file:/notes.md'));
  assert.equal(state.enabled(), false);
  await state.focus(reviewed, 'editor');
  assert.equal(state.enabled(), true);
  await state.focus(undefined);
  assert.equal(state.enabled(), false);
});

test('the same URI in a new text input is not implicitly treated as a review tab', async () => {
  const state = fixture();
  const reviewed = state.plainTab();
  await state.focus(reviewed);
  await state.reviewContext.markActiveEditor();
  await state.focus(state.plainTab());
  assert.equal(state.enabled(), false);
  await state.focus(reviewed);
  assert.equal(state.enabled(), true);
});

test('marking a staged plain Git view retains review navigation', async () => {
  const state = fixture();
  const staged = state.plainTab('git:/new.md?ref=');
  await state.focus(staged);
  await state.reviewContext.markActiveEditor();
  assert.equal(state.enabled(), true);
  await state.focus(undefined);
  await state.focus(staged, 'groups');
  assert.equal(state.enabled(), true);
});

test('diff, custom, and absent editors cannot be tagged as plain review documents', async () => {
  const state = fixture();
  for (const tab of [
    { input: new TabInputTextDiff('git:/file?ref=HEAD', 'file:/file') },
    { input: { uri: 'file:/image.png' } },
    undefined
  ]) {
    await state.focus(tab);
    await state.reviewContext.markActiveEditor();
    assert.equal(state.enabled(), false);
  }
});

test('changing the active tab group refreshes the review context', async () => {
  const state = fixture();
  const reviewed = state.plainTab();
  await state.focus(reviewed);
  await state.reviewContext.markActiveEditor();
  const anotherGroup = { activeTab: state.plainTab('file:/notes.md') };
  state.vscode.window.tabGroups.activeTabGroup = anotherGroup;
  await state.fire('groups');
  assert.equal(state.enabled(), false);
  state.vscode.window.tabGroups.activeTabGroup = state.group;
  await state.fire('groups');
  assert.equal(state.enabled(), true);
});

test('disposing the extension clears the context and removes all event listeners', async () => {
  const state = fixture();
  await state.focus(state.plainTab());
  await state.reviewContext.markActiveEditor();
  assert.equal(state.enabled(), true);
  for (const disposable of state.subscriptions) await disposable.dispose();
  assert.equal(state.enabled(), false);
  assert.ok(Object.values(state.listeners).every(listeners => listeners.size === 0));
});
