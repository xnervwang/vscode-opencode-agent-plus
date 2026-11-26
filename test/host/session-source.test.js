// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Tests for src/host/session-source.js, this extension's part of Agent Plus's session list.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSource, startOfDay } = require('../../src/host/session-source');

const rec = (id, extra = {}) => ({ id, title: `Title ${id}`, cwd: '/w/p', parentId: '', createdAt: 100, lastActiveAt: 300, lastReplyAt: 300, viewedAt: 0,
  archivedAt: 0, busy: false, cost: 0.25, tokens: { input: 1200, output: 30, reasoning: 0, cacheRead: 5000, cacheWrite: 0 }, model: 'amazon-bedrock/x.grok', outcome: 'succeeded', ...extra });

function setup({ records = [], here = {}, far = [], places = {}, known = {}, holders = {}, active = [], activeRef = null, canRename = true, canFork = true, listError = null, canDownload = true, git = null, noted } = {}) {
  const calls = [];
  const timers = [];
  let readings = 0;
  const index = {
    list: async ({ folders }) => { calls.push(['list', folders]); if (listError && listError.current) throw listError.current; return records.filter((r) => folders.some((f) => r.cwd === f || r.cwd.startsWith(`${f}/`))); },
    all: async () => records,
    stamp: async () => 's1',
    invalidate: () => calls.push(['invalidate']),
  };
  const elsewhere = {
    scan: async () => { readings++; return { at: readings, procs: [], tabs: new Map(), active: new Set(activeRef ? activeRef.ids : active) }; },
    placesOf: (r) => places[r.id] || [],
    kindOf: (r) => (r.parentId ? 'subagent' : known[r.id] ? 'background' : 'user'),
    noteRuns: () => known,
  };
  const manager = { has: (id) => id in here, snapshot: (id) => here[id] || null };
  const source = createSessionSource({
    index, elsewhere, manager, git, noted, platform: 'linux', ours: () => false, holder: (id) => holders[id] || null, otherWindows: async () => far,
    open: async (id, where) => { calls.push(['open', id, where]); return true; },
    create: async (where) => { calls.push(['create', where]); return 'ses_new'; },
    canRename: () => canRename, rename: async (id, t) => calls.push(['rename', id, t]),
    remove: async (id) => calls.push(['remove', id]),
    canFork: () => canFork, fork: async (id) => calls.push(['fork', id]),
    markViewed: async (id, idle) => calls.push(['view', id, idle]),
    stats: async (from, to, tz) => { calls.push(['stats', tz]); return { cost: 3.5 }; },
    providerName: (p) => (p === 'amazon-bedrock' ? 'Amazon Bedrock' : p),
    timeZone: () => 'America/Los_Angeles',
    canDownload: () => canDownload,
    commands: { download: 'x.downloadOpenCode', logs: 'x.showLogs' },
    now: () => Date.UTC(2026, 10, 26, 8, 30),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
  });
  return { source, calls, timers };
}

test('source.features lists the members the source has', () => {
  const { source } = setup();
  assert.deepEqual(source.features, ['sessions', 'sessionImport', 'sessionSeen', 'sessionsNotice', 'accountInfo']);
});

