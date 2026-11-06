'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createReviewNavigation } = require('../src/navigation.cjs');

class Uri {
  constructor(scheme, fsPath, query = '') {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.query = query;
  }

  static file(filename) { return new Uri('file', filename); }

  toString() { return `${this.scheme}:${this.fsPath}?${this.query}`; }
}

class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}

class TabInputText {
  constructor(uri) { this.uri = uri; }
}

const root = path.resolve('navigation-fixture');
const uri = name => Uri.file(path.join(root, name));
const gitUri = (name, ref = '~') => new Uri('git', path.join(root, name), JSON.stringify({ path: path.join(root, name), ref }));
const change = (name, status = 5) => ({ uri: uri(name), status });
const sameUri = (left, right) => left?.toString() === right?.toString();

function sameInput(left, right) {
  return left instanceof TabInputTextDiff && right instanceof TabInputTextDiff
    ? sameUri(left.original, right.original) && sameUri(left.modified, right.modified)
    : left instanceof TabInputText && right instanceof TabInputText && sameUri(left.uri, right.uri);
}

/** Model the native preview replacement that used to discard reviewed diffs. */
function fixture({ current = 'a.txt', preview = true, viewColumn = 2, text = false } = {}) {
  const calls = [];
  const closed = [];
  const events = [];
  const marked = [];
  const markArguments = [];
  const group = { viewColumn, tabs: [], activeTab: undefined };
  const tabGroups = {
    activeTabGroup: group,
    all: [group],
    async close(tabs) {
      for (const tab of Array.isArray(tabs) ? tabs : [tabs]) {
        closed.push(tab);
        events.push(['close', tab]);
        group.tabs = group.tabs.filter(candidate => candidate !== tab);
        if (group.activeTab === tab) group.activeTab = undefined;
      }
      return true;
    }
  };
  const openTab = (input, label, options = {}) => {
    const previous = group.activeTab;
    if (previous) previous.isActive = false;
    let tab = group.tabs.find(candidate => sameInput(candidate.input, input));
    if (!tab) {
      const previewIndex = group.tabs.findIndex(candidate => candidate.isPreview);
      tab = { input, label, group, isPreview: options.preview !== false, isActive: true };
      if (tab.isPreview && previewIndex !== -1) group.tabs.splice(previewIndex, 1, tab);
      else group.tabs.push(tab);
    } else {
      tab.isActive = true;
      if (options.preview === false) tab.isPreview = false;
    }
    group.activeTab = tab;
    events.push(['open', tab]);
    return tab;
  };
  const vscode = {
    Uri,
    TabInputTextDiff,
    TabInputText,
    window: { tabGroups },
    workspace: { fs: { async stat() { return { type: 1 }; } } },
    commands: {
      async executeCommand(command, ...args) {
        calls.push([command, ...args]);
        if (command === 'workbench.action.keepEditor') {
          if (group.activeTab) group.activeTab.isPreview = false;
        } else if (command === 'git.openChange') {
          openTab(new TabInputTextDiff(gitUri(path.relative(root, args[0].fsPath)), args[0]), `${path.basename(args[0].fsPath)} (Working Tree)`);
        } else if (command === 'vscode.diff') {
          openTab(new TabInputTextDiff(args[0], args[1]), args[2], args[3]);
        } else if (command === 'vscode.open') {
          openTab(new TabInputText(args[0]), args[2] || path.basename(args[0].fsPath), args[1]);
        }
      }
    }
  };
  if (current !== undefined) {
    openTab(text ? new TabInputText(uri(current)) : new TabInputTextDiff(gitUri(current), uri(current)),
      text ? current : `${current} (Working Tree)`, { preview });
  }
  const closeActiveTab = () => {
    const tab = group.activeTab;
    group.tabs = group.tabs.filter(candidate => candidate !== tab);
    if (tab) tab.isActive = false;
    group.activeTab = undefined;
  };
  const api = {
    toGitUri(target, ref) { return new Uri('git', target.fsPath, JSON.stringify({ path: target.fsPath, ref })); }
  };
  const reviewContext = { async markActiveEditor(expectedUri) { marked.push(group.activeTab); markArguments.push(expectedUri); } };
  return { vscode, api, calls, closed, events, marked, markArguments, group, openTab, closeActiveTab,
    navigation: createReviewNavigation(vscode, api, reviewContext) };
}

const stagedRepository = (name, status = 0, original = name) => ({
  state: { indexChanges: [{ uri: uri(name), originalUri: uri(original), renameUri: original === name ? undefined : uri(name), status }] }
});

