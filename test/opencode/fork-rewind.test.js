// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Forking with session/fork (recorded on 2.4.1 and 1.19.6), rewinding through OpenCode 2's /api (stage, then commit or
 * clear, with what 2.4.1 printed), and the two subcommands the extension reads text from: mcp list and debug paths.
 */
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode, parsePaths } = require('../../src/opencode');
const server = require('../../src/opencode/server');
const { fakeStarter } = require('./fake-agent');

const V1 = { major: 1, minor: 19, patch: 6, text: '1.19.6' };
const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const CWD = '/work/project';
const ORIGINAL = 'ses_df2534a3cffeV5DpIbep0DaQLs';
const FORK = 'ses_df253107effes96gJ1V26vgNKO';
const V1_FORK = 'ses_df2533677ffedlpVGbbUysWD4r';
const MSG = 'msg_20dacbf6a0018X6RZP6hV4o0Fe';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function setup(t, script, version, reply = () => [null, '', '']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter(script);
  const calls = [];
  const execFile = (file, args, opts, cb) => { calls.push({ args, opts }); const [err, out, errOut] = reply(args); cb(err, out, errOut); };
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version }), startAcp: starter.start, idleStopMs: 0, execFile, exportWaitMs: 500 });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents, calls, root };
}
const failed = (msg) => [Object.assign(new Error('Command failed'), { code: 1 }), '', msg];

test('2.x: a fork asks session/fork for the whole conversation with its folder, and the copy is a root conversation', async (t) => {
  const { oc, agents } = setup(t, 'v2-rewind.jsonl', V2, () => failed('no export here'));
  assert.equal(oc.canFork(), false, 'not known before OpenCode has started');
  await oc.openSession(ORIGINAL, { cwd: CWD });
  assert.equal(oc.canFork(), true);
  const changed = [];
  oc.onDidChangeSessions((e) => changed.push(e.sessionId));
  const f = await oc.forkSession(ORIGINAL);
  assert.deepEqual(f, { id: FORK, cwd: CWD });
  const asked = agents[0].received.find((m) => m.method === 'session/fork');
  assert.deepEqual(asked.params, { sessionId: ORIGINAL, cwd: CWD, mcpServers: [] });
  assert.equal(oc.isChild(FORK), false);
  assert.ok(changed.includes(FORK));
  await assert.rejects(oc.forkSession('not an id'), (e) => e.code === 'badRequest');
});

test('1.x: session/fork works the same, and the fork opens with its messages', async (t) => {
  const { oc } = setup(t, 'v1-fork.jsonl', V1, () => failed('no export here'));
  const s = await oc.createSession(CWD, {});
  assert.equal(oc.canFork(), true);
  const f = await oc.forkSession(s.id);
  assert.equal(f.id, V1_FORK);
  const opened = await oc.openSession(f.id, { cwd: CWD });
  assert.deepEqual((await opened.history()).filter((e) => e.type === 'userMessage').map((e) => e.text), ['Reply with the word KESTREL only.']);
});

test('without session/fork in its capabilities there is no fork', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = JSON.parse(fixture('v2-rewind.jsonl').split('\n')[0]);
  delete init.reply.agentCapabilities.sessionCapabilities.fork;
  const starter = fakeStarter('v2-rewind.jsonl', []);
  const start = (o) => { const r = starter.start(o); return r; };
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version: V2 }), startAcp: (o) => {
    const { fakeAgent, loadScript } = require('./fake-agent');
    const a = fakeAgent([init, ...loadScript('v2-rewind.jsonl').slice(1)]);
    return { child: a.child, stderrTail: () => '', args: ['acp'] };
  }, idleStopMs: 0, execFile: (f, a, o, cb) => cb(new Error('no')), exportWaitMs: 200 });
  t.after(() => oc.dispose());
  void start;
  await oc.openSession(ORIGINAL, { cwd: CWD });
  assert.equal(oc.canFork(), false);
  await assert.rejects(oc.forkSession(ORIGINAL), (e) => e.code === 'unsupported');
});

