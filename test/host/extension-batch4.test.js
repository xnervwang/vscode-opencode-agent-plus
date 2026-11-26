// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Through extension.js with the window tests' fake backend: a closed chat tab goes to Recently closed, a group in the
 * Conversations view that the button on its row empties; a deleted conversation leaves that group; Find Conversation
 * opens the one picked; a chat page gets the conversations it may link to, and a click on one opens it.
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

test('through extension.js: Recently closed, Find Conversation, and links from a chat page to other conversations', async () => {
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

  /* Closing the chat tab puts it at the top of Recently closed, which the Conversations view shows first. */
  const tabA = control.chatTab(a);
  control.setTabs([tabA, control.chatTab(b)]);
  const [t0] = control.groups[0].tabs;
  panel.dispose();
  control.closeTabs([t0]);
  assert.deepStrictEqual(api.test.recent().map((e) => e.id), [a]);
  assert.deepStrictEqual(store.get('opencodeAgentPlus.recentlyClosed').map((e) => e.id), [a]);
  const tree = control.state.trees['opencodeAgentPlus.sessions'].opts.treeDataProvider;
  await settle();
  const top = await tree.getChildren();
  assert.deepStrictEqual(top.map((g) => g.label), ['Recently closed', 'Other conversations']);
  assert.deepStrictEqual(top[0].rows.map((r) => r.id), [a]);
  assert.strictEqual(tree.getTreeItem(top[0]).contextValue, 'opencodeAgentPlus.group.recent');

  /* Its row's button clears it. */
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.clearRecentlyClosed'](), true);
  assert.deepStrictEqual(api.test.recent(), []);

  /* A deleted conversation leaves Recently closed. */
  control.closeTabs([control.groups[0].tabs[0]]);
  assert.deepStrictEqual(api.test.recent().map((e) => e.id), [b]);
  control.state.answers.push(['Delete "', 'Delete']);
  const rowB = (await tree.getChildren()).flatMap((g) => g.rows || [g]).find((r) => r.id === b);
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.deleteConversation'](rowB), true);
  assert.deepStrictEqual(api.test.recent(), []);

  /* Find Conversation opens the one picked by part of its id. */
  const run = control.state.handlers['opencodeAgentPlus.findConversation']();
  await settle();
  const qp = control.state.quickPick;
  assert.deepStrictEqual(qp.items.map((i) => i.id), [a]);
  assert.match(qp.items[0].detail, new RegExp(`^${a}`));
  const n = opened.length;
  qp.answer((items) => items.find((i) => i.detail.includes(a.slice(4, 12))));
  assert.strictEqual(await run, a);
  assert.deepStrictEqual(opened.slice(n).map(idOf), [a]);
  extension.deactivate();
});

test('package.json declares the two commands, the list\'s search button, the clear button on its group and the links setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const c = pkg.contributes;
  const cmd = (id) => c.commands.find((x) => x.command === id);
  assert.strictEqual(cmd('opencodeAgentPlus.findConversation').title, 'Find Conversation…');
  assert.strictEqual(cmd('opencodeAgentPlus.clearRecentlyClosed').icon, '$(clear-all)');
  assert.ok(c.menus['view/title'].some((m) => m.command === 'opencodeAgentPlus.findConversation' && m.when === 'view == opencodeAgentPlus.sessions && isWorkspaceTrusted'));
  const clear = c.menus['view/item/context'].find((m) => m.command === 'opencodeAgentPlus.clearRecentlyClosed');
  assert.deepStrictEqual([clear.when, clear.group], ['view == opencodeAgentPlus.sessions && viewItem == opencodeAgentPlus.group.recent', 'inline']);
  /* Rename, Fork and Delete apply only to conversation rows; the group's row is not one. */
  for (const m of c.menus['view/item/context'].filter((x) => /rename|fork|delete/i.test(x.command))) {
    assert.ok(/viewItem =~ \/\^opencodeAgentPlus\\\.session\/|viewItem == opencodeAgentPlus\.session\b/.test(m.when), m.when);
  }
  assert.strictEqual(c.configuration.properties['opencodeAgentPlus.conversationLinks'].default, true);
});
