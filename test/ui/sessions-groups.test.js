// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The Conversations view puts the conversations open in this window first, in a group of their own. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionsView, GROUPS, CONTEXT_GROUP } = require('../../src/ui/sessions-view');
const { createFakeVscode } = require('./fake-vscode');

const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const rows = [
  { id: 'a', title: 'Old', cwd: '/w', lastActiveAt: NOW - 3600000 },
  { id: 'b', title: 'Newest', cwd: '/w', lastActiveAt: NOW - 1000 },
  { id: 'c', title: 'Middle', cwd: '/w', lastActiveAt: NOW - 60000 },
];

function view(open) {
  return new SessionsView({ vscode: createFakeVscode(), listSessions: async () => rows, rename: async () => {}, remove: async () => {}, isOpenHere: (id) => open.includes(id), now: () => NOW });
}

test('open here first, then the rest, each newest first; a group is not a conversation', async () => {
  const v = view(['a', 'c']);
  const top = await v.getChildren();
  assert.deepEqual(top.map((g) => g.label), [GROUPS.open, GROUPS.other]);
  assert.deepEqual(GROUPS, { open: 'Open in this window', other: 'Other conversations' });
  assert.deepEqual((await v.getChildren(top[0])).map((r) => r.id), ['c', 'a']);
  assert.deepEqual((await v.getChildren(top[1])).map((r) => r.id), ['b']);
  const item = v.getTreeItem(top[0]);
  assert.equal(item.label, 'Open in this window');
  assert.equal(item.collapsibleState, 2, 'expanded');
  assert.equal(item.contextValue, CONTEXT_GROUP);
  assert.equal(item.description, '2');
  assert.equal(v.getTreeItem(top[0].rows[0]).id, 'c');
  assert.equal(v.find(top[0]), null, 'Rename, Delete and Fork do not take a group');
});

test('with only one kind there are no groups', async () => {
  assert.deepEqual((await view([]).getChildren()).map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual((await view(['a', 'b', 'c']).getChildren()).map((r) => r.id), ['b', 'c', 'a']);
});
