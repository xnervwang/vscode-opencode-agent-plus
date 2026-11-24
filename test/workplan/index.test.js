// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const workplan = require('../../src/workplan');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'na-workplan-'));
const SID = 'ses_df3c28ab2ffe0TYFbXAnoBpqy6';

test('sourceFile is the plugin this repository ships', () => {
  const file = workplan.sourceFile();
  assert.equal(path.basename(path.dirname(file)), 'agent-work-plan');
  const plugin = require(file);
  assert.equal(plugin.id, 'agent-work-plan');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(typeof plugin.server, 'function');
});

test('pluginDir and scriptsDir sit under the root, by default paths.root()', () => {
  assert.equal(workplan.pluginDir('/r'), path.join('/r', 'opencode-plugin', 'agent-work-plan'));
  assert.equal(workplan.scriptsDir('/r'), path.join('/r', 'opencode-plugin', 'agent-work-plan', 'hooks'));
  const saved = process.env.OPENCODE_PLUS_HOME;
  process.env.OPENCODE_PLUS_HOME = '/somewhere/home';
  try {
    assert.equal(workplan.pluginDir(), path.join('/somewhere/home', 'opencode-plugin', 'agent-work-plan'));
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_PLUS_HOME; else process.env.OPENCODE_PLUS_HOME = saved;
  }
});

test('installPlugin writes the plugin only when its content differs, through a temporary file', () => {
  const root = tmp();
  const source = path.join(tmp(), 'index.js');
  fs.writeFileSync(source, 'module.exports = 1;\n');
  const first = workplan.installPlugin({ root, source });
  assert.equal(first.changed, true);
  assert.equal(first.dir, workplan.pluginDir(root));
  assert.equal(fs.readFileSync(first.file, 'utf8'), 'module.exports = 1;\n');
  const before = fs.statSync(first.file).mtimeMs;
  const again = workplan.installPlugin({ root, source });
  assert.equal(again.changed, false);
  assert.equal(fs.statSync(first.file).mtimeMs, before);
  fs.writeFileSync(source, 'module.exports = 2;\n');
  assert.equal(workplan.installPlugin({ root, source }).changed, true);
  assert.equal(fs.readFileSync(first.file, 'utf8'), 'module.exports = 2;\n');
  assert.deepEqual(fs.readdirSync(first.dir), ['index.js']);
});

test('installPlugin copies the real plugin by default source', () => {
  const root = tmp();
  const r = workplan.installPlugin({ root });
  assert.deepEqual(fs.readFileSync(r.file), fs.readFileSync(workplan.sourceFile()));
});

test('installScripts copies the *.py files, only those that differ, and leaves files only the copy has', () => {
  const root = tmp();
  const source = tmp();
  fs.writeFileSync(path.join(source, 'plan-row.py'), 'a');
  fs.writeFileSync(path.join(source, 'plan_common.py'), 'b');
  fs.writeFileSync(path.join(source, 'notes.txt'), 'c');
  fs.mkdirSync(path.join(source, '__pycache__'));
  const first = workplan.installScripts({ root, source });
  assert.equal(first.dir, workplan.scriptsDir(root));
  assert.deepEqual(first.changed, ['plan-row.py', 'plan_common.py']);
  fs.writeFileSync(path.join(first.dir, 'launcher.json'), '{"row":["py","-3"]}');
  assert.deepEqual(workplan.installScripts({ root, source }).changed, []);
  fs.writeFileSync(path.join(source, 'plan-row.py'), 'a2');
  assert.deepEqual(workplan.installScripts({ root, source }).changed, ['plan-row.py']);
  assert.deepEqual(fs.readdirSync(first.dir).sort(), ['launcher.json', 'plan-row.py', 'plan_common.py']);
  assert.equal(fs.readFileSync(path.join(first.dir, 'plan-row.py'), 'utf8'), 'a2');
});

