'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { stageAndNext, unstagedChanges } = require('../src/review.cjs');

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

const root = path.resolve('fixture-repository');
const uri = name => Uri.file(path.join(root, name));
const change = (name, status = 5) => ({ uri: uri(name), status });
const gitUri = (name, ref = '~') => new Uri('git', path.join(root, name), JSON.stringify({ path: path.join(root, name), ref }));

/** The fake models the index transition and records observable side effects. */
function fixture({ current = 'a.txt', changes = [change('a.txt'), change('b.txt')], untracked = [], mode = 'mixed', selected = false, scmConfig = {} } = {}) {
  const calls = [];
  const messages = [];
  const document = { uri: uri(current), isDirty: false, async save() { calls.push(['save']); return true; } };
  const editor = { document, selections: [{ isEmpty: !selected }] };
  const repository = {
    rootUri: Uri.file(root),
    ui: { selected: false },
    state: { workingTreeChanges: changes, untrackedChanges: untracked, mergeChanges: [] },
    async status() { calls.push(['status']); },
    async add(paths) {
      calls.push(['add', ...paths]);
      this.state.workingTreeChanges = this.state.workingTreeChanges.filter(item => !paths.includes(item.uri.fsPath));
      this.state.untrackedChanges = this.state.untrackedChanges.filter(item => !paths.includes(item.uri.fsPath));
    }
  };
  const vscode = {
    Uri,
    TabInputTextDiff,
    window: {
      activeTextEditor: editor,
      tabGroups: { activeTabGroup: { activeTab: { input: { uri: uri(current) } } } },
      setStatusBarMessage(message) { messages.push(message); },
      showInformationMessage(message) { messages.push(message); }
    },
    workspace: {
      textDocuments: [document],
      getConfiguration(section) {
        return { get: (key, fallback) => section === 'git' && key === 'untrackedChanges'
          ? mode : scmConfig[key] ?? fallback };
      }
    },
    commands: { async executeCommand(command, target) { calls.push([command, ...(target ? [target.fsPath] : [])]); } }
  };
  const api = { getRepository: () => repository, repositories: [repository] };
  return { vscode, api, repository, document, editor, calls, messages };
}

function closeEditors(state) {
  state.vscode.window.activeTextEditor = undefined;
  state.vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  state.vscode.workspace.textDocuments = [];
}

function actions(state) {
  return state.calls.filter(([command]) => command !== 'status');
}

function navigationSpy(state) {
  const source = {};
  const staged = [];
  return {
    source,
    staged,
    async rememberSource(target) { state.calls.push(['rememberSource', target.fsPath]); return source; },
    async restoreSource(saved) { assert.equal(saved, source); state.calls.push(['restoreSource']); },
    async showStagedChange(saved, repository, target) {
      assert.equal(saved, source);
      assert.equal(repository, state.repository);
      staged.push(target);
      state.calls.push(['showStagedChange', target.fsPath]);
    },
    async openChange(target) { state.calls.push(['openChange', target.uri.fsPath]); }
  };
}

function anotherRepository(state, name, filenames, selected = false) {
  const repositoryRoot = path.resolve(name);
  return {
    rootUri: Uri.file(repositoryRoot),
    ui: { selected },
    state: {
      workingTreeChanges: filenames.map(filename => ({ uri: Uri.file(path.join(repositoryRoot, filename)), status: 5 })),
      untrackedChanges: [],
      mergeChanges: []
    },
    async status() { state.calls.push(['status']); },
    async add(paths) { state.calls.push(['add', ...paths]); }
  };
}

test('selected working-tree ranges use native Git without saving or navigating', async () => {
  const state = fixture({ selected: true });
  state.document.isDirty = true;
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.stageSelectedRanges']]);
});

test('a Source Control resource takes precedence over selections in another editor', async () => {
  const state = fixture({ current: 'a.txt', selected: true });
  state.document.isDirty = true;
  await stageAndNext(state.vscode, state.api, { resourceUri: uri('b.txt') });
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('b.txt').fsPath], ['status'], ['git.openChange', uri('a.txt').fsPath]
  ]);
});

test('the Source Control shortcut stages the whole row despite a retained editor selection', async () => {
  const state = fixture({ selected: true });
  await stageAndNext(state.vscode, state.api, { source: 'scm' });
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('a.txt').fsPath], ['status'], ['git.openChange', uri('b.txt').fsPath]
  ]);
});

