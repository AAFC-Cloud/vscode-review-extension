'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { crc32, packageExtension } = require('../scripts/package.cjs');

function readEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
    const data = zlib.inflateRawSync(archive.subarray(dataOffset, dataOffset + compressedSize));
    assert.equal(data.length, archive.readUInt32LE(offset + 22));
    assert.equal(crc32(data), archive.readUInt32LE(offset + 14));
    entries.set(name, data);
    offset = dataOffset + compressedSize;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 12), entries.size);
  assert.equal(archive.readUInt32LE(archive.length - 6), offset);
  return entries;
}

test('offline VSIX contains only distribution files and is reproducible', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-and-next-package-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('stage-and-next-package-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'src'));
  const manifest = {
    name: 'stage-and-next', version: '0.1.0', publisher: 'review-tools',
    displayName: 'Stage & Next', description: 'Stage "this" <file>',
    engines: { vscode: '^1.96.0' }, main: './src/extension.cjs', icon: 'logo.png',
    extensionDependencies: ['vscode.git']
  };
  const files = {
    'package.json': JSON.stringify(manifest),
    'README.md': '# Stage and Next', 'README.fr_ca.md': '# Stage and Next — Français',
    'LICENSE.txt': 'MIT', 'LICENSE.fr_ca.txt': 'MIT — Français',
    'THIRD_PARTY_NOTICES.md': 'Third-party attribution', 'CHANGELOG.md': 'Initial release',
    'logo.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a23sAAAAASUVORK5CYII=', 'base64'),
    'src/extension.cjs': 'exports.activate = () => {};',
    'src/ignore.js': 'excluded', 'private.txt': 'excluded', 'LICENSE': 'excluded legacy filename'
  };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(root, name), data);
  fs.mkdirSync(path.join(root, 'src', 'nested'));
  fs.writeFileSync(path.join(root, 'src', 'nested', 'ignore.cjs'), 'excluded');

  const result = packageExtension(root);
  const archive = fs.readFileSync(result.output);
  const entries = readEntries(archive);
  assert.deepEqual([...entries.keys()], [
    '[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json',
    'extension/README.md', 'extension/README.fr_ca.md', 'extension/LICENSE.txt',
    'extension/LICENSE.fr_ca.txt', 'extension/THIRD_PARTY_NOTICES.md',
    'extension/CHANGELOG.md', 'extension/logo.png', 'extension/src/extension.cjs'
  ]);
  for (const [name, data] of Object.entries(files)) {
    if (entries.has('extension/' + name)) {
      assert.deepEqual(entries.get('extension/' + name), Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
  }
  assert.deepEqual(JSON.parse(entries.get('extension/package.json')), manifest);
  assert.match(entries.get('extension.vsixmanifest').toString(), /Stage &amp; Next/);
  assert.match(entries.get('extension.vsixmanifest').toString(), /Stage &quot;this&quot; &lt;file&gt;/);
  assert.match(entries.get('extension.vsixmanifest').toString(), /Microsoft\.VisualStudio\.Code\.ExtensionDependencies" Value="vscode.git"/);
  assert.match(entries.get('extension.vsixmanifest').toString(), /<License>extension\/LICENSE\.txt<\/License>/);
  assert.match(entries.get('extension.vsixmanifest').toString(), /Type="Microsoft\.VisualStudio\.Services\.Content\.License" Path="extension\/LICENSE\.txt"/);
  assert.match(entries.get('extension.vsixmanifest').toString(), /<Icon>extension\/logo\.png<\/Icon>/);
  assert.match(entries.get('extension.vsixmanifest').toString(), /Type="Microsoft\.VisualStudio\.Services\.Icons\.Default" Path="extension\/logo\.png"/);
  assert.match(entries.get('[Content_Types].xml').toString(), /Extension="txt" ContentType="text\/plain"/);
  assert.match(entries.get('[Content_Types].xml').toString(), /Extension="png" ContentType="image\/png"/);
  packageExtension(root);
  assert.deepEqual(fs.readFileSync(result.output), archive);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...manifest, icon: 'private.txt' }));
  assert.throws(() => packageExtension(root), /icon must point to the packaged logo\.png/);
});
