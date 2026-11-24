// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-vscode');
const { createProviderConfig, SECRET_KEY } = require('../../src/host/provider-config');

const MODELS = [
  { id: 'xai.grok-4.7', invokeId: 'us.xai.grok-4.7', name: 'Grok 4.7', vendor: 'xAI', contextWindow: 256000, known: true },
  { id: 'deepseek.v3.2', invokeId: 'deepseek.v3.2', name: 'DeepSeek V3.2', vendor: 'DeepSeek', contextWindow: 128000, known: false },
];

function setup({ auth = { ok: true, detail: 'ok' }, models = MODELS } = {}) {
  const { vscode, control } = fake.create();
  const built = [];
  const loadProviders = () => ({
    createProvider(config) {
      const p = { id: 'bedrock', label: 'Amazon Bedrock', config, listCalls: 0,
        checkAuth: async () => (typeof auth === 'function' ? auth() : auth),
        listModels: async () => { p.listCalls++; if (models instanceof Error) throw models; return models; },
        async *stream(req) { yield { type: 'text', delta: `${config.region}:${req.model.id}` }; } };
      built.push(p);
      return p;
    },
  });
  const cfg = createProviderConfig({ vscode, secrets: control.secrets, loadProviders, log: () => {} });
  return { vscode, control, cfg, built };
}

test('builds the provider from the settings, once', () => {
  const { cfg, control, built } = setup();
  control.state.config['newAgent.bedrock.region'] = 'us-west-2';
  control.state.config['newAgent.bedrock.profile'] = 'self';
  cfg.provider();
  cfg.provider();
  assert.strictEqual(built.length, 1);
  assert.strictEqual(built[0].config.providerId, 'bedrock');
  assert.strictEqual(built[0].config.region, 'us-west-2');
  assert.deepStrictEqual(built[0].config.auth, { mode: 'credentials', profile: 'self' });
  assert.deepStrictEqual(cfg.settings(), { region: 'us-west-2', auth: 'credentials', profile: 'self', modelId: '' });
});

test('defaults: us-east-1 and the default credential chain', () => {
  const { cfg, built } = setup();
  cfg.provider();
  assert.strictEqual(built[0].config.region, 'us-east-1');
  assert.deepStrictEqual(built[0].config.auth, { mode: 'credentials' });
});

test('API key mode reads the key from secret storage when the provider asks', async () => {
  const { cfg, control, built } = setup();
  control.state.config['newAgent.bedrock.auth'] = 'apiKey';
  cfg.provider();
  await assert.rejects(built[0].config.auth.getKey(), /No Amazon Bedrock API key is set/);
  await control.secrets.store(SECRET_KEY, 'k-123');
  assert.strictEqual(built.length, 1, 'a new key builds the provider again only when used');
  cfg.provider();
  assert.strictEqual(built.length, 2);
  assert.strictEqual(await built[1].config.auth.getKey(), 'k-123');
});

test('a Bedrock setting change rebuilds the provider behind the proxy; a model change does not', async () => {
  const { cfg, control, built } = setup();
  let fired = 0;
  cfg.onDidChange(() => fired++);
  const out = [];
  for await (const ev of cfg.proxy.stream({ model: { id: 'm' } })) out.push(ev.delta);
  control.setConfig('newAgent.bedrock.region', 'eu-west-1');
  for await (const ev of cfg.proxy.stream({ model: { id: 'm' } })) out.push(ev.delta);
  assert.deepStrictEqual(out, ['us-east-1:m', 'eu-west-1:m']);
  assert.strictEqual(built.length, 2);
  assert.strictEqual(fired, 1);
  control.setConfig('newAgent.model', 'xai.grok-4.7');
  cfg.provider();
  assert.strictEqual(built.length, 2);
  assert.strictEqual(cfg.proxy.id, 'bedrock');
});

