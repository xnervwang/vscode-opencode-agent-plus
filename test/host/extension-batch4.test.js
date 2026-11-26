// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Through extension.js with the window tests' fake backend: a chat page gets the conversations it may link to, and a
 * click on one opens it. Closing a chat tab stores no list of this extension's own, and Agent Plus's list deletes a
 * closed conversation.
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
process.env.OPENCODE_AGENT_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext4-'));
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

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

test('through extension.js: a chat page\'s links to other conversations, and deleting a closed conversation from the list', async () => {
  const api = extension.activate(context);
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  const idOf = (u) => u.slice('opencodeagentplus-session:/'.length).split('/')[0];
  const [a, b] = opened.map(idOf);
  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscode.Uri.from({ scheme: 'opencodeagentplus-session', path: `/${a}` })), panel);

  /* The page is sent every conversation it may link to, and is told which one is its own so that it leaves that one out. */
  panel.fromPage({ type: 'ready' });
  await settle(80);
  const sent = panel.webview.posted.filter((m) => m.type === 'conversations').pop();
  assert.ok(sent, 'a conversations message');
  assert.deepStrictEqual(sent.self, { sourceId: 'opencode-plus', sessionId: a });
  assert.deepStrictEqual(sent.list.map((c) => c.sessionId).sort(), [a, b].sort());
  assert.ok(sent.list.every((c) => c.sourceId === 'opencode-plus' && c.label === 'OpenCode Agent Plus'));
  assert.deepStrictEqual(api.test.links().map((c) => c.sessionId).sort(), [a, b].sort());

  /* A click on a conversation no other window holds opens it in this window. */
  const before = opened.length;
  panel.fromPage({ type: 'openConversation', sourceId: 'opencode-plus', sessionId: b });
  await settle();
  assert.deepStrictEqual(opened.slice(before).map(idOf), [b]);
  /* One open here comes to the front. */
  const shown = panel.revealed;
  panel.fromPage({ type: 'openConversation', sourceId: 'opencode-plus', sessionId: a });
  await settle();
  assert.strictEqual(panel.revealed, shown + 1);

  /* Agent Plus keeps Recently closed for every agent, so closing the tab stores nothing here. */
  const tabA = control.chatTab(a);
  control.setTabs([tabA, control.chatTab(b)]);
  const [t0] = control.groups[0].tabs;
  panel.dispose();
  control.closeTabs([t0]);
  assert.strictEqual(store.has('opencodeAgentPlus.recentlyClosed'), false);
  assert.strictEqual(api.test.recent, undefined);

  assert.deepStrictEqual((await api.test.source.runSessionAction('delete', [b], {})).results, [{ sessionId: b, outcome: 'done' }]);
  assert.ok(!(await api.test.sessions()).some((r) => r.id === b), 'OpenCode no longer has it');
  extension.deactivate();
});

test('package.json: no list of its own (no view, no view menus, no commands only it used), and the links setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const c = pkg.contributes;
  assert.strictEqual(c.viewsContainers, undefined);
  assert.strictEqual(c.views, undefined);
  assert.strictEqual(c.viewsWelcome, undefined);
  assert.strictEqual(c.menus['view/title'], undefined);
  assert.strictEqual(c.menus['view/item/context'], undefined);
  for (const id of ['opencodeAgentPlus.findConversation', 'opencodeAgentPlus.clearRecentlyClosed', 'opencodeAgentPlus.deleteConversation']) {
    assert.ok(!c.commands.some((x) => x.command === id), id);
    assert.ok(!JSON.stringify(c.menus).includes(id), `${id} in no menu`);
  }
  assert.ok(!pkg.activationEvents.some((e) => e.startsWith('onView:')));
  assert.strictEqual(c.configuration.properties['opencodeAgentPlus.conversationLinks'].default, true);
});
