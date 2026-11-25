// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* What a steward needs from this extension: every window's conversations, each conversation's latest reply beside its
   plan, deliveries refused while it waits for the user, and the reader's time zone. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const { vscode } = fake.create();
fake.install(vscode);
const ap = require('../../src/host/agentplus-source');
const { createSessionManager } = require('../../src/host/session-manager');
const { createWindowStates } = require('../../src/host/window-states');
const { createReplyFiles, createReplyState, MAX_REPLY_CHARS, MAX_SAID_CHARS } = require('../../src/host/reply-file');
const workplan = require('../../src/workplan');
const { ChatPanel } = require('../../src/ui/chat-panel');
const ui = require('../ui/fake-vscode');
const { createFakeConversation } = require('../ui/fake-conversation');

const A = 'ses_stewardtest00000000000a';
const B = 'ses_stewardtest00000000000b';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-steward-'));
const row = (id, extra = {}) => ({ sessionId: id, title: id, cwd: '/w', state: 'idle', activity: 'stopped', unseen: false, running: true, lastActiveAt: 1, hasPlan: false, ...extra });

function liveManager() {
  const convs = new Map();
  const manager = createSessionManager({
    info: async (id) => ({ id, title: `Title of ${id}`, cwd: '/w', status: 'idle' }),
    makeConversation: async ({ id }) => {
      const listeners = new Set();
      const c = { sent: [], on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, fire: (e) => listeners.forEach((f) => f(e)),
        send(t) { c.sent.push(t); }, abort() {}, dispose() {} };
      convs.set(id, c);
      return c;
    },
  });
  return { manager, convs };
}

