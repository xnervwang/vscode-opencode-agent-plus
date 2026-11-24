// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fake-vscode');

const { vscode, control } = fake.create();
fake.install(vscode);
const ap = require('../../src/host/agentplus-source');

const A = '3f2b6c1e-0000-4000-8000-00000000000a';
const B = '3f2b6c1e-0000-4000-8000-00000000000b';

function fakeManager(rows = {}) {
  const sent = [];
  const panels = new Map();
  return {
    sent, panels,
    has: (id) => id in rows,
    list: () => Object.values(rows),
    panelOf: (id) => panels.get(id) || null,
    send(id, text) { if (!(id in rows)) throw new Error('not open'); if (rows[id].fail) throw new Error('the conversation is closing'); sent.push([id, text]); },
  };
}

function make(manager, more = {}) {
  const calls = { reveal: [], openHere: [] };
  const made = ap.createAgentPlusSource({
    manager,
    planDir: () => '/home/u/.new-agent/plans',
    logo: () => ({ light: vscode.Uri.file('/ext/l.svg'), dark: vscode.Uri.file('/ext/d.svg') }),
    reveal: async (id) => { calls.reveal.push(id); return true; },
    openHere: async (id) => { calls.openHere.push(id); return true; },
    trusted: () => true,
    ...more,
  });
  return { ...made, calls };
}

test('identity members', () => {
  const { source } = make(fakeManager());
  assert.strictEqual(source.protocol, 1);
  assert.strictEqual(source.id, 'new-agent');
  assert.strictEqual(source.label, 'New Agent');
  assert.strictEqual(source.extensionId, 'xnervwang.new-agent');
  assert.deepStrictEqual(source.features, ['shows', 'openHere']);
  assert.strictEqual(source.logo.light.fsPath, '/ext/l.svg');
  assert.strictEqual(source.planDir(), '/home/u/.new-agent/plans');
  assert.strictEqual(source.planPath(A), `/home/u/.new-agent/plans/${A}.json`);
  assert.strictEqual(source.planPath('../x'), null);
  assert.strictEqual(source.planPath(undefined), null);
  const broken = make(fakeManager(), { logo: () => { throw new Error('no file'); } }).source;
  assert.strictEqual(broken.logo, null);
});

