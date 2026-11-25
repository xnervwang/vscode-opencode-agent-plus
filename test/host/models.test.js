// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-vscode');
const { createModels, fullId } = require('../../src/host/models');

const GROK = { id: 'amazon-bedrock/us.xai.grok-4.7', invokeId: 'us.xai.grok-4.7', providerId: 'amazon-bedrock', name: 'Grok 4.7', contextWindow: 256000 };
const KIMI = { id: 'amazon-bedrock/moonshotai.kimi-k2.5', invokeId: 'moonshotai.kimi-k2.5', providerId: 'amazon-bedrock', name: 'Kimi K2.5' };

function setup({ models = [GROK, KIMI], def } = {}) {
  const { vscode, control } = fake.create();
  let calls = 0;
  const m = createModels({ vscode, listModels: async () => { calls++; if (models instanceof Error) throw models; return models; }, defaultModel: def });
  return { m, control, vscode, calls: () => calls };
}

test('the setting names the model, by provider/id or by bare id', async () => {
  const s = setup();
  s.control.state.config['opencodeAgentPlus.model'] = 'amazon-bedrock/us.xai.grok-4.7';
  assert.strictEqual(await s.m.forNew(), GROK);
  s.control.state.config['opencodeAgentPlus.model'] = 'moonshotai.kimi-k2.5';
  assert.strictEqual(await s.m.forNew(), KIMI);
  assert.strictEqual(s.m.cached('amazon-bedrock/moonshotai.kimi-k2.5'), KIMI);
  assert.strictEqual(fullId({ id: 'x' }), 'x');
  assert.strictEqual(fullId({ id: 'm', providerId: 'p' }), 'p/m');
  assert.strictEqual(fullId(GROK), 'amazon-bedrock/us.xai.grok-4.7', 'an id that already names its provider is kept');
});

test("without the setting: the backend's default, then the user's pick, which is saved", async () => {
  const byObj = setup({ def: async () => KIMI });
  assert.strictEqual(await byObj.m.forNew(), KIMI);
  const byName = setup({ def: async () => 'amazon-bedrock/us.xai.grok-4.7' });
  assert.strictEqual(await byName.m.forNew(), GROK);

  const s = setup({ def: async () => { throw new Error('no default'); } });
  assert.strictEqual(await s.m.forNew(), null, 'dismissed');
  s.control.state.pickAnswer = (list) => list.filter((i) => i.model)[1];
  assert.strictEqual(await s.m.forNew(), KIMI);
  assert.deepStrictEqual(s.control.state.configWrites.at(-1), ['opencodeAgentPlus.model', 'amazon-bedrock/moonshotai.kimi-k2.5', s.vscode.ConfigurationTarget.Global]);
  const listed = s.control.state.picks[0].list;
  assert.deepStrictEqual(listed.map((i) => (i.model ? i.description : `# ${i.label}`)), ['# amazon-bedrock', 'amazon-bedrock/us.xai.grok-4.7', 'amazon-bedrock/moonshotai.kimi-k2.5'], 'these models carry no vendor, so the heading is the provider id');
  assert.match(listed[1].detail, /256K context/);
});

test('a named model that is not connected asks for another; with no models the message says how to connect a provider', async () => {
  const s = setup();
  s.control.state.config['opencodeAgentPlus.model'] = 'gone/model';
  s.control.state.pickAnswer = (list) => list.find((i) => i.model);
  assert.strictEqual(await s.m.forNew(), GROK);
  assert.match(s.control.state.picks[0].opts.placeHolder, /gone\/model is not among/);

  const none = setup({ models: [] });
  assert.strictEqual(await none.m.pick(), null);
  assert.match(none.control.state.said.at(-1).message, /opencode auth login/);
  assert.strictEqual(await none.m.cached('x'), null);
});

test('the list is asked for each time, since OpenCode learns context windows as models are used', async () => {
  const s = setup({ models: new Error('server down') });
  await assert.rejects(s.m.list(), /server down/);
  await assert.rejects(s.m.list(), /server down/);
  assert.strictEqual(s.calls(), 2);
});
