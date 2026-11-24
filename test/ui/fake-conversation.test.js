// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeConversation, streamText, demoTurns } = require('./fake-conversation');
const vm = require('../../src/ui/view-model');

test('plays a scripted turn wrapped in turnStart, userMessage and turnEnd', async () => {
  const c = createFakeConversation({ turns: [[...streamText('Hello there', 4)]], now: () => 1000 });
  const seen = [];
  const off = c.on((ev) => seen.push(ev));
  await c.send('hi');
  await c.idle();
  assert.deepEqual(seen.map((e) => e.type), ['turnStart', 'userMessage', 'text', 'text', 'text', 'turnEnd']);
  assert.equal(seen[1].text, 'hi');
  assert.equal(seen[0].at, 1000);
  assert.equal(seen.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Hello there');
  off();
  await c.send('again');
  await c.idle();
  assert.equal(seen.length, 6, 'no events after unsubscribing');
});

test('waits at a permission request until respond, and queues sends meanwhile', async () => {
  const c = createFakeConversation({ turns: demoTurns() });
  await c.send('fix it');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.busy, true);
  assert.equal(c.events[c.events.length - 1].type, 'permission');
  await c.send('then this');
  assert.equal(c.respond('perm-1', 'allowOnce'), true);
  await c.idle();
  const types = c.events.map((e) => e.type);
  assert.ok(types.includes('permissionSettled'));
  assert.equal(types.filter((t) => t === 'turnStart').length, 2, 'the queued message got its own turn');
  const s = vm.reduceAll(c.events, vm.initialState(), Date.now());
  assert.equal(s.status, 'idle');
  assert.equal(s.items.filter((i) => i.kind === 'figures').length, 2);
});

test('abort ends the turn as aborted, even at a permission request', async () => {
  const c = createFakeConversation({ turns: demoTurns() });
  await c.send('fix it');
  await new Promise((r) => setTimeout(r, 30));
  c.abort();
  await c.idle();
  const last = c.events[c.events.length - 1];
  assert.equal(last.type, 'turnEnd');
  assert.equal(last.reason, 'aborted');
  assert.equal(c.aborts, 1);
});