test('rows: the folder\'s sessions with their times, kind, viewed time and the fork action; the core\'s folders are passed on', async () => {
  const records = [rec('ses_a', { viewedAt: 300 }), rec('ses_sub', { cwd: '/w/p/sub' }), rec('ses_kid', { parentId: 'ses_a' }), rec('ses_run'),
    rec('ses_new', { lastReplyAt: 0, lastActiveAt: 100 }), rec('ses_fork', { lastReplyAt: 0, lastActiveAt: 100, forkOf: 'ses_a' }), rec('ses_far', { cwd: '/w/other' })];
  const { source, calls } = setup({ records, known: { ses_run: 1 } });
  const { sessions, cursor } = await source.listSessions({ folders: ['/w/p'], cursor: null, limit: 500 });
  assert.equal(cursor, null);
  assert.deepEqual(calls[0], ['list', ['/w/p']]);
  const by = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
  assert.deepEqual(Object.keys(by).sort(), ['ses_a', 'ses_fork', 'ses_kid', 'ses_new', 'ses_run', 'ses_sub']);
  assert.deepEqual(by.ses_a, { sessionId: 'ses_a', title: 'Title ses_a', cwd: '/w/p', createdAt: 100, lastActiveAt: 300, lastReplyAt: 300, kind: 'user',
    viewedAt: 300, activity: 'stopped', running: false, actions: ['fork'] });
  assert.equal(by.ses_kid.kind, 'subagent');
  assert.equal(by.ses_kid.parentId, 'ses_a');
  assert.equal(by.ses_kid.actions, undefined, 'a subagent\'s session is not forked on its own');
  assert.equal(by.ses_run.kind, 'background');
  assert.equal(by.ses_new.kind, 'empty', 'never ran a turn');
  assert.equal(by.ses_fork.kind, 'user', 'a fork has the messages it was copied with, though it never ran a turn');
});

test('rows: the linked worktrees of the folders\' repositories are listed too, with their names, and every row has its folder\'s branch', async () => {
  const records = [rec('ses_main'), rec('ses_sub', { cwd: '/w/p/src' }), rec('ses_wt', { cwd: '/data/opencode/worktree/abc123/wt1' }),
    rec('ses_inner', { cwd: '/w/p/.claude/worktrees/fix/pkg' }), rec('ses_far', { cwd: '/w/other' })];
  const branches = { '/w/p': 'main', '/w/p/src': 'main', '/data/opencode/worktree/abc123/wt1': '', '/w/p/.claude/worktrees/fix/pkg': 'fix-it' };
  const git = {
    worktreesOf: async (dir) => (dir === '/w/p' ? [{ name: 'wt1', dir: '/data/opencode/worktree/abc123/wt1' }, { name: 'fix', dir: '/w/p/.claude/worktrees/fix' }] : []),
    branchOf: async (dir) => branches[dir] || '',
  };
  const { source, calls } = setup({ records, git });
  const by = Object.fromEntries((await source.listSessions({ folders: ['/w/p'] })).sessions.map((s) => [s.sessionId, s]));
  assert.deepEqual(calls[0], ['list', ['/w/p', '/data/opencode/worktree/abc123/wt1']], 'a worktree below the folder is listed with it already');
  assert.deepEqual(Object.keys(by).sort(), ['ses_inner', 'ses_main', 'ses_sub', 'ses_wt']);
  assert.equal(by.ses_main.branch, 'main');
  assert.equal(by.ses_main.worktree, undefined, 'the folder itself is no worktree');
  assert.equal(by.ses_sub.branch, 'main');
  assert.equal(by.ses_wt.worktree, 'wt1');
  assert.equal(by.ses_wt.branch, undefined, 'a detached HEAD names no branch');
  assert.equal(by.ses_inner.worktree, 'fix');
  assert.equal(by.ses_inner.branch, 'fix-it');
  assert.deepEqual((await source.importSessions({ folders: ['/w/p'] })).archived, []);
  assert.deepEqual(calls.filter((c) => c[0] === 'list').pop(), ['list', ['/w/p', '/data/opencode/worktree/abc123/wt1']], 'the import reads the same folders');
});

test('rows: a window opened on a worktree does not mark it, and a worktree two folders share is listed once', async () => {
  const records = [rec('ses_a', { cwd: '/w/p-wt' }), rec('ses_b', { cwd: '/w/q' })];
  const trees = [{ name: 'p-wt', dir: '/w/p-wt' }, { name: 'q', dir: '/w/q' }, { name: 'r', dir: '/w/r' }];
  const git = { worktreesOf: async () => trees, branchOf: async () => '' };
  const { source, calls } = setup({ records, git });
  const rows = (await source.listSessions({ folders: ['/w/p-wt', '/w/q'] })).sessions;
  assert.deepEqual(calls[0], ['list', ['/w/p-wt', '/w/q', '/w/r']]);
  assert.ok(rows.every((r) => !r.worktree), 'both are the window\'s own folders');
});

