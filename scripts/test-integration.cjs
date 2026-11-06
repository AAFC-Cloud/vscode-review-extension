// Runs the real extension host against an isolated, disposable Git repository.
// No package downloads or additional test dependencies are required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const executable = process.env.VS_CODE_EXE || path.join(
  process.env.LOCALAPPDATA || '',
  'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe',
);
assert.ok(fs.existsSync(executable), 'Set VS_CODE_EXE to a desktop VS Code executable.');

const output = path.join(root, '.test-output', `native-${Date.now()}`);
const workspace = path.join(output, 'workspace');
const profile = path.join(output, 'profile');
const extensions = path.join(output, 'extensions');
const results = path.join(output, 'results.json');
const keyboard = path.join(output, 'keyboard');
for (const folder of [workspace, path.join(profile, 'User'), extensions]) {
  fs.mkdirSync(folder, { recursive: true });
}

const env = { ...process.env };
for (const key of [
  'ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
]) delete env[key];
// Keep both fixture creation and the built-in Git extension independent of user config.
env.GIT_CONFIG_GLOBAL = path.join(output, 'gitconfig');
env.GIT_CONFIG_NOSYSTEM = '1';
env.STAGE_AND_NEXT_TEST_WORKSPACE = workspace;
env.STAGE_AND_NEXT_TEST_RESULTS = results;
env.STAGE_AND_NEXT_TEST_KEYBOARD = keyboard;
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');

