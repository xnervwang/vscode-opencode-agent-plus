// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* createOpenCode against recordings of OpenCode 1.19.6 and 2.4.1 replayed by fake-agent.js. */
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode } = require('../../src/opencode');
const { fakeStarter } = require('./fake-agent');

const V1 = { major: 1, minor: 19, patch: 6, text: '1.19.6' };
const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const CWD = '/work/project';
const GROK = 'amazon-bedrock/us.xai.grok-4.7';

function setup(t, script, version, more = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-oc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter(script, more.extra || []);
  const oc = createOpenCode({
    root,
    findOpenCode: () => ({ path: '/fake/bin/opencode', version }),
    startAcp: starter.start,
    idleStopMs: more.idleStopMs || 0,
    execFile: more.execFile,
    config: more.config,
  });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents, root };
}

const types = (evs) => evs.map((e) => e.type);
const sentResults = (agent) => agent.received.filter((m) => !m.method && m.result && m.result.outcome).map((m) => m.result.outcome);

test('1.x: a conversation with an approved command, a denied one and a stop', async (t) => {
  const { oc, agents } = setup(t, 'v1-run.jsonl', V1);
  const changes = [];
  oc.onDidChangeSessions((e) => changes.push(e.sessionId));
  const s = await oc.createSession(CWD);
  assert.equal(s.id, 'ses_df3c71e7dffeqHMoF0MwSdAou5');
  assert.equal(s.cwd, CWD);
  const events = [];
  const decisions = ['allowOnce', 'deny'];
  const statusAtAsk = [];
  let stopped = false;
  let turns = 0;
  s.on((ev) => {
    events.push(ev);
    if (ev.type === 'turnStart') turns += 1;
    if (ev.type === 'permission') {
      statusAtAsk.push([s.status, s.waitingTool]);
      setImmediate(() => s.respondPermission(ev.requestId, decisions.shift()));
    }
    if (ev.type === 'text' && turns === 3 && !stopped) {
      stopped = true;
      s.abort();
    }
  });

  const end1 = await s.send('Run the shell command `ls -la` in the working directory and tell me how many entries it printed.');
  assert.equal(end1.reason, 'endTurn');
  const turn1 = events.splice(0);
  assert.deepEqual(types(turn1).slice(0, 2), ['turnStart', 'userMessage']);
  for (const k of ['reasoning', 'toolCall', 'permission', 'permissionSettled', 'toolResult', 'text', 'usage', 'turnEnd']) assert.ok(types(turn1).includes(k), k);
  const call = turn1.find((e) => e.type === 'toolCall');
  assert.equal(call.name, 'bash');
  assert.equal(call.input.command, 'ls -la');
  const perm = turn1.find((e) => e.type === 'permission');
  assert.equal(perm.request.kind, 'command');
  assert.equal(perm.request.command, 'ls -la');
  assert.deepEqual(statusAtAsk[0], ['waiting', 'bash']);
  assert.ok(types(turn1).indexOf('toolCall') < types(turn1).indexOf('permission'));
  assert.match(turn1.find((e) => e.type === 'toolResult').content, /total 8/);
  assert.ok(turn1.some((e) => e.type === 'usage' && e.costUsd > 0 && e.contextUsed === 24262));
  assert.equal(s.status, 'idle');
  assert.ok(s.lastReplyAt >= s.lastUserAt && s.lastUserAt > 0);

  const end2 = await s.send('Run `ls -la` once more and show the first line.');
  assert.equal(end2.reason, 'endTurn', '1.x lets the model answer after a rejection');
  const turn2 = events.splice(0);
  assert.equal(turn2.find((e) => e.type === 'permissionSettled').decision, 'deny');
  assert.equal(turn2.find((e) => e.type === 'toolResult').isError, true);
  assert.deepEqual(sentResults(agents[0]).map((o) => o.optionId), ['once', 'reject']);

  const end3 = await s.send('Write a 500-word essay about the history of the ls command. No tools.');
  assert.equal(end3.reason, 'aborted');
  assert.ok(agents[0].methods().includes('session/cancel'));
  assert.ok(changes.includes(s.id));

  const list = await oc.listSessions({ cwd: CWD });
  assert.equal(list[0].id, s.id);
  assert.equal(list[0].status, 'idle');
  assert.equal(list[0].cwd, CWD);
  assert.equal(list[0].title, '', 'OpenCode\'s placeholder title is not shown');
  assert.equal(list[0].open, true);
  assert.equal(list[0].lastReplyAt, s.lastReplyAt);
});

