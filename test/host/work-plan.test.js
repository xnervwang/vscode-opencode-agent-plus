// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');
const workplan = require('../../src/workplan');
const { createWorkPlan, KEYS, DOWNLOAD, RETRY } = require('../../src/host/work-plan');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'na-host-wp-'));

function make({ trusted = true, find, config = {} } = {}) {
  const home = tmp();
  process.env.OPENCODE_PLUS_HOME = home;
  const { vscode, control } = fake.create();
  vscode.workspace.isTrusted = trusted;
  Object.assign(control.state.config, config);
  const said = [];
  const storage = path.join(home, 'storage');
  const plan = createWorkPlan({ vscode, extensionPath: ROOT, storage, tell: (t) => said.push(t), find: find || (async () => ({ launcher: ['python3'], executable: '/usr/bin/python3', version: '3.7' })) });
  const settingsFile = path.join(home, 'plans', 'config.json');
  const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  return { home, vscode, control, plan, said, storage, settingsFile, read };
}

test('the token mode decides the switches; in Custom our own settings do', () => {
  /* The time-zone note is the token mode's timeZone feature: on in Essential and All. The page draws reply images, so
     that note's switch is always on. */
  const cases = [
    [{}, { enabled: true, brief: true, tellTimeZone: true }],
    [{ 'agentPlus.tokenMode': 'all' }, { enabled: true, brief: true, tellTimeZone: true }],
    [{ 'agentPlus.tokenMode': 'essential' }, { enabled: true, brief: false, tellTimeZone: true }],
    [{ 'agentPlus.tokenMode': 'interface' }, { enabled: false, brief: false, tellTimeZone: false }],
    [{ 'agentPlus.tokenMode': 'interface', [KEYS.workPlan]: true, [KEYS.timeZone]: true }, { enabled: false, brief: false, tellTimeZone: false }],
    [{ 'agentPlus.tokenMode': 'custom' }, { enabled: true, brief: true, tellTimeZone: true }],
    [{ 'agentPlus.tokenMode': 'custom', [KEYS.conversationBrief]: false }, { enabled: true, brief: false, tellTimeZone: true }],
    [{ 'agentPlus.tokenMode': 'custom', [KEYS.workPlan]: false }, { enabled: false, brief: true, tellTimeZone: true }],
    [{ 'agentPlus.tokenMode': 'custom', [KEYS.timeZone]: false }, { enabled: true, brief: true, tellTimeZone: false }],
    [{ 'agentPlus.tokenMode': 'no-such-mode' }, { enabled: true, brief: true, tellTimeZone: true }],
  ];
  assert.equal(KEYS.timeZone, 'opencodePlus.tellOpenCodeYourTimeZone');
  for (const [config, want] of cases) {
    const { plan } = make({ config });
    assert.deepEqual(plan.values(), { ...want, replyImages: config['agentPlus.tokenMode'] !== 'interface' }, JSON.stringify(config));
    assert.equal(plan.brief(), want.enabled && want.brief);
    plan.dispose();
  }
});

test('start copies the plugin and scripts, writes config.json with this storage as marker, and the Python launcher', async () => {
  const { home, plan, storage, read } = make({ find: async () => ({ launcher: ['py', '-3'], executable: 'C:/Py/python.exe', version: '3.12' }) });
  let fired = 0;
  plan.onDidChangeNotice(() => { fired++; });
  await plan.start();
  const dir = path.join(home, 'opencode-plugin', 'agent-work-plan');
  assert.ok(fs.existsSync(path.join(dir, 'index.js')));
  for (const n of ['plan_common.py', 'plan_agent.py', 'inject-work-plan.py', 'nudge-work-plan.py', 'plan-row.py', 'resume-work-plan.py']) {
    assert.ok(fs.existsSync(path.join(dir, 'hooks', n)), n);
  }
  assert.deepEqual(read(), { enabled: true, brief: true, tellTimeZone: true, replyImages: true, extensionMarkers: [storage] });
  assert.ok(fs.existsSync(storage), 'the marker folder exists');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'launcher.json'), 'utf8')), { row: ['C:/Py/python.exe'] });
  assert.equal(plan.planNotice(), null);
  assert.ok(fired >= 1);
  await plan.start();
  plan.dispose();
});

test('a change of token mode rewrites config.json at once', async () => {
  const { control, plan, read } = make();
  await plan.start();
  control.setConfig('agentPlus.tokenMode', 'interface');
  assert.deepEqual({ enabled: read().enabled, brief: read().brief }, { enabled: false, brief: false });
  control.setConfig('agentPlus.tokenMode', 'essential');
  assert.deepEqual({ enabled: read().enabled, brief: read().brief }, { enabled: true, brief: false });
  control.setConfig('agentPlus.tokenMode', 'custom');
  control.setConfig(KEYS.conversationBrief, false);
  assert.equal(read().brief, false);
  control.setConfig(KEYS.conversationBrief, true);
  assert.equal(read().brief, true);
  plan.dispose();
});