function git(...args) {
  const result = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

fs.writeFileSync(path.join(workspace, 'a-whole.txt'), 'whole original\n');
fs.writeFileSync(path.join(workspace, 'b-next.txt'), 'next original\n');
fs.writeFileSync(path.join(workspace, 'c-partial.txt'),
  Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
fs.writeFileSync(path.join(workspace, 'd-deleted.txt'), 'delete this file\n');
fs.writeFileSync(path.join(workspace, 'notes.md'), '# Review notes\n');
for (const name of ['alpha/z-last.txt', 'beta/m-middle.txt', 'omega/a-first.txt']) {
  const filename = path.join(workspace, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${name} original\n`);
}
git('init', '--quiet');
git('config', 'user.name', 'Stage and Next Tests');
git('config', 'user.email', 'stage-and-next@example.invalid');
git('config', 'core.autocrlf', 'false');
git('config', 'core.hooksPath', path.join(output, 'empty-hooks'));
git('add', '--', '.');
git('-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Integration test baseline');

fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'files.autoSave': 'off',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'git.enabled': true,
  'git.autofetch': false,
  'git.confirmSync': false,
  'git.openRepositoryInParentFolders': 'never',
  'git.untrackedChanges': 'mixed',
  'git.openDiffOnClick': true,
  'git.closeDiffOnOperation': false,
  'scm.defaultViewMode': 'list',
  'scm.defaultViewSortKey': 'path',
  'diffEditor.renderSideBySide': true,
  'chat.disableAIFeatures': true,
}, null, 2));
// Reproduce a user's printable shortcut without reading or changing their
// profile. Keep every live SCM ordering condition from the shipped bindings.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const printableBindings = manifest.contributes.keybindings.map(({ mac, linux, win, ...binding }) =>
  ({ ...binding, key: '`' }));
fs.writeFileSync(path.join(profile, 'User', 'keybindings.json'), JSON.stringify(printableBindings, null, 2));

async function dispatchKeyboard(debugPort, type) {
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })).json();
  const page = pages.find(item => item.type === 'page' && item.url.includes('workbench'));
  assert.ok(page?.webSocketDebuggerUrl, 'The isolated workbench exposes its local debugger.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (type === 'refocus') {
      // A minimized workbench can retain its active DOM element while the list
      // service still remembers a different widget. Re-fire the focus events.
      await send('Runtime.evaluate', {
        expression: '(async () => { const element = document.activeElement; element?.blur(); await new Promise(resolve => setTimeout(resolve, 25)); element?.focus(); })()',
        awaitPromise: true,
      });
    }
    const inspection = await send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const element = document.activeElement;
        const focusedRow = document.getElementById(element?.getAttribute('aria-activedescendant'));
        return { element: element?.tagName, classes: element?.className,
          row: focusedRow?.getAttribute('aria-label') || focusedRow?.textContent,
          expanded: focusedRow?.getAttribute('aria-expanded') };
      })())`,
      returnByValue: true,
    });
    const focus = JSON.parse(inspection.result.value);
    if (type === 'shortcut') {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 3, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 3, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
    } else if (type === 'backtick') {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192,
        text: '`', unmodifiedText: '`',
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192 });
    } else if (type === 'back' || type === 'forward') {
      const position = await send('Runtime.evaluate', {
        expression: `JSON.stringify((() => {
          const bounds = document.querySelector('.editor-group-container.active').getBoundingClientRect();
          return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        })())`,
        returnByValue: true,
      });
      const point = JSON.parse(position.result.value);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', button: type, buttons: type === 'back' ? 8 : 16, clickCount: 1, ...point,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', button: type, buttons: 0, clickCount: 1, ...point,
      });
    }
    return focus;
  } finally {
    socket.close();
    for (const request of pending.values()) clearTimeout(request.timer);
  }
}

function launch(debugPort) {
  console.log(`Integration test artifacts: ${path.relative(root, output)}`);
  const child = spawn(executable, [
    '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-updates', '--disable-gpu',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--extensions-dir=${extensions}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'test', 'integration.cjs')}`,
    workspace,
  ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const log = fs.createWriteStream(path.join(output, 'vscode.log'));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let keyboardBusy = false;
  let lastKeyboardId;
  const keyboardPoll = setInterval(async () => {
    if (keyboardBusy) return;
    let request;
    try { request = JSON.parse(fs.readFileSync(`${keyboard}.request.json`, 'utf8')); } catch { return; }
    if (request.id === lastKeyboardId) return;
    keyboardBusy = true;
    lastKeyboardId = request.id;
    let response;
    try {
      const focus = await dispatchKeyboard(debugPort, request.type);
      if (request.type === 'minimize' && process.platform === 'win32') {
        // Electron may relaunch its bootstrap PID. Match only processes using
        // this harness's disposable user-data directory, and minimize if ready.
        const profileLiteral = profile.replaceAll("'", "''");
        spawnSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
          `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TestWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command); }'; $testProfile = '${profileLiteral}'; Get-CimInstance Win32_Process -Filter "Name = 'Code - Insiders.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $testProfile) } | ForEach-Object { $testProcess = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($testProcess.MainWindowHandle -ne 0) { [TestWindow]::ShowWindowAsync($testProcess.MainWindowHandle, 6) | Out-Null } }`,
        ], { windowsHide: true, encoding: 'utf8' });
      }
      console.log(`Native ${request.type} focus: ${JSON.stringify(focus)}`);
      response = { id: request.id, ok: true, focus };
    } catch (error) {
      response = { id: request.id, ok: false, error: error.stack || String(error) };
    }
    fs.writeFileSync(`${keyboard}.response.json`, JSON.stringify(response));
    keyboardBusy = false;
  }, 50);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error('Native integration tests timed out after 180 seconds.');
    if (process.platform === 'win32') {
      // The separate user-data directory makes this a process tree owned by this harness.
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else child.kill('SIGTERM');
  }, 180000);

  child.on('error', error => {
    clearTimeout(timeout);
    clearInterval(keyboardPoll);
    log.end();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    clearInterval(keyboardPoll);
    log.end();
    let report;
    try { report = JSON.parse(fs.readFileSync(results, 'utf8')); } catch {}
    for (const check of report?.checks || []) console.log(`PASS ${check}`);
    if (report?.error) console.error(report.error);
    if (timedOut || code !== 0 || !report?.ok) {
      console.error(`Integration test failed (exit ${code}, signal ${signal || 'none'}). See ${path.relative(root, output)}.`);
      process.exitCode = 1;
    } else console.log(`${report.checks.length} native integration checks passed.`);
  });
}

// Reserve a free loopback port before starting the isolated workbench.
const debugServer = net.createServer();
debugServer.on('error', error => { console.error(error); process.exitCode = 1; });
debugServer.listen(0, '127.0.0.1', () => {
  const debugPort = debugServer.address().port;
  debugServer.close(() => launch(debugPort));
});