test('opening the next diff retains both outgoing and destination preview tabs', async () => {
  const state = fixture();
  const outgoing = state.group.activeTab;
  await state.navigation.openChange(change('b.txt'));
  assert.equal(outgoing.isPreview, false);
  assert.equal(state.group.tabs.length, 2);
  assert.equal(state.group.tabs[0], outgoing);
  assert.equal(state.group.activeTab.input.modified.toString(), uri('b.txt').toString());
  assert.equal(state.group.activeTab.isPreview, false);
  assert.deepEqual(state.calls.map(([command]) => command), [
    'workbench.action.keepEditor', 'git.openChange', 'workbench.action.keepEditor'
  ]);
});

test('successive review transitions retain the full diff chain', async () => {
  const state = fixture();
  await state.navigation.openChange(change('b.txt'));
  await state.navigation.openChange(change('c.txt'));
  assert.deepEqual(state.group.tabs.map(tab => path.basename(tab.input.modified.fsPath)), ['a.txt', 'b.txt', 'c.txt']);
  assert.ok(state.group.tabs.every(tab => !tab.isPreview));
  assert.equal(state.group.activeTab, state.group.tabs[2]);
});

test('a diff closed by Git staging is restored with its exact URIs, label, and column', async () => {
  const state = fixture({ viewColumn: 3 });
  const original = gitUri('deleted.txt', 'HEAD');
  const modified = gitUri('deleted.txt', '~');
  state.group.activeTab.input = new TabInputTextDiff(original, modified);
  state.group.activeTab.label = 'deleted.txt (Working Tree)';
  const source = await state.navigation.rememberSource(uri('deleted.txt'));
  state.closeActiveTab();
  await state.navigation.restoreSource(source);
  assert.deepEqual(state.calls, [
    ['workbench.action.keepEditor'],
    ['vscode.diff', original, modified, 'deleted.txt (Working Tree)', { preview: false, viewColumn: 3 }]
  ]);
  assert.equal(state.group.tabs.length, 1);
  assert.equal(state.group.activeTab.isPreview, false);
  assert.equal(state.group.activeTab.input.original.toString(), original.toString());
  assert.equal(state.group.activeTab.input.modified.toString(), modified.toString());
});

test('restoring an inactive retained source focuses its existing tab without duplicating it', async () => {
  const state = fixture({ preview: false });
  const outgoing = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('a.txt'));
  state.openTab(new TabInputTextDiff(gitUri('b.txt'), uri('b.txt')), 'b.txt (Working Tree)', { preview: false });
  await state.navigation.restoreSource(source);
  assert.equal(state.group.activeTab, outgoing);
  assert.equal(state.group.tabs.length, 2);
  assert.equal(state.group.activeTab.isPreview, false);
});

test('an unchanged active source is not reopened during restoration', async () => {
  const state = fixture({ preview: false });
  const source = await state.navigation.rememberSource(uri('a.txt'));
  await state.navigation.restoreSource(source);
  assert.deepEqual(state.calls, []);
  assert.equal(state.group.tabs.length, 1);
});

test('an explicit target in another file leaves an unrelated active preview untouched', async () => {
  const state = fixture();
  const outgoing = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('b.txt'));
  await state.navigation.restoreSource(source);
  assert.equal(source, undefined);
  assert.equal(outgoing.isPreview, true);
  assert.deepEqual(state.calls, []);
});

test('a closed ordinary text source is restored as a pinned file in its original column', async () => {
  const state = fixture({ text: true, viewColumn: 4 });
  const source = await state.navigation.rememberSource(uri('a.txt'));
  state.closeActiveTab();
  await state.navigation.restoreSource(source);
  assert.deepEqual(state.calls, [
    ['workbench.action.keepEditor'],
    ['vscode.open', uri('a.txt'), { preview: false, viewColumn: 4 }, 'a.txt']
  ]);
  assert.ok(state.group.activeTab.input instanceof TabInputText);
  assert.equal(state.group.activeTab.isPreview, false);
  assert.deepEqual(state.marked, [state.group.activeTab]);
  assert.deepEqual(state.markArguments, [uri('a.txt')]);
});

test('untracked destinations open as retained text tabs', async () => {
  const state = fixture();
  await state.navigation.openChange(change('new.txt', 7));
  assert.equal(state.group.tabs.length, 2);
  assert.ok(state.group.activeTab.input instanceof TabInputText);
  assert.equal(state.group.activeTab.input.uri.toString(), uri('new.txt').toString());
  assert.ok(state.group.tabs.every(tab => !tab.isPreview));
  assert.equal(state.calls.some(([command]) => command === 'git.openChange'), false);
  assert.deepEqual(state.marked, [state.group.activeTab], 'The plain file must retain the review shortcut');
  assert.deepEqual(state.markArguments, [uri('new.txt')]);
});

