'use strict';

const { sameUri } = require('./review.cjs');

/** Distinguish review-opened plain tabs from ordinary document editing. */
function createReviewContext(vscode, context) {
  const reviewTabs = new WeakSet();
  let previous;
  let disposed = false;
  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

  async function update() {
    const tab = activeTab();
    const enabled = !disposed && tab?.input instanceof vscode.TabInputText && reviewTabs.has(tab);
    if (enabled === previous) return;
    previous = enabled;
    await vscode.commands.executeCommand('setContext', 'stageAndNext.reviewEditor', enabled);
  }

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
    vscode.window.onDidChangeActiveTextEditor(update),
    { dispose() { disposed = true; void update(); } }
  );
  void update();

  return {
    async markActiveEditor(expectedUri) {
      const tab = activeTab();
      if (tab?.input instanceof vscode.TabInputText
          && (!expectedUri || sameUri(tab.input.uri, expectedUri))) {
        reviewTabs.add(tab);
      }
      await update();
    }
  };
}

module.exports = { createReviewContext };