test('1.x: write and edit requests carry the file before and after', async (t) => {
  const { oc } = setup(t, 'v1-edit.jsonl', V1);
  const s = await oc.createSession(CWD);
  const perms = [];
  s.on((ev) => { if (ev.type === 'permission') { perms.push(ev.request); setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce')); } });
  await s.send('Create a file hello.txt containing exactly the line: hello world. Use the write tool.');
  await s.send('Change hello.txt so the line reads: hello there. Use the edit tool.');
  assert.equal(perms.length, 2);
  assert.equal(perms[0].kind, 'write');
  assert.equal(perms[0].tool, 'write');
  assert.deepEqual({ before: perms[0].diff.before, after: perms[0].diff.after }, { before: '', after: 'hello world' });
  assert.equal(perms[1].kind, 'edit');
  assert.deepEqual({ before: perms[1].diff.before, after: perms[1].diff.after }, { before: 'hello world', after: 'hello there' });
  assert.equal(perms[1].path, '/work/project/hello.txt');
});

test('1.x: opening a saved conversation replays its history as turns', async (t) => {
  const { oc, agents } = setup(t, 'v1-load.jsonl', V1);
  const s = await oc.openSession('ses_df3c71e7dffeqHMoF0MwSdAou5');
  assert.equal(s.cwd, CWD, 'the folder came from session/list');
  const h = await s.history();
  const users = h.filter((e) => e.type === 'userMessage').map((e) => e.text);
  assert.equal(users.length, 3);
  assert.match(users[0], /ls -la/);
  assert.equal(h.filter((e) => e.type === 'turnStart').length, 3);
  assert.equal(h.filter((e) => e.type === 'turnEnd').length, 3);
  assert.ok(h.some((e) => e.type === 'toolCall' && e.name === 'bash'));
  assert.deepEqual(h[h.length - 1], { type: 'title', title: 'Counting directory entries from ls -la' });
  assert.deepEqual(agents[0].methods(), ['initialize', 'session/list', 'session/load']);
  assert.equal(await oc.openSession(s.id), s, 'a second open returns the same object');
});

test('opening a conversation OpenCode does not have fails with noConversation, not the notFound of a missing OpenCode', async (t) => {
  const { oc } = setup(t, 'v1-load.jsonl', V1);
  await assert.rejects(oc.openSession('ses_df3c71e7dffeqHMoF0MwSdAou9'),
    (e) => e instanceof require('../../src/opencode/server').OpenCodeError && e.code === 'noConversation' && /has no conversation/.test(e.message));
});

test('2.x: the model is chosen with session/set_config_option; a rejection ends the turn', async (t) => {
  const { oc, agents } = setup(t, 'v2-run.jsonl', V2, { extra: [{ on: 'session/delete', reply: {} }] });
  const s = await oc.createSession(CWD, { model: GROK });
  assert.equal(s.getModel(), GROK);
  const decisions = ['allowOnce', 'deny'];
  s.on((ev) => { if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, decisions.shift())); });
  assert.equal((await s.send('Run the shell command `ls -la` in the working directory and tell me how many entries it printed.')).reason, 'endTurn');
  assert.equal((await s.send('Run `ls -la` once more and show the first line.')).reason, 'aborted', '2.x cancels the turn on reject');
  const methods = agents[0].methods();
  assert.ok(methods.includes('session/set_config_option'));
  assert.ok(!methods.includes('session/set_model'));
  const grok = oc.listModels().find((m) => m.id === GROK);
  assert.equal(grok.contextWindow, 500000, 'learned from usage_update');
  await oc.deleteSession(s.id);
  assert.ok(agents[0].methods().includes('session/delete'));
  assert.equal((await oc.listSessions()).some((x) => x.open), false);
});

test('2.x: list across folders, open a saved one, and the placeholder titles stay blank', async (t) => {
  const { oc } = setup(t, 'v2-load.jsonl', V2);
  const list = await oc.listSessions();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((x) => x.title).sort(), ['', '', 'Working directory entry count']);
  const s = await oc.openSession(list.find((x) => x.title).id, { cwd: CWD });
  assert.ok((await s.history()).some((e) => e.type === 'userMessage'));
});

