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
process.env.OPENCODE_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext-'));
process.env.OPENCODE_PLUS_TEST_BACKEND = BACKEND;
process.env.OPENCODE_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

const loaded = (part) => Object.keys(require.cache).some((k) => k.includes(part));
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_PLUS_HOME, 'storage')),
  extension: { packageJSON: { version: '0.0.1' } },
};

test('activate registers, and starts nothing', async () => {
  const api = extension.activate(context);
  for (const id of ['opencodePlus.newConversation', 'opencodePlus.openConversation', 'opencodePlus.renameConversation', 'opencodePlus.deleteConversation', 'opencodePlus.chooseModel', 'opencodePlus.testConnection']) {
    assert.ok(control.state.registered.includes(id), id);
  }
  assert.ok(control.state.editors['opencodePlus.chat'], 'the chat editor is registered');
  assert.strictEqual(control.state.editors['opencodePlus.chat'].opts.supportsMultipleEditorsPerDocument, false);
  assert.ok(control.state.trees['opencodePlus.sessions'], 'the Conversations view is created');
  assert.strictEqual(loaded('fake-backend.js'), false, 'the backend is not loaded');
  assert.strictEqual(loaded('@aws-sdk'), false, 'the AWS SDK is not loaded');
  assert.strictEqual(loaded('src/ui/chat-panel.js'), false, 'the chat page code is not loaded');
  await api.test.registered;
  assert.strictEqual(api.test.agentPlus.code, 'no-core', 'without Agent Plus it says so and carries on');
  assert.strictEqual(control.state.context['opencodePlus.agentPlus'], false);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const c of pkg.contributes.commands) assert.ok(control.state.registered.includes(c.command), `${c.command} in package.json is registered`);
  /* The work plan plugin and its scripts are in place before OpenCode first starts, with the switches it reads. */
  const home = process.env.OPENCODE_PLUS_HOME;
  assert.ok(fs.existsSync(path.join(home, 'opencode-plugin', 'agent-work-plan', 'index.js')));
  assert.ok(fs.existsSync(path.join(home, 'opencode-plugin', 'agent-work-plan', 'hooks', 'plan_agent.py')));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'plans', 'config.json'), 'utf8'));
  assert.deepStrictEqual({ enabled: cfg.enabled, brief: cfg.brief }, { enabled: true, brief: true });
  assert.strictEqual(api.test.plan().launch.OPENCODE_PLUS_HOOKS_DIR, path.join(home, 'opencode-plugin', 'agent-work-plan', 'hooks'));
  assert.deepStrictEqual(api.test.source.features, ['shows', 'openHere', 'brief']);
  control.setConfig('agentPlus.tokenMode', 'interface');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'plans', 'config.json'), 'utf8')).enabled, false);
  assert.deepStrictEqual(api.test.source.features, ['shows', 'openHere']);
  control.setConfig('agentPlus.tokenMode', 'all');
});

test('a new conversation is made by the backend and opened in a chat tab; closing the window stops its turn', async () => {
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri, viewType, opts) => opened.push([uri.toString(), viewType, opts]);
  await control.state.handlers['opencodePlus.newConversation']();
  assert.strictEqual(opened.length, 1);
  assert.match(opened[0][0], /^opencodeplus-session:\/ses_[0-9a-f]+$/);
  assert.deepStrictEqual(opened[0].slice(1), ['opencodePlus.chat', { preview: false }]);

  const provider = control.state.editors['opencodePlus.chat'].provider;
  const uri = vscode.Uri.from({ scheme: 'opencodeplus-session', path: opened[0][0].slice('opencodeplus-session:'.length) });
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uri), panel);
  assert.match(panel.webview.html, /media\/chat\.js/, 'the chat page is in the tab');
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const ext = extension;
  void ext;
  const tree = control.state.trees['opencodePlus.sessions'].opts.treeDataProvider;
  const rows = await tree.getChildren();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(tree.getTreeItem(rows[0]).command.command, 'opencodePlus.openConversation');

  /* Deleting it takes its plan and the files beside it, and leaves another conversation's. */
  const id = opened[0][0].slice('opencodeplus-session:/'.length);
  const plans = path.join(process.env.OPENCODE_PLUS_HOME, 'plans');
  const other = 'ses_0000000000000000other';
  for (const n of [`${id}.json`, `${id}.injected`, `${id}.turn`, `${other}.json`]) fs.writeFileSync(path.join(plans, n), '{}');
  control.state.answers.push(['Delete "', 'Delete']);
  assert.strictEqual(await control.state.handlers['opencodePlus.deleteConversation'](rows[0]), true);
  assert.deepStrictEqual(fs.readdirSync(plans).sort(), ['config.json', `${other}.json`]);
  extension.deactivate();
});