test('an explicit file URI does not stage selected ranges from an unrelated editor', async () => {
  const state = fixture({ selected: true });
  await stageAndNext(state.vscode, state.api, uri('b.txt'));
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('b.txt').fsPath], ['status'], ['git.openChange', uri('a.txt').fsPath]
  ]);
});

test('an unsupported explicit resource never falls back to the active file', async () => {
  const state = fixture();
  await stageAndNext(state.vscode, state.api, { resourceUri: new Uri('custom', '/resource') });
  assert.deepEqual(state.calls, []);
});

test('a selection on the original path of a renamed diff never stages the whole file', async () => {
  const state = fixture({ current: 'old.txt', changes: [change('new.txt')], selected: true });
  state.document.uri = gitUri('old.txt', 'HEAD');
  state.vscode.window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(state.document.uri, uri('new.txt'));
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual({ calls: state.calls, messages: state.messages }, {
    calls: [],
    messages: ['Stage and Next: Select changes in the modified (right-hand) editor to stage ranges.']
  });
});

test('canceling a dirty file save prevents staging and navigation', async () => {
  const state = fixture();
  state.document.isDirty = true;
  state.document.save = async () => { state.calls.push(['save']); return false; };
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(state.calls, [['save']]);
});

test('whole-file staging saves the target before refreshing or touching the index', async () => {
  const state = fixture();
  state.document.isDirty = true;
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(state.calls, [
    ['save'], ['status'], ['add', uri('a.txt').fsPath], ['status'], ['git.openChange', uri('b.txt').fsPath]
  ]);
});

test('a failed stage never opens another file', async () => {
  const state = fixture();
  state.repository.add = async paths => { state.calls.push(['add', ...paths]); throw new Error('index is locked'); };
  await assert.rejects(stageAndNext(state.vscode, state.api), /index is locked/);
  assert.deepEqual(state.calls, [['status'], ['add', uri('a.txt').fsPath]]);
});

test('a failed initial status does not stage anything', async () => {
  const state = fixture();
  state.repository.status = async () => { state.calls.push(['status']); throw new Error('Git unavailable'); };
  await assert.rejects(stageAndNext(state.vscode, state.api), /Git unavailable/);
  assert.deepEqual(state.calls, [['status']]);
});

test('a failed status after staging never opens another file', async () => {
  const state = fixture();
  let refreshes = 0;
  state.repository.status = async () => {
    state.calls.push(['status']);
    if (++refreshes === 2) throw new Error('refresh failed');
  };
  await assert.rejects(stageAndNext(state.vscode, state.api), /refresh failed/);
  assert.deepEqual(state.calls, [['status'], ['add', uri('a.txt').fsPath], ['status']]);
});

test('a file changed again during staging stays active', async () => {
  const state = fixture();
  state.repository.add = async paths => { state.calls.push(['add', ...paths]); };
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual({ calls: state.calls, messages: state.messages }, {
    calls: [['status'], ['add', uri('a.txt').fsPath], ['status']],
    messages: ['Stage and Next: The file still has unstaged changes; staying on this file.']
  });
});

test('whole-file review retains the staged comparison before opening the next change', async () => {
  const state = fixture();
  const navigation = navigationSpy(state);
  await stageAndNext(state.vscode, state.api, undefined, undefined, navigation);
  assert.deepEqual(state.calls, [
    ['status'], ['rememberSource', uri('a.txt').fsPath], ['add', uri('a.txt').fsPath], ['status'],
    ['showStagedChange', uri('a.txt').fsPath], ['openChange', uri('b.txt').fsPath]
  ]);
  assert.equal(navigation.staged.length, 1);
});

test('staging the only remaining file retains its staged comparison without advancing', async () => {
  const state = fixture({ changes: [change('a.txt')] });
  await stageAndNext(state.vscode, state.api, undefined, undefined, navigationSpy(state));
  assert.deepEqual(state.calls, [
    ['status'], ['rememberSource', uri('a.txt').fsPath], ['add', uri('a.txt').fsPath], ['status'],
    ['showStagedChange', uri('a.txt').fsPath]
  ]);
});

test('failed staging restores its working comparison without recording a staged review', async () => {
  const state = fixture();
  state.repository.add = async paths => { state.calls.push(['add', ...paths]); throw new Error('index is locked'); };
  await assert.rejects(stageAndNext(state.vscode, state.api, undefined, undefined, navigationSpy(state)), /index is locked/);
  assert.deepEqual(state.calls, [
    ['status'], ['rememberSource', uri('a.txt').fsPath], ['add', uri('a.txt').fsPath], ['restoreSource']
  ]);
});

