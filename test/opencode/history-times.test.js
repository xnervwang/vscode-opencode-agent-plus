// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A replayed conversation dated from OpenCode's export (recorded on 2.4.1 and 1.19.6), loading it again after a
 * rewind, and shell commands moved to the background.
 */
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode } = require('../../src/opencode');
const times = require('../../src/opencode/times');
const { fakeStarter } = require('./fake-agent');

const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const CWD = '/work/project';
const BG = 'ses_df2534a3bffe2Zq2ljHj1Y23t9';
const FORK = 'ses_df253107effes96gJ1V26vgNKO';
const ORIGINAL = 'ses_df2534a3cffeV5DpIbep0DaQLs';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function setup(t, script, { exported = {}, alive = () => false, calls = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-times-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter(script);
  const execFile = (file, args, opts, cb) => {
    calls.push(args);
    const id = args[2];
    if (args[0] === 'session' && args[1] === 'export' && exported[id]) return cb(null, exported[id], '');
    return cb(Object.assign(new Error('Command failed'), { code: 1 }), '', 'Session not found');
  };
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version: V2 }), startAcp: starter.start, idleStopMs: 0, execFile, isAlive: alive, ownQuietMs: 300, ownAfterTextMs: 40, exportWaitMs: 2000 });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents, calls };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('the export is read for times: 2.x and 1.x shapes, user messages and tool calls', () => {
  const v2 = times.lookupOf(JSON.parse(fixture('v2-bg-export.json')));
  assert.deepEqual(v2.users.map((u) => u.text.slice(0, 30)), ['Use the shell tool to start th', 'Use the write tool to create a']);
  assert.equal(v2.calls.get('call_f08503fa05bf5cb7a81e0fc99ac1d34d').created > 0, true);
  const v1 = times.lookupOf(JSON.parse(fixture('v1-export.json')));
  assert.deepEqual(v1.users.map((u) => u.text), ['Reply with the word KESTREL only.']);
  assert.deepEqual(v1.messages.get('prt_20dacbfcd001aAEP8SjIdqjzvd'), { created: 1795525754829, done: 1795525754832 });
  assert.equal(v1.messages.get('msg_20dacb8000012mg2thfzifdIMr').done, 1795525754845);
  assert.equal(times.lookupOf({ nope: 1 }), null);
  assert.equal(times.baseId('msg_abc:reasoning:0'), 'msg_abc');
});

test('2.x: opening a conversation dates its replay from the export, not from the moment it was opened', async (t) => {
  const exp = JSON.parse(fixture('v2-bg-export.json'));
  const { oc, calls } = setup(t, 'v2-bgshell.jsonl', { exported: { [BG]: fixture('v2-bg-export.json') } });
  const before = Date.now();
  const s = await oc.openSession(BG, { cwd: CWD });
  assert.deepEqual(calls[0], ['session', 'export', BG, '--standalone']);
  const events = await s.history();
  const users = exp.messages.filter((m) => m.type === 'user');
  const shown = events.filter((e) => e.type === 'userMessage');
  assert.deepEqual(shown.map((e) => e.messageId), users.map((u) => u.id));
  assert.deepEqual(shown.map((e) => e.at), users.map((u) => u.time.created));
  const starts = events.filter((e) => e.type === 'turnStart');
  assert.deepEqual(starts.map((e) => e.at), users.map((u) => u.time.created));
  const tools = exp.messages.flatMap((m) => (m.content || []).filter((p) => p.type === 'tool'));
  const calledAt = Object.fromEntries(events.filter((e) => e.type === 'toolCall').map((e) => [e.id, e.at]));
  for (const p of tools) assert.equal(calledAt[p.id], p.time.created, p.id);
  for (const e of events) if (typeof e.at === 'number') assert.ok(e.at < before, `${e.type} at ${e.at}`);
  const ends = events.filter((e) => e.type === 'turnEnd');
  const lastDone = Math.max(...exp.messages.filter((m) => m.type === 'assistant' && m.time.created < users[1].time.created).map((m) => m.time.completed || 0));
  assert.equal(ends[0].at, lastDone);
  assert.equal(s.lastUserAt, users[users.length - 1].time.created, 'the time of its last message');
  assert.equal(s.lastReplyAt, Math.max(...ends.map((e) => e.at)));
});

