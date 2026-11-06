'use strict';

const path = require('node:path');
const { sortChanges } = require('./order.cjs');

function sameUri(left, right) {
  if (!left || !right) return false;
  const a = left.toString();
  const b = right.toString();
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Convert the Git extension's virtual document URI to its working file URI. */
function workingUri(vscode, uri) {
  if (!uri) return undefined;
  if (uri.scheme === 'file') return uri;
  if (uri.scheme !== 'git') return undefined;
  try {
    const data = JSON.parse(uri.query);
    return typeof data.path === 'string' ? vscode.Uri.file(data.path) : undefined;
  } catch {
    return undefined;
  }
}

/** Match the active Source Control order, keeping separate resource groups apart. */
function unstagedChanges(repository, untrackedMode = 'mixed', viewOrder = { mode: 'list', sortKey: 'path' }) {
  const tracked = repository.state.workingTreeChanges.filter(change => untrackedMode !== 'hidden' || change.status !== 7);
  const untracked = untrackedMode === 'hidden' ? [] : repository.state.untrackedChanges;
  const unique = changes => changes.filter((change, index) => changes.findIndex(other => sameUri(other.uri, change.uri)) === index);
  const sort = changes => sortChanges(changes, repository.rootUri, viewOrder);
  if (untrackedMode === 'separate') {
    return unique(sort(tracked).concat(sort(untracked)));
  }
  return sort(unique([...tracked, ...untracked]));
}

/** Advance past the current file, or stay at the end of the remaining list. */
function nextChange(before, remaining, current) {
  if (!remaining.length) return undefined;
  const index = before.findIndex(change => sameUri(change.uri, current));
  for (const candidate of before.slice(index + 1)) {
    const match = remaining.find(change => sameUri(change.uri, candidate.uri));
    if (match && !sameUri(match.uri, current)) return match;
  }
  return remaining.findLast(change => !sameUri(change.uri, current));
}

function activeUri(vscode) {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!input) return undefined;
  // The original half of a renamed diff can refer to a different file.
  if (input instanceof vscode.TabInputTextDiff) {
    return workingUri(vscode, input.modified) || workingUri(vscode, input.original);
  }
  if (input.uri) return workingUri(vscode, input.uri);
  return workingUri(vscode, vscode.window.activeTextEditor?.document.uri);
}

async function openChange(vscode, change, navigation) {
  if (navigation) {
    await navigation.openChange(change);
    return;
  }
  // Git's openChange lookup does not include its separate Untracked group.
  await vscode.commands.executeCommand(change.status === 7 ? 'vscode.open' : 'git.openChange', change.uri);
}

/** Enter review without staging, preferring the current or selected repository. */
async function openFirstChange(vscode, api, viewOrder, preferred, refreshed, navigation) {
  const repositories = api.repositories || [];
  const candidates = [...new Set([preferred, ...repositories.filter(repository => repository.ui?.selected), ...repositories])];
  for (const repository of candidates) {
    if (!repository) continue;
    if (repository !== refreshed) await repository.status();
    const mode = vscode.workspace.getConfiguration('git', repository.rootUri).get('untrackedChanges', 'mixed');
    const first = unstagedChanges(repository, mode, viewOrder)[0];
    if (first) {
      await openChange(vscode, first, navigation);
      return;
    }
  }
  vscode.window.setStatusBarMessage('Stage and Next: No unstaged files remain in the open repositories.', 5000);
}

/** Kept separate from registration so index and navigation behavior can be tested. */
async function stageAndNext(vscode, api, argument, viewOrder, navigation) {
  const explicit = argument?.resourceUri || (argument instanceof vscode.Uri ? argument : undefined);
  const uri = explicit ? workingUri(vscode, explicit) : activeUri(vscode);
  if (explicit && !uri) {
    vscode.window.setStatusBarMessage('Stage and Next: Focus a changed file first.', 4000);
    return;
  }
  const repository = uri ? api.getRepository(uri) : undefined;
  if (explicit && !repository) {
    vscode.window.setStatusBarMessage('Stage and Next: This file is not in an open Git repository.', 4000);
    return;
  }
  if (!viewOrder) {
    const config = vscode.workspace.getConfiguration('scm');
    viewOrder = argument?.viewOrder || {
      mode: config.get('defaultViewMode', 'tree'),
      sortKey: config.get('defaultViewSortKey', 'path')
    };
  }
  if (!repository || argument?.source === 'browse') {
    await openFirstChange(vscode, api, viewOrder, argument?.source === 'browse' ? undefined : repository, undefined, navigation);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const editorMatchesTab = editor && (input instanceof vscode.TabInputTextDiff
    ? sameUri(editor.document.uri, input.original) || sameUri(editor.document.uri, input.modified)
    : sameUri(editor.document.uri, input?.uri || uri));
  const fromResource = Boolean(argument?.resourceUri) || argument?.source === 'scm';
  const selection = !fromResource && editorMatchesTab && (!explicit || sameUri(workingUri(vscode, explicit), activeUri(vscode)))
    && editor.selections.some(range => !range.isEmpty);
  if (selection && editor.document.uri.scheme !== 'file') {
    // Never turn an unsupported selection into a whole-file stage.
    vscode.window.showInformationMessage('Stage and Next: Select changes in the modified (right-hand) editor to stage ranges.');
    return;
  }

  // Save only this file, including when its dirty editor is not currently visible.
  const document = vscode.workspace.textDocuments.find(doc => sameUri(doc.uri, uri));
  if (!selection && document?.isDirty && !await document.save()) return;
  await repository.status();
  const mode = vscode.workspace.getConfiguration('git', repository.rootUri).get('untrackedChanges', 'mixed');
  const before = unstagedChanges(repository, mode, viewOrder);
  const change = before.find(item => sameUri(item.uri, uri));
  if (!change && !(selection && document?.isDirty)) {
    const conflicted = repository.state.mergeChanges.some(item => sameUri(item.uri, uri));
    if (conflicted) {
      vscode.window.setStatusBarMessage('Stage and Next: Resolve and stage merge conflicts with VS Code’s Git actions.', 5000);
    } else if (explicit) {
      vscode.window.setStatusBarMessage('Stage and Next: This file has no unstaged changes.', 5000);
    } else {
      await openFirstChange(vscode, api, viewOrder, repository, repository, navigation);
    }
    return;
  }
  if (selection) {
    const source = await navigation?.rememberSource(uri);
    try {
      await vscode.commands.executeCommand('git.stageSelectedRanges');
    } finally {
      await navigation?.restoreSource(source);
    }
    return;
  }

  const source = await navigation?.rememberSource(change.uri);
  let staged = false;
  try {
    await repository.add([change.uri.fsPath]);
    await repository.status();
    staged = true;
  } finally {
    if (!staged) await navigation?.restoreSource(source);
  }
  const remaining = unstagedChanges(repository, mode, viewOrder);
  if (remaining.some(item => sameUri(item.uri, change.uri))) {
    await navigation?.restoreSource(source);
    vscode.window.setStatusBarMessage('Stage and Next: The file still has unstaged changes; staying on this file.', 5000);
    return;
  }
  await navigation?.showStagedChange(source, repository, change.uri);
  const next = nextChange(before, remaining, change.uri);
  if (next) {
    await openChange(vscode, next, navigation);
  } else {
    vscode.window.setStatusBarMessage(`Stage and Next: Staged ${path.basename(change.uri.fsPath)}. No unstaged files remain in this repository.`, 5000);
  }
}

module.exports = { sameUri, workingUri, unstagedChanges, nextChange, activeUri, stageAndNext };