test('without an active editor, remembering and restoring are safe and the first diff is retained', async () => {
  const state = fixture();
  state.closeActiveTab();
  const source = await state.navigation.rememberSource();
  await state.navigation.restoreSource(source);
  assert.equal(source, undefined);
  assert.deepEqual(state.calls, []);
  await state.navigation.openChange(change('b.txt'));
  assert.equal(state.group.tabs.length, 1);
  assert.equal(state.group.activeTab.input.modified.toString(), uri('b.txt').toString());
  assert.equal(state.group.activeTab.isPreview, false);
});

test('a reviewed file is retained as HEAD to index, removing its now-empty working diff', async () => {
  const state = fixture({ viewColumn: 3 });
  const workingTab = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('a.txt'));
  await state.navigation.showStagedChange(source, stagedRepository('a.txt'), uri('a.txt'));

  const stagedTab = state.group.activeTab;
  assert.ok(stagedTab.input instanceof TabInputTextDiff);
  assert.equal(stagedTab.input.original.toString(), gitUri('a.txt', 'HEAD').toString());
  assert.equal(stagedTab.input.modified.toString(), gitUri('a.txt', '').toString());
  assert.equal(stagedTab.isPreview, false);
  assert.equal(state.group.tabs.includes(workingTab), false);
  assert.ok(state.closed.includes(workingTab));
  assert.equal(state.group.tabs.length, 1);
  assert.ok(state.events.findIndex(([event, tab]) => event === 'open' && tab === stagedTab)
    < state.events.findIndex(([event, tab]) => event === 'close' && tab === workingTab),
  'The staged comparison must open before its outgoing working comparison is closed.');
  const open = state.calls.find(([command]) => command === 'vscode.diff');
  assert.equal(open[4].viewColumn, 3);

  await state.navigation.openChange(change('b.txt'));
  assert.equal(state.group.tabs.length, 2);
  assert.equal(state.group.tabs[0], stagedTab);
  assert.equal(state.group.activeTab.input.modified.toString(), uri('b.txt').toString());
  assert.ok(state.group.tabs.every(tab => !tab.isPreview));
});

test('successive reviews retain staged comparisons and only the destination working diff', async () => {
  const state = fixture();
  for (const [reviewed, next] of [['a.txt', 'b.txt'], ['b.txt', 'c.txt']]) {
    const source = await state.navigation.rememberSource(uri(reviewed));
    await state.navigation.showStagedChange(source, stagedRepository(reviewed), uri(reviewed));
    await state.navigation.openChange(change(next));
  }
  assert.equal(state.group.tabs.length, 3);
  assert.deepEqual(state.group.tabs.slice(0, 2).map(tab => JSON.parse(tab.input.modified.query).ref), ['', '']);
  assert.equal(state.group.activeTab.input.modified.toString(), uri('c.txt').toString());
  assert.equal(state.closed.length, 2);
});

test('Git closing the source during staging still records the staged comparison', async () => {
  const state = fixture();
  const source = await state.navigation.rememberSource(uri('a.txt'));
  state.closeActiveTab();
  await state.navigation.showStagedChange(source, stagedRepository('a.txt'), uri('a.txt'));
  assert.equal(state.group.tabs.length, 1);
  assert.equal(state.group.activeTab.input.original.toString(), gitUri('a.txt', 'HEAD').toString());
  assert.equal(state.group.activeTab.input.modified.toString(), gitUri('a.txt', '').toString());
  assert.equal(state.group.activeTab.isPreview, false);
});

test('reviewing an ordinary file retains its staged diff instead of an unhighlighted text tab', async () => {
  const state = fixture({ text: true });
  const outgoing = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('a.txt'));
  await state.navigation.showStagedChange(source, stagedRepository('a.txt'), uri('a.txt'));
  assert.equal(state.group.tabs.includes(outgoing), false);
  assert.equal(state.group.tabs.length, 1);
  assert.ok(state.group.activeTab.input instanceof TabInputTextDiff);
  assert.equal(state.group.activeTab.input.modified.toString(), gitUri('a.txt', '').toString());
});

test('a staged rename compares the old HEAD path to the new index path', async () => {
  const state = fixture({ current: 'renamed.txt' });
  state.group.activeTab.input.original = gitUri('original.txt', 'HEAD');
  const source = await state.navigation.rememberSource(uri('renamed.txt'));
  await state.navigation.showStagedChange(source, stagedRepository('renamed.txt', 3, 'original.txt'), uri('renamed.txt'));
  assert.equal(state.group.tabs.length, 1);
  assert.equal(state.group.activeTab.input.original.toString(), gitUri('original.txt', 'HEAD').toString());
  assert.equal(state.group.activeTab.input.modified.toString(), gitUri('renamed.txt', '').toString());
});