test('rows: lastUserAt is when this window or another one saw the message sent, or else when OpenCode last began a turn', async () => {
  const records = [rec('ses_here', { lastTurnAt: 250 }), rec('ses_away', { lastTurnAt: 250 }), rec('ses_closed', { lastTurnAt: 250 }), rec('ses_never')];
  const here = { ses_here: { activity: 'stopped', lastUserAt: 240, lastReplyAt: 300 } };
  const far = [{ sessionId: 'ses_away', activity: 'stopped', lastUserAt: 230 }];
  const { source } = setup({ records, here, far });
  const by = Object.fromEntries((await source.listSessions({ folders: ['/w/p'] })).sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.ses_here.lastUserAt, 240, 'not the turn OpenCode began by itself after');
  assert.equal(by.ses_away.lastUserAt, 230);
  assert.equal(by.ses_closed.lastUserAt, 250);
  assert.equal(by.ses_never.lastUserAt, undefined);
});

test('rows: processes counts this window, another VS Code window holding it and each place elsewhere, from two on', async () => {
  const term = { kind: 'terminal', label: 'terminal pts/3 in ~/p', detail: ['process 20'], running: false };
  const run = { kind: 'exec', label: 'opencode run in ~/p', detail: ['process 30'], running: true };
  const records = [rec('ses_alone'), rec('ses_two'), rec('ses_three'), rec('ses_held'), rec('ses_out')];
  const here = { ses_alone: { activity: 'stopped' }, ses_two: { activity: 'stopped' }, ses_three: { activity: 'stopped' } };
  const places = { ses_two: [term], ses_three: [term, run], ses_out: [term] };
  const { source } = setup({ records, here, places, holders: { ses_held: { name: 'other window' } } });
  const by = Object.fromEntries((await source.listSessions({ folders: ['/w/p'] })).sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.ses_alone.processes, undefined);
  assert.equal(by.ses_two.processes, 2);
  assert.equal(by.ses_three.processes, 3);
  assert.equal(by.ses_held.processes, undefined, 'held by one other window and open nowhere else');
  assert.equal(by.ses_out.processes, undefined, 'one terminal alone');
});

test('rows: one open here has the title this window knows, and the records read are handed to the extension', async () => {
  const records = [rec('ses_open', { title: 'Old title' }), rec('ses_closed')];
  const here = { ses_open: { activity: 'stopped', title: 'Renamed here' } };
  const noted = [];
  const { source } = setup({ records, here, noted: (r) => noted.push(r.map((x) => x.id)) });
  const by = Object.fromEntries((await source.listSessions({ folders: ['/w/p'] })).sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.ses_open.title, 'Renamed here');
  assert.equal(by.ses_closed.title, 'Title ses_closed');
  assert.deepEqual(noted, [['ses_open', 'ses_closed']]);
});

test('rows page by the core\'s limit, the later pages from the same reading', async () => {
  const records = Array.from({ length: 5 }, (_, i) => rec(`ses_${i}`));
  const { source, calls } = setup({ records });
  const p1 = await source.listSessions({ folders: ['/w/p'], cursor: null, limit: 2 });
  const p2 = await source.listSessions({ folders: ['/w/p'], cursor: p1.cursor, limit: 2 });
  const p3 = await source.listSessions({ folders: ['/w/p'], cursor: p2.cursor, limit: 2 });
  assert.deepEqual([p1, p2, p3].map((p) => p.sessions.length), [2, 2, 1]);
  assert.equal(p3.cursor, null);
  assert.equal(calls.filter((c) => c[0] === 'list').length, 1, 'one reading for the three pages');
  assert.equal(new Set([...p1.sessions, ...p2.sessions, ...p3.sessions].map((s) => s.sessionId)).size, 5);
});