test('2.x: a failed export leaves the replay as it was, and says nothing to the user', async (t) => {
  const { oc } = setup(t, 'v2-bgshell.jsonl', { exported: {} });
  const before = Date.now();
  const s = await oc.openSession(BG, { cwd: CWD });
  const events = await s.history();
  assert.ok(events.filter((e) => e.type === 'userMessage').every((e) => e.at >= before));
  assert.equal(s.lastUserAt, 0, 'without the export lastUserAt stays unknown (0)');
});

test('2.x: reload() loads the conversation again with times from a new export, and is refused while a turn runs', async (t) => {
  const { oc, agents, calls } = setup(t, 'v2-bgshell.jsonl', { exported: { [BG]: fixture('v2-bg-export.json') } });
  const s = await oc.openSession(BG, { cwd: CWD });
  s.on((ev) => { if (ev.type === 'permission') s.respondPermission(ev.requestId, 'allowOnce'); });
  const first = await s.history();
  const again = await s.reload();
  assert.equal(agents[0].received.filter((m) => m.method === 'session/load').length, 2);
  assert.equal(calls.filter((a) => a[1] === 'export').length, 2);
  assert.deepEqual(again.filter((e) => e.type === 'userMessage').map((e) => [e.messageId, e.at]), first.filter((e) => e.type === 'userMessage').map((e) => [e.messageId, e.at]));
  const sending = s.send('Use the write tool to create a file named revert-me.txt containing exactly v1. Then reply done.');
  await until(() => s.status !== 'idle');
  await assert.rejects(s.reload(), (e) => e.code === 'busy');
  await sending;
});

test('2.x: the fork of a rewound conversation replays with times from its own export', async (t) => {
  const exp = JSON.parse(fixture('v2-fork-export.json'));
  const { oc } = setup(t, 'v2-rewind.jsonl', { exported: { [FORK]: fixture('v2-fork-export.json'), [ORIGINAL]: fixture('v2-rewind-export.json') } });
  await oc.openSession(ORIGINAL, { cwd: CWD });
  const f = await oc.forkSession(ORIGINAL);
  assert.equal(f.id, FORK);
  const s = await oc.openSession(FORK, { cwd: CWD });
  const shown = (await s.history()).filter((e) => e.type === 'userMessage');
  assert.deepEqual(shown.map((e) => e.text), ['Remember the word OSPREY. Reply with ok.', 'What word did I ask you to remember? If none, say none. One word.']);
  assert.deepEqual(shown.map((e) => e.at), exp.messages.filter((m) => m.type === 'user').map((m) => m.time.created));
});

test('2.x: a shell command moved to the background is reported running, then done once its process is gone', async (t) => {
  let up = true;
  const { oc } = setup(t, 'v2-bgshell.jsonl', { alive: (pid) => up && pid === 79883 });
  const s = await oc.createSession(CWD, {});
  const seen = [];
  s.on((ev) => {
    if (ev.type === 'permission') s.respondPermission(ev.requestId, 'allowOnce');
    if (ev.type === 'background' || ev.type === 'turnStart' || ev.type === 'turnEnd') seen.push(ev);
  });
  await s.send('Use the shell tool to start the command "sleep 20; echo bg-done" in the background, without waiting for it to finish. Then reply with the word started and end your response at once.');
  const running = seen.filter((e) => e.type === 'background');
  assert.equal(running.length, 1);
  assert.deepEqual({ id: running[0].id, kind: running[0].kind, title: running[0].title, status: running[0].status, pid: running[0].pid },
    { id: 'call_f08503fa05bf5cb7a81e0fc99ac1d34d', kind: 'shell', title: 'sleep 20; echo bg-done', status: 'running', pid: 79883 });
  /* The process is gone. When the command ends OpenCode starts a turn of its own, which makes the extension check the process. */
  up = false;
  await until(() => seen.some((e) => e.type === 'background' && e.status === 'done'));
  const own = seen.find((e) => e.type === 'turnStart' && e.unsolicited);
  assert.ok(own, 'the turn OpenCode started itself');
  /* Asking again reports nothing new. */
  const n = seen.length;
  s.checkBackground();
  assert.equal(seen.length, n);
});

