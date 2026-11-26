// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Tests for src/opencode/session-index.js: OpenCode's /api session.list rows as the session list needs them, read from
 * the background service or a private server, page by page, and filtered to the window's folders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionIndex, toRecord, within } = require('../../src/opencode/session-index');

/* A row as OpenCode 2.4.1 printed it. */
const row = (id, dir, time, extra = {}) => ({ id, projectID: 'p', cost: 0.5, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } }, time, location: { directory: dir }, ...extra });

test('a row becomes a record: activity from busy and idle, never from updated, when the last turn began, and the viewer and archive times', () => {
  const r = toRecord(row('ses_a', '/w/p', { created: 100, updated: 900, busy: 200, idle: 300, viewed: 300, archived: 900 }, { title: 'T', parentID: 'ses_p', model: { id: 'x.m', providerID: 'amazon-bedrock' }, outcome: 'succeeded' }));
  assert.deepEqual(r, {
    id: 'ses_a', title: 'T', cwd: '/w/p', parentId: 'ses_p', forkOf: '', createdAt: 100, lastActiveAt: 300, lastReplyAt: 300, lastTurnAt: 200, viewedAt: 300,
    archivedAt: 900, busy: false, cost: 0.5, tokens: { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 0 }, model: 'amazon-bedrock/x.m', outcome: 'succeeded',
  });
  assert.equal(toRecord(row('ses_b', '/w', { created: 100, updated: 500 })).lastActiveAt, 100, 'a session that never ran a turn is as old as it is');
  const mid = toRecord(row('ses_c', '/w', { created: 100, updated: 500, busy: 400, idle: 300 }));
  assert.equal(mid.busy, true, 'a turn began after the last one ended');
  assert.equal(mid.lastActiveAt, 400);
  assert.equal(toRecord({ time: {} }), null);
  const fork = toRecord(row('ses_f', '/w', { created: 700, updated: 701 }, { fork: { sessionID: 'ses_a', boundary: { type: 'through', messageID: 'msg_1' } } }));
  assert.deepEqual([fork.forkOf, fork.lastReplyAt, fork.lastActiveAt], ['ses_a', 0, 700], 'a fork names the session it was copied from, and has no turn of its own');
  assert.equal(r.forkOf, '');
});

test('a folder holds itself and the folders below it, and no folder whose name merely starts the same', () => {
  assert.equal(within('/w/p', '/w/p', 'linux'), true);
  assert.equal(within('/w/p/sub/deeper', '/w/p', 'linux'), true);
  assert.equal(within('/w/p/', '/w/p', 'linux'), true);
  assert.equal(within('/w/proj', '/w/p', 'linux'), false);
  assert.equal(within('/w', '/w/p', 'linux'), false);
  assert.equal(within('C:\\Work\\P\\sub', 'c:\\work\\p', 'win32'), true, 'Windows paths compare without case');
  assert.equal(within('', '/w', 'linux'), false);
});