test('configFor gives OpenCode 2 the plugin folder and the rules to read the plans folder, under every name it has', () => {
  const dir = path.join(os.tmpdir(), 'x', 'agent-work-plan');
  const real = fs.realpathSync(tmp());
  const plans = path.join(real, 'home', 'plans');
  const rules = (p) => [{ action: 'external_directory', resource: `${p}/*`, effect: 'allow' }, { action: 'read', resource: `${p}/*`, effect: 'allow' }];
  assert.deepEqual(workplan.configFor({ major: 2, minor: 4, patch: 1 }, { dir, plans }), { plugins: [dir], permissions: rules(plans) });
  assert.deepEqual(workplan.configFor(3, { dir, plans }), { plugins: [dir], permissions: rules(plans) });
  const link = path.join(fs.realpathSync(tmp()), 'link');
  fs.symlinkSync(real, link);
  const through = path.join(link, 'home', 'plans');
  assert.deepEqual(workplan.configFor(2, { dir, plans: through }).permissions, [...rules(through), ...rules(plans)],
    'a folder not made yet, reached through a link, is listed under its given and its real path');
  assert.deepEqual(workplan.configFor(2).permissions.slice(0, 2), rules(workplan.planDir()));
});

test('configFor gives OpenCode 1 a file URL of the plugin and nothing else', () => {
  const dir = path.join(os.tmpdir(), 'x', 'agent-work-plan');
  const v1 = workplan.configFor({ major: 1, minor: 19, patch: 6 }, { dir });
  assert.deepEqual(Object.keys(v1), ['plugin']);
  assert.equal(v1.plugin.length, 1);
  assert.equal(url.fileURLToPath(v1.plugin[0]), path.join(dir, 'index.js'));
  assert.deepEqual(workplan.configFor(null, { dir }), v1);
  assert.deepEqual(workplan.configFor(2).plugins, [workplan.pluginDir()]);
});

test('pluginEnv names the scripts folder and the home folder', () => {
  assert.deepEqual(workplan.pluginEnv({ hooksDir: '/h/hooks', home: '/h' }), { OPENCODE_PLUS_HOOKS_DIR: '/h/hooks', OPENCODE_PLUS_HOME: '/h' });
  const env = workplan.pluginEnv();
  assert.equal(env.OPENCODE_PLUS_HOOKS_DIR, workplan.scriptsDir());
  assert.equal(env.OPENCODE_PLUS_HOME, require('../../src/paths').root());
});

test('support: OpenCode 2 keeps a work plan; OpenCode 1 and an unknown version say it needs OpenCode 2', () => {
  assert.deepEqual(workplan.support({ major: 2, minor: 4, patch: 1, text: '2.4.1' }), { workPlan: true, message: '' });
  const v1 = workplan.support({ major: 1, minor: 19, patch: 6, text: '1.19.6' });
  assert.equal(v1.workPlan, false);
  assert.match(v1.message, /needs OpenCode 2/);
  assert.match(v1.message, /1\.19\.6/);
  const unknown = workplan.support(null);
  assert.equal(unknown.workPlan, false);
  assert.match(unknown.message, /needs OpenCode 2/);
});

test('planDir is paths.plansDir(); planPath names a plan by an OpenCode session id and nothing else', () => {
  const saved = process.env.OPENCODE_PLUS_HOME;
  process.env.OPENCODE_PLUS_HOME = '/data/na';
  try {
    assert.equal(workplan.planDir(), path.join('/data/na', 'plans'));
    assert.equal(workplan.planPath(SID), path.join('/data/na', 'plans', `${SID}.json`));
    for (const bad of ['', '../x', 'ses_../../x', '0123abcd-4567-89ef-0123-456789abcdef', 'client-time-zone', null, 7]) {
      assert.equal(workplan.planPath(bad), null, String(bad));
    }
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_PLUS_HOME; else process.env.OPENCODE_PLUS_HOME = saved;
  }
});
