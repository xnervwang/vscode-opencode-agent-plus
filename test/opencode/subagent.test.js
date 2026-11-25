// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Subagents on OpenCode 2.4.1, tested against recordings: their sessions kept out of the list, the turn OpenCode starts in the
 * parent when one finishes, a retry, and the mode and effort settings.
 */
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode } = require('../../src/opencode');
const { fakeStarter } = require('./fake-agent');
const vm = require('../../src/ui/view-model');

const V1 = { major: 1, minor: 19, patch: 6, text: '1.19.6' };
const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const CWD = '/work/project';
const GROK = 'amazon-bedrock/us.xai.grok-4.7';
const PARENT = 'ses_df344a772ffeuYwN4u7YoTQnyv';
const CHILD = 'ses_df3449ad2fferB4flZgQI8hkdG';

function setup(t, script, version, more = {}) {
  const root = more.root || fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-sub-'));
  if (!more.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter(script, more.extra || []);
  const calls = [];
  const execFile = more.execFile || ((file, args, opts, cb) => { calls.push(args); cb(new Error('not expected')); });
  const oc = createOpenCode({
    root,
    findOpenCode: () => ({ path: '/fake/bin/opencode', version }),
    startAcp: starter.start,
    idleStopMs: 0,
    execFile,
    ownQuietMs: 300,
    ownAfterTextMs: 40,
  });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents, root, calls };
}

const types = (evs) => evs.map((e) => e.type);
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('2.x: a subagent\'s session is learned from child_update and kept out of the list', async (t) => {
  const { oc, agents, root, calls } = setup(t, 'v2-subagent.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  assert.equal(s.id, PARENT);
  const init = agents[0].received.find((m) => m.method === 'initialize');
  assert.equal(init.params.clientCapabilities._meta['opencode/child-session-updates'], true, 'the capability is declared');
  s.on((ev) => { if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce')); });
  await s.send('Use the subagent tool to start one subagent…');
  await until(() => oc.isChild(CHILD));
  await until(() => s.status === 'idle' && agents[0].playedAfter.length === 22);
  const list = await oc.listSessions();
  assert.deepEqual(list.map((x) => x.id), [PARENT]);
  assert.deepEqual(calls, [], 'both were known without asking OpenCode');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'opencode-sessions.json'), 'utf8'));
  assert.deepEqual(saved.parents, { [PARENT]: '', [CHILD]: PARENT });
});

test('2.x: when a subagent finishes, the turn OpenCode then starts in the parent is reported, and ends once it goes quiet', async (t) => {
  const { oc } = setup(t, 'v2-subagent.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  const events = [];
  const statusAtAsk = [];
  s.on((ev) => {
    events.push(ev);
    if (ev.type === 'permission') {
      statusAtAsk.push(s.status);
      setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce'));
    }
  });
  const first = await s.send('Use the subagent tool to start one subagent…');
  assert.equal(first.reason, 'endTurn');
  const mine = events.splice(0);
  assert.equal(mine.filter((e) => e.type === 'turnStart').length, 1);

  await until(() => events.some((e) => e.type === 'turnEnd'));
  const all = events.splice(0);
  const own = all.slice(all.findIndex((e) => e.type === 'turnStart'));
  assert.ok(all.slice(0, all.indexOf(own[0])).every((e) => e.type === 'title' || e.type === 'subagent'), "only the title of the turn before and the subagent's progress come first");
  const start = own[0];
  assert.equal(start.type, 'turnStart');
  assert.equal(start.unsolicited, true);
  assert.equal(start.modelId, GROK);
  assert.ok(!own.some((e) => e.type === 'userMessage'), 'no user message: nobody wrote one');
  const kinds = types(own);
  for (const k of ['permission', 'permissionSettled', 'reasoning', 'toolCall', 'toolResult', 'text']) assert.ok(kinds.includes(k), k);
  assert.equal(own.filter((e) => e.type === 'permission').length, 2, "the subagent's request and the parent's own");
  assert.deepEqual(statusAtAsk, ['waiting', 'waiting']);
  assert.equal(own.filter((e) => e.type === 'turnStart').length, 1, 'one turn, not one per step');
  const end = own[own.length - 1];
  assert.equal(end.type, 'turnEnd');
  assert.equal(end.reason, 'endTurn');
  assert.equal(end.turnId, start.turnId);
  assert.match(own.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /seed\.txt contains: seed/);
  assert.equal(s.status, 'idle');
  assert.equal(s.lastReplyAt, end.at);
  const results = new Set(own.filter((e) => e.type === 'toolResult').map((e) => e.id));
  for (const call of own.filter((e) => e.type === 'toolCall')) assert.ok(results.has(call.id), `${call.name} ${call.id} ends`);
  assert.ok(own.some((e) => e.type === 'toolCall' && e.id.startsWith(`${CHILD}:`)), "the subagent's asking tool is drawn");

  const view = vm.reduceAll([...mine, ...own], vm.initialState(), 1);
  assert.ok(view.items.some((it) => it.kind === 'notice' && /started this turn on its own/.test(it.text)), 'the page says why a reply came');
  assert.equal(view.status, 'idle');
});

test('2.x: Stop ends such a turn', async (t) => {
  const { oc } = setup(t, 'v2-subagent.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  const events = [];
  s.on((ev) => {
    events.push(ev);
    if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce'));
  });
  await s.send('Use the subagent tool to start one subagent…');
  await until(() => events.some((e) => e.type === 'turnStart' && e.unsolicited));
  s.abort();
  const ends = events.filter((e) => e.type === 'turnEnd');
  assert.equal(ends[ends.length - 1].reason, 'aborted', 'Stop ends it');
  assert.equal(s.status, 'idle');
});

test('2.x: sessions nobody here has seen are looked up once with `opencode api --standalone session.list`', async (t) => {
  const A = 'ses_df3c3e455ffe3KZVShQ00LZ15D';
  const B = 'ses_df3c4ce95ffeUPMXgrnL6AjyQW';
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, env: opts.env });
    cb(null, JSON.stringify({ data: [{ id: A }, { id: B, parentID: A }], cursor: {} }), '');
  };
  const { oc } = setup(t, 'v2-load.jsonl', V2, { execFile });
  const list = await oc.listSessions();
  assert.equal(list.length, 2);
  assert.ok(!list.some((x) => x.id === B));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/fake/bin/opencode');
  assert.deepEqual(calls[0].args, ['api', 'session.list', '--param', 'limit=200', '--standalone']);
  assert.equal(calls[0].env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  await oc.listSessions();
  assert.equal(calls.length, 1, 'an id not listed by it counts as a root and is not looked up again');
  assert.equal(oc.isChild(B), true);
});

