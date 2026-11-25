// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The host side of the message box and the editor: the provider sign-in's terminal, the @ references and the lines they
 * name, Edit automatically, detached commands read from a /proc of the test's own, the quick fix, what the editor
 * offers a message, and what package.json declares for them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProviderLogin, addedProviders, onlyFreeModels, TERMINAL_NAME } = require('../../src/host/provider-login');
const mentions = require('../../src/host/mentions');
const autoEdit = require('../../src/host/auto-edit');
const detached = require('../../src/host/detached');
const fixes = require('../../src/host/fix-actions');
const { createSelectionTracker } = require('../../src/host/selection');

const ROOT = path.join(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function terminals() {
  const closed = new Set();
  const made = [];
  const vscode = {
    ThemeIcon: class { constructor(id) { this.id = id; } },
    window: {
      createTerminal(opts) { const t = { opts, shown: 0, show() { t.shown++; }, exitStatus: undefined }; made.push(t); return t; },
      onDidCloseTerminal(fn) { closed.add(fn); return { dispose: () => closed.delete(fn) }; },
    },
  };
  const close = (t, code) => { t.exitStatus = { code }; for (const fn of [...closed]) fn(t); };
  return { vscode, made, close, closed };
}

test('Connect a Provider opens one terminal with the sign-in, shows it again when asked, and runs done() when it closes', async () => {
  const { vscode, made, close, closed } = terminals();
  const done = [];
  const failed = [];
  const lg = createProviderLogin({ vscode, launch: async () => ({ shellPath: '/opt/oc/opencode', shellArgs: ['auth', 'login', '--standalone'], env: { AWS_PROFILE: 'self' } }),
    done: async (r) => { done.push(r); }, fail: (what, e) => failed.push([what, e.message]) });
  const [a, b] = await Promise.all([lg.run(), lg.run()]);
  assert.equal(a, b, 'two clicks at once open one terminal');
  assert.equal(made.length, 1);
  assert.deepEqual({ ...made[0].opts, iconPath: made[0].opts.iconPath.id }, { name: TERMINAL_NAME, shellPath: '/opt/oc/opencode', shellArgs: ['auth', 'login', '--standalone'],
    env: { AWS_PROFILE: 'self' }, isTransient: true, iconPath: 'key' });
  await lg.run();
  assert.equal(made.length, 1, 'asked again, the same terminal is shown');
  assert.ok(made[0].shown >= 2);
  close({ exitStatus: undefined }, 0);
  await settle();
  assert.deepEqual(done, [], 'another terminal closing does nothing');
  close(made[0], 0);
  await settle();
  assert.deepEqual(done, [{ exitCode: 0 }]);
  assert.equal(lg.terminal, null);
  await lg.run();
  assert.equal(made.length, 2, 'after it closed, a new one opens');
  lg.dispose();
  assert.equal(closed.size, 0);

  const broken = createProviderLogin({ vscode, launch: async () => { throw new Error('OpenCode was not found.'); }, done: async () => {}, fail: (what, e) => failed.push([what, e.message]) });
  assert.equal(await broken.run(), null);
  assert.deepEqual(failed, [['OpenCode\'s sign-in could not be started', 'OpenCode was not found.']]);
});

test('the providers a sign-in added, and a list of OpenCode\'s free models only', () => {
  const free = [{ id: 'opencode/big-pickle', providerId: 'opencode' }, { id: 'opencode/tidepool-alpha-free', providerId: 'opencode' }];
  const after = [...free, { id: 'anthropic/claude-x', providerId: 'anthropic' }, { id: 'anthropic/claude-y', providerId: 'anthropic' }];
  assert.deepEqual(addedProviders(free, after), ['anthropic']);
  assert.deepEqual(addedProviders(after, after), []);
  assert.equal(onlyFreeModels(free), true);
  assert.equal(onlyFreeModels(after), false);
  assert.equal(onlyFreeModels([]), false, 'no models is not "only free ones"');
});

test('@ references: relative inside a workspace folder, absolute outside, with lines as #L', () => {
  const root = path.join(os.tmpdir(), 'ws-x');
  const inside = path.join(root, 'src', 'sum.js');
  assert.deepEqual(mentions.refFor(inside, { folders: [root] }), { path: inside, name: 'sum.js', rel: 'src/sum.js', token: '@src/sum.js' });
  assert.equal(mentions.refFor(inside, { folders: [root], startLine: 3, endLine: 5 }).token, '@src/sum.js#L3-5');
  assert.equal(mentions.refFor(inside, { folders: [root], startLine: 4, endLine: 4 }).token, '@src/sum.js#L4');
  const outside = path.join(os.tmpdir(), 'elsewhere', 'a.txt');
  assert.equal(mentions.refFor(outside, { folders: [root] }).rel, outside.split(path.sep).join('/'));
  assert.equal(mentions.refFor('relative/a.txt', { folders: [root] }), null);
  assert.deepEqual(mentions.linesOf({ start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }), { startLine: 3, endLine: 4 }, 'a selection ending at the start of a line does not take it');
});

test('the lines a reference names are read from the editor\'s text, else from disk, and cut at the limit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-ranges-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'c.txt');
  fs.writeFileSync(f, 'one\r\ntwo\r\nthree\r\n');
  assert.equal(mentions.rangeText(f, 2, 3), 'two\nthree');
  assert.equal(mentions.rangeText(f, 2, 3, { open: 'uno\ndos\ntres' }), 'dos\ntres', 'what the editor holds, saved or not');
  assert.equal(mentions.rangeText(f, 9, 9), null, 'no such lines');
  assert.equal(mentions.rangeText(path.join(dir, 'gone.txt'), 1, 1), null);
  assert.equal(mentions.rangeText(f, 1, 3, { maxChars: 5 }), 'one\nt');
});

