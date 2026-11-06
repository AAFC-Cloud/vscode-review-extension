'use strict';

const vscode = require('vscode');
const { stageAndNext } = require('./review.cjs');
const { createReviewNavigation } = require('./navigation.cjs');
const { createReviewContext } = require('./review-context.cjs');
const markerUri = vscode.Uri.parse('stage-and-next:/Opening Source Control File');

/** Use the same translated tooltip labels as the built-in Git extension. */
async function gitStatusLabels() {
  for (const extension of vscode.extensions.all) {
    const localization = extension.packageJSON.contributes?.localizations
      ?.find(item => item.languageId === vscode.env.language);
    const translation = localization?.translations?.find(item => item.id === 'vscode.git');
    if (!translation) continue;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, translation.path));
      return JSON.parse(Buffer.from(bytes).toString('utf8')).contents?.bundle;
    } catch {
      // An unavailable language pack uses Git's original English labels.
    }
  }
  return undefined;
}

/**
 * There is no public API for the focused built-in SCM row. A temporary readonly
 * editor makes opening even an already-active file observable. preserveFocus
 * keeps the SCM list focused until list.select opens its focused row. A folder
 * or group cannot accidentally stage the previously active editor.
 */
async function openFocusedScmFile() {
  const marker = await vscode.workspace.openTextDocument(markerUri);
  await vscode.window.showTextDocument(marker, { preserveFocus: true, preview: false });
  const markerTab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === markerUri.toString());
  let subscription;
  let timer;
  try {
    const opened = new Promise(resolve => {
      const check = () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (tab && tab !== markerTab) resolve(true);
      };
      subscription = vscode.window.tabGroups.onDidChangeTabs(check);
      timer = setTimeout(() => resolve(false), 2500);
    });
    await vscode.commands.executeCommand('list.select');
    return await opened;
  } finally {
    clearTimeout(timer);
    subscription?.dispose();
    if (markerTab) await vscode.window.tabGroups.close(markerTab, true);
  }
}

function activate(context) {
  const reviewContext = createReviewContext(vscode, context);
  context.subscriptions.push(vscode.commands.registerCommand('review.toggleEnabled', async () => {
    const config = vscode.workspace.getConfiguration('stageAndNext');
    const enabled = !config.get('enabled', true);
    await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Stage and Next: ${enabled ? 'Enabled' : 'Disabled'}.`, 5000);
  }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('stage-and-next', {
    provideTextDocumentContent: () => ''
  }));
  let running = false;
  const run = async (argument, viewOrder = argument?.viewOrder) => {
    if (running || !vscode.workspace.getConfiguration('stageAndNext').get('enabled', true)) return;
    running = true;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      const git = extension && await extension.activate();
      if (!git?.enabled) {
        vscode.window.showInformationMessage('Stage and Next requires VS Code’s built-in Git extension to be enabled.');
        return;
      }
      if (argument?.source === 'scm' && !await openFocusedScmFile()) {
        argument = { ...argument, source: 'browse' };
      }
      if (!viewOrder) {
        const config = vscode.workspace.getConfiguration('scm');
        viewOrder = { mode: config.get('defaultViewMode', 'tree'), sortKey: config.get('defaultViewSortKey', 'path') };
      }
      if (viewOrder?.sortKey === 'status') {
        viewOrder = { ...viewOrder, statusLabels: await gitStatusLabels() };
      }
      const api = git.getAPI(1);
      await stageAndNext(vscode, api, argument, viewOrder, createReviewNavigation(vscode, api, reviewContext));
    } catch (error) {
      vscode.window.showErrorMessage(`Stage and Next: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('review.stageAndNext', argument => run(argument)));
  // Menu contributions cannot pass arguments. Their visibility conditions choose
  // the same live view order that the keyboard bindings pass to the main action.
  for (const order of ['name', 'path', 'status', 'tree']) {
    const viewOrder = { mode: order === 'tree' ? 'tree' : 'list', sortKey: order === 'tree' ? 'path' : order };
    context.subscriptions.push(vscode.commands.registerCommand(`review.stageAndNext.${order}`, argument => run(argument, viewOrder)));
  }
}

module.exports = { activate };