test('2.x: a replayed background command shows only while its process still runs', async (t) => {
  const gone = setup(t, 'v2-bgshell.jsonl', { alive: () => false });
  const a = await gone.oc.openSession(BG, { cwd: CWD });
  assert.deepEqual((await a.history()).filter((e) => e.type === 'background'), []);
  const running = setup(t, 'v2-bgshell.jsonl', { alive: (pid) => pid === 79883 });
  const b = await running.oc.openSession(BG, { cwd: CWD });
  const bg = (await b.history()).filter((e) => e.type === 'background');
  assert.deepEqual(bg.map((e) => [e.id, e.status]), [['call_f08503fa05bf5cb7a81e0fc99ac1d34d', 'running']]);
});

test('unplaced replay events take the time of the one before, and a turn without replies ends where it began', () => {
  const look = { messages: new Map([['msg_u1', { created: 100, done: 0 }], ['msg_a1', { created: 110, done: 150 }]]), calls: new Map([['call_1', { created: 120, done: 130 }]]), users: [] };
  const events = [
    { type: 'turnStart', turnId: 'replay-1', at: 9e12 },
    { type: 'userMessage', text: 'hi', at: 9e12, messageId: 'msg_u1' },
    { type: 'reasoning', delta: 'x' },
    { type: 'toolCall', id: 'call_1', name: 'shell', input: {}, at: 9e12 },
    { type: 'toolResult', id: 'call_1', content: '', isError: false, at: 9e12 },
    { type: 'compaction', status: 'completed', at: 9e12 },
    { type: 'turnEnd', turnId: 'replay-1', reason: 'endTurn', at: 9e12 },
    { type: 'turnStart', turnId: 'replay-2', at: 9e12 },
    { type: 'userMessage', text: 'unknown', at: 9e12, messageId: 'msg_zz' },
    { type: 'turnEnd', turnId: 'replay-2', reason: 'endTurn', at: 9e12 },
  ];
  const metas = [{}, { mid: 'msg_u1' }, { mid: 'msg_a1:reasoning:0' }, { call: 'call_1' }, { call: 'call_1' }, {}, {}, {}, {}, {}];
  const out = times.fillTimes(events, metas, look);
  assert.deepEqual(out.map((e) => e.at), [100, 100, 110, 120, 130, 130, 150, 150, 150, 150]);
  assert.equal(events[0].at, 9e12, 'the events given are not changed');
  assert.deepEqual(times.fillTimes(events, metas, null).map((e) => e.at), events.map((e) => e.at));
});

test('1.x: a reply part known only by its message id is not dated before the reasoning ahead of it, though the message was created first', () => {
  const look = times.lookupOf(JSON.parse(fixture('v1-export.json')));
  const events = [
    { type: 'turnStart', turnId: 'replay-1', at: 9e12 },
    { type: 'userMessage', text: 'Reply with the word KESTREL only.', at: 9e12, messageId: 'msg_20dacb7ef001aFhDxICVL0meIJ' },
    { type: 'reasoning', delta: 'x', at: 9e12 },
    { type: 'text', delta: 'KESTREL', at: 9e12 },
    { type: 'turnEnd', turnId: 'replay-1', reason: 'endTurn', at: 9e12 },
  ];
  const metas = [{}, {}, { mid: 'prt_20dacbfcd001aAEP8SjIdqjzvd' }, { mid: 'msg_20dacb8000012mg2thfzifdIMr' }, {}];
  const out = times.fillTimes(events, metas, look);
  assert.deepEqual(out.map((e) => e.at), [1795525752815, 1795525752815, 1795525754829, 1795525754829, 1795525754845]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].at >= out[i - 1].at, `${out[i].type} after ${out[i - 1].type}`);
});

