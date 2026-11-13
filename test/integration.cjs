// Invoked by VS Code's extension test runner, not by node --test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const command = 'review.stageAndNext';
const toggleCommand = 'review.toggleEnabled';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new Error(message);
}

async function run() {
  const workspace = process.env.STAGE_AND_NEXT_TEST_WORKSPACE;
  const resultPath = process.env.STAGE_AND_NEXT_TEST_RESULTS;
  assert.ok(workspace && resultPath, 'Use scripts/test-integration.cjs to create an isolated test workspace.');
  const expectedParent = path.resolve(__dirname, '..', '.test-output');
  const canonical = value => fs.realpathSync.native(value).toLowerCase();
  assert.ok(canonical(workspace).startsWith(canonical(expectedParent) + path.sep), 'Tests require an owned .test-output fixture.');
  assert.equal(canonical(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath), canonical(workspace));

  const checks = [];
  let keyboardSequence = 0;
  async function nativeKeyboard(type = 'shortcut') {
    const keyboard = process.env.STAGE_AND_NEXT_TEST_KEYBOARD;
    assert.ok(keyboard, 'The native test launcher provides keyboard access.');
    const id = ++keyboardSequence;
    fs.writeFileSync(`${keyboard}.request.json`, JSON.stringify({ id, type }));
    let response;
    await until(() => {
      try { response = JSON.parse(fs.readFileSync(`${keyboard}.response.json`, 'utf8')); } catch { return false; }
      return response.id === id;
    }, 'The native keyboard driver did not respond.');
    assert.ok(response.ok, response.error);
    return response.focus;
  }
  const report = (ok, error) => fs.writeFileSync(resultPath, JSON.stringify({ ok, checks, error }, null, 2));
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
  const uri = name => vscode.Uri.file(path.join(workspace, name));
  const write = (name, text) => fs.writeFileSync(path.join(workspace, name), text);
  const relativeName = filename => filename ? path.relative(workspace, filename).split(path.sep).join('/') : '';
  const activeName = () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputTextDiff) return relativeName(tab.input.modified.fsPath);
    return relativeName(vscode.window.activeTextEditor?.document.uri.fsPath);
  };

  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExtension, 'The built-in Git extension is installed.');
    const gitAPI = (await gitExtension.activate()).getAPI(1);
    await until(() => gitAPI.repositories.some(repository =>
      canonical(repository.rootUri.fsPath) === canonical(workspace)), 'Built-in Git did not open the fixture repository.');
    const repository = gitAPI.repositories.find(repository =>
      canonical(repository.rootUri.fsPath) === canonical(workspace));
    const extension = vscode.extensions.getExtension('review-tools.stage-and-next');
    assert.ok(extension, 'Stage and Next extension is available.');
    await extension.activate();
    assert.ok((await vscode.commands.getCommands()).includes(command), 'Review command is registered.');
    assert.ok((await vscode.commands.getCommands()).includes(toggleCommand), 'The escape-hatch toggle command is registered.');
    assert.equal(vscode.workspace.getConfiguration('stageAndNext').inspect('enabled').defaultValue, true,
      'The extension is enabled by default.');
    // Keep normal desktop typing out of the disposable workbench. CDP still
    // dispatches shortcuts to its focused editor or list while minimized.
    await nativeKeyboard('minimize');

    async function openDiff(name) {
      await repository.status();
      await vscode.commands.executeCommand('git.openChange', uri(name));
      await until(() => activeName() === name, `Diff did not open for ${name}.`);
      assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputTextDiff,
        `${name} opens as a Git diff.`);
      await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'file' &&
        relativeName(vscode.window.activeTextEditor.document.uri.fsPath) === name,
      `The modified side of ${name} did not become active.`);
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      // Editor API activation precedes renderer focus and its context keys.
      await pause(150);
      return editor;
    }

    async function expectNext(name) {
      await until(() => activeName() === name, `Command did not focus ${name}.`);
      assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputTextDiff,
        `Next file ${name} opens as a diff.`);
      await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'file' &&
        relativeName(vscode.window.activeTextEditor.document.uri.fsPath) === name,
      `The modified side of ${name} did not become active.`);
      // Tab activation precedes renderer focus; allow it to finish before a
      // subsequent synthetic keystroke, as a user would when reviewing the diff.
      await pause(150);
    }

    async function expectDeleted(name) {
      await until(() => activeName() === name && vscode.window.activeTextEditor?.document.uri.scheme === 'git',
        `The deleted file ${name} did not open as a Git document.`);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab.input instanceof vscode.TabInputText, 'Git opens deleted files as standalone readonly text documents.');
      assert.equal(JSON.parse(tab.input.uri.query).ref, 'HEAD');
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await pause(150);
      return editor;
    }

    async function expectNoReadonlyMessage() {
      const focus = await nativeKeyboard('inspect');
      assert.ok(!focus.editorMessages.some(message => /read.only/i.test(message)),
        'The review shortcut must not fall through to a readonly-editor typing message.');
    }

    async function expectStaged(name, tab = undefined) {
      if (!tab) {
        await until(() => {
          const active = vscode.window.tabGroups.activeTabGroup.activeTab;
          return activeName() === name && active?.input instanceof vscode.TabInputTextDiff &&
            active.input.modified.scheme === 'git';
        }, `The staged diff did not become active for ${name}.`);
        tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      }
      assert.ok(tab.input instanceof vscode.TabInputTextDiff, `${name} opens as a staged Git diff.`);
      const { original, modified } = tab.input;
      assert.equal(relativeName(original.fsPath), name);
      assert.equal(relativeName(modified.fsPath), name);
      assert.equal(original.scheme, 'git', 'The staged comparison reads the committed version.');
      assert.equal(JSON.parse(original.query).ref, 'HEAD', 'The original side of a reviewed file is HEAD.');
      assert.equal(modified.scheme, 'git', 'The reviewed side reads the Git index instead of the working file.');
      assert.equal(JSON.parse(modified.query).ref, '', 'The modified side of a reviewed file is the index.');
      const [originalDocument, modifiedDocument] = await Promise.all([
        vscode.workspace.openTextDocument(original),
        vscode.workspace.openTextDocument(modified),
      ]);
      const committedContent = git('show', `HEAD:${name}`);
      const stagedContent = git('show', `:${name}`);
      // Git's virtual document provider updates asynchronously, including when
      // an earlier fixture loaded the same index URI before a subsequent reset.
      await until(() => originalDocument.getText() === committedContent && modifiedDocument.getText() === stagedContent,
        `The HEAD/index document content did not refresh for ${name}.`);
      assert.equal(originalDocument.getText(), committedContent);
      assert.equal(modifiedDocument.getText(), stagedContent);
      assert.equal(modifiedDocument.getText(), `${name} changed\n`, 'The staged diff contains the reviewed changes.');
      assert.notEqual(originalDocument.getText(), modifiedDocument.getText(),
        'Going back shows highlighted changes rather than the now-empty working-tree comparison.');
      assert.equal(tab.isPreview, false, `The staged diff ${name} is pinned.`);
      if (tab === vscode.window.tabGroups.activeTabGroup.activeTab) await pause(150);
    }

    // Start review from an ordinary Git deletion, before any tab has been
    // marked by this extension. This matches opening a deleted SCM file directly.
    write('b-next.txt', 'next changed\n');
    fs.unlinkSync(uri('d-deleted.txt').fsPath);
    await repository.status();
    await vscode.commands.executeCommand('git.openChange', uri('d-deleted.txt'));
    const directDeleted = await expectDeleted('d-deleted.txt');
    const directDeletedContent = directDeleted.document.getText();
    await nativeKeyboard('backtick');
    await expectNext('b-next.txt');
    assert.equal(git('diff', '--cached', '--name-status', '--', 'd-deleted.txt').trim(), 'D\td-deleted.txt');
    assert.equal(fs.existsSync(uri('d-deleted.txt').fsPath), false, 'Staging a deletion never recreates the working file.');
    assert.equal(directDeleted.document.getText(), directDeletedContent, 'The readonly document is never modified.');
    await expectNoReadonlyMessage();
    checks.push('A backtick in a directly opened readonly deleted file stages its deletion and advances without a readonly message');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    git('reset', '--hard', 'HEAD');

    write('a-whole.txt', 'whole changed\n');
    write('b-next.txt', 'next changed\n');
    await openDiff('a-whole.txt');
    await vscode.commands.executeCommand(command);
    assert.equal(git('show', ':a-whole.txt'), 'whole changed\n', 'Empty selection stages the complete active file.');
    assert.equal(git('diff', '--', 'a-whole.txt'), '');
    await expectNext('b-next.txt');
    assert.equal(git('diff', '--cached', '--', 'b-next.txt'), '', 'Advancing leaves the next file unstaged.');
    checks.push('Empty diff selection stages only the active file and opens the next unstaged diff');

    const originalPartial = git('show', 'HEAD:c-partial.txt');
    const partialLines = originalPartial.trimEnd().split('\n');
    partialLines[1] = 'selected change';
    partialLines[21] = 'unselected change';
    const partialContent = partialLines.join('\n') + '\n';
    write('c-partial.txt', partialContent);
    const partialEditor = await openDiff('c-partial.txt');
    partialEditor.selection = new vscode.Selection(1, 0, 1, partialLines[1].length);
    // Native Git's diff information arrives asynchronously after the editor opens.
    // Retry only while Git reports no staged change; never accept a broader stage.
    for (let attempt = 0; attempt < 8; attempt++) {
      await pause(500);
      await vscode.commands.executeCommand(command);
      await repository.status();
      if (git('diff', '--cached', '--', 'c-partial.txt')) break;
    }
    const selectedIndex = git('show', ':c-partial.txt');
    assert.ok(selectedIndex.includes('selected change\n'), 'Selected line is staged.');
    assert.ok(!selectedIndex.includes('unselected change'), 'Unselected hunk remains out of the index.');
    assert.ok(git('diff', '--', 'c-partial.txt').includes('unselected change'));
    assert.equal(activeName(), 'c-partial.txt', 'Range staging stays on the current diff.');
    assert.equal(fs.readFileSync(uri('c-partial.txt').fsPath, 'utf8'), partialContent, 'Range staging preserves the working file.');
    checks.push('Nonempty diff selection stages its lines while leaving the other hunk unstaged');

    partialEditor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand(command);
    assert.equal(git('show', ':c-partial.txt'), partialContent, 'Empty selection stages the rest of a partially staged file.');
    assert.equal(git('diff', '--', 'c-partial.txt'), '');
    await expectNext('b-next.txt');
    checks.push('A partially staged file can subsequently be staged in full and advance');

    write('e-untracked.txt', 'new file content\n');
    await repository.status();
    // Native Git opens untracked files as ordinary editors rather than diffs.
    await vscode.commands.executeCommand('git.openChange', uri('e-untracked.txt'));
    await until(() => activeName() === 'e-untracked.txt', 'Untracked file did not open.');
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand(command);
    assert.equal(git('show', ':e-untracked.txt'), 'new file content\n');
    await expectNext('b-next.txt');
    checks.push('Untracked files are added to the index and navigation continues');

    await vscode.window.showTextDocument(uri('b-next.txt'));
    const plainEditor = vscode.window.activeTextEditor;
    plainEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand(command);
    assert.equal(git('show', ':b-next.txt'), 'next changed\n');
    await repository.status();
    assert.equal(repository.state.workingTreeChanges.length + repository.state.untrackedChanges.length, 0);
    checks.push('A plain text editor stages its file and handles an empty remaining Changes list');

    for (const closeDiffOnOperation of [false, true]) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      git('reset', '--hard', 'HEAD');
      await vscode.workspace.getConfiguration('git').update('closeDiffOnOperation', closeDiffOnOperation,
        vscode.ConfigurationTarget.Global);
      write('a-whole.txt', 'whole changed\n');
      fs.unlinkSync(uri('b-next.txt').fsPath);
      write('d-deleted.txt', 'successor changed\n');
      await repository.status();
      await setListSort('name');
      await openDiff('a-whole.txt');
      await nativeKeyboard('backtick');
      const reviewedDeletion = await expectDeleted('b-next.txt');
      assert.equal(git('diff', '--cached', '--name-only').trim(), 'a-whole.txt');
      const deletedContent = reviewedDeletion.document.getText();
      await nativeKeyboard('backtick');
      await expectNext('d-deleted.txt');
      assert.equal(git('diff', '--cached', '--name-status', '--', 'b-next.txt').trim(), 'D\tb-next.txt');
      assert.equal(git('diff', '--cached', '--', 'd-deleted.txt'), '', 'The visible successor stays unstaged.');
      assert.equal(fs.existsSync(uri('b-next.txt').fsPath), false);
      assert.equal(reviewedDeletion.document.getText(), deletedContent);
      await expectNoReadonlyMessage();
      checks.push(`Consecutive backticks stage a modified file then a deleted file and open its visible successor with git.closeDiffOnOperation=${closeDiffOnOperation}`);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    git('reset', '--hard', 'HEAD');
    await vscode.workspace.getConfiguration('git').update('closeDiffOnOperation', false,
      vscode.ConfigurationTarget.Global);

    async function scmFixture() {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // The canonical path guard above ensures this is the disposable fixture only.
      git('reset', '--hard', 'HEAD');
      write('a-whole.txt', 'whole changed\n');
      write('b-next.txt', 'next changed\n');
      await repository.status();
      // The SCM tree consumes resource-state updates after Git's API resolves.
      await pause(600);
      return openDiff('a-whole.txt');
    }

    async function focusScmRow(offset, filename) {
      await vscode.commands.executeCommand('workbench.view.scm');
      await pause(500);
      await vscode.commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
      // The command queues its focus change after opening the view.
      await until(async () => (await nativeKeyboard('inspect')).row === 'Changes',
        'The SCM Changes group did not become focused.');
      const groupFocus = await nativeKeyboard('refocus');
      if (offset > 0 && groupFocus.expanded === 'false') {
        // The group can retain a collapsed state after its last file was staged.
        await vscode.commands.executeCommand('list.expand');
        await pause(100);
      }
      for (let index = 0; index < offset; index++) {
        await vscode.commands.executeCommand('list.focusDown');
      }
      await pause(100);
      const focus = await nativeKeyboard('inspect');
      assert.equal(focus.row?.split(',')[0], filename || 'Changes', 'The intended SCM row is focused.');
    }

    async function orderingFixture() {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      git('reset', '--hard', 'HEAD');
      for (const name of ['alpha/z-last.txt', 'beta/m-middle.txt', 'omega/a-first.txt']) {
        write(name, `${name} changed\n`);
      }
      await repository.status();
      await pause(600);
    }

    async function setListSort(key) {
      await vscode.commands.executeCommand('workbench.view.scm');
      await vscode.commands.executeCommand('workbench.scm.action.setListViewMode');
      await vscode.commands.executeCommand(`workbench.scm.action.setSortKey.${key}`);
      await pause(300);
    }

    async function expectUntrackedReview(name) {
      await until(() => activeName() === name, `Review did not open untracked file ${name}.`);
      await until(() => vscode.window.activeTextEditor?.document.uri.scheme === 'file' &&
        relativeName(vscode.window.activeTextEditor.document.uri.fsPath) === name,
      `The editable side of untracked file ${name} did not become active.`);
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      // The editable control receives keyboard focus after tab activation.
      await pause(150);
      return editor;
    }

    const firstNew = 'ab-new-review.md';
    const secondNew = 'zz-new-review.md';
    const firstNewContent = '# Untracked first\nNew review content.\n';
    const secondNewContent = '# Untracked second\nLast review content.\n';
    for (const untrackedMode of ['mixed', 'separate']) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      git('reset', '--hard', 'HEAD');
      await vscode.workspace.getConfiguration('git').update('untrackedChanges', untrackedMode,
        vscode.ConfigurationTarget.Global);
      write('a-whole.txt', 'whole changed\n');
      write('b-next.txt', 'next changed\n');
      write(firstNew, firstNewContent);
      write(secondNew, secondNewContent);
      await repository.status();
      await setListSort('name');
      // Separate mode lists untracked resources after the tracked Changes group.
      const trackedStart = untrackedMode === 'mixed' ? 'a-whole.txt' : 'b-next.txt';
      await openDiff(trackedStart);
      await nativeKeyboard('backtick');
      const newEditor = await expectUntrackedReview(firstNew);
      assert.equal(newEditor.document.getText(), firstNewContent);
      await nativeKeyboard('backtick');
      if (untrackedMode === 'mixed') await expectNext('b-next.txt');
      else await expectUntrackedReview(secondNew);
      assert.equal(git('show', `:${firstNew}`), firstNewContent,
        'The printable shortcut stages the entire untracked Markdown file without inserting a character.');
      assert.equal(fs.readFileSync(uri(firstNew).fsPath, 'utf8'), firstNewContent,
        'Reviewing an untracked file leaves its working content unchanged.');
      await nativeKeyboard('back');
      await until(() => activeName() === firstNew && vscode.window.activeTextEditor?.document.uri.scheme === 'git',
        'Mouse Back did not return to the newly staged file.');
      assert.equal(JSON.parse(vscode.window.activeTextEditor.document.uri.query).ref, '');
      assert.equal(vscode.window.activeTextEditor.document.getText(), firstNewContent,
        'History retains the exact staged version of the newly added file.');
      await nativeKeyboard('forward');
      if (untrackedMode === 'mixed') await expectNext('b-next.txt');
      else await expectUntrackedReview(secondNew);
      checks.push(`The printable shortcut stages tracked then untracked Markdown and opens the visible successor with git.untrackedChanges=${untrackedMode}`);

      // Finish the disposable additions before reset so the next fixture has no
      // leftover untracked resources influencing visible navigation order.
      git('add', '--', firstNew, secondNew);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      git('reset', '--hard', 'HEAD');
      write(firstNew, firstNewContent);
      write(secondNew, secondNewContent);
      await repository.status();
      await setListSort('name');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, 0);
      await nativeKeyboard('backtick');
      await expectUntrackedReview(firstNew);
      assert.equal(git('diff', '--cached'), '', 'Browsing from no editor leaves every new file unstaged.');
      await nativeKeyboard('backtick');
      const lastNewEditor = await expectUntrackedReview(secondNew);
      assert.equal(git('show', `:${firstNew}`), firstNewContent);
      assert.equal(fs.readFileSync(uri(firstNew).fsPath, 'utf8'), firstNewContent);
      checks.push(`An untracked-only Changes list can be entered and advanced with printable shortcuts with git.untrackedChanges=${untrackedMode}`);

      await vscode.commands.executeCommand(toggleCommand);
      await nativeKeyboard('backtick');
      await until(() => lastNewEditor.document.getText() === '`' + secondNewContent,
        'Disabling review did not release typing in the untracked review editor.');
      assert.equal(activeName(), secondNew);
      assert.equal(git('diff', '--cached', '--name-only').trim(), firstNew,
        'Typing with review disabled does not stage the second untracked file.');
      await lastNewEditor.document.save();
      await vscode.commands.executeCommand(toggleCommand);
      await nativeKeyboard('backtick');
      await until(() => git('diff', '--cached', '--name-only').trim().split('\n').length === 2,
        'Re-enabling review did not stage the final untracked file.');
      assert.equal(git('show', `:${secondNew}`), '`' + secondNewContent,
        'Re-enabling stages exactly the intentionally edited untracked content.');
      assert.equal(fs.readFileSync(uri(secondNew).fsPath, 'utf8'), '`' + secondNewContent);
      await repository.status();
      assert.equal(repository.state.workingTreeChanges.length + repository.state.untrackedChanges.length, 0);
      // Git updates the index before review replaces the final working editor
      // with its staged version. Let navigation finish before resetting tabs.
      await until(() => activeName() === secondNew && vscode.window.activeTextEditor?.document.uri.scheme === 'git',
        'The final untracked file did not open in its staged index view.');
      assert.equal(JSON.parse(vscode.window.activeTextEditor.document.uri.query).ref, '');
      await pause(150);
      checks.push(`The toggle releases typing in an untracked review editor and restores staging with git.untrackedChanges=${untrackedMode}`);
    }
    await vscode.workspace.getConfiguration('git').update('untrackedChanges', 'mixed',
      vscode.ConfigurationTarget.Global);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    git('reset', '--hard', 'HEAD');
    const ordinaryNew = 'ordinary-new-notes.md';
    const ordinaryNewContent = '# Manually opened notes\n';
    write(ordinaryNew, ordinaryNewContent);
    await repository.status();
    const ordinaryNewEditor = await vscode.window.showTextDocument(uri(ordinaryNew));
    ordinaryNewEditor.selection = new vscode.Selection(1, 0, 1, 0);
    await pause(150);
    await nativeKeyboard('backtick');
    await until(() => ordinaryNewEditor.document.getText() === ordinaryNewContent + '`',
      'The review shortcut intercepted a manually opened untracked Markdown editor.');
    assert.equal(activeName(), ordinaryNew);
    assert.equal(git('diff', '--cached'), '', 'Manual untracked Markdown typing leaves the index untouched.');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.unlinkSync(uri(ordinaryNew).fsPath);
    checks.push('An untracked Markdown file opened manually still accepts a literal backtick without staging');

    await orderingFixture();
    await setListSort('name');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    assert.equal(vscode.window.activeTextEditor, undefined, 'The empty editor area has no active document.');
    assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, 0);
    await nativeKeyboard();
    await expectNext('omega/a-first.txt');
    assert.equal(git('diff', '--cached'), '', 'Opening the first change from an empty editor area does not stage anything.');
    checks.push('The shortcut from an empty editor area opens the first change in live name order without staging');

    await orderingFixture();
    await setListSort('name');
    const cleanEditor = await vscode.window.showTextDocument(uri('c-partial.txt'));
    cleanEditor.selection = new vscode.Selection(0, 0, 0, 5);
    await nativeKeyboard();
    await pause(300);
    assert.equal(activeName(), 'c-partial.txt', 'The keyboard shortcut leaves an ordinary text editor focused.');
    assert.equal(git('diff', '--cached'), '', 'Typing in an unchanged document does not stage another file.');
    checks.push('The review shortcut does not navigate or stage from an ordinary text editor');
    // The palette selects this wrapper from the live SCM view/sort context.
    await vscode.commands.executeCommand(`${command}.name`);
    await expectNext('omega/a-first.txt');
    assert.equal(git('diff', '--cached'), '', 'A selection in an unchanged document does not stage another file.');
    checks.push('The explicit command from an unchanged document can still open the first change without staging');

    await orderingFixture();
    await setListSort('name');
    const markdownEditor = await vscode.window.showTextDocument(uri('notes.md'));
    const markdownBefore = markdownEditor.document.getText();
    markdownEditor.selection = new vscode.Selection(1, 0, 1, 0);
    await pause(150);
    await nativeKeyboard('backtick');
    await until(() => markdownEditor.document.getText() === markdownBefore + '`',
      'The printable review shortcut was intercepted while typing ordinary Markdown.');
    assert.equal(activeName(), 'notes.md', 'Typing a backtick keeps the Markdown editor focused.');
    assert.equal(git('diff', '--cached'), '', 'Typing Markdown leaves the index untouched.');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    checks.push('A user backtick binding inserts a literal character in Markdown without staging or navigating');

    await orderingFixture();
    await setListSort('name');
    const disabledEditor = await openDiff('omega/a-first.txt');
    const diffBefore = disabledEditor.document.getText();
    await vscode.commands.executeCommand(toggleCommand);
    const disabledSetting = vscode.workspace.getConfiguration('stageAndNext').inspect('enabled');
    assert.equal(disabledSetting.globalValue, false, 'The toggle persists its disabled state in the user profile.');
    assert.equal(vscode.workspace.getConfiguration('stageAndNext').get('enabled'), false);
    await nativeKeyboard('backtick');
    await until(() => disabledEditor.document.getText() === '`' + diffBefore,
      'Disabling the extension did not release its printable shortcut in the diff editor.');
    await vscode.commands.executeCommand(command);
    assert.equal(activeName(), 'omega/a-first.txt', 'The disabled command does not advance.');
    assert.equal(git('diff', '--cached'), '', 'The disabled command does not stage.');
    assert.equal(disabledEditor.document.getText(), '`' + diffBefore);
    await disabledEditor.document.save();
    checks.push('The toggle command persists disabling and releases backtick typing even in a diff');
    await vscode.commands.executeCommand(toggleCommand);
    assert.equal(vscode.workspace.getConfiguration('stageAndNext').inspect('enabled').globalValue, true,
      'The toggle persists its enabled state in the user profile.');
    await nativeKeyboard('backtick');
    await expectNext('beta/m-middle.txt');
    assert.equal(git('show', ':omega/a-first.txt'), '`' + diffBefore,
      'Re-enabling restores staging through the printable shortcut.');
    checks.push('Re-enabling restores the review shortcut without reloading the extension');

    await orderingFixture();
    await setListSort('name');
    await openDiff('alpha/z-last.txt');
    await nativeKeyboard();
    await expectNext('beta/m-middle.txt');
    assert.equal(git('diff', '--cached', '--name-only').trim(), 'alpha/z-last.txt');
    assert.equal(git('diff', '--', 'alpha/z-last.txt'), '');
    checks.push('Staging the last displayed change opens the new last change rather than wrapping to the first');
    await nativeKeyboard();
    await expectNext('omega/a-first.txt');
    assert.deepEqual(git('diff', '--cached', '--name-only').trim().split('\n'),
      ['alpha/z-last.txt', 'beta/m-middle.txt']);
    assert.equal(git('diff', '--cached', '--', 'omega/a-first.txt'), '');
    checks.push('Repeated staging from the end continues backward through the remaining visible changes');

    for (const closeDiffOnOperation of [false, true]) {
      await vscode.workspace.getConfiguration('git').update('closeDiffOnOperation', closeDiffOnOperation,
        vscode.ConfigurationTarget.Global);
      await orderingFixture();
      await setListSort('name');
      await vscode.commands.executeCommand('workbench.action.clearEditorHistoryWithoutConfirm');
      await openDiff('omega/a-first.txt');
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.isPreview, true,
        'History starts from an ordinary Git preview diff.');
      await nativeKeyboard();
      await expectNext('beta/m-middle.txt');
      await nativeKeyboard();
      await expectNext('alpha/z-last.txt');
      assert.deepEqual(git('diff', '--cached', '--name-only').trim().split('\n'),
        ['beta/m-middle.txt', 'omega/a-first.txt']);
      for (const name of ['omega/a-first.txt', 'beta/m-middle.txt']) {
        const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
          tab.input instanceof vscode.TabInputTextDiff && relativeName(tab.input.modified.fsPath) === name);
        assert.ok(tab, `The staged diff ${name} remains open.`);
        await expectStaged(name, tab);
      }
      const current = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.equal(current.input.modified.scheme, 'file', 'The next unstaged comparison still reads the working file.');
      assert.equal(current.isPreview, false, 'The next unstaged diff is pinned.');
      for (const [direction, name] of [
        ['back', 'beta/m-middle.txt'],
        ['back', 'omega/a-first.txt'],
        ['forward', 'beta/m-middle.txt'],
        ['forward', 'alpha/z-last.txt'],
      ]) {
        await nativeKeyboard(direction);
        if (name === 'alpha/z-last.txt') await expectNext(name);
        else await expectStaged(name);
      }
      checks.push(`Native mouse Back and Forward revisit HEAD-to-index diffs containing reviewed changes with git.closeDiffOnOperation=${closeDiffOnOperation}`);
      await nativeKeyboard();
      await expectStaged('alpha/z-last.txt');
      assert.equal(git('diff'), '', 'Staging the final change leaves no unstaged files.');
      assert.equal(repository.state.workingTreeChanges.length + repository.state.untrackedChanges.length, 0);
      checks.push(`Staging the final file leaves its staged diff visible with git.closeDiffOnOperation=${closeDiffOnOperation}`);
    }
    await vscode.workspace.getConfiguration('git').update('closeDiffOnOperation', false,
      vscode.ConfigurationTarget.Global);

    await scmFixture();
    await focusScmRow(1, 'a-whole.txt');
    await vscode.commands.executeCommand(command, { source: 'scm' });
    assert.equal(git('show', ':a-whole.txt'), 'whole changed\n', `The SCM row stages even when its editor was already active (active: ${activeName()}).`);
    assert.equal(git('diff', '--cached', '--', 'b-next.txt'), '');
    await expectNext('b-next.txt');
    checks.push('The focused SCM file stages even when its diff was already active');

    const staleEditor = await scmFixture();
    staleEditor.selection = new vscode.Selection(0, 0, 0, 5);
    await focusScmRow(2, 'b-next.txt');
    await vscode.commands.executeCommand(command, { source: 'scm' });
    assert.equal(git('show', ':b-next.txt'), 'next changed\n', 'SCM file focus wins over a different active editor selection.');
    assert.equal(git('diff', '--cached', '--', 'a-whole.txt'), '');
    await expectNext('a-whole.txt');
    checks.push('A different focused SCM row stages its complete file despite a stale editor selection');

    await scmFixture();
    await focusScmRow(0);
    await vscode.commands.executeCommand(command, { source: 'scm' });
    assert.equal(git('diff', '--cached'), '', 'Invoking on a Changes group does not stage the previously active file.');
    checks.push('The SCM Changes header leaves the index untouched');

    await orderingFixture();
    // Keep the profile's default sort unchanged. The live toolbar selection
    // changes the visible order from z,m,a (path) to a,m,z (name).
    await setListSort('name');
    await openDiff('beta/m-middle.txt');
    await nativeKeyboard();
    await expectNext('alpha/z-last.txt');
    assert.equal(git('diff', '--cached', '--name-only').trim(), 'beta/m-middle.txt');
    checks.push('List name ordering advances by basename from an active nested diff');

    await orderingFixture();
    await setListSort('name');
    await openDiff('omega/a-first.txt');
    await focusScmRow(2, 'm-middle.txt');
    await nativeKeyboard();
    await expectNext('alpha/z-last.txt');
    assert.equal(git('diff', '--cached', '--name-only').trim(), 'beta/m-middle.txt');
    checks.push('List name ordering stages the focused SCM row and opens its visible successor');

    await orderingFixture();
    await setListSort('path');
    await openDiff('beta/m-middle.txt');
    await nativeKeyboard();
    await expectNext('omega/a-first.txt');
    checks.push('Switching the live toolbar to path order changes the next nested diff');

    await orderingFixture();
    write('b-next.txt', 'next changed\n');
    await repository.status();
    await vscode.commands.executeCommand('workbench.scm.action.setTreeViewMode');
    await pause(300);
    await openDiff('omega/a-first.txt');
    await vscode.commands.executeCommand(`${command}.tree`);
    await expectNext('b-next.txt');
    checks.push('Tree ordering visits folder contents before root files');

    report(true);
  } catch (error) {
    report(false, error.stack || String(error));
    throw error;
  }
}

module.exports = { run };