test('dots: a turn, a prompt and background work here; a turn in another window; a turn elsewhere; the places outside VS Code', async () => {
  const records = [rec('ses_w'), rec('ses_q'), rec('ses_bg'), rec('ses_far'), rec('ses_tui'), rec('ses_idle')];
  const { source } = setup({
    records,
    here: {
      ses_w: { activity: 'working', title: 'Live title', lastUserAt: 900, lastReplyAt: 300 },
      ses_q: { activity: 'waiting', waitingFor: { kind: 'permission', tool: 'bash' }, title: 'New conversation' },
      ses_bg: { activity: 'background', background: [{ kind: 'command', title: 'npm test', pid: 42 }, { kind: 'subagent', title: 'Look' }] },
    },
    far: [{ sessionId: 'ses_far', activity: 'waiting', waitingFor: { kind: 'question' } }],
    places: { ses_tui: [{ kind: 'terminal', label: 'terminal pts/3 in ~/p', detail: ['x'], running: true }], ses_idle: [{ kind: 'terminal', label: 't', detail: [], running: false }] },
  });
  const by = Object.fromEntries((await source.listSessions({ folders: ['/w/p'] })).sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.ses_w.activity, 'working');
  assert.equal(by.ses_w.title, 'Live title', 'this window\'s title is newer');
  assert.equal(by.ses_w.lastActiveAt, 900, 'and so is its last message');
  assert.equal(by.ses_q.title, 'Title ses_q', 'a placeholder title gives way to OpenCode\'s');
  assert.deepEqual([by.ses_q.activity, by.ses_q.waitingFor], ['waiting', { kind: 'permission', tool: 'bash' }]);
  assert.equal(by.ses_bg.activity, 'background');
  assert.deepEqual(by.ses_bg.hover, ['Command still running: npm test (process 42)', 'Subagent still running: Look']);
  assert.deepEqual([by.ses_far.activity, by.ses_far.waitingFor], ['waiting', { kind: 'question' }]);
  assert.deepEqual([by.ses_tui.activity, by.ses_tui.running, by.ses_tui.elsewhere[0].kind], ['working', true, 'terminal']);
  assert.deepEqual([by.ses_idle.activity, by.ses_idle.running, by.ses_idle.elsewhere.length], ['stopped', false, 1], 'open there, not running');
});

test('the scan and the database are watched once the list reads rows, and a change in what runs elsewhere is announced', async () => {
  const activeRef = { ids: [] };
  const { source, timers } = setup({ records: [rec('ses_a')], activeRef });
  assert.equal(timers.length, 0, 'nothing runs before the list asks');
  let fired = 0;
  source.onDidChangeSessions(() => fired++);
  await source.listSessions({ folders: ['/w/p'] });
  assert.deepEqual(timers.map((t) => t.ms), [10000, 3000]);
  const before = fired;
  await timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(fired, before, 'the same reading again fires no change');
  activeRef.ids = ['ses_a'];
  await timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(fired, before + 1, 'a turn that began elsewhere is announced');
});

