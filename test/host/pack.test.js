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
/* pack-vsix.js runs zip, and these tests read its .vsix with unzip. The .vsix is built on Linux (the vscode and
   release workflows); Windows runners have neither command. */
const runs = (cmd) => !cp.spawnSync(cmd, ['-v'], { stdio: 'ignore' }).error;
const NO_PACK = !fs.existsSync(path.join(ROOT, 'node_modules')) ? 'no node_modules'
  : !(runs('zip') && runs('unzip')) ? 'no zip and unzip commands' : false;

test('build/pack-vsix.js packs the extension, its run-time packages and nothing else', { skip: NO_PACK }, () => {
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

test('rebaseLinks points relative links and images at the base URLs', () => {
  const { rebaseLinks } = require('../../build/pack-vsix');
  const md = '[a](docs/setup.md#x) [b](#here) [c](https://example.com/) ![i](images/i.png) [d](./LICENSE) [e](mailto:x@example.com)';
  assert.strictEqual(rebaseLinks(md, 'https://h/o/r/blob/s', 'https://h/o/r/raw/s/'),
    '[a](https://h/o/r/blob/s/docs/setup.md#x) [b](#here) [c](https://example.com/) ![i](https://h/o/r/raw/s/images/i.png) '
    + '[d](https://h/o/r/blob/s/LICENSE) [e](mailto:x@example.com)');
  assert.strictEqual(rebaseLinks(md, 'https://h/c/', ''), md.replace('(docs/', '(https://h/c/docs/').replace('(images/', '(https://h/c/images/')
    .replace('(./LICENSE', '(https://h/c/LICENSE'), 'images fall back to the content base');
  assert.strictEqual(rebaseLinks(md, '', ''), md);
});

test('build/pack-vsix.js with --base-content-url leaves no relative link in the packed README', { skip: NO_PACK }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'na-pack-')), 'x.vsix');
  const base = 'https://github.com/o/r/blob/0123abc/';
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'build', 'pack-vsix.js'), ROOT, '--out', out, '--base-content-url', base], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const readme = cp.spawnSync('unzip', ['-p', out, 'extension/README.md'], { encoding: 'utf8' }).stdout;
  const targets = [...readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
  assert.ok(targets.some((t) => t.startsWith(`${base}docs/`)), 'links into docs/ point at the repository');
  assert.deepStrictEqual(targets.filter((t) => !t.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(t)), []);
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes(base), false, 'the README in the repository is unchanged');
});

test('ThirdPartyNotices.txt names every image with the OpenCode mark and carries its MIT notice', () => {
  const text = fs.readFileSync(path.join(ROOT, 'ThirdPartyNotices.txt'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const commandIcons = pkg.contributes.commands.flatMap((c) => (c.icon && typeof c.icon === 'object' ? [c.icon.light, c.icon.dark] : []));
  assert.deepStrictEqual(commandIcons, ['images/editor-title-light.svg', 'images/editor-title-dark.svg']);
  const icons = [pkg.icon, ...pkg.contributes.viewsContainers.activitybar.map((c) => c.icon), 'images/icon.svg', ...commandIcons];
  for (const f of icons) assert.ok(text.includes(f), `names ${f}`);
  assert.match(text, /packages\/identity\/mark-light\.svg in OpenCode \(https:\/\/github\.com\/anomalyco\/opencode\)/);
  assert.match(text, /^MIT License\n\nCopyright \(c\) 2025 opencode\n/m);
  assert.match(text, /The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
  /* The mark's own outline is in the extension icon as OpenCode draws it. */
  assert.ok(fs.readFileSync(path.join(ROOT, 'images', 'icon.svg'), 'utf8').includes('M384 416H128V96H384V416ZM320 160H192V352H320V160Z'));
  assert.ok(require('../../build/pack-vsix').OWN.includes('ThirdPartyNotices.txt'), 'packed');
});
