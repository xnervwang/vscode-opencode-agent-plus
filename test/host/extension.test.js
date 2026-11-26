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
process.env.OPENCODE_AGENT_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext-'));
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = BACKEND;
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

const loaded = (part) => Object.keys(require.cache).some((k) => k.includes(part));
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'storage')),
  extension: { packageJSON: { version: '0.0.1' } },
};

test('activate registers, and starts nothing', async () => {
  const api = extension.activate(context);
  for (const id of ['opencodeAgentPlus.newConversation', 'opencodeAgentPlus.openConversation', 'opencodeAgentPlus.renameConversation', 'opencodeAgentPlus.deleteConversation', 'opencodeAgentPlus.chooseModel', 'opencodeAgentPlus.testConnection']) {
    assert.ok(control.state.registered.includes(id), id);
  }
  assert.ok(control.state.editors['opencodeAgentPlus.chat'], 'the chat editor is registered');
  assert.strictEqual(control.state.editors['opencodeAgentPlus.chat'].opts.supportsMultipleEditorsPerDocument, false);
  assert.strictEqual(control.state.editors['opencodeAgentPlus.chat'].opts.webviewOptions.retainContextWhenHidden, true, 'a hidden chat tab keeps its page');
  assert.ok(control.state.trees['opencodeAgentPlus.sessions'], 'the Conversations view is created');
  assert.strictEqual(loaded('fake-backend.js'), false, 'the backend is not loaded');
  assert.strictEqual(loaded('@aws-sdk'), false, 'the AWS SDK is not loaded');
  assert.strictEqual(loaded('src/ui/chat-panel.js'), false, 'the chat page code is not loaded');
  await api.test.registered;
  assert.strictEqual(api.test.agentPlus.code, 'no-core', 'without Agent Plus it says so and carries on');
  assert.strictEqual(control.state.context['opencodeAgentPlus.agentPlus'], false);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const c of pkg.contributes.commands) assert.ok(control.state.registered.includes(c.command), `${c.command} in package.json is registered`);
  for (const k of pkg.contributes.keybindings) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === k.command), `${k.command} of a keybinding is a command`);
    /* The key works in a chat tab, and in a text editor unless the Claude Code panel came to the front after the chat
       tab, so it does not take the official panel's keys. */
    assert.ok(/activeCustomEditorId == 'opencodeAgentPlus\.chat'/.test(k.when) || /editorTextFocus && !opencodeAgentPlus\.otherChatLast/.test(k.when),
      `${k.command} works only in a chat tab or an editor: ${k.when}`);
  }
  const home = process.env.OPENCODE_AGENT_PLUS_HOME;
  assert.ok(fs.existsSync(path.join(home, 'opencode-plugin', 'agent-work-plan', 'index.js')));
  assert.ok(fs.existsSync(path.join(home, 'opencode-plugin', 'agent-work-plan', 'hooks', 'plan_agent.py')));
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'plans', 'config.json'), 'utf8'));
  assert.deepStrictEqual({ enabled: cfg.enabled, brief: cfg.brief }, { enabled: true, brief: true });
  assert.strictEqual(api.test.plan().launch.OPENCODE_AGENT_PLUS_HOOKS_DIR, path.join(home, 'opencode-plugin', 'agent-work-plan', 'hooks'));
  assert.deepStrictEqual(api.test.source.features, ['shows', 'openHere', 'brief', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'sessionsNotice', 'accountInfo']);
  control.setConfig('agentPlus.tokenMode', 'interface');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'plans', 'config.json'), 'utf8')).enabled, false);
  assert.deepStrictEqual(api.test.source.features, ['shows', 'openHere', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'sessionsNotice', 'accountInfo']);
  control.setConfig('agentPlus.tokenMode', 'all');
});

test('a new conversation is made by the backend and opened in a chat tab; closing the window stops its turn', async () => {
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri, viewType, opts) => opened.push([uri.toString(), viewType, opts]);
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  assert.strictEqual(opened.length, 1);
  assert.match(opened[0][0], /^opencodeagentplus-session:\/ses_[0-9a-f]+$/);
  assert.deepStrictEqual(opened[0].slice(1), ['opencodeAgentPlus.chat', { preview: false, viewColumn: 1 }]);

  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const uri = vscode.Uri.from({ scheme: 'opencodeagentplus-session', path: opened[0][0].slice('opencodeagentplus-session:'.length) });
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(uri), panel);
  assert.match(panel.webview.html, /media\/chat\.js/, 'the chat page is in the tab');
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const saves = control.state.saves;
  panel.fromPage({ type: 'send', text: 'Say: saved first' });
  await settle();
  assert.strictEqual(control.state.saves, saves + 1, 'edited files are saved before a message is sent');
  control.state.config['opencodeAgentPlus.autosave'] = false;
  panel.fromPage({ type: 'send', text: 'Say: not saved' });
  await settle();
  assert.strictEqual(control.state.saves, saves + 1, 'with autosave off nothing is saved');
  delete control.state.config['opencodeAgentPlus.autosave'];
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.showLogs'](), true);
  assert.strictEqual(control.state.shownChannel, 'OpenCode Agent Plus', 'Show Logs opens the extension\'s output channel');
  const tree = control.state.trees['opencodeAgentPlus.sessions'].opts.treeDataProvider;
  const rows = await tree.getChildren();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(tree.getTreeItem(rows[0]).command.command, 'opencodeAgentPlus.openConversation');

  const id = opened[0][0].slice('opencodeagentplus-session:/'.length);
  const plans = path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'plans');
  const scratch = path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'scratch');
  const other = 'ses_0000000000000000other';
  for (const n of [`${id}.json`, `${id}.injected`, `${id}.turn`, `${other}.json`]) fs.writeFileSync(path.join(plans, n), '{}');
  for (const s of [id, other]) {
    fs.mkdirSync(path.join(scratch, s, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(scratch, s, 'chart.png'), 'png');
    fs.writeFileSync(path.join(scratch, s, 'sub', 'more.svg'), '<svg/>');
  }
  control.state.answers.push(['Delete "', 'Delete']);
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.deleteConversation'](rows[0]), true);
  assert.deepStrictEqual(fs.readdirSync(plans).sort(), ['config.json', `${other}.json`, 'windows'], 'and the window entry Agent Plus reads stays');
  assert.deepStrictEqual(fs.readdirSync(scratch), [other]);
  assert.ok(fs.existsSync(path.join(scratch, other, 'sub', 'more.svg')));
  extension.deactivate();
});