test('actions: what the source can do, and each one carried out or refused with a reason', async () => {
  const records = [rec('ses_a'), rec('ses_open'), rec('ses_far'), rec('ses_tui'), rec('ses_kid', { parentId: 'ses_a' })];
  const { source, calls } = setup({ records, here: { ses_open: { activity: 'stopped' } }, holders: { ses_far: { pid: 9 } },
    places: { ses_tui: [{ kind: 'terminal', label: 'terminal pts/3 in ~/p', detail: [], running: false }] } });
  assert.deepEqual(source.sessionActions, { open: ['tab'], create: ['tab'], rename: true, delete: true, own: [{ id: 'fork', title: 'Fork Conversation' }] });
  assert.deepEqual((await source.runSessionAction('create', [], { where: 'tab' })).results, [{ sessionId: 'ses_new', outcome: 'done' }]);
  assert.deepEqual((await source.runSessionAction('open', ['ses_a'], { where: 'tab' })).results, [{ sessionId: 'ses_a', outcome: 'done' }]);
  const tui = (await source.runSessionAction('open', ['ses_tui'], { where: 'tab' })).results[0];
  assert.equal(tui.outcome, 'refused');
  assert.match(tui.reason, /terminal pts\/3/);
  assert.equal((await source.runSessionAction('rename', ['ses_a'], { title: '  ' })).results[0].outcome, 'refused');
  assert.deepEqual((await source.runSessionAction('rename', ['ses_a'], { title: 'New name' })).results, [{ sessionId: 'ses_a', outcome: 'done' }]);
  const del = (await source.runSessionAction('delete', ['ses_open', 'ses_far', 'ses_tui', 'ses_a'], {})).results;
  assert.deepEqual(del.map((r) => r.outcome), ['refused', 'refused', 'refused', 'done']);
  assert.match(del[0].reason, /open in this window/);
  assert.match(del[1].reason, /another VS Code window/);
  assert.match(del[2].reason, /elsewhere/);
  assert.deepEqual(calls.filter((c) => c[0] === 'remove'), [['remove', 'ses_a']]);
  assert.deepEqual((await source.runSessionAction('fork', ['ses_a'], {})).results, [{ sessionId: 'ses_a', outcome: 'done' }]);
  assert.equal((await source.runSessionAction('pin', ['ses_a'], {})).results[0].outcome, 'refused', 'an action the source does not have');
  assert.equal((await source.describeDeletion(['ses_a', 'ses_kid']))[0].what, "The conversation and the sessions of its 1 subagent, from OpenCode's database");
  const old = setup({ records, canRename: false, canFork: false }).source;
  assert.deepEqual(old.sessionActions, { open: ['tab'], create: ['tab'], rename: false, delete: true, own: [] });
  assert.match((await old.runSessionAction('rename', ['ses_a'], { title: 'x' })).results[0].reason, /OpenCode 2/);
});

test('a turn running elsewhere stops a delete with a reason, and nothing is removed', async () => {
  const { source, calls } = setup({ records: [rec('ses_r', { busy: true })], active: ['ses_r'] });
  const r = (await source.runSessionAction('delete', ['ses_r'], {})).results[0];
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /it is running a turn/);
  assert.equal(calls.filter((c) => c[0] === 'remove').length, 0);
});

test('import: the sessions OpenCode archived, with their archive times', async () => {
  const { source } = setup({ records: [rec('ses_a', { archivedAt: 555 }), rec('ses_b')] });
  assert.deepEqual(await source.importSessions({ folders: ['/w/p'] }), { archived: [{ sessionId: 'ses_a', at: 555 }], groups: [], pinned: [], colors: {} });
});

test('seen is written to OpenCode for a reply it has not recorded as seen; unread is not', async () => {
  const { source, calls } = setup({ records: [rec('ses_a', { lastReplyAt: 300, viewedAt: 0 }), rec('ses_b', { lastReplyAt: 300, viewedAt: 300 })] });
  await source.noteSeen(['ses_a', 'ses_b'], true);
  assert.deepEqual(calls.filter((c) => c[0] === 'view'), [['view', 'ses_a', 300]]);
  await source.noteSeen(['ses_a'], false);
  assert.equal(calls.filter((c) => c[0] === 'view').length, 1);
});

