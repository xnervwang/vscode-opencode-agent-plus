// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Writes into a conversation's own folder are allowed once without asking; every other request still asks the user. */
const nodeTest = require('node:test');
const test = (name, opts, fn) => (fn ? nodeTest(name, { timeout: 15000, ...opts }, fn) : nodeTest(name, { timeout: 15000 }, opts));
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode } = require('../../src/opencode');
const quiet = require('../../src/opencode/quiet-writes');
const { fakeStarter } = require('./fake-agent');

const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const SID = 'ses_df2534a3cffeV5DpIbep0DaQLs';
const WS = '/work/batch/runs/rewind/ws';
const OPTIONS = [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' }];
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-quiet-')));

/* A write request as OpenCode 2.4.1 sends it (fixtures/v2-rewind.jsonl). */
function writeCall(file, name = 'write') {
  return { toolCallId: 'call_1', name, title: file, kind: 'edit', status: 'pending', locations: [{ path: file }],
    rawInput: name === 'write' ? { path: file, content: 'x' } : { path: file, oldString: 'a', newString: 'b' },
    content: [{ type: 'diff', path: file, oldText: null, newText: 'x' }] };
}
const ask = (sessionId, toolCall, options = OPTIONS) => ({ sessionId, toolCall, options });

test('a write or an edit only inside the conversation\'s own folder is allowed once; others are asked', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folderOf = (id) => (/^ses_[A-Za-z0-9]{8,64}$/.test(id) ? path.join(root, 'scratch', id) : null);
  const own = path.join(root, 'scratch', SID);
  const ONCE = { outcome: { outcome: 'selected', optionId: 'once' } };
  assert.deepEqual(quiet.answer(ask(SID, writeCall(`${own}/chart.svg`)), folderOf), ONCE, 'before the folder exists');
  fs.mkdirSync(path.join(own, 'sub'), { recursive: true });
  assert.deepEqual(quiet.answer(ask(SID, writeCall(`${own}/sub/b.png`)), folderOf), ONCE);
  assert.deepEqual(quiet.answer(ask(SID, writeCall(`${own}/sub/b.png`, 'edit')), folderOf), ONCE);
  const asked = [
    ['another conversation\'s folder', ask(SID, writeCall(path.join(root, 'scratch', 'ses_other00000000000', 'x.svg')))],
    ['the folder itself', ask(SID, writeCall(own))],
    ['a folder whose name starts the same', ask(SID, writeCall(`${own}x/a.svg`))],
    ['a .. segment', ask(SID, writeCall(`${own}/../ses_other00000000000/a.svg`))],
    ['a . segment', ask(SID, writeCall(`${own}/./a.svg`))],
    ['a relative path', ask(SID, writeCall('scratch/a.svg'))],
    ['the workspace', ask(SID, writeCall(path.join(root, 'ws', 'a.txt')))],
    ['one target outside among others', ask(SID, { ...writeCall(`${own}/a.svg`), locations: [{ path: `${own}/a.svg` }, { path: path.join(root, 'b.svg') }] })],
    ['a diff naming another file', ask(SID, { ...writeCall(`${own}/a.svg`), content: [{ type: 'diff', path: path.join(root, 'b.svg'), newText: '' }] })],
    ['a command', ask(SID, { toolCallId: 'c', name: 'shell', kind: 'execute', locations: [{ path: own }], rawInput: { command: `touch ${own}/a`, cwd: own } })],
    ['a patch', ask(SID, { ...writeCall(`${own}/a.svg`), name: 'patch' })],
    ['a read', ask(SID, { ...writeCall(`${own}/a.svg`), name: 'read', kind: 'read' })],
    ['no target named', ask(SID, { toolCallId: 'w', name: 'write', kind: 'edit', locations: [], rawInput: {} })],
    ['no allow-once option', ask(SID, writeCall(`${own}/a.svg`), OPTIONS.filter((o) => o.kind !== 'allow_once'))],
    ['a session id of another shape', ask('../x', writeCall(`${own}/a.svg`))],
  ];
  for (const [what, params] of asked) assert.equal(quiet.answer(params, folderOf), null, what);
  assert.equal(quiet.answer(ask(SID, writeCall(`${own}/a.svg`)), null), null, 'no folder function');
  assert.equal(quiet.answer(ask(SID, writeCall(`${own}/a.svg`)), () => { throw new Error('x'); }), null);
});

test('a symbolic link cannot lead a quiet write out of the folder', { skip: process.platform === 'win32' && 'links need rights on Windows' }, (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, 'scratch', SID);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(own, 'out'));
  fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
  fs.symlinkSync(path.join(outside, 'f.txt'), path.join(own, 'f.txt'));
  const folderOf = () => own;
  assert.equal(quiet.answer(ask(SID, writeCall(`${own}/out/a.svg`)), folderOf), null, 'a linked folder');
  assert.equal(quiet.answer(ask(SID, writeCall(`${own}/f.txt`)), folderOf), null, 'a linked file');
  fs.symlinkSync(root, path.join(outside, 'root-link'));
  const viaLink = path.join(outside, 'root-link', 'scratch', SID);
  assert.deepEqual(quiet.answer(ask(SID, writeCall(`${viaLink}/a.svg`)), folderOf), { outcome: { outcome: 'selected', optionId: 'once' } });
});

function setup(t, more = {}) {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter('v2-rewind.jsonl');
  const logged = [];
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version: V2 }), startAcp: starter.start, idleStopMs: 0,
    log: (l) => logged.push(l), ...more });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents, logged };
}

async function writeTurn(oc) {
  const s = await oc.createSession('/work/batch/runs/rewind/ws', {});
  const events = [];
  s.on((ev) => { events.push(ev); if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce')); });
  await s.send('first');
  await s.send('write revert-me.txt and edit seed.txt');
  return events;
}
const answers = (agent) => agent.received.filter((m) => !m.method && m.result && m.result.outcome).map((m) => m.result.outcome);

test('through createOpenCode: writes in the folder that quietFolder names are answered without a permission event', async (t) => {
  const { oc, agents, logged } = setup(t, { quietFolder: (id) => (id === SID ? WS : null) });
  const events = await writeTurn(oc);
  assert.equal(events.filter((e) => e.type === 'permission').length, 0);
  assert.ok(events.some((e) => e.type === 'toolCall' && e.name === 'write'), 'the tool call still shows');
  assert.deepEqual(answers(agents[0]), [{ outcome: 'selected', optionId: 'once' }, { outcome: 'selected', optionId: 'once' }]);
  assert.equal(logged.filter((l) => /allowed without asking/.test(l)).length, 2);
});

test('through createOpenCode: another folder, no quietFolder, or OpenCode\'s own policy still asks the user', async (t) => {
  for (const more of [{ quietFolder: () => '/work/elsewhere' }, {}, { quietFolder: () => WS, permissions: false }]) {
    const { oc, agents } = setup(t, more);
    const events = await writeTurn(oc);
    assert.equal(events.filter((e) => e.type === 'permission').length, 2, JSON.stringify(Object.keys(more)));
    assert.equal(answers(agents[0]).length, 2);
  }
});

test('restart() takes a new quietFolder, and null turns it off', async (t) => {
  const { oc } = setup(t, { quietFolder: () => WS });
  await oc.restart({ quietFolder: null });
  const events = await writeTurn(oc);
  assert.equal(events.filter((e) => e.type === 'permission').length, 2);
});
