// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBackend, normInfo } = require('../../src/host/backend');

test('session info is read into one shape', () => {
  assert.deepStrictEqual(normInfo({ id: 'ses_1', title: 'T', directory: '/w', createdAt: 5, updatedAt: '1970-01-01T00:00:01.000Z', status: 'waiting', waitingTool: 'bash', lastUserAt: 2, lastReplyAt: 3 }),
    { id: 'ses_1', title: 'T', cwd: '/w', createdAt: 5, lastActiveAt: 1000, status: 'waiting', lastUserAt: 2, lastReplyAt: 3, waitingFor: { tool: 'bash' } });
  assert.deepStrictEqual(normInfo({ sessionId: 'ses_2', status: 'busy' }), { id: 'ses_2', title: '', cwd: '', createdAt: 0, lastActiveAt: 0, status: 'idle', lastUserAt: 0, lastReplyAt: 0 });
  assert.strictEqual(normInfo({ title: 'no id' }), null);
  assert.strictEqual(normInfo(null), null);
});

test('the module is loaded on first use, not before', async () => {
  let loads = 0;
  const calls = [];
  const fake = {
    listSessions: async () => [{ id: 'ses_a', cwd: '/w', status: 'working' }, null, { nope: 1 }],
    createSession: async (cwd) => { calls.push(['create', cwd]); return 'ses_new'; },
    renameSession: async (...a) => calls.push(['rename', ...a]),
    deleteSession: async (...a) => calls.push(['delete', ...a]),
    session: async (id) => ({ id }),
    listModels: async () => [{ id: 'm' }],
    defaultModel: async () => 'p/m',
    onDidChangeSessions: (fn) => { fake.fire = fn; return { dispose: () => { fake.fire = null; } }; },
    dispose: () => calls.push(['dispose']),
  };
  const b = createBackend({ load: () => { loads++; return { createBackend: (opts) => { fake.opts = opts; return fake; } }; }, options: { log: 'x' } });
  let heard = 0;
  b.onDidChangeSessions(() => heard++);
  assert.strictEqual(loads, 0);
  assert.strictEqual(b.started, false);
  assert.deepStrictEqual(await b.listSessions(), [{ id: 'ses_a', title: '', cwd: '/w', createdAt: 0, lastActiveAt: 0, status: 'working', lastUserAt: 0, lastReplyAt: 0 }]);
  assert.strictEqual(loads, 1);
  assert.deepStrictEqual(fake.opts, { log: 'x' });
  b.listen();
  fake.fire();
  assert.strictEqual(heard, 1);
  assert.deepStrictEqual(await b.createSession('/w'), { id: 'ses_new', title: '', cwd: '/w', createdAt: 0, lastActiveAt: 0, status: 'idle', lastUserAt: 0, lastReplyAt: 0 });
  await b.renameSession('ses_a', 'New');
  await b.deleteSession('ses_a');
  assert.deepStrictEqual(await b.session('ses_a'), { id: 'ses_a' });
  assert.deepStrictEqual(await b.listModels(), [{ id: 'm' }]);
  assert.strictEqual(await b.defaultModel(), 'p/m');
  b.dispose();
  assert.strictEqual(fake.fire, null);
  assert.deepStrictEqual(calls, [['create', '/w'], ['rename', 'ses_a', 'New'], ['delete', 'ses_a'], ['dispose']]);
  assert.strictEqual(loads, 1);
});

test('a missing member or factory is an error the caller sees, not a crash', async () => {
  const bare = createBackend({ load: () => ({ create: () => ({ listSessions: async () => 'not a list', openSession: async (id) => ({ opened: id }) }) }) });
  assert.deepStrictEqual(await bare.listSessions(), []);
  assert.deepStrictEqual(await bare.session('x'), { opened: 'x' });
  await assert.rejects(bare.renameSession('x', 'y'), /has no renameSession/);
  assert.strictEqual(await bare.defaultModel(), null);
  const none = createBackend({ load: () => ({}) });
  await assert.rejects(none.listSessions(), /exports no factory/);
});