test('Account & usage, given at once from the last reading: the provider and model of the conversation in front, today\'s cost of every conversation, and this one\'s cost and tokens', async () => {
  const { source, calls } = setup({ records: [rec('ses_a')] });
  let told = 0;
  source.onDidChangeAccountInfo(() => { told++; });
  const first = source.accountInfo({ sessionId: 'ses_a' });
  assert.ok(!first || typeof first.then !== 'function', 'not a promise: Agent Plus does not wait for it');
  assert.equal(first, null, 'nothing read yet');
  for (let i = 0; i < 50 && !told; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(told, 1, 'the core is told once the reading finishes');
  const info = source.accountInfo({ sessionId: 'ses_a' });
  assert.deepEqual(info.rows.map((r) => [r.label, r.value]), [['Provider', 'Amazon Bedrock'], ['Model', 'x.grok'], ['Today, all conversations', '$3.50']]);
  assert.deepEqual(info.conversation.rows.map((r) => [r.label, r.value]), [['Cost', '$0.25'], ['Tokens', '1.2K in · 30 out']]);
  assert.deepEqual(calls.filter((c) => c[0] === 'stats'), [['stats', 'America/Los_Angeles']]);
  source.accountInfo({ sessionId: 'ses_a' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((c) => c[0] === 'stats').length, 1, 'read again only after a minute');
  assert.equal(told, 1, 'and nothing new to tell');
  const none = source.accountInfo({ sessionId: '' });
  assert.deepEqual(none.rows.map((r) => r.label), ['Today, all conversations']);
});

test('today starts at midnight in the user\'s time zone', () => {
  const t = Date.UTC(2026, 10, 26, 8, 30);
  assert.equal(startOfDay(t, 'America/Los_Angeles'), Date.UTC(2026, 10, 26, 8, 0), 'midnight in Los Angeles is 08:00 UTC in November');
  assert.equal(startOfDay(t, 'UTC'), Date.UTC(2026, 10, 26, 0, 0));
});

test('no OpenCode: no rows and a short note with a download button; another failure: the error and the logs; a good reading clears it', async () => {
  const listError = { current: Object.assign(new Error('OpenCode was not found. Install it with npm.'), { code: 'notFound' }) };
  const { source } = setup({ records: [rec('ses_a')], listError });
  let told = 0;
  source.onDidChangeSessionsNotice(() => told++);
  assert.equal(source.sessionsNotice(), null);
  assert.deepEqual(await source.listSessions({ folders: ['/w/p'] }), { sessions: [], cursor: null }, 'nothing to list is not a failed list');
  assert.deepEqual(source.sessionsNotice(), { text: 'OpenCode was not found. Install OpenCode 2 with npm install -g @opencode/cli and reload the window, or download it with the button here.',
    actions: [{ label: 'Download OpenCode', command: 'x.downloadOpenCode', arguments: [] }, { label: 'Show Logs', command: 'x.showLogs', arguments: [] }] });
  assert.equal(told, 1);
  listError.current = new Error('session.list was not JSON');
  await assert.rejects(source.listSessions({ folders: ['/w/p'] }), /not JSON/, 'a failed list still rejects, so the core reports it');
  assert.deepEqual(source.sessionsNotice(), { text: "Couldn't list OpenCode's conversations: session.list was not JSON", actions: [{ label: 'Show Logs', command: 'x.showLogs', arguments: [] }] });
  listError.current = null;
  assert.equal((await source.listSessions({ folders: ['/w/p'] })).sessions.length, 1);
  assert.equal(source.sessionsNotice(), null);
  assert.equal(told, 3);
  const nowhere = setup({ listError: { current: Object.assign(new Error('OpenCode was not found.'), { code: 'notFound' }) }, canDownload: false }).source;
  await nowhere.listSessions({ folders: ['/w/p'] });
  assert.deepEqual(nowhere.sessionsNotice().actions.map((a) => a.label), ['Show Logs'], 'no download for a platform without a build');
  assert.match(nowhere.sessionsNotice().text, /or set the path of the one you have in opencodeAgentPlus\.opencode\.path\.$/);
  assert.ok(nowhere.sessionsNotice().text.length <= 300, 'the note fits the 300 characters the list gives it');
});
