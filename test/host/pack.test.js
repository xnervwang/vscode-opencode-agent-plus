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
    'extension/README.md', 'extension/ThirdPartyNotices.txt', 'extension/images/icon.png', 'extension/images/icon.svg', 'extension/src/host/chat-editor.js', 'extension/src/ui/chat-panel.js', 'extension/media/chat.js', 'extension/images/sidebar.svg',
    'extension/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'extension/node_modules/markdown-it/LICENSE',
    'extension/opencode-plugin/agent-work-plan/index.js', 'extension/opencode-plugin/agent-work-plan/hooks/plan_agent.py',
    'extension/opencode-plugin/agent-work-plan/hooks/plan_common.py', 'extension/opencode-plugin/agent-work-plan/hooks/inject-work-plan.py',
    'extension/opencode-plugin/agent-work-plan/hooks/nudge-work-plan.py', 'extension/opencode-plugin/agent-work-plan/hooks/plan-row.py',
    'extension/opencode-plugin/agent-work-plan/hooks/resume-work-plan.py', 'extension/src/shared/hook-settings.js',
    'extension/src/shared/python-runtime.js', 'extension/src/shared/token-mode.js', 'extension/src/workplan/index.js']) {
    assert.ok(list.includes(f), `has ${f}`);
  }
  const bad = list.filter((f) => /^extension\/(test|build|docs)\/|\.git\/|CLAUDE\.md|TASKSPEC|\.vsix$|__pycache__|\.pyc$|launcher\.json$|bedrock-token-generator|\/dist-es\/|\/dist-types\/|node_modules\/(argparse|linkify-it|mdurl)\/|opencode$/.test(f));
  assert.deepStrictEqual(bad, []);
  const pkg = JSON.parse(cp.spawnSync('unzip', ['-p', out, 'extension/package.json'], { encoding: 'utf8' }).stdout);
  const types = cp.spawnSync('unzip', ['-p', out, '\\[Content_Types\\].xml'], { encoding: 'utf8' }).stdout;
  assert.match(types, /<Override PartName="\/extension\/node_modules\/markdown-it\/LICENSE" ContentType="text\/plain" \/>/);
  assert.match(types, /<Default Extension="\.py" ContentType="text\/x-python" \/>/);
  const manifest = cp.spawnSync('unzip', ['-p', out, 'extension.vsixmanifest'], { encoding: 'utf8' }).stdout;
  assert.match(manifest, new RegExp(`Id="${pkg.name}" Version="${pkg.version.replace(/\./g, '\\.')}" Publisher="${pkg.publisher}"`));
  assert.match(manifest, /ExtensionDependencies" Value="xnervwang\.agent-plus"/);
});

test('ThirdPartyNotices.txt names every image with the OpenCode mark and carries its MIT notice', () => {
  const text = fs.readFileSync(path.join(ROOT, 'ThirdPartyNotices.txt'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const icons = [pkg.icon, ...pkg.contributes.viewsContainers.activitybar.map((c) => c.icon), 'images/icon.svg'];
  for (const f of icons) assert.ok(text.includes(f), `names ${f}`);
  assert.match(text, /packages\/identity\/mark-light\.svg in OpenCode \(https:\/\/github\.com\/anomalyco\/opencode\)/);
  assert.match(text, /^MIT License\n\nCopyright \(c\) 2025 opencode\n/m);
  assert.match(text, /The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
  /* The mark's own outline is in the extension icon as OpenCode draws it. */
  assert.ok(fs.readFileSync(path.join(ROOT, 'images', 'icon.svg'), 'utf8').includes('M384 416H128V96H384V416ZM320 160H192V352H320V160Z'));
  assert.ok(require('../../build/pack-vsix').OWN.includes('ThirdPartyNotices.txt'), 'packed');
});