test('1.x has no session/delete: deleting runs `opencode session delete`', async (t) => {
  const calls = [];
  const execFile = (file, args, opts, cb) => { calls.push([file, args]); cb(null, '', ''); };
  const { oc } = setup(t, 'v1-load.jsonl', V1, { execFile });
  await oc.deleteSession('ses_x');
  assert.deepEqual(calls, [['/fake/bin/opencode', ['session', 'delete', 'ses_x']]]);
  await assert.rejects(oc.renameSession('ses_x', 'new'), (e) => e.code === 'unsupported');
});

test('models, the default model and what to say about Bedrock', async (t) => {
  const { oc } = setup(t, 'v1-run.jsonl', V1);
  assert.equal(oc.bedrockStatus().state, 'unknown');
  assert.match(oc.bedrockStatus().help, /"provider": \{ "amazon-bedrock": \{ "options"/);
  await oc.createSession(CWD);
  const models = oc.listModels();
  assert.ok(models.some((m) => m.id === GROK && m.providerId === 'amazon-bedrock' && m.invokeId === 'us.xai.grok-4.7'));
  assert.equal(oc.defaultModel().id, 'opencode/big-pickle');
  assert.deepEqual(oc.bedrockStatus(), { state: 'listed', models: models.filter((m) => m.providerId === 'amazon-bedrock').length, opencodeMajor: 1, help: '' });
});

test('the models are remembered for the next window', async (t) => {
  const first = setup(t, 'v1-run.jsonl', V1);
  await first.oc.createSession(CWD);
  await first.oc.dispose();
  const again = createOpenCode({ root: first.root, findOpenCode: () => { throw new Error('not started'); }, startAcp: () => { throw new Error('not started'); } });
  assert.ok(again.listModels().length > 0);
  assert.equal(again.defaultModel().id, 'opencode/big-pickle');
});

test('OpenCode exiting mid-turn ends it with an error; the next message starts it again and reloads', async (t) => {
  const { oc, agents } = setup(t, 'v1-run.jsonl', V1, { extra: [{ on: 'session/load', reply: { configOptions: [] } }] });
  const s = await oc.createSession(CWD);
  s.on((ev) => { if (ev.type === 'permission') agents[0].child.kill('SIGKILL'); });
  const end = await s.send('Run the shell command `ls -la`.');
  assert.equal(end.reason, 'error');
  assert.equal(end.error.kind, 'unavailable');
  assert.equal(s.status, 'idle');
  s.on((ev) => { if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce')); });
  const again = await s.send('Run the shell command `ls -la`.');
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[1].methods().slice(0, 4), ['initialize', 'session/load', 'session/set_config_option', 'session/prompt'], 'loaded and its model set again');
  assert.equal(again.reason, 'endTurn');
});

test('the process stops once no conversation has been open for idleStopMs', async (t) => {
  const { oc, agents } = setup(t, 'v1-run.jsonl', V1, { idleStopMs: 30 });
  const s = await oc.createSession(CWD);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(agents[0].child.exitCode, null, 'an open conversation keeps it');
  s.dispose();
  await new Promise((r) => setTimeout(r, 80));
  assert.notEqual(agents[0].child.exitCode, null);
  assert.equal(oc.info(), null);
});

test('a missing opencode fails createSession and listSessions with the notFound error that says how to install it', async (t) => {
  const { OpenCodeError } = require('../../src/opencode/server');
  const oc = createOpenCode({ root: os.tmpdir(), findOpenCode: () => { throw new OpenCodeError('notFound', 'OpenCode was not found. Install it with ...'); } });
  t.after(() => oc.dispose());
  await assert.rejects(oc.createSession(CWD), (e) => e.code === 'notFound');
  const s = await oc.listSessions().catch((e) => e);
  assert.equal(s.code, 'notFound');
});

test('1.x: plugin text in the history is marked synthetic, not drawn as the user\'s words', async (t) => {
  const { oc } = setup(t, 'v1-synthetic.jsonl', V1);
  const s = await oc.openSession('ses_df3b0117dffebyB1zyNbkfzFv5', { cwd: CWD });
  const users = (await s.history()).filter((e) => e.type === 'userMessage').map((e) => [e.text, !!e.synthetic]);
  assert.deepEqual(users, [
    ['Reply with the single word OK.', false],
    ['[work plan] 1 open: 1. doing probe', true],
    ['[work plan] The turn ended with row 1 still doing.', true],
  ]);
});

test('detect() reports the version line, and config can depend on it', async (t) => {
  const seen = [];
  const { oc, agents } = setup(t, 'v2-run.jsonl', V2, { config: (line) => { seen.push(line); return line >= 2 ? { plugins: ['/plugin'] } : { plugin: ['file:///plugin/index.js'] }; } });
  assert.deepEqual(oc.detect(), { path: '/fake/bin/opencode', version: V2, line: 2 });
  await oc.start();
  assert.deepEqual(seen, [2]);
  assert.deepEqual(agents[0].launch.config, { plugins: ['/plugin'] });
  assert.equal(oc.info().line, 2);
});

test('session/new that gets no answer fails as unavailable, and the next try starts OpenCode again', async (t) => {
  const { fakeAgent, loadScript } = require('./fake-agent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-oc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorded = loadScript('v2-run.jsonl');
  const init = recorded.find((e) => e.on === 'initialize');
  const made = recorded.find((e) => e.on === 'session/new');
  const agents = [];
  const oc = createOpenCode({
    root,
    findOpenCode: () => ({ path: '/fake/bin/opencode', version: V2 }),
    startAcp: () => {
      const a = fakeAgent(agents.length ? [init, made] : [init, { on: 'session/new', send: [{ waitFor: 'never/sent' }] }]);
      agents.push(a);
      return { child: a.child, stderrTail: () => '', args: ['acp'] };
    },
    idleStopMs: 0,
    newSessionTimeoutMs: 150,
  });
  t.after(() => oc.dispose());
  await assert.rejects(oc.createSession(CWD), (e) => e.name === 'Error' && e.code === 'unavailable' && e.kind === 'unavailable'
    && /did not start the conversation within 0 seconds|within \d+ seconds/.test(e.message));
  await new Promise((r) => setImmediate(r));
  assert.notEqual(agents[0].child.exitCode === null && agents[0].child.signalCode === null, true, 'the process that did not answer is stopped');
  const s = await oc.createSession(CWD);
  assert.equal(agents.length, 2);
  assert.equal(s.id, made.reply.sessionId);
});

test('2.x: a conversation whose plugin left a turn-end reminder replays without it (recorded on 2.4.1)', async (t) => {
  const { oc } = setup(t, 'v2-plan-load.jsonl', V2);
  const s = await oc.openSession('ses_df36f00bdffeGuBy2khAO50yCY', { cwd: CWD });
  const evs = await s.history();
  assert.deepEqual(evs.filter((e) => e.type === 'userMessage').map((e) => [e.text, !!e.synthetic]), [
    ["Call the add_row tool once, with state doing and title 'list the files'. Do nothing else, then reply with only ok.", false],
    ['Reply with only the word two.', false],
  ]);
  assert.equal(evs.filter((e) => e.type === 'turnStart').length, 2);
  assert.deepEqual(evs.filter((e) => e.type === 'toolCall').map((e) => e.name), ['add_row', 'set_row', 'set_summary', 'set_status']);
  assert.equal(JSON.stringify(evs).includes('<system-update>'), false);
});
