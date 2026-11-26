// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Tests for src/opencode/elsewhere.js: OpenCode's terminal interface and `opencode run` found among the processes, the
 * terminal interface's tabs, the background service's turns, and the sessions `opencode run` created.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createElsewhere, roleOf, readTabs, linuxProcesses, macProcesses, windowsProcesses, splitWindows } = require('../../src/opencode/elsewhere');

test('an OpenCode process is told apart by its subcommand, with flag values not taken for one', () => {
  assert.deepEqual(roleOf(['/usr/bin/opencode']), { role: 'terminal', dir: '', session: '', continues: false, fork: false });
  assert.equal(roleOf(['opencode', '/w/p']).dir, '/w/p', 'a folder given to the terminal interface');
  assert.equal(roleOf(['opencode', '-s', 'ses_x']).session, 'ses_x');
  assert.equal(roleOf(['opencode', '--prompt', 'run', '/w']).role, 'terminal', 'a value after --prompt is not the run subcommand');
  assert.equal(roleOf(['opencode', 'mini']).role, 'terminal');
  assert.deepEqual(roleOf(['/x/opencode', 'run', 'Count to 3']), { role: 'run', dir: '', session: '', continues: false, fork: false });
  assert.equal(roleOf(['opencode', 'run', '-s', 'ses_y', 'go on']).continues, true);
  assert.equal(roleOf(['opencode', 'run', '-c', '--fork', 'again']).fork, true);
  for (const sub of ['acp', 'serve', 'api', 'session']) assert.equal(roleOf(['opencode', sub, '--stdio']).role, 'other', sub);
  assert.equal(roleOf(['C:\\Tools\\OpenCode.exe']).role, 'terminal');
  assert.equal(roleOf(['/usr/bin/node', 'opencode']), null, 'not an OpenCode program');
  assert.equal(roleOf([]), null);
});

function fakeProc(t, procs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-proc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'stat'), 'cpu  1 2 3\nbtime 1700000000\n');
  for (const p of procs) {
    const dir = path.join(root, String(p.pid));
    fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cmdline'), `${p.argv.join('\0')}\0`);
    if (p.cwd) fs.symlinkSync(p.cwd, path.join(dir, 'cwd'));
    if (p.tty) fs.symlinkSync(`/dev/${p.tty}`, path.join(dir, 'fd', '0'));
    /* Field 22 of stat, the start time in clock ticks after boot; the name has a space and a parenthesis in it. */
    fs.writeFileSync(path.join(dir, 'stat'), `${p.pid} (open code) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${p.ticks || 0} 0 0\n`);
  }
  return root;
}

const LINUX_ONLY = { skip: process.platform === 'win32' && 'a fake /proc needs POSIX symbolic links; the reader runs on Linux only' };

test('Linux: the OpenCode processes, with their folder, terminal and start time, from /proc', LINUX_ONLY, (t) => {
  const proc = fakeProc(t, [
    { pid: 10, argv: ['/opt/opencode', 'run', 'hi'], cwd: '/w/p', tty: 'pts/3', ticks: 250 },
    { pid: 11, argv: ['/usr/bin/bash'], cwd: '/w' },
  ]);
  const got = linuxProcesses(proc, fs);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { pid: 10, argv: ['/opt/opencode', 'run', 'hi'], cwd: '/w/p', tty: 'pts/3', startedAt: 1700000000000 + 2500 });
});

test('macOS: ps and lsof give the same', async () => {
  const execFile = (file, args, opts, cb) => {
    if (file === 'ps') return cb(null, '  501 Wed Nov 26 05:36:12 2026     ttys003  /opt/homebrew/bin/opencode\n  502 Wed Nov 26 05:36:12 2026 ??  /bin/zsh\n', '');
    if (file === 'lsof') return cb(null, 'p501\nfcwd\nn/Users/me/proj\n', '');
    return cb(new Error('no'), '', '');
  };
  const got = await macProcesses(execFile);
  assert.equal(got.length, 1);
  assert.equal(got[0].pid, 501);
  assert.equal(got[0].tty, 'ttys003');
  assert.equal(got[0].cwd, '/Users/me/proj');
  assert.ok(got[0].startedAt > 0);
});

test('Windows: Win32_Process gives the command line and start time, and no folder', async () => {
  const execFile = (file, args, opts, cb) => cb(null, JSON.stringify({ ProcessId: 77, CommandLine: '"C:\\Program Files\\OpenCode\\opencode.exe" run "two words"', Started: 1795671431923 }), '');
  const got = await windowsProcesses(execFile);
  assert.deepEqual(got, [{ pid: 77, argv: ['C:\\Program Files\\OpenCode\\opencode.exe', 'run', 'two words'], cwd: '', tty: '', startedAt: 1795671431923 }]);
  assert.deepEqual(splitWindows('a "" b'), ['a', '', 'b']);
});