test('a subagent session another window recorded stays out of the list; 1.x is never looked up; after a failed lookup the rest all show', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-sub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'opencode-sessions.json'), JSON.stringify({ format: 1, parents: { ses_df3c4ce95ffeUPMXgrnL6AjyQW: 'ses_df3c3e455ffe3KZVShQ00LZ15D' } }));
  const v2 = setup(t, 'v2-load.jsonl', V2, { root, execFile: (f, a, o, cb) => { v2calls.push(a); cb(new Error('boom')); } });
  const v2calls = [];
  const list = await v2.oc.listSessions();
  assert.equal(list.length, 2, 'the child another window recorded is hidden; the failed lookup leaves the rest');
  assert.equal(v2calls.length, 1);
  assert.equal((await v2.oc.listSessions()).length, 2);
  assert.equal(v2calls.length, 1);

  const v1 = setup(t, 'v1-load.jsonl', V1);
  await v1.oc.listSessions();
  assert.deepEqual(v1.calls, []);
});

test('2.x: a retry OpenCode schedules becomes a retry event, cleared when the next try starts', async (t) => {
  const { oc } = setup(t, 'v2-retry.jsonl', V2);
  const s = await oc.createSession(CWD, { model: 'fakeup/m1' });
  const events = [];
  s.on((ev) => events.push(ev));
  const end = await s.send('Say hello.');
  assert.equal(end.reason, 'endTurn');
  const retries = events.filter((e) => e.type === 'retry');
  assert.equal(retries.length, 2);
  assert.equal(retries[0].attempt, 2);
  assert.equal(retries[0].error.kind, 'unavailable');
  assert.match(retries[0].error.message, /overloaded/);
  assert.ok(retries[0].waitMs >= 0);
  assert.equal(retries[1].attempt, 0);
  const at = (i) => types(events).indexOf(i);
  assert.ok(events.indexOf(retries[1]) < events.findIndex((e) => e.type === 'text'));
  assert.ok(at('retry') > at('turnStart'));
  let st = vm.initialState();
  for (const ev of events.slice(0, events.indexOf(retries[0]) + 1)) st = vm.reduce(st, ev, 10);
  assert.equal(st.retry.attempt, 2);
  assert.match(st.retry.error, /Model unavailable: The fake upstream is overloaded/);
  st = vm.reduce(st, retries[1], 11);
  assert.equal(st.retry, null);
});

