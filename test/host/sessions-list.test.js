// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessionsList } = require('../../src/host/sessions-list');

function setup({ here = {}, holders = {} } = {}) {
  const calls = [];
  const backend = {
    listSessions: async () => [{ id: 'a', title: 'Server title', status: 'idle', lastActiveAt: 5 }, { id: 'b', title: 'B', status: 'working' }],
    renameSession: async (id, t) => calls.push(['rename', id, t]),
    deleteSession: async (id) => calls.push(['delete', id]),
  };
  const manager = {
    updates: [],
    update(infos) { this.updates.push(infos); },
    snapshot: (id) => here[id] || null,
    get: (id) => (here[id] ? { id } : null),
    close: (id, o) => calls.push(['close', id, o]),
  };
  const list = createSessionsList({ backend, manager, holder: (id) => holders[id] || 0, closeTabs: async (id) => calls.push(['tabs', id]) });
  return { list, calls, manager };
}

test("the backend's sessions, with what this window knows of those open here", async () => {
  const s = setup({ here: { a: { title: 'Local title', activity: 'waiting' } } });
  const rows = await s.list.list();
  assert.deepStrictEqual(rows.map((r) => [r.id, r.title, r.status]), [['a', 'Local title', 'waiting'], ['b', 'B', 'working']]);
  assert.strictEqual(s.manager.updates.length, 1, 'the open conversations hear of the fresh list');
  assert.strictEqual(s.list.statusOf(rows[0]), 'waiting');
  assert.strictEqual(s.list.statusOf({ status: 'something' }), 'idle');
  assert.strictEqual(s.list.statusOf(null), 'idle');
});

test('rename goes to the backend; delete closes the tab first and refuses one open elsewhere', async () => {
  const s = setup({ here: { a: { title: 'x' } }, holders: { b: 4242 } });
  await s.list.rename('a', 'Renamed');
  assert.deepStrictEqual(s.manager.updates.at(-1), [{ id: 'a', title: 'Renamed' }]);
  await s.list.remove('a');
  await assert.rejects(s.list.remove('b'), /open in another window/);
  assert.deepStrictEqual(s.calls, [['rename', 'a', 'Renamed'], ['tabs', 'a'], ['close', 'a', { abort: true }], ['delete', 'a']]);
});
