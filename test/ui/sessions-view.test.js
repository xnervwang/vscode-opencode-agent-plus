// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionsView, age, RENAME_COMMAND, DELETE_COMMAND } = require('../../src/ui/sessions-view');
const { createFakeVscode } = require('./fake-vscode');

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const MIN = 60000;

function metas() {
  return [
    { id: 'a', title: 'Old one', cwd: '/w', createdAt: NOW - 3 * 86400000, lastActiveAt: NOW - 2 * 86400000, modelId: 'deepseek.v3.2' },
    { id: 'b', title: 'Running', cwd: '/w', createdAt: NOW - 60 * MIN, lastActiveAt: NOW - 30 * 1000, modelId: 'us.xai.grok-4.7' },
    { id: 'c', title: '', cwd: '/w', createdAt: NOW - 90 * MIN, lastActiveAt: NOW - 5 * MIN },
  ];
}

function setup(answers, statuses = { b: 'working', c: 'waiting' }) {
  const vscode = createFakeVscode(answers);
  let fire = null;
  const calls = { renamed: [], removed: [] };
  const view = new SessionsView({
    vscode,
    listSessions: async () => metas(),
    onDidChange: (fn) => {
      fire = fn;
      return { dispose: () => { fire = null; } };
    },
    statusOf: (m) => statuses[m.id] || 'idle',
    rename: async (id, title) => calls.renamed.push([id, title]),
    remove: async (id) => calls.removed.push(id),
    now: () => NOW,
  });
  return { vscode, view, calls, fire: () => fire && fire() };
}

test('lists conversations by last activity with title, age and status icon', async () => {
  const { view } = setup();
  const rows = await view.getChildren();
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c', 'a']);
  const [b, c, a] = rows.map((r) => view.getTreeItem(r));
  assert.equal(b.label, 'Running');
  assert.equal(b.description, 'now');
  assert.equal(b.iconPath.id, 'sync~spin');
  assert.equal(b.iconPath.color.id, 'charts.green');
  assert.equal(b.contextValue, 'opencodeAgentPlus.session.busy');
  assert.deepEqual(b.command, { command: 'opencodeAgentPlus.openConversation', title: 'Open Conversation', arguments: ['b'] });
  assert.equal(c.label, 'Untitled conversation');
  assert.equal(c.description, '5m');
  assert.equal(c.iconPath.id, 'bell-dot');
  assert.equal(a.description, '2d');
  assert.equal(a.iconPath.id, 'comment-discussion');
  assert.equal(a.contextValue, 'opencodeAgentPlus.session');
  assert.match(a.tooltip, /Folder: \/w\nModel: deepseek\.v3\.2\nID: a$/);
  assert.deepEqual(await view.getChildren(rows[0]), []);
});

test('redraws when the injected change event fires, and when shown again', async () => {
  const { view, fire } = setup();
  let fired = 0;
  view.onDidChangeTreeData(() => fired++);
  fire();
  assert.equal(fired, 1);
  const d = view.register();
  view.treeView.visibility.fire({ visible: true });
  view.treeView.visibility.fire({ visible: false });
  assert.equal(fired, 2);
  d.dispose();
  view.dispose();
  fire();
  assert.equal(fired, 2, 'no refresh after dispose');
});

test('rename asks for a title and passes it on', async () => {
  const { vscode, view, calls } = setup({ input: '  New name ' });
  view.register();
  await view.getChildren();
  assert.equal(await vscode.rec.registered.get(RENAME_COMMAND)(view.last[2]), true);
  assert.deepEqual(calls.renamed, [['a', 'New name']]);
  assert.equal(vscode.rec.inputs[0].value, 'Old one');
  assert.equal(vscode.rec.inputs[0].validateInput('  '), 'Enter a title.');
});

test('delete confirms first, and refuses a conversation that is still running', async () => {
  const cancelled = setup({ warning: undefined });
  cancelled.view.register();
  await cancelled.view.getChildren();
  assert.equal(await cancelled.vscode.rec.registered.get(DELETE_COMMAND)('a'), false);
  assert.deepEqual(cancelled.calls.removed, []);
  const [message, options, button] = cancelled.vscode.rec.warnings[0];
  assert.equal(message, 'Delete "Old one"?');
  assert.equal(options.modal, true);
  assert.equal(button, 'Delete');

  const confirmed = setup({ warning: 'Delete' });
  await confirmed.view.getChildren();
  assert.equal(await confirmed.view.confirmDelete('a'), true);
  assert.deepEqual(confirmed.calls.removed, ['a']);
  assert.equal(await confirmed.view.confirmDelete('b'), false);
  assert.deepEqual(confirmed.calls.removed, ['a']);
  assert.deepEqual(confirmed.vscode.rec.infos, ['Stop the conversation before deleting it.']);
});

test('a failing list shows its error in the view', async () => {
  const vscode = createFakeVscode();
  const view = new SessionsView({ vscode, listSessions: async () => { throw new Error('EACCES'); }, rename() {}, remove() {} });
  view.register();
  assert.deepEqual(await view.getChildren(), []);
  assert.equal(view.treeView.message, "Couldn't list conversations: EACCES");
});

test('age', () => {
  assert.equal(age(NOW - 59 * 1000, NOW), 'now');
  assert.equal(age(NOW - 3 * 3600000, NOW), '3h');
  assert.equal(age(NOW - 40 * 86400000, NOW), '1mo');
  assert.equal(age(NOW - 400 * 86400000, NOW), '1y');
  assert.equal(age(0, NOW), '');
});

test('rename from a chat tab: the argument names the conversation through idOf, and the box starts at its title', async () => {
  const vscode = createFakeVscode({ input: 'From the tab' });
  const calls = [];
  const tabUri = { scheme: 'opencodeagentplus-session', path: '/ses_tab' };
  const view = new SessionsView({
    vscode,
    listSessions: async () => [],
    rename: async (id, title) => calls.push([id, title]),
    remove: async () => {},
    idOf: (arg) => (arg === tabUri ? 'ses_tab' : arg === undefined ? 'ses_front' : ''),
    titleOf: (id) => ({ ses_tab: 'Tab title', ses_front: 'Front title' }[id] || ''),
  });
  view.register();
  const run = vscode.rec.registered.get(RENAME_COMMAND);
  assert.equal(await run(tabUri), true);
  assert.equal(vscode.rec.inputs[0].value, 'Tab title');
  assert.equal(await run(undefined), true, 'with no argument, the tab in front');
  assert.equal(vscode.rec.inputs[1].value, 'Front title');
  assert.equal(await run({ scheme: 'file', path: '/x' }), false, 'a tab that is not a chat names none');
  assert.deepEqual(calls, [['ses_tab', 'From the tab'], ['ses_front', 'From the tab']]);
});