function stateWithTabs(t, tabs) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-state-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  fs.mkdirSync(path.join(state, 'latest', 'tui'), { recursive: true });
  /* As 2.4.1 wrote it. */
  fs.writeFileSync(path.join(state, 'latest', 'tui', 'tabs.json'), JSON.stringify({ global: { tabs: [], unread: {} }, cwd: Object.fromEntries(Object.entries(tabs).map(([k, ids]) => [k, { tabs: ids.map((id) => ({ sessionID: id, title: 't' })), unread: {} }])) }));
  return state;
}

test('the terminal interface\'s tabs are read by folder', (t) => {
  const state = stateWithTabs(t, { '/w/p': ['ses_a', 'ses_b'], '/w/q': [] });
  const tabs = readTabs(state, fs);
  assert.deepEqual([...tabs.keys()], ['/w/p']);
  assert.deepEqual([...tabs.get('/w/p')], ['ses_a', 'ses_b']);
  assert.equal(readTabs('/nonexistent', fs).size, 0);
});

function setup(t, { procs = [], tabs = {}, active = [], ours = [] } = {}) {
  const proc = fakeProc(t, procs);
  const state = stateWithTabs(t, tabs);
  let memory = {};
  const e = createElsewhere({ platform: 'linux', proc, fs, home: '/w', stateDir: async () => state, active: async () => new Set(active),
    memory: { get: () => memory, set: (v) => { memory = v; } }, ours: (id) => ours.includes(id) });
  return { e, memory: () => memory };
}

const rec = (id, cwd, createdAt, extra = {}) => ({ id, cwd, createdAt, parentId: '', ...extra });

test('a tab of a terminal interface that runs in its folder is open there, idle or in a turn; a tab left by one that exited is not', LINUX_ONLY, async (t) => {
  const { e } = setup(t, { procs: [{ pid: 20, argv: ['/opt/opencode'], cwd: '/w/p', tty: 'pts/10', ticks: 100 }], tabs: { '/w/p': ['ses_a'], '/w/q': ['ses_q'] }, active: ['ses_a'] });
  const reading = await e.scan();
  const places = e.placesOf(rec('ses_a', '/w/p', 1), reading);
  assert.equal(places.length, 1);
  assert.equal(places[0].kind, 'terminal');
  assert.equal(places[0].label, 'terminal pts/10 in ~/p');
  assert.equal(places[0].running, true, 'its turn runs in the background service');
  assert.ok(places[0].detail.some((d) => d.includes('process 20')));
  assert.deepEqual(e.placesOf(rec('ses_q', '/w/q', 1), reading), [], 'no terminal interface runs in /w/q');
});

test('a turn in the background service with no terminal interface showing it is placed there, and running', async (t) => {
  const { e } = setup(t, { active: ['ses_web'] });
  const places = e.placesOf(rec('ses_web', '/w/p', 1), await e.scan());
  assert.deepEqual(places.map((p) => [p.kind, p.running]), [['other', true]]);
});

test('a session created in its folder just after an opencode run started is that run\'s, and stays background after it ends', LINUX_ONLY, async (t) => {
  const start = 1700000000000 + 5000;
  const { e, memory } = setup(t, { procs: [{ pid: 30, argv: ['/opt/opencode', 'run', 'go'], cwd: '/w/p', ticks: 500 }], ours: ['ses_ours'] });
  const reading = await e.scan();
  const records = [rec('ses_before', '/w/p', start - 60000), rec('ses_ours', '/w/p', start + 100), rec('ses_run', '/w/p', start + 900), rec('ses_there', '/w/q', start + 900)];
  e.noteRuns(records, reading);
  assert.deepEqual(Object.keys(memory()), ['ses_run'], 'not one made earlier, not one this extension made, not one in another folder');
  assert.equal(e.kindOf(records[2]), 'background');
  assert.equal(e.kindOf(records[0]), 'user');
  assert.equal(e.kindOf(rec('ses_child', '/w/p', 1, { parentId: 'ses_run' })), 'subagent');
  const places = e.placesOf(records[2], reading);
  assert.deepEqual(places.map((p) => [p.kind, p.label, p.running]), [['exec', 'opencode run in ~/p', true]]);
  const later = setup(t, {}).e;
  assert.equal(e.kindOf(records[2]), 'background', 'remembered');
  assert.deepEqual(later.placesOf(records[2], await later.scan()), [], 'nothing left running once the run is gone');
});

test('an opencode run that continues a session (-s, -c) marks nothing; one with --fork marks the copy it makes', LINUX_ONLY, async (t) => {
  const start = 1700000000000 + 5000;
  const records = [rec('ses_new', '/w/p', start + 500)];
  const cont = setup(t, { procs: [{ pid: 31, argv: ['/opt/opencode', 'run', '-s', 'ses_old', 'more'], cwd: '/w/p', ticks: 500 }] });
  cont.e.noteRuns(records, await cont.e.scan());
  assert.deepEqual(cont.memory(), {});
  const forked = setup(t, { procs: [{ pid: 32, argv: ['/opt/opencode', 'run', '-c', '--fork', 'again'], cwd: '/w/p', ticks: 500 }] });
  forked.e.noteRuns(records, await forked.e.scan());
  assert.deepEqual(Object.keys(forked.memory()), ['ses_new']);
});