test('our switch changed outside Custom says it has no effect, once, with Switch to Custom', async () => {
  const { control, plan } = make({ config: { 'agentPlus.tokenMode': 'all' } });
  control.setConfig(KEYS.workPlan, false);
  control.setConfig(KEYS.workPlan, true);
  await new Promise((r) => setImmediate(r));
  const notes = control.state.said.filter((s) => /has no effect until the mode is Custom/.test(s.message));
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].buttons, ['Switch to Custom']);
  plan.dispose();
});

test('with no Python the plan shows a row saying so, and looking again clears it', async () => {
  let python = null;
  const { home, control, plan } = make({ find: async () => python });
  await plan.start();
  const n = plan.planNotice();
  assert.equal(n.title, 'Work plans need Python 3');
  assert.equal(n.command, process.platform === 'win32' ? DOWNLOAD : RETRY);
  assert.match(n.detail, /plugin adds nothing/);
  assert.ok(!fs.existsSync(path.join(home, 'opencode-plugin', 'agent-work-plan', 'hooks', 'launcher.json')));
  assert.ok(control.state.registered.includes(DOWNLOAD) && control.state.registered.includes(RETRY));
  python = { launcher: ['python'], executable: '/opt/py/bin/python', version: '3.9' };
  await control.state.handlers[RETRY]();
  assert.equal(plan.planNotice(), null);
  assert.equal(plan.python.executable, '/opt/py/bin/python');
  plan.dispose();
});

test('on OpenCode 1 the notice that the work plan needs OpenCode 2 shows once per workspace and version, and a row above the plan keeps it; on OpenCode 2 neither shows', () => {
  const { plan, said } = make();
  assert.equal(plan.checkVersion({ major: 2, text: '2.4.1' }).workPlan, true);
  assert.deepEqual(said, []);
  assert.equal(plan.planNotice(), null);
  const s = plan.checkVersion({ major: 1, text: '1.19.6' });
  assert.equal(s.workPlan, false);
  plan.checkVersion({ major: 1, text: '1.19.6' });
  assert.deepEqual(said, ['The work plan needs OpenCode 2, and this is OpenCode 1.19.6. Update OpenCode to keep a work plan in these conversations.']);
  const row = plan.planNotice();
  assert.equal(row.title, 'Work plans need OpenCode 2');
  assert.equal(row.description, 'OpenCode 1.19.6 is in use');
  assert.deepEqual([row.command, row.arguments], ['workbench.action.openSettings', ['opencodePlus.opencode.path']]);
  plan.checkVersion({ major: 2, text: '2.4.1' });
  assert.equal(plan.planNotice(), null);
  plan.dispose();

  /* A reload is a new extension host with the same workspace state: the notice is not shown again for the same version. */
  const store = new Map();
  const memo = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } };
  const said2 = [];
  const { vscode } = fake.create();
  for (let i = 0; i < 2; i++) {
    const p = createWorkPlan({ vscode, extensionPath: ROOT, storage: tmp(), memo, tell: (t) => said2.push(t) });
    p.checkVersion({ major: 1, text: '1.19.6' });
    assert.equal(p.planNotice().title, 'Work plans need OpenCode 2');
    p.dispose();
  }
  assert.equal(said2.length, 1);
  const p3 = createWorkPlan({ vscode, extensionPath: ROOT, storage: tmp(), memo, tell: (t) => said2.push(t) });
  p3.checkVersion({ major: 1, text: '1.19.7' });
  assert.equal(said2.length, 2, 'another version is said again');
  p3.dispose();
});

test('launch adds the plugin environment and configuration to the settings OpenCode starts with', async () => {
  const { home, plan } = make();
  assert.deepEqual(plan.launch({ env: { AWS_PROFILE: 'p' } }), { env: { AWS_PROFILE: 'p' }, quietFolder: null }, 'nothing while the plugin is not in place');
  await plan.start();
  const o = plan.launch({ binaryPath: '/x/opencode', permissions: true, env: { AWS_PROFILE: 'p' } });
  assert.equal(o.binaryPath, '/x/opencode');
  assert.equal(o.permissions, true);
  assert.deepEqual(o.env, { AWS_PROFILE: 'p', OPENCODE_PLUS_HOOKS_DIR: workplan.scriptsDir(home), OPENCODE_PLUS_HOME: home });
  assert.deepEqual(o.config(2).plugins, [workplan.pluginDir(home)]);
  assert.ok(o.config(2).permissions.some((r) => r.action === 'read' && r.resource === `${path.join(home, 'plans')}/*`));
  assert.match(o.config(1).plugin[0], /^file:\/\/.*\/agent-work-plan\/index\.js$/);
  /* Writes into a conversation's own image folder go without asking (src/opencode/quiet-writes.js). */
  assert.equal(o.quietFolder('ses_df3c28ab2ffe0TYFbXAnoBpqy6'), path.join(home, 'scratch', 'ses_df3c28ab2ffe0TYFbXAnoBpqy6'));
  assert.equal(o.quietFolder('../x'), null);
  assert.deepEqual(plan.launch(undefined).env, { OPENCODE_PLUS_HOOKS_DIR: workplan.scriptsDir(home), OPENCODE_PLUS_HOME: home });
  plan.dispose();
});

test('in Restricted Mode nothing is copied or written', async () => {
  const { home, plan } = make({ trusted: false });
  await plan.start();
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(plan.writeSettings(), false);
  plan.dispose();
});
