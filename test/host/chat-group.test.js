// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatColumn } = require('../../src/host/chat-group');

const chat = { kind: 'chat' };
const file = { kind: 'file' };
const isChat = (t) => t.kind === 'chat';
const windowWith = (...groups) => ({
  ViewColumn: { One: 1 },
  window: { tabGroups: { all: groups.map(([viewColumn, tabs, isActive]) => ({ viewColumn, tabs, isActive: !!isActive })) } },
});

test('with no chat tab open, a conversation opens in the first group, not in the active split to the right', () => {
  assert.equal(chatColumn(windowWith([1, [file]], [2, [file], true]), isChat), 1);
  assert.equal(chatColumn(windowWith([1, []], [2, [], true]), isChat), 1);
});

test('a group holding only chat tabs comes first, the active one of them before the others', () => {
  assert.equal(chatColumn(windowWith([1, [file, chat]], [2, [chat]], [3, [file], true]), isChat), 2);
  assert.equal(chatColumn(windowWith([1, [chat]], [2, [chat], true]), isChat), 2);
});

test('else a group holding any chat tab, the active one first', () => {
  assert.equal(chatColumn(windowWith([1, [file]], [2, [file, chat]], [3, [file], true]), isChat), 2);
  assert.equal(chatColumn(windowWith([1, [file, chat]], [2, [chat, file], true]), isChat), 2);
});

test('with no groups listed, the first column', () => {
  assert.equal(chatColumn(windowWith(), isChat), 1);
});
