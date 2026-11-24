// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const { vscode, control } = fake.create();
fake.install(vscode);
const { ChatEditorProvider } = require('../../src/host/chat-editor');
const { createSessionManager } = require('../../src/host/session-manager');
const { createLocks } = require('../../src/host/locks');
const { uriOf } = require('../../src/host/agentplus-source');

const A = '3f2b6c1e-0000-4000-8000-00000000000a';

function setup({ locked = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ce-'));
  if (locked) createLocks({ dir, pid: 7777, alive: () => true }).acquire(A);
  const convs = [];
  const manager = createSessionManager({
    locks: createLocks({ dir, pid: 1000, alive: (pid) => pid === 7777 }),
    info: async (id) => ({ id, title: 'Saved title', cwd: '/w', status: 'idle' }),
    makeConversation: async () => {
      const listeners = new Set();
      const c = { aborted: 0, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, fire: (e) => listeners.forEach((f) => f(e)),
        send() {}, abort() { c.aborted++; }, dispose() {} };
      convs.push(c);
      return c;
    },
  });
  const shown = [], focused = [], busy = [];
  const provider = new ChatEditorProvider({
    manager,
    show: (panel, entry) => { const v = { panel, entry, disposed: 0, dispose() { v.disposed++; } }; shown.push(v); return v; },
    focus: (id) => focused.push(id),
    busy: (id, pid) => busy.push([id, pid]),
  });
  return { manager, provider, shown, focused, busy, convs };
}

const open = async (provider, uri, panel) => provider.resolveCustomEditor(provider.openCustomDocument(uri), panel);

test('a chat tab opens its conversation, takes its title and reports focus', async () => {
  const s = setup();
  const panel = control.panel();
  await open(s.provider, uriOf(A), panel);
  assert.strictEqual(s.shown.length, 1);
  assert.strictEqual(s.shown[0].entry.id, A);
  assert.strictEqual(panel.title, 'Saved title');
  assert.deepStrictEqual(s.focused, [A]);
  assert.strictEqual(s.manager.panelOf(A), panel);

  s.convs[0].fire({ type: 'title', title: 'Renamed by the agent' });
  assert.strictEqual(panel.title, 'Renamed by the agent');

  s.convs[0].fire({ type: 'turnEnd', reason: 'endTurn', at: 5 });
  assert.strictEqual(s.manager.snapshot(A).unseen, true, 'nobody was said to be looking');
  panel.setActive(false);
  panel.setActive(true);
  assert.strictEqual(s.manager.snapshot(A).unseen, false, 'coming to the front marks it seen');
  assert.deepStrictEqual(s.focused, [A, A]);
});

test('closing the tab disposes the page and closes the conversation', async () => {
  const s = setup();
  const panel = control.panel();
  await open(s.provider, uriOf(A), panel);
  s.convs[0].fire({ type: 'turnStart', at: 1 });
  panel.dispose();
  assert.strictEqual(s.shown[0].disposed, 1);
  assert.strictEqual(s.manager.has(A), false);
  assert.strictEqual(s.convs[0].aborted, 1);
});

test('a conversation running in another window is not opened here', async () => {
  const s = setup({ locked: true });
  const panel = control.panel();
  await open(s.provider, uriOf(A), panel);
  assert.strictEqual(s.shown.length, 0);
  assert.match(panel.webview.html, /open in another window/);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.deepStrictEqual(s.busy, [[A, 7777]]);
});

test('a URI that names no conversation, and a tab closed while it opened', async () => {
  const s = setup();
  const bad = control.panel();
  await open(s.provider, vscode.Uri.from({ scheme: 'opencodeplus-session', path: '/../x' }), bad);
  assert.match(bad.webview.html, /does not name a conversation/);

  const panel = control.panel();
  const p = open(s.provider, uriOf(A), panel);
  panel.dispose();
  await p;
  assert.strictEqual(s.shown.length, 0);
  assert.strictEqual(s.manager.has(A), false, 'the conversation it started opening is closed again');
});

test('a page that fails to draw leaves a message in the tab', async () => {
  const s = setup();
  s.provider.deps.show = () => { throw new Error('no media folder'); };
  const panel = control.panel();
  await open(s.provider, uriOf(A), panel);
  assert.match(panel.webview.html, /could not be shown: no media folder/);
});
