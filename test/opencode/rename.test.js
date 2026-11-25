// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Renaming a conversation: OpenCode 2's /api session.update in a private server, OpenCode 1 refused. */
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
const LOADED = 'ses_df3c3e455ffe3KZVShQ00LZ15D';

function setup(t, version, execFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter('v2-load.jsonl', []);
  const oc = createOpenCode({
    root,
    env: { AWS_PROFILE: 'self' },
    findOpenCode: () => ({ path: '/fake/bin/opencode', version }),
    startAcp: starter.start,
    idleStopMs: 0,
    execFile,
  });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents };
}

test('2.x: a rename runs `opencode api session.update --standalone` and the open conversation reports the title', async (t) => {
  const calls = [];
  const execFile = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, '', ''); };
  const { oc, agents } = setup(t, V2, execFile);
  assert.equal(oc.canRename(), true);
  const s = await oc.openSession(LOADED, { cwd: CWD });
  const seen = [];
  s.on((ev) => seen.push(ev));
  const changed = [];
  oc.onDidChangeSessions((e) => changed.push(e.sessionId));
  /* Opening the conversation ran `opencode session export`, which dates the replay. */
  assert.deepEqual(calls.map((c) => c.args), [['session', 'export', LOADED, '--standalone']]);
  calls.length = 0;
  await oc.renameSession(LOADED, '  Weekly   report\n draft ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/fake/bin/opencode');
  assert.deepEqual(calls[0].args, ['api', 'session.update', '--param', `sessionID=${LOADED}`, '-d', '{"title":"Weekly report draft"}', '--standalone']);
  assert.equal(calls[0].opts.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(calls[0].opts.env.AWS_PROFILE, 'self');
  assert.deepEqual(seen, [{ type: 'title', title: 'Weekly report draft' }]);
  assert.equal(s.title, 'Weekly report draft');
  assert.ok(changed.includes(LOADED));
  assert.equal(agents[0].received.filter((m) => m.method === 'session/prompt').length, 0, 'no message goes to the model');
});

test("2.x: a rename OpenCode refuses fails with OpenCode's message; an empty title or a bad id runs nothing", async (t) => {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push(args);
    cb(Object.assign(new Error('Command failed'), { code: 1 }), '{"_tag":"SessionNotFoundError","message":"Session not found: ses_gone"}', 'HTTP 404 Not Found');
  };
  const { oc } = setup(t, V2, execFile);
  await assert.rejects(oc.renameSession('ses_gone', 'x'), (e) => e.code === 'renameFailed' && /Session not found: ses_gone/.test(e.message));
  await assert.rejects(oc.renameSession('ses_gone', '   '), (e) => e.code === 'badRequest');
  await assert.rejects(oc.renameSession('ses gone; rm', 'x'), (e) => e.code === 'badRequest');
  assert.equal(calls.length, 1);
});

test('2.x: a rename does not start `opencode acp`', async (t) => {
  const { oc, agents } = setup(t, V2, (file, args, opts, cb) => cb(null, '', ''));
  await oc.renameSession(LOADED, 'Renamed');
  assert.equal(agents.length, 0);
});

test('1.x: no rename, and nothing runs', async (t) => {
  const calls = [];
  const { oc } = setup(t, V1, (file, args, opts, cb) => { calls.push(args); cb(null, '', ''); });
  assert.equal(oc.canRename(), false);
  await assert.rejects(oc.renameSession(LOADED, 'Renamed'), (e) => e.code === 'unsupported' && /OpenCode 2/.test(e.message));
  assert.deepEqual(calls, []);
});