test('the model list is fetched once per provider, again after a failure', async () => {
  const s = setup({ models: new Error('throttled') });
  await assert.rejects(s.cfg.listModels(), /throttled/);
  await assert.rejects(s.cfg.listModels(), /throttled/);
  assert.strictEqual(s.built[0].listCalls, 2);

  const ok = setup();
  await ok.cfg.listModels();
  await ok.cfg.proxy.listModels();
  assert.strictEqual(ok.built[0].listCalls, 1);
  assert.strictEqual((await ok.cfg.modelById('us.xai.grok-4.7')).id, 'xai.grok-4.7');
  assert.strictEqual(await ok.cfg.modelById('nope'), null);
});

test('modelForNew: the set model, else a pick that is saved; null when dismissed', async () => {
  const { cfg, control, vscode } = setup();
  assert.strictEqual(await cfg.modelForNew(), null);
  assert.strictEqual(control.state.picks.length, 1);
  assert.deepStrictEqual(control.state.picks[0].list.map((i) => i.description), ['xai.grok-4.7', 'deepseek.v3.2']);
  assert.match(control.state.picks[0].list[1].detail, /limits not known/);

  control.state.pickAnswer = (list) => list[1];
  assert.strictEqual((await cfg.modelForNew()).id, 'deepseek.v3.2');
  assert.deepStrictEqual(control.state.configWrites.at(-1), ['newAgent.model', 'deepseek.v3.2', vscode.ConfigurationTarget.Global]);

  control.state.pickAnswer = () => { throw new Error('must not ask'); };
  assert.strictEqual((await cfg.modelForNew()).id, 'deepseek.v3.2');

  control.state.config['newAgent.model'] = 'gone.model';
  control.state.pickAnswer = (list) => list[0];
  assert.strictEqual((await cfg.modelForNew()).id, 'xai.grok-4.7');
  assert.match(control.state.picks.at(-1).opts.placeHolder, /gone\.model is not among/);
});

test('testConnection says in one sentence what it found', async () => {
  const ok = setup();
  ok.control.state.config['newAgent.bedrock.profile'] = 'self';
  assert.strictEqual((await ok.cfg.testConnection()).ok, true);
  assert.deepStrictEqual(ok.control.state.said.at(-1), { kind: 'info', message: 'Connected to Amazon Bedrock (us-east-1, profile self): 2 models available.', buttons: [] });

  ok.control.state.config['newAgent.model'] = 'gone.model';
  await ok.cfg.testConnection();
  assert.strictEqual(ok.control.state.said.at(-1).kind, 'warning');
  assert.match(ok.control.state.said.at(-1).message, /2 models available, but not gone\.model\.$/);

  const denied = setup({ auth: { ok: false, detail: 'The profile is missing bedrock:ListFoundationModels.' } });
  assert.strictEqual((await denied.cfg.testConnection()).ok, false);
  assert.deepStrictEqual(denied.control.state.said.at(-1), { kind: 'error', message: 'Amazon Bedrock (us-east-1, default credentials): The profile is missing bedrock:ListFoundationModels.', buttons: [] });

  const throwing = setup({ auth: () => { throw new Error('expired token'); } });
  await throwing.cfg.testConnection();
  assert.match(throwing.control.state.said.at(-1).message, /expired token/);

  const noList = setup({ models: new Error('AccessDenied') });
  await noList.cfg.testConnection();
  assert.match(noList.control.state.said.at(-1).message, /listing models failed: AccessDenied/);
});

test('setting and clearing the API key', async () => {
  const { cfg, control } = setup();
  control.state.inputAnswer = undefined;
  assert.strictEqual(await cfg.setApiKey(), false);
  assert.strictEqual(control.state.inputs[0].password, true);
  assert.strictEqual(control.state.inputs[0].validateInput('  '), 'Enter a key.');

  control.state.inputAnswer = '  abc  ';
  control.state.answers.push(['still uses AWS credentials', 'Use the API key']);
  assert.strictEqual(await cfg.setApiKey(), true);
  assert.strictEqual(control.state.secrets.get(SECRET_KEY), 'abc');
  assert.strictEqual(control.state.config['newAgent.bedrock.auth'], 'apiKey');

  await cfg.setApiKey();
  assert.strictEqual(control.state.said.at(-1).message, 'The Amazon Bedrock API key is saved.');

  await cfg.clearApiKey();
  assert.strictEqual(control.state.secrets.has(SECRET_KEY), false);
});
