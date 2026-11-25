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

test('a scripted question waits for respondQuestion, and abort ends a long wait at once', async () => {
  const c = createFakeConversation({ turns: [] });
  c.script([{ type: 'question', requestId: 'q-1', message: 'Which?', schema: { type: 'object', properties: { a: { type: 'string' } } } }, ...streamText('ok')]);
  await c.send('ask me');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.events[c.events.length - 1].type, 'question');
  assert.equal(c.respondQuestion('nope', { action: 'accept' }), false, 'no such question');
  assert.equal(c.respondQuestion('q-1', { action: 'accept', content: { a: 'x' } }), true);
  await c.idle();
  const settled = c.events.find((e) => e.type === 'questionSettled');
  assert.deepEqual([settled.requestId, settled.action], ['q-1', 'accept']);
  c.script([{ wait: 600000 }]);
  const started = Date.now();
  await c.send('wait');
  await new Promise((r) => setTimeout(r, 20));
  c.abort();
  await c.idle();
  assert.ok(Date.now() - started < 2000, 'the wait ended with the abort');
  assert.equal(c.events[c.events.length - 1].reason, 'aborted');
});

test('a function step gets the answer to each request and plays the steps it returns', async () => {
  const c = createFakeConversation({ turns: [] });
  c.script([
    { type: 'permission', requestId: 'p-1', request: { kind: 'execute', tool: 'bash', summary: 'ls' } },
    { type: 'question', requestId: 'q-1', message: 'Which?', schema: { type: 'object', properties: { a: { type: 'string' } } } },
    (got) => [{ type: 'text', delta: `${got['p-1']} ${got['q-1'].content.a}` }],
    () => undefined,
    null,
  ]);
  await c.send('go');
  await new Promise((r) => setTimeout(r, 20));
  c.respond('p-1', 'allowOnce');
  await new Promise((r) => setTimeout(r, 20));
  c.respondQuestion('q-1', { action: 'accept', content: { a: 'blue' } });
  await c.idle();
  assert.equal(c.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'allowOnce blue');
  assert.equal(c.events[c.events.length - 1].reason, 'endTurn');
});

test('start plays a turn the agent begins itself after the current one, with no user message', async () => {
  const c = createFakeConversation({ turns: [[{ wait: 30 }, ...streamText('first')]] });
  await c.send('hi');
  await c.start([...streamText('on my own')]);
  await c.idle();
  const starts = c.events.filter((e) => e.type === 'turnStart');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].unsolicited, undefined);
  assert.equal(starts[1].unsolicited, true);
  assert.equal(c.events.filter((e) => e.type === 'userMessage').length, 1, 'only the sent message');
  assert.deepEqual(c.sent, ['hi']);
  const last = c.events.slice(c.events.lastIndexOf(starts[1]));
  assert.deepEqual(last.map((e) => e.type), ['turnStart', 'text', 'turnEnd']);
});

test('turnStart gets the fields turnStart() returns at that moment, and the user message gets an id', async () => {
  let effort = 'low';
  let n = 0;
  const c = createFakeConversation({ turns: [], turnStart: () => ({ effort }), messageId: () => `msg_${++n}` });
  await c.send('one');
  await c.idle();
  effort = 'high';
  await c.send('two');
  await c.idle();
  assert.deepEqual(c.events.filter((e) => e.type === 'turnStart').map((e) => e.effort), ['low', 'high']);
  assert.deepEqual(c.events.filter((e) => e.type === 'userMessage').map((e) => [e.text, e.messageId]), [['one', 'msg_1'], ['two', 'msg_2']]);
});
