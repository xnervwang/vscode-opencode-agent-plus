// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The chat page's mode and effort pickers, the effort in a reply's figures, and the list's tooltip. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ChatPanel } = require('../../src/ui/chat-panel');
const vm = require('../../src/ui/view-model');
const { SessionsView } = require('../../src/ui/sessions-view');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const OPTIONS = () => [
  { id: 'mode', name: 'Session Mode', value: 'build', values: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan', description: 'Read-only' }] },
  { id: 'effort', name: 'Effort', value: 'default', values: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'default', name: 'Default' }] },
];

function conversation({ options = OPTIONS(), fail = false } = {}) {
  const listeners = new Set();
  let opts = options;
  const c = {
    set: [],
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send() {}, abort() {}, setModel: async () => {},
    async setOption(id, value) {
      if (fail) throw new Error('OpenCode refused it');
      c.set.push([id, value]);
      opts = opts.map((o) => (o.id === id ? { ...o, value } : o));
    },
    dispose() {},
  };
  if (options !== null) c.options = () => opts;
  return c;
}

function panelFor(conv) {
  const vscode = createFakeVscode();
  const panel = createFakePanel();
  const chat = new ChatPanel({ vscode, panel, extensionUri: Uri.file(ROOT), conversation: conv, listModels: async () => [], respond() {} });
  return { vscode, panel, chat };
}

const optionsPosted = (panel) => panel.posted.filter((m) => m.type === 'options');

test('the page gets the settings when it loads and each time they change, and a value picked there goes to the conversation', async () => {
  const conv = conversation();
  const { panel, chat } = panelFor(conv);
  assert.match(panel.webview.html, /<select id="mode" class="option" hidden><\/select>/);
  assert.match(panel.webview.html, /<select id="effort" class="option" hidden><\/select>/);
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(optionsPosted(panel)[0].options.map((o) => [o.id, o.value]), [['mode', 'build'], ['effort', 'default']]);

  panel.fromPage({ type: 'setOption', id: 'effort', value: 'low' });
  await settle();
  assert.deepEqual(conv.set, [['effort', 'low']]);
  assert.equal(optionsPosted(panel).pop().options.find((o) => o.id === 'effort').value, 'low');

  panel.fromPage({ type: 'setOption', id: 'effort', value: 'turbo' });
  panel.fromPage({ type: 'setOption', id: 'speed', value: 'fast' });
  await settle();
  assert.equal(conv.set.length, 1, 'values the conversation does not offer are not sent');

  const n = optionsPosted(panel).length;
  conv.fire({ type: 'options', options: [{ id: 'mode', name: 'Mode', value: 'plan', values: [{ value: 'plan', name: 'Plan' }] }] });
  assert.equal(optionsPosted(panel).length, n + 1);
  assert.deepEqual(optionsPosted(panel).pop().options.map((o) => o.id), ['mode']);
  assert.equal(chat.state.items.length, 0, 'an options event draws nothing in the log');
  chat.dispose();
});

test('a refused setting is reported and the page is put back; a conversation without options shows none', async () => {
  const conv = conversation({ fail: true });
  const { vscode, panel, chat } = panelFor(conv);
  panel.fromPage({ type: 'ready' });
  await settle();
  panel.fromPage({ type: 'setOption', id: 'mode', value: 'plan' });
  await settle();
  assert.match(vscode.rec.errors.join('\n'), /refused/);
  assert.equal(optionsPosted(panel).pop().options.find((o) => o.id === 'mode').value, 'build');
  chat.dispose();

  const bare = panelFor(conversation({ options: null }));
  bare.panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(optionsPosted(bare.panel).pop().options, []);
  bare.chat.dispose();
});

test('the figures under a reply name the effort after the model; the default effort is left out', () => {
  let s = vm.reduce(vm.initialState(), { type: 'ui.model', model: { id: 'amazon-bedrock/us.xai.grok-4.7', contextWindow: 500000 } });
  s = vm.reduceAll([
    { type: 'turnStart', turnId: 't1', at: 1000, modelId: 'amazon-bedrock/us.xai.grok-4.7', effort: 'high' },
    { type: 'userMessage', text: 'hi', at: 1000 },
    { type: 'text', delta: 'hello' },
    { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 3000 },
    { type: 'turnStart', turnId: 't2', at: 4000, modelId: 'amazon-bedrock/us.xai.grok-4.7' },
    { type: 'turnEnd', turnId: 't2', reason: 'endTurn', at: 6000 },
  ], s, 5);
  const figures = s.items.filter((it) => it.kind === 'figures');
  assert.equal(figures[0].text, '2s · grok-4.7 high');
  assert.equal(figures[0].effort, 'high');
  assert.equal(figures[1].text, '2s · grok-4.7');
});

test('a turn the agent began itself is announced; a retry shows until its attempt starts', () => {
  let s = vm.reduce(vm.initialState(), { type: 'turnStart', turnId: 'o1', at: 10, unsolicited: true });
  assert.equal(s.status, 'working');
  assert.equal(s.items[0].kind, 'notice');
  assert.match(s.items[0].text, /started this turn on its own, for a background subagent or command/);
  s = vm.reduce(s, { type: 'retry', attempt: 2, waitMs: 2000, error: { kind: 'throttled', message: 'slow down' }, at: 20 });
  assert.deepEqual(s.retry, { attempt: 2, waitMs: 2000, error: 'Throttled: slow down', at: 20 });
  assert.equal(vm.head(s).retry.attempt, 2);
  s = vm.reduce(s, { type: 'retry', attempt: 0, at: 22 });
  assert.equal(s.retry, null);
  s = vm.reduce(s, { type: 'turnEnd', turnId: 'o1', reason: 'endTurn', at: 30 });
  assert.equal(s.status, 'idle');
  assert.ok(!s.items.some((it) => it.kind === 'user'));
});

test('the tooltip says how long ago and names the time zone of the time it shows', async () => {
  const NOW = Date.UTC(2026, 10, 24, 8, 8, 35);
  const vscode = createFakeVscode();
  const view = new SessionsView({
    vscode,
    listSessions: async () => [{ id: 'a', title: 'Greeting', cwd: '/w', lastActiveAt: NOW - 5 * 60000 }, { id: 'b', title: 'Fresh', lastActiveAt: NOW - 1000 }],
    rename: async () => {}, remove: async () => {},
    now: () => NOW,
  });
  const rows = await view.getChildren();
  const a = rows.find((r) => r.id === 'a');
  const b = rows.find((r) => r.id === 'b');
  const tip = view.getTreeItem(a).tooltip;
  assert.match(tip, /Idle · last active 5m ago \(.+\)/);
  const zone = new Date(NOW).toLocaleString(undefined, { timeZoneName: 'short' }).split(' ').pop();
  assert.ok(tip.includes(zone), `the zone ${zone} is named in: ${tip}`);
  assert.match(view.getTreeItem(b).tooltip, /last active just now \(/);
});
