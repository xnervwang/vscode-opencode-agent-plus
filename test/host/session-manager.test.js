// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createLocks } = require('../../src/host/locks');
const { createSessionManager, subscribe, validId } = require('../../src/host/session-manager');

const A = '3f2b6c1e-0000-4000-8000-00000000000a';
const B = '3f2b6c1e-0000-4000-8000-00000000000b';

/* A conversation with on(fn), driven by the test through fire(event). */
function fakeConversation() {
  const listeners = new Set();
  return {
    sent: [], aborted: 0, disposed: 0,
    on(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send(text) { this.sent.push(text); return Promise.resolve(); },
    abort() { this.aborted++; },
    dispose() { this.disposed++; },
  };
}

function setup({ infos = {}, looking = false, alive = () => true, pid = 1000, withLocks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-sm-'));
  const locks = createLocks({ dir, pid, alive });
  const made = [];
  const manager = createSessionManager({
    locks: withLocks ? locks : undefined,
    info: async (id, conv) => { conv.askedFor = id; return id in infos ? infos[id] : { id, cwd: '/work/folder', status: 'idle' }; },
    makeConversation: async ({ id }) => { const c = fakeConversation(); c.id = id; made.push(c); return c; },
    isLooking: () => looking,
    now: () => 5000,
  });
  const changes = [];
  manager.onDidChange((e) => changes.push(e.sessionId));
  return { manager, locks, made, changes, dir };
}

test("opens a conversation with the backend's folder and state", async () => {
  const { manager, made, changes } = setup();
  const r = await manager.open(A);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(manager.snapshot(A).cwd, '/work/folder');
  assert.strictEqual(made[0].askedFor, A, 'the info is read with the conversation at hand');
  assert.deepStrictEqual(manager.list(), [{ sessionId: A, title: 'New conversation', cwd: '/work/folder', activity: 'stopped', unseen: false,
    lastActiveAt: 5000, running: true, lastUserAt: 0, lastReplyAt: 0, background: [] }]);
  assert.deepStrictEqual(changes, [A]);
});

test('a saved conversation keeps its folder, title, times and state', async () => {
  const { manager } = setup({ infos: { [A]: { id: A, cwd: '/other', title: 'Fix the build', lastUserAt: 10, lastReplyAt: 20, lastActiveAt: 30, status: 'waiting', waitingFor: { tool: 'bash' } },
    [B]: { id: B, cwd: '/w', status: 'working', createdAt: '2026-11-24T00:00:00.000Z' } } });
  await manager.open(A);
  const s = manager.snapshot(A);
  assert.strictEqual(s.cwd, '/other');
  assert.strictEqual(s.title, 'Fix the build');
  assert.strictEqual(s.lastUserAt, 10);
  assert.strictEqual(s.lastReplyAt, 20);
  assert.strictEqual(s.lastActiveAt, 30);
  assert.strictEqual(s.activity, 'waiting');
  assert.deepStrictEqual(s.waitingFor, { kind: 'permission', tool: 'bash' });
  await manager.open(B);
  assert.strictEqual(manager.snapshot(B).activity, 'working');
  assert.strictEqual(manager.snapshot(B).lastActiveAt, Date.parse('2026-11-24T00:00:00.000Z'), 'date strings are read too');
});

test('a session the backend does not know is not opened', async () => {
  const { manager, locks, made } = setup({ infos: { [A]: null } });
  const r = await manager.open(A);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no such conversation/);
  assert.deepStrictEqual(locks.held(), []);
  assert.strictEqual(made[0].disposed, 1, 'the half-opened conversation is let go');
});

test("without an info function the conversation's own fields are read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-sm-'));
  const manager = createSessionManager({ locks: createLocks({ dir, pid: 1000 }),
    makeConversation: async ({ id }) => Object.assign(fakeConversation(), { id, cwd: '/proj', title: 'From OpenCode', status: 'waiting', waitingTool: 'bash', lastUserAt: 7, lastReplyAt: 8 }) });
  await manager.open(A);
  const s = manager.snapshot(A);
  assert.deepStrictEqual([s.cwd, s.title, s.activity, s.waitingFor.tool, s.lastUserAt, s.lastReplyAt], ['/proj', 'From OpenCode', 'waiting', 'bash', 7, 8]);
});

test('update() brings titles and newer times from a backend list, for open conversations only', async () => {
  const { manager, changes } = setup();
  await manager.open(A);
  changes.length = 0;
  manager.update([{ id: A, title: 'From the server', lastReplyAt: 9000 }, { id: B, title: 'not open' }, null]);
  assert.strictEqual(manager.snapshot(A).title, 'From the server');
  assert.strictEqual(manager.snapshot(A).lastReplyAt, 9000);
  manager.update([{ id: A, title: '', lastReplyAt: 10 }]);
  assert.strictEqual(manager.snapshot(A).title, 'From the server');
  assert.strictEqual(manager.snapshot(A).lastReplyAt, 9000, 'an older time does not win');
  assert.deepStrictEqual(changes, [A]);
  assert.strictEqual(manager.snapshot(B), null);
});