test('after reload() the next turn reports the session\'s whole cost, as a conversation just opened does', async (t) => {
  const { oc } = setup(t, 'v2-bgshell.jsonl', { exported: { [BG]: fixture('v2-bg-export.json') } });
  const s = await oc.openSession(BG, { cwd: CWD });
  const costs = [];
  s.on((ev) => {
    if (ev.type === 'permission') s.respondPermission(ev.requestId, 'allowOnce');
    if (ev.type === 'usage' && typeof ev.costUsd === 'number') costs.push(ev.costUsd);
  });
  await s.send('Use the write tool to create a file named revert-me.txt containing exactly v1. Then reply done.');
  const first = costs.slice();
  await s.reload();
  costs.length = 0;
  await s.send('Use the write tool to create a file named revert-me.txt containing exactly v1. Then reply done.');
  /* The recording's running cost is 0.098 after its first prompt and 0.2499 after its second: after reload() the turn
     reports the whole 0.2499, not the 0.1518 it added. */
  assert.deepEqual(first, [0.09801682]);
  assert.deepEqual(costs, [0.24987127000000003]);
});


test('2.x: each replayed turn gets its usage from the export: the cost of its replies, the context of the last', async (t) => {
  const exp = JSON.parse(fixture('v2-bg-export.json'));
  const { oc } = setup(t, 'v2-bgshell.jsonl', { exported: { [BG]: fixture('v2-bg-export.json') } });
  const s = await oc.openSession(BG, { cwd: CWD });
  const events = await s.history();
  const users = exp.messages.filter((m) => m.type === 'user').map((m) => m.time.created);
  const replies = exp.messages.filter((m) => m.type === 'assistant');
  const turnOf = (m) => users.filter((u) => u <= m.time.created).length - 1;
  const used = (m) => m.tokens.input + m.tokens.output + m.tokens.reasoning + m.tokens.cache.read + m.tokens.cache.write;
  const usage = events.filter((e) => e.type === 'usage');
  assert.equal(usage.length, users.length);
  usage.forEach((u, i) => {
    const mine = replies.filter((m) => turnOf(m) === i);
    assert.ok(Math.abs(u.costUsd - mine.reduce((n, m) => n + m.cost, 0)) < 1e-9, `turn ${i} cost`);
    assert.equal(u.contextUsed, used(mine[mine.length - 1]), `turn ${i} context`);
  });
  /* Each usage event comes right before its turn's turnEnd, with the same time. */
  for (const u of usage) {
    const next = events[events.indexOf(u) + 1];
    assert.equal(next.type, 'turnEnd');
    assert.equal(u.at, next.at);
  }
});

test('a replay without an export, or an export without usage, gets no usage events', () => {
  const events = [{ type: 'turnStart', turnId: 't1' }, { type: 'userMessage', text: 'hi', messageId: 'msg_u' }, { type: 'text', delta: 'yo' }, { type: 'turnEnd', turnId: 't1' }];
  const metas = [{}, { mid: 'msg_u' }, { mid: 'msg_a' }, {}];
  assert.deepEqual(times.fillUsage(events, metas, null).events, events);
  const bare = times.lookupOf({ messages: [{ id: 'msg_u', type: 'user', time: { created: 1 } }, { id: 'msg_a', type: 'assistant', time: { created: 2 } }] });
  assert.deepEqual(times.fillUsage(events, metas, bare).events.map((e) => e.type), ['turnStart', 'userMessage', 'text', 'turnEnd']);
});

test('1.x: a replayed turn names its reply by a part id, and gets that message\'s usage', () => {
  const exp = JSON.parse(fixture('v1-export.json'));
  const look = times.lookupOf(exp);
  const reply = exp.messages.find((m) => m.info.role === 'assistant');
  const part = reply.parts.find((p) => p.type === 'text');
  const user = exp.messages.find((m) => m.info.role === 'user');
  const events = [{ type: 'turnStart', turnId: 't1' }, { type: 'userMessage', text: 'x', messageId: user.info.id }, { type: 'text', delta: 'KESTREL' }, { type: 'turnEnd', turnId: 't1' }];
  const out = times.fillUsage(events, [{}, {}, { mid: part.id }, {}], look);
  const u = out.events.find((e) => e.type === 'usage');
  assert.equal(u.costUsd, reply.info.cost);
  assert.equal(u.contextUsed, reply.info.tokens.total);
  assert.equal(out.metas.length, out.events.length);
});
