// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The host's side of subagents and settings: a turn the agent began itself in the session manager, a subagent's session
 * kept from Agent Plus, the model-choice wrapper passing settings through, and the arguments of OpenCode subcommands.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const { vscode } = fake.create();
fake.install(vscode);
const { createSessionManager } = require('../../src/host/session-manager');
const { createLocks } = require('../../src/host/locks');
const ap = require('../../src/host/agentplus-source');
const { withModelChoice } = require('../../src/host/model-choice');
const server = require('../../src/opencode/server');

const A = 'ses_df344a772ffeuYwN4u7YoTQnyv';
const CHILD = 'ses_df3449ad2fferB4flZgQI8hkdG';

function conv() {
  const listeners = new Set();
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send() {}, abort() {}, dispose() {},
  };
}

async function managerWith(looking) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-sh-'));
  const made = [];
  const manager = createSessionManager({
    locks: createLocks({ dir, pid: 1000, alive: () => true }),
    info: async (id) => ({ id, cwd: '/w', status: 'idle', title: 'Parent' }),
    makeConversation: async () => { const c = conv(); made.push(c); return c; },
    isLooking: () => looking,
    now: () => 5000,
  });
  await manager.open(A);
  return { manager, c: made[0] };
}

test('a turn the agent began itself shows as working, then as an unseen reply in a tab nobody looks at', async () => {
  const { manager, c } = await managerWith(false);
  const changes = [];
  manager.onDidChange((e) => changes.push(manager.snapshot(e.sessionId).activity));
  c.fire({ type: 'turnStart', turnId: 'o1', at: 100, unsolicited: true });
  assert.strictEqual(manager.snapshot(A).activity, 'working');
  c.fire({ type: 'options', options: [] });
  c.fire({ type: 'text', delta: 'The subagent finished.' });
  c.fire({ type: 'turnEnd', turnId: 'o1', reason: 'endTurn', at: 200 });
  const s = manager.snapshot(A);
  assert.strictEqual(s.activity, 'stopped');
  assert.strictEqual(s.unseen, true);
  assert.strictEqual(s.lastReplyAt, 200);
  assert.strictEqual(s.lastUserAt, 0, 'nobody wrote');
  assert.deepStrictEqual(changes, ['working', 'stopped']);
});

test('in a tab the user is looking at, a turn the agent began itself leaves no unseen reply', async () => {
  const { manager, c } = await managerWith(true);
  c.fire({ type: 'turnStart', turnId: 'o1', at: 100, unsolicited: true });
  c.fire({ type: 'turnEnd', turnId: 'o1', reason: 'endTurn', at: 200 });
  assert.strictEqual(manager.snapshot(A).unseen, false);
});

test("Agent Plus is not given a subagent's session even when a tab restored it", async () => {
  const rows = [{ sessionId: A, activity: 'stopped' }, { sessionId: CHILD, activity: 'stopped' }];
  const manager = { list: () => rows, has: () => true, panelOf: () => null };
  const made = ap.createAgentPlusSource({ manager, planDir: () => '/p', logo: () => null, reveal: async () => true, openHere: async () => true, hidden: (id) => id === CHILD });
  assert.deepStrictEqual((await made.source.listConversations()).map((c) => c.sessionId), [A]);
  const broken = ap.createAgentPlusSource({ manager, planDir: () => '/p', logo: () => null, reveal: async () => true, openHere: async () => true, hidden: () => { throw new Error('x'); } });
  assert.strictEqual((await broken.source.listConversations()).length, 2, 'a failing check hides nothing');
});

test('the model-choice wrapper passes the settings through', async () => {
  const calls = [];
  const inner = { on: () => () => {}, options: () => [{ id: 'mode', value: 'plan' }], setOption: async (id, v) => calls.push([id, v]), setModel: async () => {} };
  const f = withModelChoice(inner, { needsChoice: false, choose: async () => null, tell() {} });
  assert.deepStrictEqual(f.options(), [{ id: 'mode', value: 'plan' }]);
  await f.setOption('mode', 'build');
  assert.deepStrictEqual(calls, [['mode', 'build']]);
  const bare = withModelChoice({ on: () => () => {}, setModel: async () => {} }, { needsChoice: false, choose: async () => null, tell() {} });
  assert.deepStrictEqual(bare.options(), []);
  await assert.rejects(bare.setOption('mode', 'plan'), /no settings/);
});

test('OpenCode 2 subcommands get --standalone and autoupdate off; 1.x has no such flag', () => {
  assert.deepStrictEqual(server.subcommandArgs({ major: 2 }, ['api', 'session.list']), ['api', 'session.list', '--standalone']);
  assert.deepStrictEqual(server.subcommandArgs({ major: 1 }, ['session', 'delete', 'ses_x']), ['session', 'delete', 'ses_x']);
  assert.deepStrictEqual(server.subcommandArgs(null, ['session', 'list']), ['session', 'list']);
  const env = server.subcommandEnv({ AWS_PROFILE: 'self' }, { PATH: '/bin', OPENCODE_DISABLE_AUTOUPDATE: '0' });
  assert.deepStrictEqual(env, { PATH: '/bin', AWS_PROFILE: 'self', OPENCODE_DISABLE_AUTOUPDATE: '1' });
});
