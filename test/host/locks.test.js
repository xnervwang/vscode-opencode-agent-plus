// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocks, processAlive, windowToken } = require('../../src/host/locks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'na-locks-'));
const ID = '3f2b6c1e-0000-4000-8000-000000000001';

test('takes a free lock and records its pid', () => {
  const dir = tmp();
  const locks = createLocks({ dir, pid: 111, alive: () => true });
  assert.deepStrictEqual(locks.acquire(ID), { ok: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(locks.file(ID), 'utf8')).pid, 111);
  assert.deepStrictEqual(locks.acquire(ID), { ok: true }, 'the holder can take it again');
  assert.deepStrictEqual(fs.readdirSync(dir), [`${ID}.lock`], 'no temporary file is left');
});

test('a live holder in another process keeps it', () => {
  const dir = tmp();
  createLocks({ dir, pid: 111, alive: () => true }).acquire(ID);
  const other = createLocks({ dir, pid: 222, alive: (pid) => pid === 111 });
  assert.deepStrictEqual(other.acquire(ID), { ok: false, pid: 111 });
  assert.strictEqual(other.holder(ID), 111);
  other.release(ID);
  assert.ok(fs.existsSync(other.file(ID)), "release does not remove another process's lock");
});

test('a dead holder, a lock from before the boot and a damaged file are taken over', () => {
  const dir = tmp();
  createLocks({ dir, pid: 111 }).acquire(ID);
  const dead = createLocks({ dir, pid: 222, alive: () => false });
  assert.deepStrictEqual(dead.acquire(ID), { ok: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(dead.file(ID), 'utf8')).pid, 222);

  const old = createLocks({ dir, pid: 333, alive: () => true, booted: () => Date.now() + 1e9 });
  assert.deepStrictEqual(old.acquire(ID), { ok: true }, 'a pid recorded before the last boot is not trusted');

  fs.writeFileSync(old.file(ID), '{not json');
  const next = createLocks({ dir, pid: 444, alive: () => true });
  assert.deepStrictEqual(next.acquire(ID), { ok: true });
  assert.strictEqual(next.holder(ID), 0, 'its own lock is not "another holder"');
});

test('release and releaseAll remove only what this process holds', () => {
  const dir = tmp();
  const locks = createLocks({ dir, pid: 111, alive: () => true });
  const other = '3f2b6c1e-0000-4000-8000-000000000002';
  locks.acquire(ID);
  locks.acquire(other);
  assert.deepStrictEqual(locks.held().sort(), [ID, other].sort());
  locks.release(ID);
  assert.ok(!fs.existsSync(locks.file(ID)));
  locks.releaseAll();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.deepStrictEqual(locks.held(), []);
});