test('sessionForTab: ours by viewType and scheme, null for any other tab', () => {
  const { source } = make(fakeManager());
  assert.strictEqual(source.sessionForTab(control.chatTab(A)), A);
  assert.strictEqual(source.sessionForTab({ input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'newagent-session', path: '/' }), 'newAgent.chat') }), '');
  assert.strictEqual(source.sessionForTab({ input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', path: `/${A}` }), 'chatgpt.conversationEditor') }), null);
  assert.strictEqual(source.sessionForTab(control.fileTab('/w/a.txt')), null);
  assert.strictEqual(source.sessionForTab({ input: new vscode.TabInputWebview('mainThreadWebview-newAgent.chat') }), null);
  assert.strictEqual(source.sessionForTab(undefined), null);
  assert.strictEqual(ap.sessionOfUri(ap.uriOf(A)), A);
});

test('isFocused follows the active tab, and the last focus report while no tab is active', () => {
  const made = make(fakeManager());
  const { source } = made;
  control.setTabs([control.chatTab(A), control.chatTab(B)], 0);
  assert.strictEqual(source.isFocused(A), true);
  assert.strictEqual(source.isFocused(B), false);
  control.setTabs([control.fileTab('/w/a.txt'), control.chatTab(A)], 0);
  made.focus(A);
  assert.strictEqual(source.isFocused(A), false, 'a tab not ours in front means false');
  control.setTabs([], -1);
  made.focus(B);
  assert.strictEqual(source.isFocused(B), true);
  made.tabsChanged(control.fileTab('/w/b.txt'));
  assert.strictEqual(source.isFocused(B), false);
  assert.strictEqual(source.isFocused(''), false);
});

test('focus reports and refocus fire onDidFocus', () => {
  const made = make(fakeManager());
  const got = [];
  made.source.onDidFocus((e) => got.push(e.sessionId));
  made.focus(A);
  made.focus('');
  control.setTabs([control.chatTab(B)], 0);
  made.refocus();
  assert.deepStrictEqual(got, [A, B]);
});

test('listConversations gives the protocol fields', async () => {
  const rows = {
    [A]: { sessionId: A, title: 'Fix the build', cwd: '/w', activity: 'waiting', waitingFor: { kind: 'permission', tool: 'bash' }, unseen: true,
      lastActiveAt: 30, running: true, lastUserAt: 10, lastReplyAt: 20 },
    [B]: { sessionId: B, title: '', cwd: '/w', activity: 'stopped', unseen: false, lastActiveAt: 5, running: true, lastUserAt: 0, lastReplyAt: 0 },
  };
  const { source } = make(fakeManager(rows));
  const list = await source.listConversations();
  assert.deepStrictEqual(list[0], { sessionId: A, title: 'Fix the build', cwd: '/w', state: 'prompt', activity: 'waiting', unseen: true, running: true,
    lastActiveAt: 30, hasPlan: false, lastUserAt: 10, lastReplyAt: 20, waitingFor: { kind: 'permission', tool: 'bash' } });
  assert.deepStrictEqual(list[1], { sessionId: B, title: 'New conversation', cwd: '/w', state: 'idle', activity: 'stopped', unseen: false, running: true,
    lastActiveAt: 5, hasPlan: false });
  assert.strictEqual(ap.stateOf({ activity: 'working' }), 'working');
  assert.strictEqual(ap.stateOf({ activity: 'stopped', unseen: true }), 'unread');
  assert.deepStrictEqual(ap.toConversation({ sessionId: A, activity: 'waiting' }).waitingFor, { kind: 'permission' });
});

test('onDidChangeConversations fires on changed()', () => {
  const made = make(fakeManager());
  let n = 0;
  made.source.onDidChangeConversations(() => n++);
  made.changed();
  assert.strictEqual(n, 1);
});

test('reveal, shows and openHere', async () => {
  const manager = fakeManager({ [A]: { sessionId: A } });
  const made = make(manager);
  assert.strictEqual(await made.source.reveal(B), false, 'not open here: the core asks the other windows');
  assert.strictEqual(await made.source.reveal(A), true);
  assert.deepStrictEqual(made.calls.reveal, [A]);
  assert.strictEqual(made.source.shows(A), false);
  manager.panels.set(A, {});
  assert.strictEqual(made.source.shows(A), true);
  assert.strictEqual(await made.source.openHere(B), true);
  assert.strictEqual(await made.source.openHere('../x'), false);
  const failing = make(manager, { reveal: async () => { throw new Error('gone'); } });
  assert.strictEqual(await failing.source.reveal(A), false);
});

test('deliverAnswer types one delivery once and lets one that did not arrive be retried', async () => {
  const rows = { [A]: { sessionId: A } };
  const manager = fakeManager(rows);
  const { source } = make(manager);
  assert.strictEqual(source.canDeliver(A), true);
  assert.strictEqual(source.canDeliver(B), false);
  const [r1, r2] = await Promise.all([source.deliverAnswer(A, 'yes', { deliveryId: 'd1' }), source.deliverAnswer(A, 'yes', { deliveryId: 'd1' })]);
  assert.deepStrictEqual(r1, { outcome: 'submitted' });
  assert.strictEqual(r1, r2);
  assert.deepStrictEqual(manager.sent, [[A, 'yes']]);

  const miss = await source.deliverAnswer(B, 'no', { deliveryId: 'd2' });
  assert.strictEqual(miss.outcome, 'notReceived');
  rows[B] = { sessionId: B };
  assert.deepStrictEqual(await source.deliverAnswer(B, 'no', { deliveryId: 'd2' }), { outcome: 'submitted' });

  rows[A].fail = true;
  const failed = await source.deliverAnswer(A, 'x', {});
  assert.strictEqual(failed.outcome, 'notReceived');
  assert.match(failed.reason, /closing/);
});

test('nothing is typed into a conversation of an untrusted workspace', async () => {
  const manager = fakeManager({ [A]: { sessionId: A } });
  const { source } = make(manager, { trusted: () => false });
  assert.strictEqual(source.canDeliver(A), false);
  assert.strictEqual((await source.deliverAnswer(A, 'x', { deliveryId: 'z' })).outcome, 'notReceived');
  assert.strictEqual(await source.openHere(A), false);
  assert.deepStrictEqual(manager.sent, []);
});

test('register: no Agent Plus, accepted, refused, throwing', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const src = make(fakeManager()).source;
  control.state.extensions.delete(ap.CORE_ID);
  assert.strictEqual((await ap.register(src, { log })).code, 'no-core');

  const disposed = [];
  const core = { version: '1.3.0', registerSource: (s) => (s === src ? { accepted: true, code: '', reason: '', registration: { dispose: () => disposed.push(1) } } : null) };
  control.state.extensions.set(ap.CORE_ID, { isActive: true, exports: { agentPlus: core } });
  const ok = await ap.register(src, { log });
  assert.strictEqual(ok.accepted, true);
  ok.registration.dispose();
  assert.deepStrictEqual(disposed, [1]);

  core.registerSource = () => ({ accepted: false, code: 'core-too-old', reason: 'protocol 1 is newer', registration: null });
  assert.deepStrictEqual(await ap.register(src, { log }), { accepted: false, code: 'core-too-old', reason: 'protocol 1 is newer', registration: null });

  core.registerSource = () => { throw new Error('boom'); };
  assert.strictEqual((await ap.register(src, { log })).code, 'failed');

  control.state.extensions.set(ap.CORE_ID, { isActive: false, activate: async () => { throw new Error('bad'); } });
  assert.strictEqual((await ap.register(src, { log })).code, 'no-core');
  control.state.extensions.set(ap.CORE_ID, { isActive: true, exports: {} });
  assert.strictEqual((await ap.register(src, { log })).code, 'no-core');
  assert.ok(lines.some((l) => /core-too-old/.test(l)));
});