test('2.x: mode and effort come from configOptions; setting one keeps the value asked for over a stale answer', async (t) => {
  const { oc, agents } = setup(t, 'v2-options.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  const byId = () => Object.fromEntries(s.options().map((o) => [o.id, o.value]));
  assert.deepEqual(s.options().map((o) => o.id), ['mode', 'effort']);
  assert.deepEqual(byId(), { mode: 'build', effort: 'default' });
  assert.deepEqual(s.options().find((o) => o.id === 'effort').values.map((v) => v.value), ['low', 'medium', 'high', 'xhigh', 'default'], 'the effort values of the model now chosen');
  const seen = [];
  s.on((ev) => { if (ev.type === 'options') seen.push(Object.fromEntries(ev.options.map((o) => [o.id, o.value]))); });
  await s.setOption('effort', 'low');
  assert.deepEqual(byId(), { mode: 'build', effort: 'low' });
  await s.setOption('mode', 'plan');
  assert.deepEqual(byId(), { mode: 'plan', effort: 'low' });
  await s.setOption('mode', 'build');
  assert.equal(byId().mode, 'build', 'OpenCode answered with the old mode; the one asked for stays');
  assert.deepEqual(seen, [{ mode: 'build', effort: 'low' }, { mode: 'plan', effort: 'low' }, { mode: 'build', effort: 'low' }],
    'an update of the earlier change, sent while the request ran, did not show plan again');
  const sets = agents[0].received.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]);
  assert.deepEqual(sets, [['model', GROK], ['effort', 'low'], ['mode', 'plan'], ['mode', 'build']]);
  await assert.rejects(s.setOption('effort', 'turbo'), /not one of the effort values/);
  await assert.rejects(s.setOption('speed', 'fast'), /no speed setting/);

  const events = [];
  s.on((ev) => { events.push(ev); if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce')); });
  await s.send('Use the subagent tool…');
  assert.equal(byId().mode, 'build', "OpenCode's own update during the turn says build too");
  const start = events.find((e) => e.type === 'turnStart');
  assert.equal(start.effort, 'low', 'the turn says which effort it ran with');
  const view = vm.reduceAll(events, vm.initialState(), 1);
  const figures = view.items.find((it) => it.kind === 'figures');
  assert.match(figures.text, /grok-4\.7 low$/);
});

test('2.x: a setting changed while a turn runs is sent before the next message', async (t) => {
  const { oc, agents } = setup(t, 'v2-options.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  let changed = null;
  s.on((ev) => {
    if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce'));
    if (ev.type === 'text' && !changed) changed = s.setOption('effort', 'low');
  });
  await s.send('first');
  await changed;
  const before = agents[0].received.filter((m) => m.method === 'session/set_config_option').length;
  assert.equal(before, 1, 'not sent while the turn ran');
  assert.equal(s.options().find((o) => o.id === 'effort').value, 'low', 'shown as chosen meanwhile');
  await s.send('second');
  const methods = agents[0].methods();
  const i = methods.lastIndexOf('session/prompt');
  assert.equal(methods[i - 1], 'session/set_config_option');
});

test('2.x: an effort picked just before a message applies to that turn, though OpenCode has not confirmed it yet', async (t) => {
  const { oc, agents } = setup(t, 'v2-options.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  const events = [];
  s.on((ev) => { events.push(ev); if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce')); });
  const picked = s.setOption('effort', 'low');
  assert.equal(s.options().find((o) => o.id === 'effort').value, 'low', 'shown as picked at once');
  const done = s.send('Use the subagent tool…');
  const start = events.find((e) => e.type === 'turnStart');
  assert.equal(start.effort, 'low', 'the turn began before OpenCode answered, and still names the effort');
  await picked;
  await done;
  const methods = agents[0].methods();
  const sets = agents[0].received.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]);
  assert.deepEqual(sets, [['model', GROK], ['effort', 'low']], 'sent once');
  assert.ok(methods.lastIndexOf('session/set_config_option') < methods.indexOf('session/prompt'), 'set before the message went');
  const figures = vm.reduceAll(events, vm.initialState(), 1).items.find((it) => it.kind === 'figures');
  assert.match(figures.text, /grok-4\.7 low$/);
});

test('2.x: two settings picked at once are each sent once, in the order picked', async (t) => {
  const { oc, agents } = setup(t, 'v2-options.jsonl', V2);
  const s = await oc.createSession(CWD, { model: GROK });
  const a = s.setOption('effort', 'low');
  const b = s.setOption('mode', 'plan');
  await Promise.all([a, b]);
  const sets = agents[0].received.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]);
  assert.deepEqual(sets, [['model', GROK], ['effort', 'low'], ['mode', 'plan']]);
  assert.deepEqual(s.options().map((o) => [o.id, o.value]), [['mode', 'plan'], ['effort', 'low']]);
});

test('1.x lists mode too: settings follow what OpenCode offers, not its version', async (t) => {
  const { oc } = setup(t, 'v1-run.jsonl', V1);
  const s = await oc.createSession(CWD);
  assert.deepEqual(s.options().map((o) => o.id), ['mode']);
  await s.setModel(GROK);
  assert.deepEqual(s.options().map((o) => o.id), ['mode', 'effort'], 'the model chosen offers effort levels');
});

test('2.x: a second window loading a parent replays the turn OpenCode started as part of the one before', async (t) => {
  const { oc } = setup(t, 'v2-subagent-load.jsonl', V2);
  const s = await oc.openSession(PARENT, { cwd: CWD });
  const h = await s.history();
  assert.equal(h.filter((e) => e.type === 'userMessage').length, 1, 'no user bubble for the wake-up');
  assert.match(h.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /seed\.txt contains: seed/);
  assert.deepEqual(s.options().map((o) => [o.id, o.value]), [['mode', 'build'], ['effort', 'default']]);
});