test('window files: this window writes what it has open, reads the other running windows, and drops those gone', () => {
  const dir = tmp();
  try {
    let mine = [row(A, { title: 'Mine' })];
    const me = createWindowStates({ dir, pid: 100, alive: (p) => p === 200 || p === 100, list: () => mine, now: () => 5 });
    assert.strictEqual(me.write(), true);
    assert.strictEqual(me.write(), false, 'unchanged, not written again');
    const file = JSON.parse(fs.readFileSync(path.join(dir, '100.json'), 'utf8'));
    assert.deepStrictEqual(file, { format: 1, pid: 100, at: 5, conversations: mine });
    fs.writeFileSync(path.join(dir, '200.json'), JSON.stringify({ format: 1, pid: 200, at: 9, conversations: [row(B, { title: 'Other window', activity: 'waiting', state: 'prompt', waitingFor: { kind: 'permission', tool: 'bash' } }), row(A, { title: 'Stale copy' })] }));
    fs.writeFileSync(path.join(dir, '300.json'), JSON.stringify({ format: 1, pid: 300, at: 1, conversations: [row('ses_gonewindow0000000000')] }));
    fs.writeFileSync(path.join(dir, '400.json'), '{ half');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a window');
    const all = me.readAll();
    assert.deepStrictEqual(all.map((c) => [c.sessionId, c.title]), [[A, 'Mine'], [B, 'Other window']]);
    assert.deepStrictEqual(all[1].waitingFor, { kind: 'permission', tool: 'bash' });
    assert.ok(!fs.existsSync(path.join(dir, '300.json')), 'a window that is not running any more is removed');
    mine = [];
    assert.strictEqual(me.write(), true);
    assert.ok(!fs.existsSync(path.join(dir, '100.json')), 'nothing open, no file');
    mine = [row(A)];
    me.write();
    me.dispose();
    assert.ok(!fs.existsSync(path.join(dir, '100.json')), 'a window going away takes its file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the latest reply: the user\'s last messages and what came after the last one, with steward-peek\'s limits', () => {
  const r = createReplyState();
  for (let i = 1; i <= 7; i++) r.take({ type: 'userMessage', text: `message ${i}`, at: i });
  r.take({ type: 'userMessage', text: 'a plan line the plugin added', at: 8, synthetic: true });
  r.take({ type: 'turnStart', turnId: 't', at: 8 });
  r.take({ type: 'reasoning', delta: 'thinking that is not shown' });
  r.take({ type: 'text', delta: 'First ' });
  r.take({ type: 'text', delta: 'part.' });
  r.take({ type: 'toolCall', id: 'c1', name: 'bash', input: {}, at: 9 });
  r.take({ type: 'toolResult', id: 'c1', content: 'tool output that is not shown', isError: false, at: 9 });
  r.take({ type: 'text', delta: 'Second part.' });
  assert.strictEqual(r.take({ type: 'turnEnd', turnId: 't', reason: 'endTurn', at: 10 }), true);
  assert.deepStrictEqual(r.body(), {
    format: 1, at: 10, lastUserAt: 7, reply: 'First part.\n\nSecond part.',
    said: [3, 4, 5, 6, 7].map((i) => ({ text: `message ${i}`, at: i })),
  });
  r.take({ type: 'userMessage', text: 'x'.repeat(MAX_SAID_CHARS + 10), at: 11 });
  assert.strictEqual(r.body().reply, '', 'a new message starts a new reply');
  assert.strictEqual(r.body().said.at(-1).text, `${'x'.repeat(MAX_SAID_CHARS)}...`);
  r.take({ type: 'text', delta: 'y'.repeat(MAX_REPLY_CHARS * 3) + 'END' });
  r.take({ type: 'turnEnd', reason: 'endTurn', at: 12 });
  const reply = r.body().reply;
  assert.strictEqual(reply.length, MAX_REPLY_CHARS + 3);
  assert.ok(reply.startsWith('...') && reply.endsWith('END'), 'its end is kept');
});

test("the latest reply keeps a steward's message as it came, signed first line included", () => {
  const signed = 'Sent by the steward "Night steward" (bbbbbbbb-1111-4222-8333-444444444444) for the user:\n  Please look at the build.\n';
  const r = createReplyState();
  r.take({ type: 'turnStart', turnId: 't', at: 1 });
  r.take({ type: 'userMessage', text: signed, at: 1 });
  r.take({ type: 'userMessage', text: 'Sent by the steward (aaaaaaaa-1111-4222-8333-444444444444) for the user:\na plugin note', synthetic: true, at: 2 });
  r.take({ type: 'text', delta: 'On it.' });
  r.take({ type: 'turnEnd', reason: 'endTurn', at: 3 });
  assert.deepStrictEqual(r.body().said, [{ text: signed, at: 1 }], 'whole and untrimmed; a synthetic message is not the user\'s');
  const long = `Sent by the steward (aaaaaaaa-1111-4222-8333-444444444444) for the user:\n${'z'.repeat(MAX_SAID_CHARS * 2)}`;
  r.take({ type: 'userMessage', text: long, at: 4 });
  assert.ok(r.body().said.at(-1).text.startsWith('Sent by the steward (aaaaaaaa-1111-4222-8333-444444444444) for the user:\n'), 'a long one is truncated at the end');
});

test('the latest reply file is written beside the plan when a turn ends, from the history on, and deleted with the plan', () => {
  const dir = tmp();
  try {
    const files = createReplyFiles({ dir: () => dir });
    const listeners = new Set();
    const conv = { on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
    const fire = (e) => listeners.forEach((f) => f(e));
    const unfinished = files.track(B, conv, [{ type: 'userMessage', text: 'never answered', at: 1 }]);
    assert.ok(!fs.existsSync(files.fileOf(B)), 'opening a conversation with no finished turn writes nothing');
    unfinished();
    const stop = files.track(A, conv, [{ type: 'userMessage', text: 'from the history', at: 1 }, { type: 'text', delta: 'old reply' }, { type: 'turnEnd', reason: 'endTurn', at: 2 }]);
    const file = path.join(dir, `${A}.reply.json`);
    assert.strictEqual(files.fileOf(A), file);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
      { format: 1, at: 2, lastUserAt: 1, said: [{ text: 'from the history', at: 1 }], reply: 'old reply' },
      'opening a conversation with a finished turn in its history writes that turn at once');
    fire({ type: 'turnStart', at: 3 });
    fire({ type: 'text', delta: 'more of it' });
    fire({ type: 'turnEnd', reason: 'endTurn', at: 4 });
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(body, { format: 1, at: 4, lastUserAt: 1, said: [{ text: 'from the history', at: 1 }], reply: 'old reply\n\nmore of it' });
    stop();
    assert.strictEqual(listeners.size, 0);
    fs.writeFileSync(path.join(dir, `${A}.json`), '{}');
    assert.deepStrictEqual(workplan.removePlan(A, dir).sort(), [`${A}.json`, `${A}.reply.json`]);
    assert.ok(!fs.existsSync(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a delivery to a conversation waiting for an approval or a form is refused with the reason; once that is answered the same delivery goes through', async () => {
  const { manager, convs } = liveManager();
  await manager.open(A);
  const link = ap.createAgentPlusSource({ manager, planDir: () => '/p', reveal: async () => true, openHere: async () => true, trusted: () => true });
  const c = convs.get(A);
  c.fire({ type: 'turnStart', at: 1 });
  c.fire({ type: 'permission', requestId: 'p1', request: { tool: 'bash' } });
  assert.deepStrictEqual(await link.source.deliverAnswer(A, 'go on', { deliveryId: 'd1' }), { outcome: 'notReceived', reason: 'bash is waiting for approval in its window' });
  c.fire({ type: 'permissionSettled', requestId: 'p1', decision: 'allowOnce' });
  c.fire({ type: 'question', requestId: 'q1', message: 'Questions', schema: {} });
  assert.deepStrictEqual((await link.source.listConversations())[0].waitingFor, { kind: 'question' });
  assert.deepStrictEqual(await link.source.deliverAnswer(A, 'go on', { deliveryId: 'd1' }), { outcome: 'notReceived', reason: 'a question in its window is waiting for an answer' });
  c.fire({ type: 'questionSettled', requestId: 'q1', action: 'accept' });
  assert.deepStrictEqual(await link.source.deliverAnswer(A, 'go on', { deliveryId: 'd1' }), { outcome: 'submitted' }, 'the refused id can be tried again');
  assert.deepStrictEqual(c.sent, ['go on']);
  assert.strictEqual(ap.waitReason({ activity: 'waiting', waitingFor: { kind: 'permission' } }), 'a tool is waiting for approval in its window');
  assert.strictEqual(ap.waitReason({ activity: 'working' }), '');
});

test("listAllConversations gives every window's conversations except subagents'; timeZone is the zone the page reported", async () => {
  const { manager } = liveManager();
  await manager.open(A);
  let zone = '';
  const link = ap.createAgentPlusSource({
    manager, planDir: () => '/p', reveal: async () => true, openHere: async () => true, trusted: () => true,
    hidden: (id) => id === 'ses_childofsomeone000000',
    allConversations: async () => [row(A), row(B), row('ses_childofsomeone000000')],
    timeZone: () => zone,
  });
  assert.deepStrictEqual((await link.source.listAllConversations()).map((c) => c.sessionId), [A, B]);
  assert.deepStrictEqual(link.conversations().map((c) => c.sessionId), [A], 'this window\'s, as the window file holds them');
  assert.strictEqual(link.source.timeZone(), '');
  zone = 'America/Los_Angeles';
  assert.strictEqual(link.source.timeZone(), 'America/Los_Angeles');
  const bare = ap.createAgentPlusSource({ manager, planDir: () => '/p', reveal: async () => true, openHere: async () => true });
  assert.deepStrictEqual((await bare.source.listAllConversations()).map((c) => c.sessionId), [A], 'without the window files, this window\'s');
});

test('the chat page reports the zone of the machine it runs on when it loads', async () => {
  const zones = [];
  const panel = ui.createFakePanel();
  const chat = new ChatPanel({ vscode: ui.createFakeVscode(), panel, extensionUri: ui.Uri.file(path.join(__dirname, '..', '..')), conversation: createFakeConversation({ turns: [] }),
    listModels: async () => [], respond: () => {}, onTimeZone: (z) => zones.push(z) });
  panel.fromPage({ type: 'ready', tz: 'Asia/Shanghai' });
  panel.fromPage({ type: 'ready', tz: '../../etc/passwd zone' });
  panel.fromPage({ type: 'ready' });
  assert.deepStrictEqual(zones, ['Asia/Shanghai']);
  chat.dispose();
});