test('a rename staged under its original path resolves to the new index path', async () => {
  const state = fixture({ current: 'original.txt' });
  const source = await state.navigation.rememberSource(uri('original.txt'));
  await state.navigation.showStagedChange(source, stagedRepository('renamed.txt', 3, 'original.txt'), uri('original.txt'));
  assert.ok(state.group.activeTab.input instanceof TabInputTextDiff);
  assert.equal(state.group.activeTab.input.original.toString(), gitUri('original.txt', 'HEAD').toString());
  assert.equal(state.group.activeTab.input.modified.toString(), gitUri('renamed.txt', '').toString());
});

for (const [kind, status] of [['added', 1], ['copied', 4]]) {
  test(`a staged ${kind} file retains its index content without requesting a nonexistent HEAD file`, async () => {
    const state = fixture({ current: 'new.txt', text: true });
    const source = await state.navigation.rememberSource(uri('new.txt'));
    await state.navigation.showStagedChange(source, stagedRepository('new.txt', status), uri('new.txt'));
    assert.equal(state.group.tabs.length, 1);
    assert.ok(state.group.activeTab.input instanceof TabInputText);
    assert.equal(state.group.activeTab.input.uri.toString(), gitUri('new.txt', '').toString());
    assert.equal(state.group.activeTab.isPreview, false);
    assert.equal(state.calls.some(([command]) => command === 'vscode.diff'), false);
    assert.deepEqual(state.marked, [state.group.activeTab], 'History must retain the review shortcut in a staged plain file');
    assert.deepEqual(state.markArguments, [gitUri('new.txt', '')]);
  });
}

test('a deleted staged file retains its HEAD content, matching the staged deleted-file view', async () => {
  const state = fixture({ current: 'deleted.txt' });
  const source = await state.navigation.rememberSource(uri('deleted.txt'));
  await state.navigation.showStagedChange(source, stagedRepository('deleted.txt', 2), uri('deleted.txt'));
  assert.equal(state.group.tabs.length, 1);
  assert.ok(state.group.activeTab.input instanceof TabInputText);
  assert.equal(state.group.activeTab.input.uri.toString(), gitUri('deleted.txt', 'HEAD').toString());
  assert.equal(state.group.activeTab.isPreview, false);
  assert.equal(state.calls.some(([command]) => command === 'vscode.diff'), false);
  assert.deepEqual(state.marked, [state.group.activeTab]);
  assert.deepEqual(state.markArguments, [gitUri('deleted.txt', 'HEAD')]);
});

test('a missing staged entry falls back to the file instead of retaining its empty working diff', async () => {
  const state = fixture();
  const workingTab = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('a.txt'));
  await state.navigation.showStagedChange(source, { state: { indexChanges: [] } }, uri('a.txt'));
  assert.equal(state.group.tabs.length, 1);
  assert.ok(state.group.activeTab.input instanceof TabInputText);
  assert.equal(state.group.activeTab.input.uri.toString(), uri('a.txt').toString());
  assert.equal(state.group.activeTab.isPreview, false);
  assert.equal(state.group.tabs.includes(workingTab), false);
  assert.deepEqual(state.marked, [state.group.activeTab]);
  assert.deepEqual(state.markArguments, [uri('a.txt')]);
});

test('a disappeared file with no staged entry is not reopened as an invalid virtual document', async () => {
  const state = fixture();
  state.vscode.workspace.fs.stat = async () => { throw new Error('File not found'); };
  const source = await state.navigation.rememberSource(uri('a.txt'));
  await state.navigation.showStagedChange(source, { state: { indexChanges: [] } }, uri('a.txt'));
  assert.equal(state.group.tabs.length, 0);
  assert.equal(state.calls.some(([command]) => command === 'vscode.diff' || command === 'vscode.open'), false);
});

test('an explicit SCM review records its staged comparison while retaining an unrelated editor', async () => {
  const state = fixture({ current: 'unrelated.txt' });
  const unrelated = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('a.txt'));
  assert.equal(source, undefined);
  await state.navigation.showStagedChange(source, stagedRepository('a.txt'), uri('a.txt'));
  assert.equal(state.group.tabs.length, 2);
  assert.equal(state.group.tabs.includes(unrelated), true);
  assert.equal(state.closed.length, 0);
  assert.equal(state.group.activeTab.input.modified.toString(), gitUri('a.txt', '').toString());
});

test('a failure to open the staged comparison leaves the outgoing editor available', async () => {
  const state = fixture();
  const outgoing = state.group.activeTab;
  const source = await state.navigation.rememberSource(uri('a.txt'));
  const execute = state.vscode.commands.executeCommand;
  state.vscode.commands.executeCommand = async (command, ...args) => {
    if (command === 'vscode.diff') throw new Error('Editor unavailable');
    return execute(command, ...args);
  };
  await assert.rejects(state.navigation.showStagedChange(source, stagedRepository('a.txt'), uri('a.txt')), /Editor unavailable/);
  assert.equal(state.group.tabs.length, 1);
  assert.equal(state.group.activeTab, outgoing);
  assert.equal(state.closed.length, 0);
});