test('failed post-stage refresh restores the source instead of guessing a staged comparison', async () => {
  const state = fixture();
  let refreshes = 0;
  state.repository.status = async () => {
    state.calls.push(['status']);
    if (++refreshes === 2) throw new Error('refresh failed');
  };
  await assert.rejects(stageAndNext(state.vscode, state.api, undefined, undefined, navigationSpy(state)), /refresh failed/);
  assert.deepEqual(state.calls, [
    ['status'], ['rememberSource', uri('a.txt').fsPath], ['add', uri('a.txt').fsPath], ['status'], ['restoreSource']
  ]);
});

test('a concurrent working-tree edit restores the source and retains the remaining diff', async () => {
  const state = fixture();
  state.repository.add = async paths => { state.calls.push(['add', ...paths]); };
  await stageAndNext(state.vscode, state.api, undefined, undefined, navigationSpy(state));
  assert.deepEqual(state.calls, [
    ['status'], ['rememberSource', uri('a.txt').fsPath], ['add', uri('a.txt').fsPath], ['status'], ['restoreSource']
  ]);
});

test('selected-range staging keeps its working comparison and never converts it to a staged review', async () => {
  const state = fixture({ selected: true });
  await stageAndNext(state.vscode, state.api, undefined, undefined, navigationSpy(state));
  assert.deepEqual(state.calls, [
    ['status'], ['rememberSource', uri('a.txt').fsPath], ['git.stageSelectedRanges'], ['restoreSource']
  ]);
});

test('staging the final path opens the last remaining change without wrapping', async () => {
  const state = fixture({ current: 'c.txt', changes: [change('b.txt'), change('c.txt'), change('a.txt')] });
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('c.txt').fsPath], ['status'], ['git.openChange', uri('b.txt').fsPath]
  ]);
});

test('if every following entry disappears, navigation opens the last remaining entry', async () => {
  const state = fixture({
    current: 'c.txt',
    changes: ['e.txt', 'c.txt', 'a.txt', 'd.txt', 'b.txt'].map(name => change(name))
  });
  state.repository.add = async paths => {
    state.calls.push(['add', ...paths]);
    state.repository.state.workingTreeChanges = [change('a.txt'), change('b.txt')];
  };
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('c.txt').fsPath], ['status'], ['git.openChange', uri('b.txt').fsPath]
  ]);
});

test('successive stages from the end walk backward until no unstaged files remain', async () => {
  const state = fixture({ current: 'c.txt', changes: ['a.txt', 'b.txt', 'c.txt'].map(name => change(name)) });
  for (const filename of ['c.txt', 'b.txt', 'a.txt']) {
    state.document.uri = uri(filename);
    state.vscode.window.tabGroups.activeTabGroup.activeTab.input = { uri: state.document.uri };
    await stageAndNext(state.vscode, state.api);
  }
  assert.deepEqual(actions(state), [
    ['add', uri('c.txt').fsPath], ['git.openChange', uri('b.txt').fsPath],
    ['add', uri('b.txt').fsPath], ['git.openChange', uri('a.txt').fsPath],
    ['add', uri('a.txt').fsPath]
  ]);
  assert.deepEqual(state.repository.state.workingTreeChanges, []);
});

test('separate untracked changes follow tracked changes and open as ordinary files', async () => {
  const state = fixture({ current: 'z.txt', changes: [change('z.txt')], untracked: [change('a-new.txt', 7)], mode: 'separate' });
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('z.txt').fsPath], ['status'], ['vscode.open', uri('a-new.txt').fsPath]
  ]);
});

test('staging the final untracked file returns to the last remaining tracked change', async () => {
  const state = fixture({ current: 'a-new.txt', changes: [change('z.txt')], untracked: [change('a-new.txt', 7)], mode: 'separate' });
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(state.calls, [
    ['status'], ['add', uri('a-new.txt').fsPath], ['status'], ['git.openChange', uri('z.txt').fsPath]
  ]);
});

test('with every editor closed, the shortcut opens the first change in the live view order', async () => {
  const state = fixture({ changes: [change(path.join('a-folder', 'z.txt')), change(path.join('z-folder', 'a.txt'))] });
  closeEditors(state);
  await stageAndNext(state.vscode, state.api, undefined, { mode: 'list', sortKey: 'name' });
  assert.deepEqual(actions(state), [['git.openChange', uri(path.join('z-folder', 'a.txt')).fsPath]]);
});

