// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-vscode');
const { createProviderConfig, SECRET_KEY, OUR_WAY } = require('../../src/host/provider-config');

function setup(config = {}, secret) {
  const { vscode, control } = fake.create();
  Object.assign(control.state.config, config);
  if (secret) control.state.secrets.set(SECRET_KEY, secret);
  const restarts = [];
  const lines = [];
  const cfg = createProviderConfig({ vscode, secrets: control.secrets, restart: async (o) => restarts.push(o), log: (l) => lines.push(l) });
  return { cfg, control, restarts, lines, vscode };
}

test('empty settings add nothing; set ones become the environment OpenCode starts with', async () => {
  const empty = setup();
  await empty.cfg.ready;
  assert.deepStrictEqual(empty.cfg.options(), { binaryPath: '', permissions: true, env: {} });
  const s = setup({ 'opencodeAgentPlus.bedrock.profile': 'self', 'opencodeAgentPlus.bedrock.region': 'us-east-1', 'opencodeAgentPlus.opencode.path': '/opt/oc', 'opencodeAgentPlus.opencode.askPermissions': false }, 'k-1');
  await s.cfg.ready;
  assert.deepStrictEqual(s.cfg.options(), { binaryPath: '/opt/oc', permissions: false, env: { AWS_PROFILE: 'self', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 'k-1' } });
  assert.deepStrictEqual(s.restarts, [], 'reading the key at activation is no change');
});

test('a change of setting or key starts OpenCode again, once per real change, and the key is never logged', async () => {
  const s = setup();
  await s.cfg.ready;
  s.control.setConfig('opencodeAgentPlus.bedrock.profile', 'self');
  s.control.setConfig('opencodeAgentPlus.model', 'x/y');
  s.control.setConfig('opencodeAgentPlus.bedrock.profile', 'self');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(s.restarts.map((o) => o.env), [{ AWS_PROFILE: 'self' }]);
  await s.control.secrets.store(SECRET_KEY, 'secret-value');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.restarts.at(-1).env.AWS_BEARER_TOKEN_BEDROCK, 'secret-value');
  s.control.setConfig('opencodeAgentPlus.opencode.askPermissions', false);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.restarts.at(-1).permissions, false);
  assert.strictEqual(s.restarts.length, 3);
  assert.ok(!s.lines.join('\n').includes('secret-value'));
});

test('setting and clearing the API key', async () => {
  const s = setup();
  s.control.state.inputAnswer = undefined;
  assert.strictEqual(await s.cfg.setApiKey(), false);
  assert.strictEqual(s.control.state.inputs[0].password, true);
  assert.strictEqual(s.control.state.inputs[0].validateInput(' '), 'Enter a key.');
  s.control.state.inputAnswer = '  abc ';
  assert.strictEqual(await s.cfg.setApiKey(), true);
  assert.strictEqual(s.control.state.secrets.get(SECRET_KEY), 'abc');
  await s.cfg.clearApiKey();
  assert.strictEqual(s.control.state.secrets.has(SECRET_KEY), false);
});

test("describe: one sentence for each state, and OpenCode's help with ours when Bedrock is not usable", () => {
  const { cfg } = setup();
  const found = { path: '/x/opencode', version: { text: '1.19.6', major: 1 } };
  assert.deepStrictEqual(cfg.describe({ status: { state: 'listed', models: 179 }, models: new Array(189), found }),
    { level: 'info', text: 'OpenCode 1.19.6 is connected: 189 models, 179 of them on Amazon Bedrock.' });
  assert.deepStrictEqual(cfg.describe({ status: { state: 'unknown' }, models: [], found }),
    { level: 'info', text: 'OpenCode 1.19.6 is installed. Its models show up once you open a conversation.' });
  const failed = cfg.describe({ status: { state: 'authFailed', error: 'AWS default credential chain failed', help: 'H1\nH2' }, models: [1], found });
  assert.deepStrictEqual(failed, { level: 'error', text: 'Amazon Bedrock refused the credentials: AWS default credential chain failed.', detail: `H1\nH2\n${OUR_WAY}` });
  assert.strictEqual(cfg.describe({ status: { state: 'notListed', help: 'H' }, models: [1, 2], found }).text, 'OpenCode 1.19.6 lists 2 models, none on Amazon Bedrock.');
  assert.deepStrictEqual(cfg.describe({ error: new Error('OpenCode was not found. Install it with ...') }), { level: 'error', text: 'OpenCode was not found. Install it with ...' });
});

test('show: the fix opens in a dialog on request', async () => {
  const s = setup();
  s.control.state.answers.push(['refused', 'How to fix']);
  await s.cfg.show({ level: 'error', text: 'Amazon Bedrock refused the credentials.', detail: 'do this' });
  assert.deepStrictEqual(s.control.state.said.map((x) => [x.kind, x.message, x.buttons]), [['error', 'Amazon Bedrock refused the credentials.', ['How to fix']], ['info', 'Amazon Bedrock refused the credentials.', []]]);
});