test('2.x: rewinding stages with the message id, reads what it restores, then commits or clears', async (t) => {
  const { oc, calls } = setup(t, 'v2-rewind.jsonl', V2, (args) => {
    if (args[1] === 'session.revert.stage') return [null, fixture('v2-revert-stage.json'), ''];
    if (args[1] === 'export') return failed('no export here');
    return [null, '', ''];
  });
  assert.equal(oc.canRewind(), true);
  const staged = await oc.rewindStage(ORIGINAL, MSG);
  assert.deepEqual(calls[0].args, ['api', 'session.revert.stage', '--param', `sessionID=${ORIGINAL}`, '-d', JSON.stringify({ messageID: MSG }), '--standalone']);
  assert.equal(calls[0].opts.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(staged.tracked, true);
  assert.deepEqual(staged.files.map((f) => [f.file, f.status, f.additions, f.deletions]), [['revert-me.txt', 'deleted', 0, 1], ['seed.txt', 'modified', 1, 1]]);
  assert.match(staged.files[1].patch, /-seed2/);
  await oc.rewindCommit(ORIGINAL);
  await oc.rewindClear(ORIGINAL);
  assert.deepEqual(calls.slice(1).map((c) => c.args.slice(0, 3)), [['api', 'session.revert.commit', '--param'], ['api', 'session.revert.clear', '--param']]);
  assert.ok(calls.slice(1).every((c) => c.args[c.args.length - 1] === '--standalone'));
});

test('2.x: in a folder OpenCode keeps no snapshots of, a rewind restores no files and says so', async (t) => {
  const { oc } = setup(t, 'v2-rewind.jsonl', V2, () => [null, fixture('v2-revert-stage-nogit.json'), '']);
  const staged = await oc.rewindStage(ORIGINAL, 'msg_20dad7443001Ct1Z3hYCEqDRyZ');
  assert.deepEqual(staged, { messageId: 'msg_20dad7443001Ct1Z3hYCEqDRyZ', tracked: false, files: [] });
});

test('rewinding: a bad message id never runs, OpenCode refusing says why, a working conversation and 1.x are refused', async (t) => {
  const { oc, calls } = setup(t, 'v2-rewind.jsonl', V2, () => [Object.assign(new Error('Command failed'), { code: 1 }), '{"_tag":"Session.BusyError","message":"Session is busy"}', 'HTTP 409']);
  await assert.rejects(oc.rewindStage(ORIGINAL, 'msg x; rm'), (e) => e.code === 'badRequest');
  assert.equal(calls.length, 0);
  await assert.rejects(oc.rewindStage(ORIGINAL, MSG), (e) => e.code === 'rewindFailed' && /Session is busy/.test(e.message));
  const s = await oc.createSession(CWD, {});
  /* The turn begins as send() is called, before anything has been answered. */
  const sending = s.send('Remember the word OSPREY. Reply with ok.');
  await assert.rejects(oc.rewindStage(s.id, MSG), (e) => e.code === 'busy');
  await sending;
  const v1 = setup(t, 'v1-fork.jsonl', V1);
  assert.equal(v1.oc.canRewind(), false);
  await assert.rejects(v1.oc.rewindStage(ORIGINAL, MSG), (e) => e.code === 'unsupported');
  assert.equal(v1.calls.length, 0);
});

test('the user messages of a conversation come from its export, oldest first', async (t) => {
  const { oc, calls } = setup(t, 'v2-rewind.jsonl', V2, () => [null, fixture('v2-fork-export.json'), '']);
  const users = await oc.userMessages(FORK);
  assert.deepEqual(calls[0].args, ['session', 'export', FORK, '--standalone']);
  assert.deepEqual(users.map((u) => u.text), ['Remember the word OSPREY. Reply with ok.', 'What word did I ask you to remember? If none, say none. One word.']);
  assert.ok(users.every((u) => /^msg_/.test(u.id) && u.at > 0));
});

test('1.x exports with `opencode export <id>`, no --standalone', async (t) => {
  const { oc, calls } = setup(t, 'v1-fork.jsonl', V1, () => [null, fixture('v1-export.json'), 'Exporting session: x']);
  const users = await oc.userMessages('ses_df253483effeDS9GAB4SMCCKaz');
  assert.deepEqual(calls[0].args, ['export', 'ses_df253483effeDS9GAB4SMCCKaz']);
  assert.deepEqual(users.map((u) => u.text), ['Reply with the word KESTREL only.']);
});

test('mcp list goes through --standalone on 2.x and comes back without terminal colours', async (t) => {
  const v2 = setup(t, 'v2-rewind.jsonl', V2, () => [null, fixture('v2-mcp-list.txt'), '']);
  assert.equal(await v2.oc.mcpList(), 'No MCP servers configured');
  assert.deepEqual(v2.calls[0].args, ['mcp', 'list', '--standalone']);
  const v1 = setup(t, 'v1-fork.jsonl', V1, () => [null, `\x1b[0m${fixture('v1-mcp-list.txt')}`, '\x1b[0m\n']);
  const text = await v1.oc.mcpList();
  assert.deepEqual(v1.calls[0].args, ['mcp', 'list']);
  assert.match(text, /No MCP servers configured/);
  assert.doesNotMatch(text, /\x1b/);
});

test('debug paths runs without --standalone, which it refuses; 1.x names no db, found beside the data', async (t) => {
  assert.deepEqual(server.subcommandArgs(V2, ['debug', 'paths']), ['debug', 'paths']);
  assert.deepEqual(server.subcommandArgs(V2, ['mcp', 'list']), ['mcp', 'list', '--standalone']);
  const v2 = setup(t, 'v2-rewind.jsonl', V2, () => [null, fixture('v2-debug-paths.txt'), '']);
  const p = await v2.oc.dataPaths();
  assert.deepEqual(v2.calls[0].args, ['debug', 'paths']);
  assert.equal(p.db, '/work/xdg/data/opencode/opencode.db');
  assert.equal(p.data, '/work/xdg/data/opencode');
  await v2.oc.dataPaths();
  assert.equal(v2.calls.length, 1, 'read once');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-paths-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data, 'opencode.db'), '');
  const v1 = setup(t, 'v1-fork.jsonl', V1, () => [null, fixture('v1-debug-paths.txt').replace('/work/xdg/data/opencode', data), '']);
  assert.equal((await v1.oc.dataPaths()).db, path.join(data, 'opencode.db'));
  assert.deepEqual(parsePaths('home   /h\nnot a line\n  db     /x y/opencode.db  '), { home: '/h', db: '/x y/opencode.db' });
});
