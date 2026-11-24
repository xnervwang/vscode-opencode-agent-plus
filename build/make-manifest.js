// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Writes extension.vsixmanifest and [Content_Types].xml into a staging folder, from the staged package.json, so the
 * identity and version in the package cannot drift from the manifest VS Code reads. [Content_Types].xml names a type
 * for every file extension in the tree, and one per file that has none (a package's LICENSE), as the Open Packaging
 * Conventions zip format asks.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TYPES = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.cjs': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png',
  '.py': 'text/x-python', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.yml': 'text/yaml', '.yaml': 'text/yaml',
};

function write(stageDir) {
  const ext = path.join(stageDir, 'extension');
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else files.push(path.relative(stageDir, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walk(ext);
  const icon = pkg.icon ? `extension/${pkg.icon}` : '';
  const missing = ['extension/LICENSE.txt', 'extension/README.md', icon].filter((f) => f && !files.includes(f));
  if (missing.length) throw new Error(`the manifest names files the package does not hold: ${missing.join(', ')}`);

  const vsix = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${esc((pkg.extensionDependencies || []).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
${icon ? `    <Icon>${esc(icon)}</Icon>\n` : ''}  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
${icon ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="${esc(icon)}" Addressable="true" />\n` : ''}  </Assets>
</PackageManifest>
`;
  const exts = [...new Set(files.map((f) => path.extname(f).toLowerCase()).filter(Boolean).concat('.vsixmanifest'))].sort();
  const bare = files.filter((f) => !path.extname(f));
  const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${exts.map((x) => `  <Default Extension="${esc(x)}" ContentType="${x === '.vsixmanifest' ? 'text/xml' : TYPES[x] || 'application/octet-stream'}" />`).join('\n')}
${bare.map((f) => `  <Override PartName="/${esc(f)}" ContentType="text/plain" />`).join('\n')}
</Types>
`;
  fs.writeFileSync(path.join(stageDir, 'extension.vsixmanifest'), vsix);
  fs.writeFileSync(path.join(stageDir, '[Content_Types].xml'), types);
  return pkg;
}

module.exports = { write, TYPES };
