// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The model lists: each provider's models under its name, OpenCode's own free models left out by
 * opencodeAgentPlus.openCodeModels (auto once another provider is listed, hide always), and with hide OpenCode told
 * to leave its own provider out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');
const { createModels, visibleModels, groupOf } = require('../../src/host/models');
const { createProviderConfig } = require('../../src/host/provider-config');
const { createOpenCode } = require('../../src/opencode');
const { fakeStarter } = require('../opencode/fake-agent');

const model = (id, vendor) => ({ id, providerId: id.split('/')[0], invokeId: id.split('/')[1], name: id.split('/')[1], vendor, contextWindow: 0 });
const FREE = [model('opencode/big-pickle', 'OpenCode'), model('opencode/qwen4-max-free', 'OpenCode')];
const BEDROCK = [model('amazon-bedrock/us.xai.grok-4.7', 'Amazon Bedrock'), model('amazon-bedrock/openai.gpt-5.6-luna', 'Amazon Bedrock')];
const ids = (l) => l.map((m) => m.id);

test('auto lists OpenCode\'s own models only while no other provider is listed', () => {
  assert.deepEqual(ids(visibleModels(FREE, 'auto', '')), ids(FREE));
  assert.deepEqual(ids(visibleModels([...FREE, ...BEDROCK], 'auto', '')), ids(BEDROCK));
  assert.deepEqual(ids(visibleModels([...FREE, ...BEDROCK], undefined, '')), ids(BEDROCK), 'auto is the default');
});

test('show lists them always, hide never, and the model in use stays listed', () => {
  assert.deepEqual(ids(visibleModels([...FREE, ...BEDROCK], 'show', '')), ids([...FREE, ...BEDROCK]));
  assert.deepEqual(ids(visibleModels(FREE, 'hide', '')), []);
  assert.deepEqual(ids(visibleModels([...FREE, ...BEDROCK], 'hide', 'opencode/big-pickle')), ['opencode/big-pickle', ...ids(BEDROCK)]);
  assert.deepEqual(ids(visibleModels([...FREE, ...BEDROCK], 'auto', 'opencode/qwen4-max-free')), ['opencode/qwen4-max-free', ...ids(BEDROCK)]);
});

test('each model is listed under its provider\'s name, OpenCode\'s own under where they run', () => {
  assert.equal(groupOf(BEDROCK[0]), 'Amazon Bedrock');
  assert.equal(groupOf(FREE[0]), "OpenCode's free models (opencode.ai)");
  assert.equal(groupOf({ id: 'x/y', providerId: 'x' }), 'x');
});

test('the command palette\'s model list has a heading for each provider and leaves out what the setting hides', async () => {
  const { vscode, control } = fake.create();
  control.state.pickAnswer = (list) => list.find((i) => i.model && i.model.id === 'amazon-bedrock/us.xai.grok-4.7');
  const models = createModels({ vscode, listModels: async () => [...FREE, ...BEDROCK] });
  const chosen = await models.pick();
  assert.equal(chosen.id, 'amazon-bedrock/us.xai.grok-4.7');
  const list = control.state.picks[0].list;
  assert.deepEqual(list.map((i) => (i.kind === vscode.QuickPickItemKind.Separator ? `# ${i.label}` : i.description)),
    ['# Amazon Bedrock', 'amazon-bedrock/us.xai.grok-4.7', 'amazon-bedrock/openai.gpt-5.6-luna']);
  control.setConfig('opencodeAgentPlus.openCodeModels', 'show');
  control.state.pickAnswer = () => undefined;
  await models.pick();
  assert.deepEqual(control.state.picks[1].list.filter((i) => i.kind === vscode.QuickPickItemKind.Separator).map((i) => i.label),
    ["OpenCode's free models (opencode.ai)", 'Amazon Bedrock']);
});

test('hide has OpenCode leave out its own provider, and a change of the setting starts OpenCode again', async () => {
  const { vscode, control } = fake.create();
  const restarts = [];
  const cfg = createProviderConfig({ vscode, secrets: control.secrets, restart: async (o) => restarts.push(o), baseEnv: {} });
  await cfg.ready;
  assert.deepEqual(cfg.options().disabledProviders, []);
  control.setConfig('opencodeAgentPlus.openCodeModels', 'hide');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(restarts.map((o) => o.disabledProviders), [['opencode']]);
  control.setConfig('opencodeAgentPlus.openCodeModels', 'show');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(restarts.at(-1).disabledProviders, []);
});

test('OpenCode starts with disabled_providers in its inline configuration when providers are left out', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter('v2-run.jsonl');
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version: { major: 2, minor: 4, patch: 1, text: '2.4.1' } }),
    startAcp: starter.start, idleStopMs: 0, disabledProviders: ['opencode', 'not ok/..'] });
  t.after(() => oc.dispose());
  await oc.createSession('/work/project');
  assert.deepEqual(starter.agents[0].launch.config.disabled_providers, ['opencode']);
  await oc.restart({ disabledProviders: [] });
  await oc.createSession('/work/project');
  const last = starter.agents.at(-1).launch.config;
  assert.ok(!last || !('disabled_providers' in last), 'none once the setting lets them in');
});
