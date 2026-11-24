// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

test('build/pack-vsix.js packs the extension, its run-time packages and nothing else', { skip: !fs.existsSync(path.join(ROOT, 'node_modules')) && 'no node_modules' }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'na-pack-')), 'x.vsix');
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'build', 'pack-vsix.js'), ROOT, '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const list = cp.spawnSync('unzip', ['-Z1', out], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const f of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/extension.js', 'extension/LICENSE.txt',
    'extension/README.md', 'extension/src/host/chat-editor.js', 'extension/src/ui/chat-panel.js', 'extension/media/chat.js', 'extension/images/sidebar.svg',
    'extension/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'extension/node_modules/markdown-it/LICENSE']) {
    assert.ok(list.includes(f), `has ${f}`);
  }
  const bad = list.filter((f) => /^extension\/(test|build|docs)\/|\.git\/|CLAUDE\.md|TASKSPEC|\.vsix$|bedrock-token-generator|\/dist-es\/|\/dist-types\/|node_modules\/(argparse|linkify-it|mdurl)\/|opencode$/.test(f));
  assert.deepStrictEqual(bad, []);
  const pkg = JSON.parse(cp.spawnSync('unzip', ['-p', out, 'extension/package.json'], { encoding: 'utf8' }).stdout);
  const types = cp.spawnSync('unzip', ['-p', out, '\\[Content_Types\\].xml'], { encoding: 'utf8' }).stdout;
  assert.match(types, /<Override PartName="\/extension\/node_modules\/markdown-it\/LICENSE" ContentType="text\/plain" \/>/);
  const manifest = cp.spawnSync('unzip', ['-p', out, 'extension.vsixmanifest'], { encoding: 'utf8' }).stdout;
  assert.match(manifest, new RegExp(`Id="${pkg.name}" Version="${pkg.version.replace(/\./g, '\\.')}" Publisher="${pkg.publisher}"`));
  assert.match(manifest, /ExtensionDependencies" Value="xnervwang\.agent-plus"/);
});
