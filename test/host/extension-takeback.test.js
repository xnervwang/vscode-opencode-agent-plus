// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Through extension.js with the window tests' fake backend: a conversation still held by this window's own extension
 * host from before a reload (the same window name in its lock) is taken back without asking when its tab is restored;
 * one held by another window still asks "Take over here".
 */
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const { vscode, control } = fake.create();
fake.install(vscode);
process.env.OPENCODE_AGENT_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext-takeback-'));
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');
const { createLocks } = require('../../src/host/locks');

const store = new Map();
const memento = (m) => ({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } });
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'storage')),
  globalState: memento(new Map()),
  workspaceState: memento(store),
  extension: { packageJSON: { version: '0.0.1' } },
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const uriOf = (id) => vscode.Uri.from({ scheme: 'opencodeagentplus-session', path: `/${id}` });
const BUSY = 'This conversation is open in another VS Code window';

test('this window takes back what its earlier extension host holds without asking; another window still asks', async (t) => {
  /* A live process stands in for the earlier extension host; its locks are written as that host would write them. */
  const ghost = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { ghost.kill('SIGKILL'); } catch (_) { /* gone */ } });
  extension.activate(context);
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  const [a, b] = opened.map((u) => u.slice('opencodeagentplus-session:/'.length));
  const token = store.get('opencodeAgentPlus.window');
  assert.match(String(token), /^[0-9a-f-]{36}$/, 'the window has a name, kept in its workspace state');

  const dir = path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'locks');
  const asked = [];
  const earlier = createLocks({ dir, pid: ghost.pid, window: token });
  earlier.onTakeover((id) => { asked.push(id); });
  t.after(() => earlier.dispose());
  assert.deepStrictEqual(earlier.acquire(a), { ok: true });
  const other = createLocks({ dir, pid: ghost.pid, window: '11111111-2222-4333-8444-555555555555' });
  t.after(() => other.dispose());
  assert.deepStrictEqual(other.acquire(b), { ok: true });

  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const panelA = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uriOf(a)), panelA);
  assert.deepStrictEqual(asked, [a]);
  assert.ok(!control.state.said.some((m) => String(m.message).includes(BUSY)), 'not asked');
  assert.match(panelA.webview.html, /media\/chat\.js/, 'the chat page is in the tab');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${a}.lock`), 'utf8')).pid, process.pid);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${a}.lock`), 'utf8')).window, token);

  const panelB = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uriOf(b)), panelB);
  const said = control.state.said.filter((m) => String(m.message).includes(BUSY));
  assert.strictEqual(said.length, 1);
  assert.deepStrictEqual(said[0].buttons, ['Take over here']);
  assert.match(panelB.webview.html, /Take over here/);
  assert.strictEqual(other.held().includes(b), true);
  await settle();
  extension.deactivate();
});

test('the lock of an earlier host of this window that does not answer is taken by force, still without asking', async (t) => {
  const ghost = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { ghost.kill('SIGKILL'); } catch (_) { /* gone */ } });
  extension.activate(context);
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  const id = opened[0].slice('opencodeagentplus-session:/'.length);
  const dir = path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'locks');
  /* A frozen host: it holds the lock and never sees the request. */
  const frozen = createLocks({ dir, pid: ghost.pid, window: store.get('opencodeAgentPlus.window'), watch: () => ({ close() {} }) });
  assert.deepStrictEqual(frozen.acquire(id), { ok: true });
  const saidBefore = control.state.said.length;
  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const panel = control.panel();
  const started = Date.now();
  await provider.resolveCustomEditor(provider.openCustomDocument(uriOf(id)), panel);
  assert.ok(Date.now() - started >= 9000, 'it waited for the earlier host first');
  assert.deepStrictEqual(control.state.said.slice(saidBefore).filter((m) => m.kind !== 'error'), [], 'nothing asked');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8')).pid, process.pid);
  assert.match(panel.webview.html, /media\/chat\.js/);
  extension.deactivate();
});
