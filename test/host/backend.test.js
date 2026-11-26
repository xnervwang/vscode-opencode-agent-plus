// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBackend, normInfo } = require('../../src/host/backend');

test('session info is read into one shape', () => {
  assert.deepStrictEqual(normInfo({ id: 'ses_1', title: 'T', directory: '/w', createdAt: 5, updatedAt: '1970-01-01T00:00:01.000Z', status: 'waiting', waitingTool: 'bash', lastUserAt: 2, lastReplyAt: 3 }),
    { id: 'ses_1', title: 'T', cwd: '/w', createdAt: 5, lastActiveAt: 1000, status: 'waiting', lastUserAt: 2, lastReplyAt: 3, waitingFor: { kind: 'permission', tool: 'bash' } });
  assert.deepStrictEqual(normInfo({ id: 'ses_3', status: 'waiting', waitingFor: { kind: 'question' } }).waitingFor, { kind: 'question', tool: '' }, 'waiting on an answer to a question');
  assert.deepStrictEqual(normInfo({ sessionId: 'ses_2', status: 'busy' }), { id: 'ses_2', title: '', cwd: '', createdAt: 0, lastActiveAt: 0, status: 'idle', lastUserAt: 0, lastReplyAt: 0 });
  assert.strictEqual(normInfo({ title: 'no id' }), null);
  assert.strictEqual(normInfo(null), null);
});

test('the module is loaded on first use, not before', async () => {
  let loads = 0;
  const calls = [];
  const fake = {
    listSessions: async () => [{ id: 'ses_a', cwd: '/w', status: 'working' }, null, { nope: 1 }],
    createSession: async (cwd, opts) => { calls.push(['create', cwd, opts]); return { id: 'ses_new', cwd }; },
    renameSession: async (...a) => calls.push(['rename', ...a]),
    deleteSession: async (...a) => calls.push(['delete', ...a]),
    openSession: async (id, opts) => ({ id, opts }),
    listModels: async () => [{ id: 'm' }],
    defaultModel: () => 'p/m',
    bedrockStatus: () => ({ state: 'listed', models: 3 }),
    detect: () => ({ path: '/x/opencode' }),
    restart: async (o) => calls.push(['restart', o]),
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
  assert.deepStrictEqual(await b.createSession('/w', { model: 'p/m' }), { id: 'ses_new', cwd: '/w' }, "OpenCode's session object as it is");
  await b.renameSession('ses_a', 'New');
  await b.deleteSession('ses_a');
  assert.deepStrictEqual(await b.session('ses_a', { cwd: '/w' }), { id: 'ses_a', opts: { cwd: '/w' } });
  assert.deepStrictEqual(await b.listModels(), [{ id: 'm' }], 'a list given at once is taken too');
  assert.strictEqual(await b.defaultModel(), 'p/m');
  assert.deepStrictEqual(await b.bedrockStatus(), { state: 'listed', models: 3 });
  assert.deepStrictEqual(await b.detect(), { path: '/x/opencode' });
  await b.restart({ env: { AWS_PROFILE: 'self' } });
  await b.dispose();
  assert.strictEqual(fake.fire, null);
  assert.deepStrictEqual(calls, [['create', '/w', { model: 'p/m' }], ['rename', 'ses_a', 'New'], ['delete', 'ses_a'], ['restart', { env: { AWS_PROFILE: 'self' } }], ['dispose']]);
  assert.strictEqual(loads, 1);
});

test('options may be a function, read when the module loads; restart before that does nothing', async () => {
  let seen = null;
  let reads = 0;
  const b = createBackend({ options: () => { reads++; return { env: { A: '1' } }; }, load: () => ({ createOpenCode: (o) => { seen = o; return { listSessions: async () => [] }; } }) });
  await b.restart({ env: {} });
  assert.strictEqual(reads, 0);
  await b.listSessions();
  assert.deepStrictEqual(seen, { env: { A: '1' } });
  assert.strictEqual(await b.bedrockStatus(), null, 'a module without it answers null');
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

test('one subscribed to session changes before the module loads hears them once it has loaded, without listen()', async () => {
  let emit = null;
  const fake = { listSessions: async () => [], onDidChangeSessions: (fn) => { emit = fn; return { dispose() { emit = null; } }; } };
  const b = createBackend({ load: () => ({ createOpenCode: () => fake }) });
  const heard = [];
  b.onDidChangeSessions((id) => heard.push(id));
  assert.strictEqual(emit, null, 'nothing loaded yet');
  await b.listSessions();
  assert.ok(emit, 'subscribed as the module loaded');
  emit('ses_x');
  assert.deepStrictEqual(heard, ['ses_x']);
  b.listen();
  emit('ses_y');
  assert.deepStrictEqual(heard, ['ses_x', 'ses_y'], 'listen() after it subscribes nothing twice');
});
