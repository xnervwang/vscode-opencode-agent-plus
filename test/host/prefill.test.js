// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Agent Plus's prefill: where the text goes in the message box, and the source's answers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fake = require('./fake-vscode');

const { vscode: hostVscode } = fake.create();
fake.install(hostVscode);
const ap = require('../../src/host/agentplus-source');
const C = require('../../media/composer');
const { ChatPanel } = require('../../src/ui/chat-panel');
const ui = require('../ui/fake-vscode');

const A = '3f2b6c1e-0000-4000-8000-00000000000a';
const ROOT = path.join(__dirname, '..', '..');

function source(more = {}) {
  const manager = { has: () => true, list: () => [], panelOf: () => null, send() {} };
  return ap.createAgentPlusSource({ manager, planDir: () => '/p', reveal: async () => true, openHere: async () => true, trusted: () => true, ...more }).source;
}

test('the text goes after what the box holds, with a space between unless the box\'s text ends in white space', () => {
  const t = 'About row 3 (Write the docs): ';
  assert.equal(C.prefillText('', t), t);
  assert.equal(C.prefillText('see also', t), `see also ${t}`);
  assert.equal(C.prefillText('see also ', t), `see also ${t}`);
  assert.equal(C.prefillText('first line\n', t), `first line\n${t}`);
});

test("the source offers 'prefill' only when the window can do it, and passes the text on as it is", async () => {
  assert.ok(!source().features.includes('prefill'));
  const seen = [];
  const s = source({ prefill: async (id, text, deadline) => { seen.push([id, text, deadline - Date.now()]); return { outcome: 'drafted' }; } });
  assert.ok(s.features.includes('prefill'));
  assert.deepEqual(await s.prefill(A, '关于第 2 行（发布）：'), { outcome: 'drafted' });
  assert.equal(seen[0][0], A);
  assert.equal(seen[0][1], '关于第 2 行（发布）：');
  assert.ok(seen[0][2] > 9000 && seen[0][2] <= 9500, `deadline ${seen[0][2]} ms away`);
});

test('the source answers notReceived when it cannot try, or when the window fails, and never rejects', async () => {
  const ok = { prefill: async () => ({ outcome: 'drafted' }) };
  assert.equal((await source({ ...ok, trusted: () => false }).prefill(A, 'x')).outcome, 'notReceived');
  assert.equal((await source(ok).prefill('not-a-session/../x', 'x')).outcome, 'notReceived');
  assert.equal((await source(ok).prefill(A, '')).outcome, 'notReceived');
  const failed = await source({ prefill: async () => { throw new Error('the tab is closing'); } }).prefill(A, 'x');
  assert.deepEqual(failed, { outcome: 'notReceived', reason: 'the tab is closing' });
  const refused = await source({ prefill: async () => ({ outcome: 'notReceived', reason: 'the conversation could not be opened in this window' }) }).prefill(A, 'x');
  assert.equal(refused.reason, 'the conversation could not be opened in this window');
  assert.equal((await source({ prefill: async () => 'odd' }).prefill(A, 'x')).outcome, 'uncertain');
});

test('the source answers uncertain once its time is up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = source({ prefill: () => new Promise(() => {}) });
  const p = s.prefill(A, 'x');
  t.mock.timers.tick(9500);
  assert.equal((await p).outcome, 'uncertain');
});

function panel() {
  const vscode = ui.createFakeVscode();
  const fakePanel = ui.createFakePanel();
  const conv = { id: 'ses_prefill', on() { return () => {}; }, send() { throw new Error('a prefill sent a message'); }, abort() {}, setModel: async () => {}, setOption: async () => {}, dispose() {} };
  const chat = new ChatPanel({ vscode, panel: fakePanel, extensionUri: ui.Uri.file(ROOT), conversation: conv, listModels: async () => [], respond() {} });
  return { fakePanel, chat };
}

test('the chat panel hands the text to its page, waiting for it to load, and resolves with its answer', async () => {
  const { fakePanel, chat } = panel();
  const asked = chat.prefill('About row 1 (A): ', 2000);
  assert.equal(fakePanel.posted.filter((m) => m.type === 'prefill').length, 0, 'held until the page is ready');
  fakePanel.fromPage({ type: 'ready' });
  const m = fakePanel.posted.find((x) => x.type === 'prefill');
  assert.equal(m.text, 'About row 1 (A): ');
  fakePanel.fromPage({ type: 'prefilled', id: m.id, ok: true });
  assert.equal(await asked, true);
  const refused = chat.prefill('x', 2000);
  const m2 = fakePanel.posted.filter((x) => x.type === 'prefill').pop();
  fakePanel.fromPage({ type: 'prefilled', id: m2.id, ok: false });
  assert.equal(await refused, false);
  assert.equal(fakePanel.posted.filter((x) => x.type === 'send').length, 0);
  chat.dispose();
});

test('with no answer from its page the chat panel resolves with null, and closing it resolves the prefills still waiting with false', async () => {
  const { fakePanel, chat } = panel();
  fakePanel.fromPage({ type: 'ready' });
  assert.equal(await chat.prefill('x', 30), null);
  const waiting = chat.prefill('y', 5000);
  chat.dispose();
  assert.equal(await waiting, false);
});
