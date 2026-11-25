// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { withModelChoice } = require('../../src/host/model-choice');

function inner() {
  const listeners = new Set();
  return {
    id: 'ses_1', cwd: '/w', title: 'T', status: 'idle', waitingTool: '', lastUserAt: 1, lastReplyAt: 2,
    sent: [], models: [], aborted: 0, disposed: 0, answered: [], current: 'opencode/default',
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send(text) { this.sent.push(text); return Promise.resolve('turn over'); },
    setModel(m) { this.models.push(m); this.current = m.id; return Promise.resolve(); },
    getModel() { return this.current; },
    abort() { this.aborted++; },
    respondPermission(id, d) { this.answered.push([id, d]); return true; },
    history: async () => [{ type: 'userMessage', text: 'x' }],
    dispose() { this.disposed++; },
    count: () => listeners.size,
  };
}

const GROK = { id: 'amazon-bedrock/us.xai.grok-4.7', providerId: 'amazon-bedrock' };

test("a new conversation's first message waits until the user picks a model, and a ui.model event tells the page", async () => {
  const c = inner();
  const told = [];
  let asked = 0;
  const f = withModelChoice(c, { needsChoice: true, choose: async () => { asked++; return GROK; }, tell: (t) => told.push(t) });
  const events = [];
  f.on((e) => events.push(e));
  assert.strictEqual(f.modelName, 'opencode/default');
  assert.strictEqual(await f.send('hi'), 'turn over');
  await f.send('again');
  assert.strictEqual(asked, 1);
  assert.deepStrictEqual(c.models, [GROK]);
  assert.deepStrictEqual(c.sent, ['hi', 'again']);
  assert.deepStrictEqual(events, [{ type: 'ui.model', model: GROK }]);
  assert.strictEqual(f.modelName, 'amazon-bedrock/us.xai.grok-4.7');
  c.fire({ type: 'text', delta: 'x' });
  assert.deepStrictEqual(events.at(-1), { type: 'text', delta: 'x' });
  assert.deepStrictEqual(told, []);
});

test('a dismissed picker or a failed list sends nothing and says why', async () => {
  const c = inner();
  const told = [];
  const f = withModelChoice(c, { needsChoice: true, choose: async () => null, tell: (t) => told.push(t) });
  assert.strictEqual(await f.send('hi'), undefined);
  assert.strictEqual(f.needsChoice, true, 'it asks again next time');
  const broken = withModelChoice(inner(), { needsChoice: true, choose: async () => { throw new Error('expired token'); }, tell: (t) => told.push(t) });
  await broken.send('hi');
  assert.deepStrictEqual(c.sent, []);
  assert.deepStrictEqual(told, ["Couldn't send the message: choose a model first.", "Couldn't send the message: listing the models failed (expired token)."]);
});

test('a saved conversation, or a model picked in the page, needs no question', async () => {
  const c = inner();
  const f = withModelChoice(c, { needsChoice: false, choose: async () => { throw new Error('must not ask'); }, tell() {} });
  await f.send('hi');
  assert.deepStrictEqual(c.sent, ['hi']);
  const d = inner();
  const g = withModelChoice(d, { needsChoice: true, choose: async () => { throw new Error('must not ask'); }, tell() {} });
  await g.setModel(GROK);
  await g.send('go');
  assert.deepStrictEqual(d.sent, ['go']);
});

test('the rest passes through', async () => {
  const c = inner();
  const f = withModelChoice(c, { needsChoice: false, choose: async () => null, tell() {} });
  assert.deepStrictEqual([f.id, f.cwd, f.title, f.status, f.lastUserAt, f.lastReplyAt], ['ses_1', '/w', 'T', 'idle', 1, 2]);
  assert.deepStrictEqual(await f.history(), [{ type: 'userMessage', text: 'x' }]);
  f.respond('p1', 'deny');
  f.respondPermission('p2', 'allowSession');
  assert.deepStrictEqual(c.answered, [['p1', 'deny'], ['p2', 'allowSession']]);
  f.abort();
  assert.strictEqual(f.getModel(), 'opencode/default');
  const off = f.on(() => {});
  off.dispose();
  f.dispose();
  assert.strictEqual(c.aborted, 1);
  assert.strictEqual(c.disposed, 1);
  assert.strictEqual(c.count(), 0, 'unsubscribed from the session');
});
