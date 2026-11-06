'use strict';

const path = require('node:path');
const { activeUri, sameUri } = require('./review.cjs');

/** Preserve real editor inputs so VS Code's own Back/Forward history survives. */
function createReviewNavigation(vscode, api, reviewContext) {
  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

  async function keepActiveEditor() {
    if (activeTab()?.isPreview) {
      await vscode.commands.executeCommand('workbench.action.keepEditor');
    }
  }

  async function rememberSource(expectedUri) {
    const tab = activeTab();
    const input = tab?.input;
    if (!input || (expectedUri && !sameUri(activeUri(vscode), expectedUri))) return undefined;
    if (!(input instanceof vscode.TabInputTextDiff) && !(input instanceof vscode.TabInputText)) return undefined;
    const source = {
      tab,
      input,
      label: tab.label,
      viewColumn: vscode.window.tabGroups.activeTabGroup.viewColumn
    };
    await keepActiveEditor();
    return source;
  }

  async function restoreSource(source) {
    if (!source || activeTab() === source.tab) return;
    const options = { preview: false, viewColumn: source.viewColumn };
    if (source.input instanceof vscode.TabInputTextDiff) {
      await vscode.commands.executeCommand('vscode.diff', source.input.original, source.input.modified, source.label, options);
    } else {
      await vscode.commands.executeCommand('vscode.open', source.input.uri, options, source.label);
    }
    await reviewContext?.markActiveEditor(source.input instanceof vscode.TabInputTextDiff ? source.input.modified : source.input.uri);
  }

  async function closeSource(source, allowActive = false) {
    if (source && (allowActive || activeTab() !== source.tab) && vscode.window.tabGroups.all.some(group => group.tabs.includes(source.tab))) {
      await vscode.window.tabGroups.close(source.tab, true);
    }
  }

  /** Keep the staged comparison in history after the working-tree diff empties. */
  async function showStagedChange(source, repository, uri) {
    const changes = repository.state.indexChanges;
    const staged = changes.find(change => sameUri(change.uri, uri))
      || changes.find(change => sameUri(change.originalUri, uri) || sameUri(change.renameUri, uri));
    const options = { preview: false, viewColumn: source?.viewColumn };
    let reviewUri = uri;
    if (!staged) {
      // Staging a reversion can leave no index change. Its ordinary file remains
      // a useful history entry even though there is no staged diff to display.
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await closeSource(source, true);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', uri, options);
    } else {
      const name = path.basename(staged.uri.fsPath);
      if (staged.status === 2) {
        reviewUri = api.toGitUri(staged.uri, 'HEAD');
        await vscode.commands.executeCommand('vscode.open', reviewUri, options, `${name} (Deleted)`);
      } else if (staged.status === 1 || staged.status === 4) {
        reviewUri = api.toGitUri(staged.uri, '');
        await vscode.commands.executeCommand('vscode.open', reviewUri, options, `${name} (Index)`);
      } else {
        reviewUri = api.toGitUri(staged.uri, '');
        await vscode.commands.executeCommand('vscode.diff',
          api.toGitUri(staged.originalUri || staged.uri, 'HEAD'),
          reviewUri, `${name} (Index)`, options);
      }
    }
    await reviewContext?.markActiveEditor(reviewUri);
    // Open the replacement first so closing the old diff cannot activate an
    // unrelated editor and put it between reviewed files in native history.
    await closeSource(source);
  }

  async function openChange(change) {
    await rememberSource();
    await vscode.commands.executeCommand(change.status === 7 ? 'vscode.open' : 'git.openChange', change.uri);
    await keepActiveEditor();
    await reviewContext?.markActiveEditor(change.uri);
  }

  return { rememberSource, restoreSource, showStagedChange, openChange };
}

module.exports = { createReviewNavigation };
