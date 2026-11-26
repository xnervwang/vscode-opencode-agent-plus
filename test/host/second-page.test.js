// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Through extension.js with the window tests' fake backend: a second chat page for a conversation already open in
 * another page shows the same entries as that page, including the turns this window ran since the conversation opened.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const { vscode, control } = fake.create();
fake.install(vscode);
process.env.OPENCODE_AGENT_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext-second-page-'));
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

const memento = (m) => ({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } });
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'storage')),
  globalState: memento(new Map()),
  workspaceState: memento(new Map()),
  extension: { packageJSON: { version: '0.0.1' } },
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
};
const reset = (p) => p.webview.posted.filter((m) => m.type === 'reset').pop();

test('a second page for an open conversation shows the turns this window ran in it', async () => {
  control.state.config['opencodeAgentPlus.model'] = 'fake/fake-small';
  const api = extension.activate(context);
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  const id = opened[0].slice('opencodeagentplus-session:/'.length).split('/')[0];
  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const uri = vscode.Uri.from({ scheme: 'opencodeagentplus-session', path: `/${id}` });
  const first = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uri), first);
  first.fromPage({ type: 'ready' });
  await api.test.send(id, 'Reply with only the word alpha.');
  const done = await until(() => { const s = api.test.snapshot(id); return s && s.activity === 'stopped' && s.lastReplyAt; });
  assert.ok(done, 'the turn ended');

  const second = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uri), second);
  second.fromPage({ type: 'ready' });
  const got = await until(() => reset(second));
  assert.ok(got, 'the second page was sent its view');
  assert.match(JSON.stringify(got.items), /Reply with only the word alpha\./, 'it includes the message sent from the first page');
  const kinds = (p) => (reset(p) ? reset(p).items.map((x) => x.kind) : []);
  first.webview.posted.length = 0;
  first.fromPage({ type: 'ready' });
  await until(() => reset(first));
  assert.deepStrictEqual(kinds(second), kinds(first), 'the same entries as the first page');
  extension.deactivate();
});
