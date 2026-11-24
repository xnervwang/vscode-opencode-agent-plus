// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The plan bar: Agent Plus's summary of a conversation's plan, followed while its page is open, and the bar's clicks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createPlanBar, SOURCE } = require('../../src/host/plan-bar');
const { ChatPanel } = require('../../src/ui/chat-panel');
const { createFakeVscode, createFakePanel, Uri } = require('../ui/fake-vscode');
const { createFakeConversation } = require('../ui/fake-conversation');
const hostFake = require('./fake-vscode');

hostFake.install(hostFake.create().vscode);
const { ID } = require('../../src/host/agentplus-source');

const ROOT = path.join(__dirname, '..', '..');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const SUMMARY = { total: 3, done: 1, counts: { doing: 1, todo: 1, done: 1 }, current: { number: '2', title: 'Write the tests', state: 'doing', dim: false }, allDone: false, questions: 0, open: [] };

function fakeCore({ features = ['allConversations', 'waitingFor', 'planSummary'] } = {}) {
  const listeners = new Set();
  const summaries = new Map();
  const asked = [];
  return {
    features,
    asked,
    summaries,
    planSummary(sourceId, sessionId) { asked.push([sourceId, sessionId]); return summaries.get(`${sourceId}\n${sessionId}`) || null; },
    onDidChangePlanSummary(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    fire(e) { for (const fn of [...listeners]) fn(e); },
    listeners: () => listeners.size,
  };
}

test('the source id the bar asks with is the one this extension registers', () => {
  assert.equal(SOURCE, ID);
});

test('a page follows its conversation\'s summary while open; other conversations and sources are not its own', () => {
  let on = true;
  const ran = [];
  const bar = createPlanBar({ on: () => on, run: async (c, a) => ran.push([c, a]) });
  const core = fakeCore();
  assert.equal(bar.summaryOf('ses_a'), null, 'nothing before Agent Plus took the source');
  const got = [];
  const follow = bar.follow('ses_a', (s) => got.push(s));
  assert.equal(core.listeners(), 0);
  bar.attach(core);
  assert.equal(core.listeners(), 1, 'listens once a page follows and Agent Plus has planSummary');
  assert.deepEqual(got, [null], 'told at once, with no plan yet');
  core.summaries.set(`${SOURCE}\nses_a`, SUMMARY);
  core.fire({ sourceId: SOURCE, sessionId: 'ses_a' });
  assert.deepEqual(got.at(-1), SUMMARY);
  core.fire({ sourceId: SOURCE, sessionId: 'ses_b' });
  core.fire({ sourceId: 'codex', sessionId: 'ses_a' });
  assert.equal(got.length, 2, 'another conversation or another source changes nothing here');
  assert.deepEqual(core.asked.at(-1), [SOURCE, 'ses_a']);
  on = false;
  bar.settingChanged();
  assert.equal(got.at(-1), null, 'switched off, the page draws no bar');
  assert.equal(core.listeners(), 0, 'and Agent Plus is not listened to');
  on = true;
  bar.settingChanged();
  assert.deepEqual(got.at(-1), SUMMARY);
  follow.dispose();
  assert.equal(core.listeners(), 0, 'no page left, nothing listened to');
  assert.deepEqual(bar.following(), []);
});

test('clicks go to Agent Plus\'s two commands with this source and conversation; an Agent Plus without planSummary gets none', async () => {
  const ran = [];
  const bar = createPlanBar({ on: () => true, run: async (c, a) => ran.push([c, a]) });
  bar.attach(fakeCore());
  assert.equal(await bar.open('ses_a', 'plan'), true);
  assert.equal(await bar.open('ses_a', 'answer'), true);
  assert.deepEqual(ran, [
    ['agentPlus.showWorkPlanOf', { sourceId: SOURCE, sessionId: 'ses_a' }],
    ['agentPlus.answerQuestionOf', { sourceId: SOURCE, sessionId: 'ses_a' }],
  ]);
  const old = fakeCore({ features: ['allConversations', 'waitingFor'] });
  bar.attach(old);
  bar.follow('ses_a', () => {});
  assert.equal(old.listeners(), 0);
  assert.equal(bar.summaryOf('ses_a'), null);
  assert.equal(await bar.open('ses_a', 'plan'), false);
  assert.equal(ran.length, 2);
});

test('the chat page gets the summary when it loads and when it changes, and its clicks reach the bar', async () => {
  const vscode = createFakeVscode();
  const panel = createFakePanel();
  const conversation = createFakeConversation({ turns: [] });
  let summary = null;
  let tell = null;
  const opened = [];
  const chat = new ChatPanel({
    vscode, panel, extensionUri: Uri.file(ROOT), conversation, listModels: async () => [], respond: () => {},
    planBar: {
      summary: () => summary,
      onDidChange: (fn) => { tell = fn; return { dispose: () => { tell = null; } }; },
      open: (part) => opened.push(part),
    },
  });
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(panel.posted.filter((m) => m.type === 'planBar').map((m) => m.summary), [null]);
  summary = SUMMARY;
  tell(SUMMARY);
  await settle();
  assert.deepEqual(panel.posted.filter((m) => m.type === 'planBar').at(-1).summary, SUMMARY);
  panel.fromPage({ type: 'planBarOpen', part: 'plan' });
  panel.fromPage({ type: 'planBarOpen', part: 'answer' });
  panel.fromPage({ type: 'planBarOpen', part: 'something else' });
  await settle();
  assert.deepEqual(opened, ['plan', 'answer', 'plan']);
  chat.dispose();
  assert.equal(tell, null, 'the page stops following when it goes');
});

test('the page script finds Agent Plus\'s fragment under the name it exports', () => {
  const fragment = require('../../media/plan-bar.js');
  assert.equal(typeof fragment.create, 'function');
  assert.equal(fragment.model(SUMMARY, 600, false).count, '2 open');
  assert.equal(fragment.model(null, 600, false), null);
});
