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
vscode.workspace.isTrusted = false;
control.state.strictCommands = true;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-trust-'));
process.env.OPENCODE_PLUS_HOME = HOME;
process.env.OPENCODE_PLUS_TEST_BACKEND = BACKEND;
process.env.OPENCODE_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');
const gate = require('../../src/host/trust-gate');

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const COMMANDS = PKG.contributes.commands.map((c) => c.command);
const KEYS = ['opencodePlus.opencode.path', 'opencodePlus.opencode.askPermissions', 'opencodePlus.bedrock.profile', 'opencodePlus.bedrock.region'];
const SESSION = 'ses_00000000000000restricted';
const loaded = (part) => Object.keys(require.cache).some((k) => k.includes(part));
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const memento = (m) => ({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] });

/* Agent Plus, recording the sources registered with it. */
const sources = [];
control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { version: '1.4.0',
  registerSource: (s) => { sources.push(s); return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(HOME, 'storage')),
  globalState: memento(new Map()),
  workspaceState: memento(new Map()),
  extension: { packageJSON: { version: '0.0.1' } },
};
const chatUri = (id) => vscode.Uri.from({ scheme: 'opencodeplus-session', path: `/${id}` });

let api;
let panel;

test('in Restricted Mode nothing starts: no OpenCode, no conversation, no file, no Agent Plus source', async () => {
  api = extension.activate(context);
  assert.strictEqual(api.test.restricted(), true);
  assert.strictEqual(api.test.registered, undefined, 'nothing of start() ran');
  await settle();
  for (const part of ['fake-backend.js', 'src/opencode/index.js', 'src/opencode/server.js', 'src/opencode/client.js', 'src/ui/chat-panel.js', '@aws-sdk']) {
    assert.strictEqual(loaded(part), false, `${part} is not loaded`);
  }
  assert.deepStrictEqual(fs.readdirSync(HOME), [], 'nothing is written: no plugin, no plans, no locks, no window state');
  assert.deepStrictEqual(sources, [], 'nothing is registered with Agent Plus');
  assert.strictEqual(control.state.context['opencodePlus.agentPlus'], undefined);
  assert.ok(control.state.log.some((l) => /Restricted Mode: nothing starts until this workspace is trusted/.test(l)));

  /* Every command is there, and says what to do instead of doing it. */
  for (const id of COMMANDS) assert.ok(control.state.handlers[id], `${id} answers`);
  control.state.answers.push(['does nothing in Restricted Mode', 'Manage Workspace Trust']);
  for (const id of ['opencodePlus.newConversation', 'opencodePlus.testConnection', 'opencodePlus.findConversation', 'opencodePlus.chooseModel', 'opencodePlus.showMcpServers']) {
    const before = control.state.said.length;
    assert.strictEqual(await control.state.handlers[id](), false, id);
    const said = control.state.said.slice(before);
    assert.strictEqual(said.length, 1, id);
    assert.strictEqual(said[0].message, gate.TEXT);
    assert.deepStrictEqual(said[0].buttons, ['Manage Workspace Trust']);
  }
  assert.strictEqual(await control.state.handlers['opencodePlus.openConversation'](SESSION), false);
  await settle();
  assert.ok(control.state.commands.some((c) => c[0] === 'workbench.trust.manage'), 'the button opens Manage Workspace Trust');
  assert.ok(!control.state.commands.some((c) => c[0] === 'vscode.openWith'), 'no chat tab is opened');
  assert.deepStrictEqual(fs.readdirSync(HOME), [], 'still nothing written');
  for (const part of ['fake-backend.js', 'src/opencode/index.js']) assert.strictEqual(loaded(part), false, `${part} is still not loaded`);

  /* The Conversations view is an empty list, so VS Code shows package.json's Restricted Mode text in it. */
  assert.strictEqual(control.state.trees['opencodePlus.sessions'], undefined, 'the real view is not made');
  const stub = control.state.treeProviders['opencodePlus.sessions'];
  assert.ok(stub && !stub.disposed);
  assert.deepStrictEqual(await stub.provider.getChildren(), []);

  /* A chat tab VS Code restores shows the Restricted Mode page with the button, and nothing else. */
  const editor = control.state.editors['opencodePlus.chat'];
  assert.ok(editor, 'the chat editor is registered');
  assert.strictEqual(editor.opts.supportsMultipleEditorsPerDocument, false);
  panel = control.panel();
  await editor.provider.resolveCustomEditor(editor.provider.openCustomDocument(chatUri(SESSION)), panel);
  assert.match(panel.webview.html, /does nothing in Restricted Mode\. It starts when you trust this workspace\./);
  assert.match(panel.webview.html, /<button id="manage" type="button">Manage Workspace Trust<\/button>/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(panel.webview.html);
  assert.ok(nonce, 'scripts only with the nonce');
  assert.match(panel.webview.html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-/);
  assert.strictEqual((panel.webview.html.match(/<script/g) || []).length, 1);
  assert.ok(panel.webview.html.includes(`<script nonce="${nonce[1]}">`));
  assert.deepStrictEqual(panel.webview.options, { enableScripts: true });
  /* Its button opens Manage Workspace Trust. */
  const asked = control.state.commands.length;
  panel.fromPage({ type: 'manageTrust' });
  panel.fromPage({ type: 'somethingElse' });
  await settle();
  assert.deepStrictEqual(control.state.commands.slice(asked).map((c) => c[0]), ['workbench.trust.manage']);
  assert.strictEqual(api.test.waitingTabs(), 1);
  assert.deepStrictEqual(fs.readdirSync(HOME), []);
  assert.strictEqual(loaded('fake-backend.js'), false);
});

test('once trust is granted it starts without a reload, and the chat tab already open gets its conversation', async () => {
  /* The fake backend already keeps the conversation that the restored tab names. */
  fs.writeFileSync(path.join(HOME, 'fake-backend.json'), JSON.stringify({ sessions: { [SESSION]: {
    id: SESSION, title: 'Kept from before', cwd: HOME, lastActiveAt: Date.now(), lastUserAt: 0, lastReplyAt: 0, model: 'fake/fake-small', events: [] } } }));
  control.grantTrust();
  assert.strictEqual(api.test.restricted(), false);
  assert.ok(api.test.registered, "start() ran and gave the tests' handle its members");
  for (const id of COMMANDS) assert.ok(control.state.unregistered.includes(id), `the stand-in for ${id} is gone`);
  for (const id of COMMANDS) assert.strictEqual(control.state.live.get(id), 1, `${id} is registered once`);
  assert.ok(control.state.treeProviders['opencodePlus.sessions'].disposed, 'the empty list is gone');
  assert.ok(control.state.trees['opencodePlus.sessions'], 'the real Conversations view is made');
  assert.ok(fs.existsSync(path.join(HOME, 'opencode-plugin', 'agent-work-plan', 'index.js')), 'the work plan plugin is copied now');
  await api.test.registered;
  assert.strictEqual(sources.length, 1, 'registered with Agent Plus now');
  assert.strictEqual(sources[0], api.test.source);

  /* The tab that showed the Restricted Mode page now shows the chat page of its conversation. */
  await settle(200);
  assert.strictEqual(api.test.waitingTabs(), 0);
  assert.match(panel.webview.html, /media\/chat\.js/, 'the chat page is in the tab');
  assert.strictEqual(panel.webview.options.enableScripts, true);
  const asked = control.state.commands.length;
  panel.fromPage({ type: 'manageTrust' });
  await settle();
  assert.ok(!control.state.commands.slice(asked).some((c) => c[0] === 'workbench.trust.manage'), 'the Restricted Mode page no longer listens');
  assert.ok(api.test.conversations().some((c) => c.sessionId === SESSION || c.id === SESSION), 'the conversation is open in this window');

  /* The commands are the real ones: a new conversation is made and opened. */
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodePlus.newConversation']();
  assert.strictEqual(opened.length, 1);
  assert.match(opened[0], /^opencodeplus-session:\/ses_[0-9a-f]+$/);
  assert.ok(loaded('fake-backend.js'), 'the backend starts on first use');

  /* A second grant (VS Code fires it once, but) changes nothing. */
  assert.doesNotThrow(() => control.grantTrust());
  extension.deactivate();
});

test('package.json: the four settings that pick what runs are read from user or remote machine settings only', () => {
  const props = PKG.contributes.configuration.properties;
  for (const k of KEYS) assert.strictEqual(props[k].scope, 'machine', k);
  for (const [k, v] of Object.entries(props)) if (!KEYS.includes(k)) assert.notStrictEqual(v.scope, 'machine', `${k} keeps its scope`);
  assert.strictEqual(props['opencodePlus.model'].scope, undefined, 'the model may still be set per workspace');
  const ut = PKG.capabilities.untrustedWorkspaces;
  assert.strictEqual(ut.supported, 'limited');
  assert.deepStrictEqual(ut.restrictedConfigurations, KEYS);
  assert.strictEqual(ut.description, 'In Restricted Mode, this extension does nothing. It starts when the workspace is trusted.');
});

test('package.json: the view says what to do in Restricted Mode, and its buttons and the commands are hidden there', () => {
  const c = PKG.contributes;
  const welcome = c.viewsWelcome.filter((w) => w.view === 'opencodePlus.sessions');
  const restricted = welcome.find((w) => w.when === '!isWorkspaceTrusted');
  assert.ok(restricted);
  assert.strictEqual(restricted.contents, `${gate.TEXT}\n[Manage Workspace Trust](command:workbench.trust.manage)`);
  assert.ok(welcome.filter((w) => w !== restricted).every((w) => w.when === 'isWorkspaceTrusted'), 'the empty-list text shows only once trusted');
  for (const m of c.menus['view/title']) assert.match(m.when, /&& isWorkspaceTrusted$/, m.command);
  for (const id of COMMANDS) {
    const entry = c.menus.commandPalette.find((e) => e.command === id);
    assert.ok(entry, `${id} has a Command Palette entry`);
    assert.ok(entry.when === 'false' || /\bisWorkspaceTrusted$/.test(entry.when), `${id}: ${entry.when}`);
  }
});

test('the Restricted Mode page loads nothing, and each page has its own nonce', () => {
  const html = gate.page();
  assert.doesNotMatch(html, /\bsrc=|https?:|command:/);
  assert.match(html, />Manage Workspace Trust</);
  assert.notStrictEqual(/nonce-([^']+)/.exec(gate.page())[1], /nonce-([^']+)/.exec(html)[1]);
});
