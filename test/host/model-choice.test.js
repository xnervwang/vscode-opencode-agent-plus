// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { withModelChoice } = require('../../src/host/model-choice');

function inner({ model = null, loaded = null } = {}) {
  const listeners = new Set();
  return {
    model, loaded, sessionId: 's1', sent: [], models: [], aborted: 0, disposed: 0, responded: [],
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send(text) { this.sent.push(text); return Promise.resolve('turn over'); },
    setModel(m) { this.models.push(m); this.model = m; },
    abort() { this.aborted++; },
    respond(id, d) { this.responded.push([id, d]); return true; },
    setTitle(t) { this.title = t; },
    dispose() { this.disposed++; },
    count: () => listeners.size,
  };
}

const GROK = { id: 'xai.grok-4.7', providerId: 'bedrock' };

test('the first message waits for a model, which the page hears about', async () => {
  const c = inner();
  const told = [];
  let asked = 0;
  const f = withModelChoice(c, { modelById: async () => null, modelForNew: async () => { asked++; return GROK; }, tell: (t) => told.push(t) });
  const events = [];
  f.on((e) => events.push(e));
  assert.strictEqual(await f.send('hi'), 'turn over');
  await f.send('again');
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(c.models, [GROK]);
  assert.deepStrictEqual(c.sent, ['hi', 'again']);
  assert.deepStrictEqual(events, [{ type: 'ui.model', model: GROK }]);
  c.fire({ type: 'text', delta: 'x' });
  assert.deepStrictEqual(events.at(-1), { type: 'text', delta: 'x' });
  assert.deepStrictEqual(told, []);
});

test("a saved conversation takes its own model back, if it is still listed", async () => {
  const c = inner({ loaded: { modelId: 'deepseek.v3.2' } });
  const ds = { id: 'deepseek.v3.2' };
  const f = withModelChoice(c, { modelById: async (id) => (id === 'deepseek.v3.2' ? ds : null), modelForNew: async () => { throw new Error('must not ask'); }, tell() {} });
  assert.strictEqual(f.shownModelId, 'deepseek.v3.2');
  await f.send('go on');
  assert.deepStrictEqual(c.models, [ds]);

  const gone = inner({ loaded: { modelId: 'old.model' } });
  const g = withModelChoice(gone, { modelById: async () => null, modelForNew: async () => GROK, tell() {} });
  await g.send('x');
  assert.deepStrictEqual(gone.models, [GROK]);
});

test('no model, or no model list: nothing is sent and the user is told why', async () => {
  const c = inner();
  const told = [];
  const f = withModelChoice(c, { modelById: async () => null, modelForNew: async () => null, tell: (t) => told.push(t) });
  assert.strictEqual(await f.send('hi'), undefined);
  const broken = withModelChoice(inner(), { modelById: async () => null, modelForNew: async () => { throw new Error('expired token'); }, tell: (t) => told.push(t) });
  await broken.send('hi');
  assert.deepStrictEqual(c.sent, []);
  assert.deepStrictEqual(told, ['The message was not sent: choose a model first.', 'The message was not sent: the models could not be listed (expired token).']);
});

test('permission answers go to respondPermission when the session has it', () => {
  const c = inner();
  const answered = [];
  c.respondPermission = (id, d) => { answered.push([id, d]); return true; };
  c.history = () => [{ type: 'userMessage', text: 'x' }];
  const f = withModelChoice(c, { modelById: async () => null, modelForNew: async () => null, tell() {} });
  f.respond('p9', 'allowSession');
  assert.deepStrictEqual(answered, [['p9', 'allowSession']]);
  assert.deepStrictEqual(c.responded, []);
  assert.deepStrictEqual(f.history(), [{ type: 'userMessage', text: 'x' }]);
  c.modelId = 'amazon-bedrock/us.xai.grok-4.7';
  assert.strictEqual(f.shownModelId, 'amazon-bedrock/us.xai.grok-4.7');
});

test('a model already set, a model picked in the page, and the passed-through members', async () => {
  const c = inner({ model: GROK });
  const f = withModelChoice(c, { modelById: async () => { throw new Error('no'); }, modelForNew: async () => { throw new Error('no'); }, tell() {} });
  assert.deepStrictEqual(f.history(), []);
  await f.send('hi');
  assert.deepStrictEqual(c.sent, ['hi']);
  const other = { id: 'zai.glm-5' };
  f.setModel(other);
  assert.strictEqual(f.model, other);
  assert.strictEqual(f.shownModelId, 'zai.glm-5');
  f.abort();
  assert.strictEqual(f.respond('p1', 'deny'), true);
  f.setTitle('T');
  assert.strictEqual(c.title, 'T');
  assert.strictEqual(f.sessionId, 's1');
  const off = f.on(() => {});
  off.dispose();
  f.dispose();
  assert.strictEqual(c.aborted, 1);
  assert.deepStrictEqual(c.responded, [['p1', 'deny']]);
  assert.strictEqual(c.disposed, 1);
  assert.strictEqual(c.count(), 0, 'unsubscribed from the conversation');
});