test('the browse-only binding opens a change without saving or staging a retained active editor', async () => {
  const state = fixture({ current: 'b.txt', selected: true });
  state.document.isDirty = true;
  await stageAndNext(state.vscode, state.api, { source: 'browse' });
  assert.deepEqual(actions(state), [['git.openChange', uri('a.txt').fsPath]]);
  assert.deepEqual(state.repository.state.workingTreeChanges.map(item => item.uri.fsPath), [uri('a.txt').fsPath, uri('b.txt').fsPath]);
});

test('a saved file with no unstaged change opens the first change without saving the document', async () => {
  const state = fixture({ current: 'clean.txt' });
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', uri('a.txt').fsPath]]);
});

test('a selection in an unchanged saved file opens a change instead of staging unrelated ranges', async () => {
  const state = fixture({ current: 'clean.txt', selected: true });
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', uri('a.txt').fsPath]]);
});

test('an unsupported active document opens a change without staging its selection', async () => {
  const state = fixture({ selected: true });
  state.document.uri = new Uri('untitled', 'scratch');
  state.document.isDirty = true;
  state.vscode.window.tabGroups.activeTabGroup.activeTab.input = { uri: state.document.uri };
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', uri('a.txt').fsPath]]);
});

test('a file outside open repositories opens an available change without saving', async () => {
  const state = fixture();
  state.document.uri = Uri.file(path.resolve('outside-repository.txt'));
  state.document.isDirty = true;
  state.vscode.window.tabGroups.activeTabGroup.activeTab.input = { uri: state.document.uri };
  state.api.getRepository = target => target.fsPath === state.document.uri.fsPath ? undefined : state.repository;
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', uri('a.txt').fsPath]]);
});

test('fallback navigation prefers the active document repository over the selected repository', async () => {
  const state = fixture({ current: 'clean.txt' });
  const selectedRepository = anotherRepository(state, 'selected-repository', ['other.txt'], true);
  state.api.repositories = [selectedRepository, state.repository];
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', uri('a.txt').fsPath]]);
});

test('with no active document, fallback navigation prefers the selected repository', async () => {
  const state = fixture();
  const selectedRepository = anotherRepository(state, 'selected-repository', ['other.txt'], true);
  state.api.repositories = [state.repository, selectedRepository];
  closeEditors(state);
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', selectedRepository.state.workingTreeChanges[0].uri.fsPath]]);
});

test('an empty selected repository falls through to another open repository with changes', async () => {
  const state = fixture({ changes: [] });
  const emptySelectedRepository = anotherRepository(state, 'selected-repository', [], true);
  const changedRepository = anotherRepository(state, 'changed-repository', ['other.txt']);
  state.api.repositories = [state.repository, emptySelectedRepository, changedRepository];
  closeEditors(state);
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), [['git.openChange', changedRepository.state.workingTreeChanges[0].uri.fsPath]]);
});

test('with no editor and no unstaged files, the shortcut does not save, stage, or open anything', async () => {
  const state = fixture({ changes: [] });
  closeEditors(state);
  await stageAndNext(state.vscode, state.api);
  assert.deepEqual(actions(state), []);
});

test('an explicit unchanged file does not fall back to staging or opening another change', async () => {
  const state = fixture();
  await stageAndNext(state.vscode, state.api, uri('clean.txt'));
  assert.deepEqual(actions(state), []);
});

test('an explicit file outside open repositories does not fall back to another change', async () => {
  const state = fixture();
  state.api.getRepository = () => undefined;
  await stageAndNext(state.vscode, state.api, Uri.file(path.resolve('outside-repository.txt')));
  assert.deepEqual(actions(state), []);
});

test('hidden untracked files are excluded from both Git resource groups', () => {
  const state = fixture({ changes: [change('b.txt'), change('a-new.txt', 7)], untracked: [change('c-new.txt', 7)] });
  assert.deepEqual(unstagedChanges(state.repository, 'hidden').map(item => path.basename(item.uri.fsPath)), ['b.txt']);
});

test('the same untracked change reported in both groups appears once', () => {
  const state = fixture({ changes: [change('b.txt'), change('a-new.txt', 7)], untracked: [change('a-new.txt', 7)] });
  assert.deepEqual(unstagedChanges(state.repository).map(item => path.basename(item.uri.fsPath)), ['a-new.txt', 'b.txt']);
});
