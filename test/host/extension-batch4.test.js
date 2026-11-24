// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The fourth batch as extension.js wires it, with the window tests' fake backend: a chat tab closed goes to Recently
 * closed and its group shows in the Conversations view, which its row clears; a deleted conversation leaves it; Find
 * Conversation opens the one picked; a chat page gets the conversations it may link to, and a click on one opens it.
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
process.env.OPENCODE_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext4-'));
process.env.OPENCODE_PLUS_TEST_BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
process.env.OPENCODE_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

const store = new Map();
const memento = (m) => ({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } });
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_PLUS_HOME, 'storage')),
  globalState: memento(new Map()),
  workspaceState: memento(store),
  extension: { packageJSON: { version: '0.0.1' } },
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('the fourth batch through extension.js', async () => {
  const api = extension.activate(context);
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodePlus.newConversation']();
  await control.state.handlers['opencodePlus.newConversation']();
  const [a, b] = opened.map((u) => u.slice('opencodeplus-session:/'.length));
  const provider = control.state.editors['opencodePlus.chat'].provider;
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscode.Uri.from({ scheme: 'opencodeplus-session', path: `/${a}` })), panel);

  /* The page is sent every conversation it may link to, its own named so that it is left out. */
  panel.fromPage({ type: 'ready' });
  await settle(80);
  const sent = panel.webview.posted.filter((m) => m.type === 'conversations').pop();
  assert.ok(sent, 'a conversations message');
  assert.deepStrictEqual(sent.self, { sourceId: 'opencode-plus', sessionId: a });
  assert.deepStrictEqual(sent.list.map((c) => c.sessionId).sort(), [a, b].sort());
  assert.ok(sent.list.every((c) => c.sourceId === 'opencode-plus' && c.label === 'OpenCode Plus'));
  assert.deepStrictEqual(api.test.links().map((c) => c.sessionId).sort(), [a, b].sort());

  /* A click on one opens it here, as nothing else has it. */
  const before = opened.length;
  panel.fromPage({ type: 'openConversation', sourceId: 'opencode-plus', sessionId: b });
  await settle();
  assert.deepStrictEqual(opened.slice(before), [`opencodeplus-session:/${b}`]);
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
  assert.deepStrictEqual(store.get('opencodePlus.recentlyClosed').map((e) => e.id), [a]);
  const tree = control.state.trees['opencodePlus.sessions'].opts.treeDataProvider;
  await settle();
  const top = await tree.getChildren();
  assert.deepStrictEqual(top.map((g) => g.label), ['Recently closed', 'Other conversations']);
  assert.deepStrictEqual(top[0].rows.map((r) => r.id), [a]);
  assert.strictEqual(tree.getTreeItem(top[0]).contextValue, 'opencodePlus.group.recent');

  /* Its row's button clears it. */
  assert.strictEqual(await control.state.handlers['opencodePlus.clearRecentlyClosed'](), true);
  assert.deepStrictEqual(api.test.recent(), []);

  /* A deleted conversation leaves Recently closed. */
  control.closeTabs([control.groups[0].tabs[0]]);
  assert.deepStrictEqual(api.test.recent().map((e) => e.id), [b]);
  control.state.answers.push(['Delete "', 'Delete']);
  const rowB = (await tree.getChildren()).flatMap((g) => g.rows || [g]).find((r) => r.id === b);
  assert.strictEqual(await control.state.handlers['opencodePlus.deleteConversation'](rowB), true);
  assert.deepStrictEqual(api.test.recent(), []);

  /* Find Conversation opens the one picked by part of its id. */
  const run = control.state.handlers['opencodePlus.findConversation']();
  await settle();
  const qp = control.state.quickPick;
  assert.deepStrictEqual(qp.items.map((i) => i.id), [a]);
  assert.match(qp.items[0].detail, new RegExp(`^${a}`));
  const n = opened.length;
  qp.answer((items) => items.find((i) => i.detail.includes(a.slice(4, 12))));
  assert.strictEqual(await run, a);
  assert.deepStrictEqual(opened.slice(n), [`opencodeplus-session:/${a}`]);
  extension.deactivate();
});

test('package.json declares the two commands, the list\'s search button, the clear button on its group and the links setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const c = pkg.contributes;
  const cmd = (id) => c.commands.find((x) => x.command === id);
  assert.strictEqual(cmd('opencodePlus.findConversation').title, 'Find Conversation…');
  assert.strictEqual(cmd('opencodePlus.clearRecentlyClosed').icon, '$(clear-all)');
  assert.ok(c.menus['view/title'].some((m) => m.command === 'opencodePlus.findConversation' && m.when === 'view == opencodePlus.sessions && isWorkspaceTrusted'));
  const clear = c.menus['view/item/context'].find((m) => m.command === 'opencodePlus.clearRecentlyClosed');
  assert.deepStrictEqual([clear.when, clear.group], ['view == opencodePlus.sessions && viewItem == opencodePlus.group.recent', 'inline']);
  /* Rename, Fork and Delete take conversation rows only, which the group's row is not. */
  for (const m of c.menus['view/item/context'].filter((x) => /rename|fork|delete/i.test(x.command))) {
    assert.ok(/viewItem =~ \/\^opencodePlus\\\.session\/|viewItem == opencodePlus\.session\b/.test(m.when), m.when);
  }
  assert.strictEqual(c.configuration.properties['opencodePlus.conversationLinks'].default, true);
});
