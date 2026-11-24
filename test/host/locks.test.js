// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocks, processAlive } = require('../../src/host/locks');

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

test('processAlive', () => {
  assert.strictEqual(processAlive(process.pid), true);
  assert.strictEqual(processAlive(0), false);
  assert.strictEqual(processAlive(-5), false);
  assert.strictEqual(processAlive('12'), false);
  assert.strictEqual(processAlive(2 ** 22 + 12345), false);
});