test('Fix with OpenCode drafts what the editor reports, with the place as a reference', () => {
  const ref = mentions.refFor(path.join(os.tmpdir(), 'ws', 'bad.json'), { folders: [path.join(os.tmpdir(), 'ws')], startLine: 2, endLine: 2 });
  const one = mentions.fixDraft(ref, [{ severity: 0, message: 'Expected comma\n  or closing brace', line: 2, source: 'json', code: 514 }]);
  assert.equal(one, 'Fix this problem in @bad.json#L2:\n- Error at line 2 (json 514): Expected comma or closing brace');
  const many = mentions.fixDraft(ref, Array.from({ length: 7 }, (_, i) => ({ severity: 1, message: `w${i}`, line: 2 })));
  assert.match(many, /^Fix these problems in @bad\.json#L2:/);
  assert.equal(many.split('\n').length, 1 + mentions.MAX_DIAGNOSTICS);
});

test('Edit automatically is kept per conversation in the workspace state, newest last', () => {
  const store = new Map();
  const memo = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } };
  const a = autoEdit.createAutoEdit({ memo });
  const heard = [];
  a.onDidChange((id) => heard.push(id));
  a.set('ses_one', true);
  a.set('ses_two', true);
  a.set('ses_one', true);
  a.set('ses_two', false);
  assert.deepEqual(store.get(autoEdit.KEY), ['ses_one']);
  assert.deepEqual(heard, ['ses_one', 'ses_two', 'ses_two']);
  const again = autoEdit.createAutoEdit({ memo });
  assert.equal(again.get('ses_one'), true, 'a reopened tab finds it');
  assert.equal(again.get('ses_two'), false);
});

test('only edits and writes of files inside the conversation\'s folder are allowed without asking', () => {
  const folder = path.join(os.tmpdir(), 'proj');
  assert.equal(autoEdit.allowable({ kind: 'edit', path: path.join(folder, 'a.js') }, folder), true);
  assert.equal(autoEdit.allowable({ kind: 'write', path: 'src/new.js' }, folder), true, 'relative to the folder');
  assert.equal(autoEdit.allowable({ kind: 'edit', diff: { path: path.join(folder, 'b.js') } }, folder), true);
  assert.equal(autoEdit.allowable({ kind: 'edit', path: path.join(folder, '..', 'other', 'a.js') }, folder), false, 'outside the folder');
  assert.equal(autoEdit.allowable({ kind: 'command', command: 'rm -rf /' }, folder), false, 'commands still ask');
  assert.equal(autoEdit.allowable({ kind: 'other', summary: 'webfetch' }, folder), false);
  assert.equal(autoEdit.allowable({ kind: 'edit' }, folder), false, 'no path, no answer');
});

