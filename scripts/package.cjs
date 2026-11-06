'use strict';

// Build an offline VSIX from an explicit list of distributable files.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) {
    checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const local = [];
  const directory = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names.
    header.writeUInt16LE(8, 8); // Deflate.
    header.writeUInt16LE(0x0021, 12); // 1980-01-01; reproducible, without local timestamps.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // ZIP 2.0, Unix file attributes.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }

  const directoryData = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryData, end]);
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function vsixManifest(manifest) {
  const properties = {
    'Microsoft.VisualStudio.Code.Engine': manifest.engines.vscode,
    'Microsoft.VisualStudio.Code.ExtensionDependencies': (manifest.extensionDependencies || []).join(','),
    'Microsoft.VisualStudio.Code.ExtensionKind': (manifest.extensionKind || ['workspace']).join(',')
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
    <DisplayName>${xml(manifest.displayName || manifest.name)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description || '')}</Description>
    <Tags>${xml((manifest.keywords || []).join(','))}</Tags>
    <Categories>${xml((manifest.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
${Object.entries(properties).map(([name, value]) => `      <Property Id="${xml(name)}" Value="${xml(value)}" />`).join('\n')}
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/logo.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/logo.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function packageExtension(root = path.resolve(__dirname, '..')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.name || '') ||
      !/^[a-z0-9][a-z0-9-]*$/i.test(manifest.publisher || '') ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version || '') ||
      typeof manifest.engines?.vscode !== 'string') {
    throw new Error('package.json must contain a valid name, publisher, version, and VS Code engine.');
  }

  const sourceFiles = fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.cjs'))
    .map(entry => 'src/' + entry.name).sort();
  const files = [
    'package.json', 'README.md', 'README.fr_ca.md', 'LICENSE.txt', 'LICENSE.fr_ca.txt',
    'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'logo.png', ...sourceFiles
  ];
  const main = String(manifest.main || '').replace(/^\.\//, '');
  if (!sourceFiles.includes(main)) {
    throw new Error('package.json main must point to a packaged src/*.cjs file.');
  }
  if (manifest.icon !== 'logo.png') {
    throw new Error('package.json icon must point to the packaged logo.png file.');
  }
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="cjs" ContentType="application/javascript" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
` },
    { name: 'extension.vsixmanifest', data: vsixManifest(manifest) },
    ...files.map(file => {
      const filename = path.join(root, file);
      if (!fs.lstatSync(filename).isFile()) {
        throw new Error(`Distribution file must be a regular file: ${file}`);
      }
      return { name: 'extension/' + file, data: fs.readFileSync(filename) };
    })
  ];
  const output = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, createZip(entries));
  return { output, files: entries.map(entry => entry.name) };
}

module.exports = { crc32, createZip, packageExtension };

if (require.main === module) {
  try {
    const result = packageExtension();
    console.log(`Packaged ${result.files.length} files into ${path.relative(process.cwd(), result.output)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