test('a holder asked to let go stops the conversation, releases and answers; the asker then takes it', async (t) => {
  const dir = tmp();
  const holder = createLocks({ dir, pid: 111, alive: () => true });
  t.after(() => holder.dispose());
  const asked = [];
  holder.onTakeover(async (id, req) => { asked.push([id, req.pid]); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepStrictEqual(holder.acquire(ID), { ok: true });
  const asker = createLocks({ dir, pid: 222, alive: (pid) => pid === 111 });
  assert.strictEqual(asker.holder(ID), 111);
  const outcome = await asker.requestTakeover(ID, { timeoutMs: 5000 });
  assert.strictEqual(outcome, 'released');
  assert.deepStrictEqual(asked, [[ID, 222]]);
  assert.deepStrictEqual(holder.held(), [], 'the holder no longer has it');
  assert.deepStrictEqual(asker.acquire(ID), { ok: true });
  assert.deepStrictEqual(fs.readdirSync(dir), [`${ID}.lock`], 'the request and the answer are cleaned up');
});

test('the holder answers a request whatever file the event names, as macOS may name the temporary one', async () => {
  const dir = tmp();
  let fire = null;
  const holder = createLocks({ dir, pid: 111, alive: () => true, watch: (d, fn) => { fire = fn; return { close() {} }; } });
  const asked = [];
  holder.onTakeover((id) => { asked.push(id); });
  holder.acquire(ID);
  fs.writeFileSync(path.join(dir, `${ID}.takeover`), JSON.stringify({ pid: 222, at: Date.now() }));
  fire('rename', `.${ID}.takeover.222.1.tmp`);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(asked, [ID]);
  assert.deepStrictEqual(holder.held(), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${ID}.letgo`), 'utf8')).for, 222);
});

test('when its file watch never fires, a takeover request still sees the answer and is written again while it waits', async () => {
  const dir = tmp();
  createLocks({ dir, pid: 111, alive: () => true, watch: () => ({ close() {} }) }).acquire(ID);
  const asker = createLocks({ dir, pid: 222, alive: (pid) => pid === 111, watch: () => ({ close() {} }) });
  const req = path.join(dir, `${ID}.takeover`);
  const waiting = asker.requestTakeover(ID, { timeoutMs: 5000 });
  const first = JSON.parse(fs.readFileSync(req, 'utf8')).at;
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(JSON.parse(fs.readFileSync(req, 'utf8')).at > first, 'the request was written again');
  fs.writeFileSync(path.join(dir, `${ID}.letgo`), JSON.stringify({ pid: 111, for: 222, at: Date.now() }));
  const started = Date.now();
  assert.strictEqual(await waiting, 'released');
  assert.ok(Date.now() - started < 1000, 'found on the next round of checks, not at the timeout');
});

test('a holder that does not answer times out; force takes the lock anyway', async () => {
  const dir = tmp();
  createLocks({ dir, pid: 111, alive: () => true, watch: () => ({ close() {} }) }).acquire(ID);
  const asker = createLocks({ dir, pid: 222, alive: (pid) => pid === 111 });
  const started = Date.now();
  assert.strictEqual(await asker.requestTakeover(ID, { timeoutMs: 150 }), 'timeout');
  assert.ok(Date.now() - started >= 140);
  assert.deepStrictEqual(asker.acquire(ID), { ok: false, pid: 111 });
  assert.deepStrictEqual(asker.acquire(ID, { force: true }), { ok: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(asker.file(ID), 'utf8')).pid, 222);
  assert.deepStrictEqual(fs.readdirSync(dir), [`${ID}.lock`]);
  assert.strictEqual(await createLocks({ dir, pid: 333, alive: () => false }).requestTakeover(ID), 'free', 'no live holder: nothing to ask');
});

test('the folder is watched only while a lock is held, and old or own requests are ignored', async () => {
  const dir = tmp();
  const watches = [];
  const watch = (d, fn) => { const w = { fn, closed: false, close() { w.closed = true; } }; watches.push(w); return w; };
  const locks = createLocks({ dir, pid: 111, alive: () => true, watch });
  const asked = [];
  locks.onTakeover((id) => { asked.push(id); });
  assert.strictEqual(watches.length, 0);
  locks.acquire(ID);
  assert.strictEqual(watches.length, 1);
  fs.writeFileSync(path.join(dir, `${ID}.takeover`), JSON.stringify({ pid: 111, at: Date.now() }));
  watches[0].fn('rename', `${ID}.takeover`);
  fs.writeFileSync(path.join(dir, `${ID}.takeover`), JSON.stringify({ pid: 222, at: Date.now() - 120000 }));
  watches[0].fn('rename', `${ID}.takeover`);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(asked, [], "its own request and one left behind long ago are not answered");
  assert.deepStrictEqual(locks.held(), [ID]);
  locks.release(ID);
  assert.strictEqual(watches[0].closed, true);
});

test('a lock names its window; ownWindow is true only for another live holder of this same window', () => {
  const dir = tmp();
  const W = '0d6f3c1e-1111-4222-8333-444455556666';
  const old = createLocks({ dir, pid: 111, window: W, alive: () => true });
  assert.deepStrictEqual(old.acquire(ID), { ok: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(old.file(ID), 'utf8')).window, W);
  assert.strictEqual(old.ownWindow(ID), false, 'its own lock is not another holder');
  const reloaded = createLocks({ dir, pid: 222, window: W, alive: (pid) => pid === 111 });
  assert.strictEqual(reloaded.ownWindow(ID), true);
  assert.strictEqual(reloaded.holder(ID), 111, 'it is still a live holder for everything else');
  assert.strictEqual(createLocks({ dir, pid: 333, window: 'another', alive: () => true }).ownWindow(ID), false, 'another window');
  assert.strictEqual(createLocks({ dir, pid: 333, alive: () => true }).ownWindow(ID), false, 'a window with no name');
  assert.strictEqual(createLocks({ dir, pid: 222, window: W, alive: () => false }).ownWindow(ID), false, 'a holder that is gone');
  const rec = JSON.parse(fs.readFileSync(old.file(ID), 'utf8'));
  fs.writeFileSync(old.file(ID), JSON.stringify({ ...rec, host: 'another-machine' }));
  assert.strictEqual(reloaded.ownWindow(ID), false, 'a lock written on another machine');
  fs.writeFileSync(old.file(ID), JSON.stringify({ pid: 111, at: Date.now() }));
  assert.strictEqual(reloaded.ownWindow(ID), false, 'a lock that names no window');
  const unnamed = createLocks({ dir: tmp(), pid: 444, alive: () => true });
  unnamed.acquire(ID);
  assert.strictEqual('window' in JSON.parse(fs.readFileSync(unnamed.file(ID), 'utf8')), false);
});

test('windowToken makes a name once and reads it back; a damaged one is replaced', async () => {
  const store = new Map();
  const memo = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } };
  const first = windowToken(memo, 'k');
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(store.get('k'), first);
  assert.strictEqual(windowToken(memo, 'k'), first, 'the same after a reload');
  store.set('k', '../not a name');
  const fresh = windowToken(memo, 'k');
  assert.notStrictEqual(fresh, first);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(store.get('k'), fresh);
  assert.strictEqual(windowToken(undefined, 'k'), '');
  assert.strictEqual(windowToken({ get() { throw new Error('x'); }, update() { throw new Error('y'); } }, 'k').length, 36);
});

test('processAlive', () => {
  assert.strictEqual(processAlive(process.pid), true);
  assert.strictEqual(processAlive(0), false);
  assert.strictEqual(processAlive(-5), false);
  assert.strictEqual(processAlive('12'), false);
  assert.strictEqual(processAlive(2 ** 22 + 12345), false);
});