test('the guard answers an allowed request once and keeps it and its answer from the page; the others pass', async () => {
  const listeners = new Set();
  const conv = { cwd: '/proj', on(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const emit = (ev) => { for (const fn of [...listeners]) fn(ev); };
  let on = true;
  const answered = [];
  autoEdit.guard(conv, { enabled: () => on, folder: () => conv.cwd, answer: async (rid) => { answered.push(rid); } });
  const seen = [];
  conv.on((ev) => seen.push(`${ev.type}:${ev.requestId || ''}`));
  emit({ type: 'toolCall', id: 't1' });
  emit({ type: 'permission', requestId: 'p1', request: { kind: 'edit', path: '/proj/a.js' } });
  emit({ type: 'permission', requestId: 'p2', request: { kind: 'command', command: 'ls' } });
  emit({ type: 'permissionSettled', requestId: 'p1', decision: 'allowOnce' });
  on = false;
  emit({ type: 'permission', requestId: 'p3', request: { kind: 'edit', path: '/proj/b.js' } });
  await settle();
  assert.deepEqual(answered, ['p1']);
  assert.deepEqual(seen, ['toolCall:', 'permission:p2', 'permission:p3']);
});

/* A /proc with: this conversation's detached sleep (ppid 1), its shell under the OpenCode (pid 500), another
   conversation's command, and a process whose environment cannot be read. */
function fakeProc(t, session) {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-proc-'));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu  1 2 3\nbtime 1795590000\nprocesses 9\n');
  const put = (pid, { ppid, start = 100, env = [], cmd = [], unreadable = false }) => {
    const d = path.join(proc, String(pid));
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (some (odd) name) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`);
    if (!unreadable) fs.writeFileSync(path.join(d, 'environ'), `${env.join('\0')}\0`);
    fs.writeFileSync(path.join(d, 'cmdline'), `${cmd.join('\0')}\0`);
  };
  put(1, { ppid: 0, cmd: ['/sbin/init'] });
  put(500, { ppid: 1, cmd: ['opencode', 'acp'] });
  put(501, { ppid: 500, env: [`OPENCODE_SESSION_ID=${session}`, 'OPENCODE=1'], cmd: ['/bin/bash', '-c', 'npm test'] });
  put(777, { ppid: 1, start: 12345, env: ['HOME=/h', `OPENCODE_SESSION_ID=${session}`], cmd: ['sleep', '287'] });
  put(778, { ppid: 1, start: 99, env: ['OPENCODE_SESSION_ID=ses_other'], cmd: ['sleep', '9'] });
  put(779, { ppid: 1, unreadable: true, cmd: ['secret'] });
  fs.mkdirSync(path.join(proc, 'self'));
  return proc;
}

test('detached commands: this conversation\'s processes outside the OpenCode\'s tree, with command line, pid and start', (t) => {
  const session = 'ses_dedf9bb86ffeQWHYoj0gKnGLyB';
  const proc = fakeProc(t, session);
  const found = detached.scan({ sessionId: session, rootPid: 500, proc, self: 99999 });
  assert.deepEqual(found, [{ pid: 777, command: 'sleep 287', startedAt: (1795590000 + 123.45) * 1000 }]);
  assert.deepEqual(detached.scan({ sessionId: session, rootPid: 0, proc, self: 99999 }).map((d) => d.pid), [501, 777], 'without the OpenCode\'s pid, all of them');
  assert.deepEqual(detached.scan({ sessionId: '', proc }), []);
  assert.deepEqual(detached.scan({ sessionId: session, proc: path.join(proc, 'missing') }), [], 'no /proc, nothing');
  assert.equal(detached.supported('linux', proc), true);
  assert.equal(detached.supported('darwin', proc), false, 'other systems list none');
  assert.equal(detached.supported('win32', proc), false);
});

test('the quick fix is offered for errors and warnings in files while the setting is on, and carries them', () => {
  class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
  const vscode = { CodeAction, CodeActionKind: { QuickFix: 'quickfix' } };
  let on = true;
  const p = fixes.createFixActions({ vscode, enabled: () => on });
  const doc = { uri: { scheme: 'file', fsPath: '/ws/bad.json' } };
  const d = (severity, line, message) => ({ severity, message, source: 'json', code: { value: 514 }, range: { start: { line, character: 0 }, end: { line, character: 4 } } });
  const [a] = p.provideCodeActions(doc, null, { diagnostics: [d(0, 1, 'Expected comma'), d(2, 1, 'just a note'), d(1, 2, 'Trailing comma')] });
  assert.equal(a.title, 'Fix with OpenCode Agent Plus');
  assert.equal(a.kind, 'quickfix');
  assert.equal(a.diagnostics.length, 2, 'an information is not offered a fix');
  assert.equal(a.command.command, fixes.COMMAND);
  assert.deepEqual(a.command.arguments[1], [
    { severity: 0, message: 'Expected comma', line: 2, endLine: 2, source: 'json', code: '514' },
    { severity: 1, message: 'Trailing comma', line: 3, endLine: 3, source: 'json', code: '514' }]);
  assert.deepEqual(p.provideCodeActions(doc, null, { diagnostics: [d(3, 1, 'hint')] }), []);
  assert.deepEqual(p.provideCodeActions({ uri: { scheme: 'untitled' } }, null, { diagnostics: [d(0, 1, 'x')] }), [], 'files only');
  on = false;
  assert.deepEqual(p.provideCodeActions(doc, null, { diagnostics: [d(0, 1, 'x')] }), [], 'off with the setting');
  assert.equal(fixes.registerFixActions({ vscode: {}, enabled: () => true }), null, 'no languages API, no provider');
});

test('what the editor offers a message: the selection and the file last in front, while they are visible', async () => {
  const listeners = { sel: new Set(), vis: new Set(), act: new Set() };
  const ev = (set) => (fn) => { set.add(fn); return { dispose: () => set.delete(fn) }; };
  const editor = (p, sel) => ({ document: { uri: { scheme: 'file', fsPath: p }, getText: () => 'text' }, selection: sel });
  const empty = { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const lines = (a, b) => ({ isEmpty: false, start: { line: a, character: 0 }, end: { line: b, character: 3 } });
  const a = editor('/ws/a.js', empty);
  const b = editor('/ws/b.js', empty);
  const window = { activeTextEditor: a, visibleTextEditors: [a, b], onDidChangeTextEditorSelection: ev(listeners.sel),
    onDidChangeVisibleTextEditors: ev(listeners.vis), onDidChangeActiveTextEditor: ev(listeners.act) };
  const tracker = createSelectionTracker({ vscode: { window }, settleMs: 1 });
  const off = tracker.onDidChange(() => {});
  assert.deepEqual(tracker.context(), { selection: null, file: { path: '/ws/a.js', name: 'a.js', label: 'a.js', key: '/ws/a.js' } });
  window.activeTextEditor = undefined;
  for (const fn of listeners.act) fn(undefined);
  assert.equal(tracker.context().file.path, '/ws/a.js', 'moving into the chat tab keeps the file last in front');
  window.activeTextEditor = b;
  for (const fn of listeners.act) fn(b);
  b.selection = lines(1, 2);
  for (const fn of listeners.sel) fn({ textEditor: b });
  assert.deepEqual(tracker.context(), { selection: { path: '/ws/b.js', name: 'b.js', startLine: 2, endLine: 3, label: 'b.js:2-3', key: '/ws/b.js:2-3' },
    file: { path: '/ws/b.js', name: 'b.js', label: 'b.js', key: '/ws/b.js' } });
  assert.equal(tracker.lastEditor(), b);
  window.visibleTextEditors = [a];
  for (const fn of listeners.vis) fn();
  assert.deepEqual(tracker.context(), { selection: null, file: { path: '/ws/a.js', name: 'a.js', label: 'a.js', key: '/ws/a.js' } }, 'a hidden editor offers nothing');
  /* Opened beside the chat tab without taking the focus: no editor became active, and the new one is in front. */
  const c = editor('/ws/c.js', empty);
  window.visibleTextEditors = [a, c];
  for (const fn of listeners.vis) fn();
  assert.equal(tracker.context().file.path, '/ws/c.js');
  off.dispose();
});

test('package.json: the commands, menus, keys and settings of the message box and the editor', () => {
  const c = PKG.contributes;
  const cmd = (id) => c.commands.find((x) => x.command === id);
  assert.equal(cmd('opencodeAgentPlus.connectProvider').title, 'Connect a Model Provider');
  for (const id of ['focusInput', 'blurInput', 'insertAtMention', 'addToConversation', 'fixWithOpenCode']) assert.ok(cmd(`opencodeAgentPlus.${id}`), id);
  const keys = (id) => c.keybindings.filter((k) => k.command === id);
  /* As the Claude Code extension's: Cmd on macOS, Ctrl elsewhere; Alt+K on all. */
  assert.deepEqual(keys('opencodeAgentPlus.focusInput').map((k) => [k.key, k.mac]), [['cmd+escape', 'cmd+escape']]);
  assert.deepEqual(keys('opencodeAgentPlus.blurInput').map((k) => [k.key, k.mac]), [['cmd+escape', 'cmd+escape']]);
  assert.deepEqual(keys('opencodeAgentPlus.insertAtMention').map((k) => [k.key, k.mac]), [['alt+k', 'alt+k']]);
  assert.match(keys('opencodeAgentPlus.focusInput')[0].when, /editorTextFocus && !opencodeAgentPlus\.otherChatLast/);
  assert.match(keys('opencodeAgentPlus.blurInput')[0].when, /^isWorkspaceTrusted && activeCustomEditorId == 'opencodeAgentPlus\.chat' && !editorTextFocus/);
  assert.match(keys('opencodeAgentPlus.insertAtMention')[0].when, /editorTextFocus && !opencodeAgentPlus\.otherChatLast/);
  const add = (menu) => c.menus[menu].find((m) => m.command === 'opencodeAgentPlus.addToConversation');
  assert.match(add('editor/context').when, /isWorkspaceTrusted/);
  assert.match(add('explorer/context').when, /!explorerResourceIsFolder/);
  const props = c.configuration.properties;
  assert.deepEqual(['attachOpenFile', 'attachSelection', 'useCtrlEnterToSend', 'showFixActions'].map((k) => props[`opencodeAgentPlus.${k}`].default), [true, true, false, true]);
});