test('without locks a conversation opens all the same', async () => {
  const { manager } = setup({ withLocks: false });
  assert.strictEqual((await manager.open(A)).ok, true);
  manager.disposeAll();
  assert.deepStrictEqual(manager.ids(), []);
});

test('a turn sets the activity to working, a permission request to waiting with its tool, and a reply nobody has looked at is unseen', async () => {
  const { manager, made } = setup();
  await manager.open(A);
  const c = made[0];
  c.fire({ type: 'userMessage', text: 'List the files\nplease', at: 100 });
  c.fire({ type: 'turnStart', turnId: 't1', at: 101 });
  assert.strictEqual(manager.snapshot(A).activity, 'working');
  assert.strictEqual(manager.snapshot(A).lastUserAt, 100);
  assert.strictEqual(manager.snapshot(A).title, 'List the files', 'the first line of the first message stands in for a title');
  c.fire({ type: 'permission', requestId: 'p1', request: { kind: 'command', tool: 'bash', summary: 'ls' } });
  assert.strictEqual(manager.snapshot(A).activity, 'waiting');
  assert.deepStrictEqual(manager.snapshot(A).waitingFor, { kind: 'permission', tool: 'bash' });
  c.fire({ type: 'permissionSettled', requestId: 'p1', decision: 'allowOnce' });
  assert.strictEqual(manager.snapshot(A).activity, 'working');
  assert.strictEqual(manager.snapshot(A).waitingFor, undefined);
  c.fire({ type: 'text', delta: 'Here' });
  c.fire({ type: 'title', title: 'Listing files' });
  c.fire({ type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 200 });
  const s = manager.snapshot(A);
  assert.strictEqual(s.activity, 'stopped');
  assert.strictEqual(s.lastReplyAt, 200);
  assert.strictEqual(s.unseen, true);
  assert.strictEqual(s.title, 'Listing files');
  manager.seen(A);
  assert.strictEqual(manager.snapshot(A).unseen, false);
});

test("a synthetic user message (text a plugin added) sets neither the time of the user's last message nor the title", async () => {
  const { manager, made } = setup();
  await manager.open(A);
  made[0].fire({ type: 'userMessage', text: 'Work plan reminder', synthetic: true, at: 77 });
  assert.strictEqual(manager.snapshot(A).lastUserAt, 0);
  assert.strictEqual(manager.snapshot(A).title, 'New conversation');
});

test('two permission requests: waiting until both are settled', async () => {
  const { manager, made } = setup();
  await manager.open(A);
  const c = made[0];
  c.fire({ type: 'turnStart', turnId: 't', at: 1 });
  c.fire({ type: 'permission', requestId: 'p1', request: { tool: 'edit_file' } });
  c.fire({ type: 'permission', requestId: 'p2', request: { tool: 'bash' } });
  c.fire({ type: 'permissionSettled', requestId: 'p2', decision: 'deny' });
  assert.deepStrictEqual(manager.snapshot(A).waitingFor, { kind: 'permission', tool: 'edit_file' });
  c.fire({ type: 'permissionSettled', requestId: 'p1', decision: 'deny' });
  assert.strictEqual(manager.snapshot(A).activity, 'working');
});

test('a reply the user is looking at and an aborted turn do not mark the conversation unseen', async () => {
  const looking = setup({ looking: true });
  await looking.manager.open(A);
  looking.made[0].fire({ type: 'turnEnd', reason: 'endTurn', at: 9 });
  assert.strictEqual(looking.manager.snapshot(A).unseen, false);

  const away = setup();
  await away.manager.open(A);
  away.made[0].fire({ type: 'turnEnd', reason: 'aborted', at: 9 });
  assert.strictEqual(away.manager.snapshot(A).unseen, false);
  assert.strictEqual(away.manager.snapshot(A).lastReplyAt, 0);
});

test('a conversation another live window runs is not opened here', async () => {
  const { dir } = setup();
  const elsewhere = createLocks({ dir, pid: 4242, alive: () => true });
  elsewhere.acquire(A);
  const manager = createSessionManager({ locks: createLocks({ dir, pid: 1000, alive: () => true }),
    makeConversation: () => { throw new Error('must not be made'); } });
  assert.deepStrictEqual(await manager.open(A), { ok: false, pid: 4242, error: '' });
  assert.strictEqual(manager.has(A), false);
});

test('opening twice at once makes one conversation', async () => {
  const { manager, made } = setup();
  const [r1, r2] = await Promise.all([manager.open(A), manager.open(A)]);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(r1.entry, r2.entry);
});

test('the last panel closing stops a running turn, lets the conversation go and frees its lock', async () => {
  const { manager, made, locks } = setup();
  await manager.open(A);
  made[0].fire({ type: 'turnStart', at: 1 });
  const p1 = {}, p2 = {};
  manager.attach(A, p1);
  manager.attach(A, p2);
  assert.strictEqual(manager.panelOf(A), p2);
  manager.detach(A, p2);
  assert.strictEqual(manager.has(A), true);
  manager.detach(A, p1);
  assert.strictEqual(manager.has(A), false);
  assert.strictEqual(made[0].aborted, 1);
  assert.strictEqual(made[0].disposed, 1);
  assert.ok(!fs.existsSync(locks.file(A)));
  made[0].fire({ type: 'turnStart', at: 1 });
  assert.strictEqual(manager.snapshot(A), null, 'events after closing change nothing');
});