function setup(t, { service = null, pages = [], answers = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const db = path.join(root, 'opencode.db');
  fs.writeFileSync(db, 'x');
  if (service) fs.writeFileSync(path.join(state, 'service.json'), JSON.stringify(service));
  const calls = [];
  const requests = [];
  const execFile = (file, args, opts, cb) => {
    calls.push(args);
    const cursor = (args.find((a) => a.startsWith('cursor=')) || '').slice(7);
    const page = pages[cursor ? Number(cursor) : 0];
    cb(null, JSON.stringify(page || { data: [], cursor: { next: null } }), '');
  };
  const request = async (url, opts) => {
    requests.push({ url, opts });
    const u = new URL(url);
    if (answers[u.pathname]) return { status: 200, body: JSON.stringify(answers[u.pathname]) };
    const page = pages[u.searchParams.get('cursor') ? Number(u.searchParams.get('cursor')) : 0];
    return { status: 200, body: JSON.stringify(page || { data: [] }) };
  };
  const index = createSessionIndex({ found: () => ({ path: '/fake/opencode', version: { major: 2 } }), paths: async () => ({ state, db }), execFile, request, platform: 'linux' });
  return { index, calls, requests, db, state };
}

const full = (n, dir, from = 0) => Array.from({ length: n }, (_, i) => row(`ses_${from + i}`, dir, { created: 1000 - from - i }));

test('with no background service it reads a private server page by page, and keeps the window\'s folders and those below', async (t) => {
  const { PAGE } = require('../../src/opencode/session-index');
  const pages = [
    { data: [...full(PAGE - 2, '/w/p'), row('ses_sub', '/w/p/sub', { created: 5 }), row('ses_other', '/w/other', { created: 4 })], cursor: { next: '1' } },
    { data: [row('ses_last', '/w/p', { created: 1 })], cursor: { next: 'ignored-after-a-short-page' } },
  ];
  const { index, calls, requests } = setup(t, { pages });
  const got = await index.list({ folders: ['/w/p'] });
  assert.equal(requests.length, 0, 'no service, no HTTP');
  assert.equal(calls.length, 2, 'two pages, the second one short');
  for (const args of calls) {
    assert.equal(args[0], 'api');
    assert.ok(args.includes('--standalone'), 'never `opencode api` without --standalone: it would start the background service');
  }
  assert.deepEqual(calls[1].slice(-3), ['--param', 'cursor=1', '--standalone']);
  assert.equal(got.length, PAGE);
  assert.ok(got.some((r) => r.id === 'ses_sub') && got.some((r) => r.id === 'ses_last'));
  assert.ok(!got.some((r) => r.id === 'ses_other'));
});

test('a database that has not changed is not read again; a write to it is', async (t) => {
  const pages = [{ data: [row('ses_a', '/w', { created: 1 })], cursor: { next: null } }];
  const { index, calls, db } = setup(t, { pages });
  await index.list({ folders: ['/w'] });
  await index.list({ folders: ['/w'] });
  assert.equal(calls.length, 1);
  fs.writeFileSync(`${db}-wal`, 'changed');
  await index.list({ folders: ['/w'] });
  assert.equal(calls.length, 2);
  index.invalidate();
  await index.list({ folders: ['/w'] });
  assert.equal(calls.length, 3);
});

test('a running background service is asked over HTTP with its password, for the list and the turns that run', async (t) => {
  const pages = [{ data: [row('ses_a', '/w', { created: 1, busy: 2 })], cursor: { next: null } }];
  const { index, calls, requests } = setup(t, { pages, service: { url: 'http://127.0.0.1:4321', pid: process.pid, password: 'pw' }, answers: { '/api/session/active': { data: { ses_a: { type: 'running' } } } } });
  const got = await index.list({ folders: ['/w'] });
  assert.equal(got[0].busy, true);
  assert.equal(calls.length, 0, 'no private server while the service runs');
  assert.equal(requests[0].opts.headers.authorization, `Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:4321\/api\/session\?limit=1000$/);
  assert.deepEqual([...await index.active()], ['ses_a']);
});

test('a service file left by a crashed service, or one naming another host, counts as no service', async (t) => {
  const dead = setup(t, { service: { url: 'http://127.0.0.1:4321', pid: 2 ** 22 + 12345, password: 'pw' } });
  assert.equal(await dead.index.service(), null);
  assert.deepEqual([...await dead.index.active()], [], 'and nobody is asked which sessions run');
  assert.equal(dead.requests.length, 0);
  const remote = setup(t, { service: { url: 'http://example.test:4321', pid: process.pid, password: 'pw' } });
  assert.equal(await remote.index.service(), null);
});

test('a seen turn and the day\'s statistics go to the background service when it runs, else to a private server', async (t) => {
  const svc = setup(t, { service: { url: 'http://127.0.0.1:4321', pid: process.pid, password: 'pw' }, answers: { '/api/experimental/session/stats': { data: { cost: 1.25 } } } });
  await svc.index.view('ses_a', 300);
  assert.equal(svc.requests[0].opts.method, 'POST');
  assert.match(svc.requests[0].url, /\/api\/session\/ses_a\/view$/);
  assert.equal(svc.requests[0].opts.body, JSON.stringify({ idle: 300 }));
  assert.deepEqual(await svc.index.stats(1000, 2000, 'America/Los_Angeles'), { cost: 1.25 });
  assert.match(svc.requests[1].url, /stats\?from=1000&to=2000&timezone=America%2FLos_Angeles$/);
  const priv = setup(t);
  await priv.index.view('ses_b', 400);
  assert.deepEqual(priv.calls[0], ['api', 'session.view', '--param', 'sessionID=ses_b', '-d', '{"idle":400}', '--standalone']);
  await priv.index.stats(1000, 2000, '');
  assert.deepEqual(priv.calls[1], ['api', 'experimental.session.stats', '--param', 'from=1000', '--param', 'to=2000', '--standalone']);
});

test('a backend with its own records (the window tests\' fake) is read instead of OpenCode, and nothing of OpenCode runs', async (t) => {
  const { calls, requests, state, db } = setup(t);
  void state; void db;
  const viewed = [];
  const own = { rows: async () => [row('ses_f', '/w/p', { created: 1, busy: 2, idle: 3 })], view: async (id, idle) => viewed.push([id, idle]), stats: async () => ({ cost: 2 }) };
  const index = createSessionIndex({ found: () => { throw new Error('no OpenCode'); }, paths: async () => ({}), store: async () => own, execFile: () => { throw new Error('ran'); } });
  assert.deepEqual((await index.list({ folders: ['/w/p'] })).map((r) => r.id), ['ses_f']);
  assert.deepEqual([...await index.active()], []);
  await index.view('ses_f', 3);
  assert.deepEqual(viewed, [['ses_f', 3]]);
  assert.deepEqual(await index.stats(0, 10, ''), { cost: 2 });
  assert.equal(calls.length + requests.length, 0);
});
