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

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
const { vscode, control } = fake.create();
fake.install(vscode);
process.env.NEW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext-'));
process.env.NEW_AGENT_TEST_BACKEND = BACKEND;
process.env.NEW_AGENT_TEST_CONTROL = '1';
const extension = require('../../extension');

const loaded = (part) => Object.keys(require.cache).some((k) => k.includes(part));
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.NEW_AGENT_HOME, 'storage')),
  extension: { packageJSON: { version: '0.0.1' } },
};

test('activate registers, and starts nothing', async () => {
  const api = extension.activate(context);
  for (const id of ['newAgent.newConversation', 'newAgent.openConversation', 'newAgent.renameConversation', 'newAgent.deleteConversation', 'newAgent.chooseModel', 'newAgent.testConnection']) {
    assert.ok(control.state.registered.includes(id), id);
  }
  assert.ok(control.state.editors['newAgent.chat'], 'the chat editor is registered');
  assert.strictEqual(control.state.editors['newAgent.chat'].opts.supportsMultipleEditorsPerDocument, false);
  assert.ok(control.state.trees['newAgent.sessions'], 'the Conversations view is created');
  assert.strictEqual(loaded('fake-backend.js'), false, 'the backend is not loaded');
  assert.strictEqual(loaded('@aws-sdk'), false, 'the AWS SDK is not loaded');
  assert.strictEqual(loaded('src/ui/chat-panel.js'), false, 'the chat page code is not loaded');
  await api.test.registered;
  assert.strictEqual(api.test.agentPlus.code, 'no-core', 'without Agent Plus it says so and carries on');
  assert.strictEqual(control.state.context['newAgent.agentPlus'], false);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const c of pkg.contributes.commands) assert.ok(control.state.registered.includes(c.command), `${c.command} in package.json is registered`);
});

test('a new conversation is made by the backend and opened in a chat tab; closing the window stops its turn', async () => {
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri, viewType, opts) => opened.push([uri.toString(), viewType, opts]);
  await control.state.handlers['newAgent.newConversation']();
  assert.strictEqual(opened.length, 1);
  assert.match(opened[0][0], /^newagent-session:\/ses_[0-9a-f]+$/);
  assert.deepStrictEqual(opened[0].slice(1), ['newAgent.chat', { preview: false }]);

  const provider = control.state.editors['newAgent.chat'].provider;
  const uri = vscode.Uri.from({ scheme: 'newagent-session', path: opened[0][0].slice('newagent-session:'.length) });
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uri), panel);
  assert.match(panel.webview.html, /media\/chat\.js/, 'the chat page is in the tab');
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const ext = extension;
  void ext;
  const tree = control.state.trees['newAgent.sessions'].opts.treeDataProvider;
  const rows = await tree.getChildren();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(tree.getTreeItem(rows[0]).command.command, 'newAgent.openConversation');
  extension.deactivate();
});