test('closing a stopped conversation aborts nothing', async () => {
  const { manager, made } = setup();
  await manager.open(A);
  const p = {};
  manager.attach(A, p);
  manager.detach(A, p);
  assert.strictEqual(made[0].aborted, 0);
  assert.strictEqual(made[0].disposed, 1);
});

test('send goes to the conversation; disposeAll stops running turns when asked', async () => {
  const { manager, made, locks } = setup();
  await manager.open(A);
  await manager.open(B);
  manager.send(A, 'hello');
  assert.deepStrictEqual(made[0].sent, ['hello']);
  assert.throws(() => manager.send('3f2b6c1e-0000-4000-8000-0000000000ff', 'x'), /not open/);
  made[1].fire({ type: 'turnStart', at: 1 });
  manager.disposeAll({ abort: true });
  assert.deepStrictEqual(manager.ids(), []);
  assert.deepStrictEqual(locks.held(), []);
  assert.strictEqual(made[0].aborted, 0, 'it was not running');
  assert.strictEqual(made[1].aborted, 1);
});

test('a conversation that fails to start gives its lock back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-sm-'));
  const locks = createLocks({ dir, pid: 1000 });
  const lines = [];
  const manager = createSessionManager({ locks, makeConversation: async () => { throw new Error('no provider'); },
    log: (l) => lines.push(l) });
  const r = await manager.open(A);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no provider/);
  assert.deepStrictEqual(locks.held(), []);
  assert.ok(lines.some((l) => l.includes('no provider')));
});

test('ids are checked', async () => {
  const { manager } = setup();
  assert.strictEqual(validId(A), true);
  assert.strictEqual(validId('ses_4f1d2a3b9ffeAbCdEf'), true, "OpenCode's ids");
  for (const bad of ['', '../x', 'a b', '-lead', '_lead', 'x'.repeat(201), null]) assert.strictEqual(validId(bad), false, String(bad));
  assert.strictEqual((await manager.open('../etc')).ok, false);
});

test('subscribe understands onEvent, a Node EventEmitter and on(fn)', () => {
  const seen = [];
  const vsStyle = { onEvent(fn) { this.fn = fn; return { dispose: () => { this.fn = null; } }; } };
  const off1 = subscribe(vsStyle, (e) => seen.push(['vs', e]));
  vsStyle.fn(1);
  off1();
  assert.strictEqual(vsStyle.fn, null);

  const node = new EventEmitter();
  const off2 = subscribe(node, (e) => seen.push(['node', e]));
  node.emit('event', 2);
  off2();
  node.emit('event', 3);

  let fn = null;
  const plain = { on(f) { fn = f; return () => { fn = null; }; } };
  const off3 = subscribe(plain, (e) => seen.push(['plain', e]));
  fn(4);
  off3();
  assert.strictEqual(fn, null);
  /* An emit() of its own does not make a conversation a Node EventEmitter (test/ui/fake-conversation.js has one). */
  let g = null;
  const both = { on(f) { g = f; return () => { g = null; }; }, emit() {} };
  const off4 = subscribe(both, (e) => seen.push(['both', e]));
  g(5);
  off4();
  assert.deepStrictEqual(seen, [['vs', 1], ['node', 2], ['plain', 4], ['both', 5]]);
  assert.strictEqual(typeof subscribe({}, () => {}), 'function');
});

test('a turn over with a background command or subagent still running is background, and stopped once both end', async () => {
  const { manager, made } = setup();
  await manager.open(A);
  const c = made[0];
  c.fire({ type: 'turnStart', turnId: 't1', at: 100 });
  c.fire({ type: 'background', id: 'call_1', kind: 'shell', title: 'npm test', status: 'running', pid: 4321, at: 110 });
  c.fire({ type: 'subagent', childId: 'ses_child', title: 'Look for the bug', status: 'running' });
  assert.strictEqual(manager.snapshot(A).activity, 'working', 'a turn runs: working, whatever runs beside it');
  c.fire({ type: 'turnEnd', reason: 'endTurn', at: 120 });
  const s = manager.snapshot(A);
  assert.strictEqual(s.activity, 'background');
  assert.deepStrictEqual(s.background, [
    { kind: 'command', title: 'npm test', pid: 4321, since: 110 },
    { kind: 'subagent', title: 'Look for the bug', pid: 0, since: 5000 },
  ]);
  c.fire({ type: 'subagent', childId: 'ses_child', title: 'Look for the bug', status: 'done' });
  assert.strictEqual(manager.snapshot(A).activity, 'background', 'the command still runs');
  c.fire({ type: 'background', id: 'call_1', kind: 'shell', title: 'npm test', status: 'done', pid: 4321, at: 130 });
  assert.strictEqual(manager.snapshot(A).activity, 'stopped');
  assert.deepStrictEqual(manager.snapshot(A).background, []);
});
