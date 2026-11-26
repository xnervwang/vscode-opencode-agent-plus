// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Host modules run without an editor: which conversations a page may link to and where a click opens one
 * (src/host/conversation-links.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../../src/host/conversation-links');

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function core(list = []) {
  const fns = new Set();
  return { features: ['allConversations', 'planSummary'], list, listening: () => fns.size,
    allConversations() { return this.list; }, onDidChangeAllConversations: (fn) => { fns.add(fn); return { dispose: () => fns.delete(fn) }; },
    fire: () => { for (const fn of [...fns]) fn(); } };
}

function make(over = {}) {
  const state = { on: true, active: true, own: [{ id: 'ses_own1', title: 'Own one', cwd: '/w', lastActiveAt: 5 }], ownCalls: 0, core: [], own2: [] };
  const l = links.createConversationLinks({
    on: () => state.on,
    active: () => state.active,
    own: async () => { state.ownCalls++; return state.own; },
    openCore: async (t) => { state.core.push(t); },
    openOwn: async (id, handOff) => { state.own2.push([id, handOff]); return over.ownResult === undefined ? true : over.ownResult; },
    ...over.deps,
  });
  return { l, state };
}

test("the list joins Agent Plus's conversations with this extension's own, each once, and its revision moves only when the entries change", async () => {
  const { l, state } = make();
  let fired = 0;
  l.onDidChange(() => fired++);
  const c = core([
    { sourceId: 'opencode-plus', label: 'OpenCode Agent Plus', sessionId: 'ses_own1', title: 'Own one (open)', cwd: '/w', lastActiveAt: 9 },
    { sourceId: 'claude-code', label: 'Claude Code', sessionId: '0f9e8d7c-1111-4222-8333-444455556666', title: 'Other agent', cwd: '/x', lastActiveAt: '2026-11-24T06:00:00Z' },
    { sourceId: 'codex', sessionId: '' },
  ]);
  l.attach(c);
  assert.equal(c.listening(), 1, 'Agent Plus is listened to while a page is open');
  await settle();
  const got = l.current();
  assert.deepEqual(got.list.map((e) => [e.sourceId, e.sessionId, e.title]), [
    ['opencode-plus', 'ses_own1', 'Own one (open)'],
    ['claude-code', '0f9e8d7c-1111-4222-8333-444455556666', 'Other agent'],
  ]);
  assert.equal(got.list[1].lastActiveAt, Date.parse('2026-11-24T06:00:00Z'));
  assert.equal(state.ownCalls, 1);
  const rev = got.rev;
  const before = fired;
  c.fire();
  assert.equal(l.current().rev, rev, 'the same list again is no change');
  assert.equal(fired, before);
  c.list = c.list.concat([{ sourceId: 'codex', label: 'Codex', sessionId: '0f9e8d7c-2222-4222-8333-444455556666', title: 'New', cwd: '' }]);
  c.fire();
  assert.equal(l.current().rev, rev + 1);
  assert.equal(fired, before + 1);
  state.own = state.own.concat([{ id: 'ses_own2', title: 'Second own' }]);
  l.refresh();
  await settle();
  assert.ok(l.current().list.some((e) => e.sessionId === 'ses_own2' && e.sourceId === 'opencode-plus' && e.label === 'OpenCode Agent Plus'));
  l.dispose();
  assert.equal(c.listening(), 0);
});

test('nothing is read while no page is open or the setting is off, and turning the setting off sends the pages an empty list', async () => {
  const { l, state } = make();
  state.active = false;
  const c = core([{ sourceId: 'claude-code', sessionId: '0f9e8d7c-1111-4222-8333-444455556666', title: 'X' }]);
  l.attach(c);
  l.refresh();
  await settle();
  assert.equal(c.listening(), 0);
  assert.equal(state.ownCalls, 0);
  state.active = true;
  l.settingChanged();
  await settle();
  assert.equal(c.listening(), 1);
  assert.ok(l.current().list.length > 0);
  let fired = 0;
  l.onDidChange(() => fired++);
  state.on = false;
  l.settingChanged();
  assert.equal(fired, 1);
  assert.deepEqual(l.current().list, []);
  assert.equal(c.listening(), 0);
  state.active = false;
  state.on = true;
  l.settingChanged();
  assert.equal(c.listening(), 0, 'the last page closed');
});

test('an Agent Plus without allConversations still links this extension\'s own conversations', async () => {
  const { l } = make();
  l.attach({ features: ['planSummary'] });
  await settle();
  assert.deepEqual(l.current().list.map((e) => e.sessionId), ['ses_own1']);
  l.attach(null);
  await settle();
  assert.deepEqual(l.current().list.map((e) => e.sessionId), ['ses_own1']);
});

test('a click opens this extension\'s conversation here, hands one held by another window to Agent Plus, and any other agent\'s to Agent Plus', async () => {
  const { l, state } = make();
  const c = core([{ sourceId: 'claude-code', sessionId: '0f9e8d7c-1111-4222-8333-444455556666', title: 'Other agent', cwd: '/x' }]);
  l.attach(c);
  await settle();
  assert.equal(await l.open('opencode-plus', 'ses_own1'), 'here');
  assert.deepEqual(state.own2, [['ses_own1', true]], 'with Agent Plus, one held elsewhere may be handed to it');
  assert.equal(await l.open('claude-code', '0f9e8d7c-1111-4222-8333-444455556666'), 'agentPlus');
  assert.deepEqual(state.core, [{ sourceId: 'claude-code', sessionId: '0f9e8d7c-1111-4222-8333-444455556666', title: 'Other agent', cwd: '/x' }]);
  assert.equal(await l.open('opencode-plus', ''), 'nowhere');

  const held = make({ ownResult: false });
  held.l.attach(core());
  await settle();
  assert.equal(await held.l.open('opencode-plus', 'ses_own1'), 'agentPlus');
  assert.deepEqual(held.state.core, [{ sourceId: 'opencode-plus', sessionId: 'ses_own1', title: 'Own one', cwd: '/w' }]);

  const alone = make();
  alone.l.attach(null);
  await settle();
  assert.equal(await alone.l.open('opencode-plus', 'ses_own1'), 'here');
  assert.deepEqual(alone.state.own2, [['ses_own1', false]], 'without Agent Plus it opens here, taking it over if need be');
  assert.equal(await alone.l.open('claude-code', 'x-y'), 'nowhere');
  assert.deepEqual(alone.state.core, []);
});

test('a change while the backend\'s sessions are read is read again once that reading ends', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const { l } = make({ deps: { own: async () => { calls++; if (calls === 1) { await gate; return [{ id: 'ses_own1', title: 'Own one', cwd: '/w', lastActiveAt: 5 }]; }
    return [{ id: 'ses_own1', title: 'Own one', cwd: '/w', lastActiveAt: 5 }, { id: 'ses_fork1', title: 'Own one (fork)', cwd: '/w', lastActiveAt: 6 }]; } } });
  l.attach(null);
  await settle(5);
  assert.strictEqual(calls, 1, 'the first reading has begun');
  l.refresh();
  await settle(5);
  assert.strictEqual(calls, 1, 'not read twice at once');
  release();
  await settle(30);
  assert.strictEqual(calls, 2, 'read again after');
  assert.deepStrictEqual(l.list().map((c) => c.sessionId).sort(), ['ses_fork1', 'ses_own1']);
});
