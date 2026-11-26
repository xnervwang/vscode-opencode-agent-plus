// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Host modules run without an editor: which conversations a page may link to and where a click opens one
 * (src/host/conversation-links.js), the closed tabs kept for Recently closed (src/host/recent-closed.js) and how the
 * Conversations view groups them, and the Find Conversation pick (src/host/find-conversation.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../../src/host/conversation-links');
const recentClosed = require('../../src/host/recent-closed');
const { pickItems, findConversation } = require('../../src/host/find-conversation');
const { SessionsView, GROUPS, CONTEXT_RECENT, SHOWN } = require('../../src/ui/sessions-view');
const { createFakeVscode } = require('../ui/fake-vscode');
const fake = require('./fake-vscode');

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

test('Recently closed keeps the tabs closed, most recent first, each once, and outlasts a reload', () => {
  assert.deepEqual(recentClosed.record([{ id: 'a', at: 1 }, { id: 'b', at: 2 }], 'b', 3), [{ id: 'b', at: 3 }, { id: 'a', at: 1 }]);
  assert.deepEqual(recentClosed.record([{ id: 'a', at: 1 }, { bad: 1 }], 'not an id!', 3), [{ id: 'a', at: 1 }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, at: i }));
  assert.equal(recentClosed.record(many, 'new', 99).length, recentClosed.KEEP);
  const store = new Map();
  const memo = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } };
  let t = 100;
  const r = recentClosed.createRecentClosed({ memo, now: () => t });
  let heard = 0;
  r.onDidChange(() => heard++);
  r.add('ses_a'); t++; r.add('ses_b'); t++; r.add('ses_a');
  assert.deepEqual(r.get().map((e) => e.id), ['ses_a', 'ses_b']);
  assert.deepEqual(store.get(recentClosed.KEY), [{ id: 'ses_a', at: 102 }, { id: 'ses_b', at: 101 }]);
  const again = recentClosed.createRecentClosed({ memo });
  assert.deepEqual(again.get().map((e) => e.id), ['ses_a', 'ses_b'], 'read back after a reload');
  r.remove('ses_b');
  assert.deepEqual(r.get().map((e) => e.id), ['ses_a']);
  r.remove('ses_zzz');
  r.clear();
  assert.deepEqual(r.get(), []);
  r.clear();
  assert.equal(heard, 5, 'three closings, one removal and one clearing; nothing for what changed nothing');
});

const NOW = Date.UTC(2026, 10, 24, 15, 0, 0);
const rows = [
  { id: 'a', title: 'Alpha', cwd: '/w', lastActiveAt: NOW - 3600000 },
  { id: 'b', title: 'Bravo', cwd: '/w', lastActiveAt: NOW - 1000 },
  { id: 'c', title: 'Charlie', cwd: '/w', lastActiveAt: NOW - 60000 },
];
function view(open, recent) {
  return new SessionsView({ vscode: createFakeVscode(), listSessions: async () => rows, rename: async () => {}, remove: async () => {},
    isOpenHere: (id) => open.includes(id), recent: () => recent, now: () => NOW });
}

test('Recently closed comes first, most recently closed first, leaving out the open ones and those no longer listed', async () => {
  const v = view(['b'], [{ id: 'gone', at: NOW - 10 }, { id: 'b', at: NOW - 20 }, { id: 'c', at: NOW - 30000 }, { id: 'a', at: NOW - 40000 }]);
  const top = await v.getChildren();
  assert.deepEqual(top.map((g) => g.label), [GROUPS.recent, GROUPS.open, GROUPS.other]);
  assert.equal(GROUPS.recent, 'Recently closed');
  assert.deepEqual((await v.getChildren(top[0])).map((r) => r.id), ['c', 'a']);
  assert.deepEqual((await v.getChildren(top[2])).map((r) => r.id), ['c', 'a'], 'they stay in their own group too');
  const g = v.getTreeItem(top[0]);
  assert.equal(g.contextValue, CONTEXT_RECENT);
  assert.equal(g.description, '2');
  const item = v.getTreeItem(top[0].rows[0]);
  assert.equal(item.id, 'recent:c', 'a row id of its own, as the conversation is listed twice');
  assert.match(item.tooltip, /Tab closed /);
  assert.deepEqual(item.command.arguments, ['c'], 'a click opens it');
  assert.equal(v.find(top[0].rows[0]).id, 'c', 'Rename, Delete and Fork take it');
});

test('Recently closed and one other kind make two groups; with nothing closed the rows are not grouped; Recently closed shows at most SHOWN rows', async () => {
  const one = await view([], [{ id: 'a', at: NOW }]).getChildren();
  assert.deepEqual(one.map((g) => g.label), [GROUPS.recent, GROUPS.other]);
  assert.deepEqual((await view([], []).getChildren()).map((r) => r.id), ['b', 'c', 'a']);
  const lots = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, title: `R${i}`, lastActiveAt: NOW - i }));
  const v = new SessionsView({ vscode: createFakeVscode(), listSessions: async () => lots, rename: async () => {}, remove: async () => {},
    recent: () => lots.map((r, i) => ({ id: r.id, at: NOW - i })), now: () => NOW });
  const top = await v.getChildren();
  assert.equal(top[0].rows.length, SHOWN);
});

test('Find Conversation lists every conversation, newest first, findable by title, id or folder', () => {
  const items = pickItems([
    { id: 'ses_old', title: 'Old one', cwd: '/w/a', lastActiveAt: NOW - 86400000 * 2 },
    { id: 'ses_new', title: '', cwd: '/w/b', lastActiveAt: NOW - 30000 },
    { id: '', title: 'no id' },
  ], { now: NOW, openHere: (id) => id === 'ses_new' });
  assert.deepEqual(items.map((i) => [i.label, i.description, i.detail, i.id]), [
    ['Untitled conversation', 'open in this window · active now', 'ses_new  ·  /w/b', 'ses_new'],
    ['Old one', 'active 2d ago', 'ses_old  ·  /w/a', 'ses_old'],
  ]);
});

test('the pick matches on the id and the folder, and opens the one picked; closing it opens nothing', async () => {
  const { vscode, control } = fake.create();
  const opened = [];
  const run = findConversation({ vscode, list: async () => rows, open: async (id) => { opened.push(id); }, now: () => NOW });
  await settle();
  const qp = control.state.quickPick;
  assert.equal(qp.matchOnDetail, true);
  assert.equal(qp.matchOnDescription, true);
  assert.deepEqual(qp.items.map((i) => i.id), ['b', 'c', 'a']);
  qp.answer((items) => items.find((i) => i.id === 'c'));
  assert.equal(await run, 'c');
  assert.deepEqual(opened, ['c']);
  assert.equal(qp.disposed, true);
  const none = findConversation({ vscode, list: async () => { throw new Error('OpenCode is not running'); }, open: async (id) => { opened.push(id); } });
  await settle();
  const qp2 = control.state.quickPick;
  assert.match(qp2.placeholder, /Couldn't list conversations: OpenCode is not running/);
  qp2.answer(() => null);
  assert.equal(await none, '');
  assert.deepEqual(opened, ['c']);
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
