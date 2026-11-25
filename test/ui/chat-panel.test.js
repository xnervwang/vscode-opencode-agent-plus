// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ChatPanel, DIFF_SCHEME, OPEN_DIFFS_KEY } = require('../../src/ui/chat-panel');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');
const { createFakeConversation, demoTurns } = require('./fake-conversation');

const ROOT = path.join(__dirname, '..', '..');
const MODELS = [
  { id: 'us.xai.grok-4.7', name: 'Grok 4.7', vendor: 'xAI', contextWindow: 200000 },
  { id: 'deepseek.v3.2', name: 'DeepSeek V3.2', vendor: 'DeepSeek', contextWindow: 128000 },
];
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function setup(opts = {}) {
  const vscode = createFakeVscode(opts.answers);
  const panel = createFakePanel();
  const conversation = createFakeConversation({ turns: opts.turns || demoTurns() });
  const responses = [];
  const chat = new ChatPanel({
    vscode,
    panel,
    extensionUri: Uri.file(ROOT),
    conversation,
    listModels: opts.listModels || (async () => MODELS),
    respond: (id, decision) => {
      responses.push([id, decision]);
      conversation.respond(id, decision);
    },
    model: MODELS[0],
    history: opts.history,
  });
  return { vscode, panel, conversation, chat, responses };
}

test('sets the webview up with scripts from the extension only; inline styles only for the plan bar fragment', () => {
  const { panel, chat } = setup();
  /* Every panel shares one diff provider; a panel left open here would keep it registered with this test's vscode. */
  try {
    const { options, html } = panel.webview;
    assert.equal(options.enableScripts, true);
    assert.equal(options.retainContextWhenHidden, undefined);
    const roots = options.localResourceRoots.map((u) => u.path);
    /* Uri.joinPath adds to a URI's path with '/' on every system. */
    assert.deepEqual(roots, [path.posix.join(ROOT, 'media'), path.posix.join(ROOT, 'node_modules/markdown-it/dist/browser')]);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src https:\/\/fake\.webview data:; style-src https:\/\/fake\.webview 'unsafe-inline'; font-src https:\/\/fake\.webview; script-src https:\/\/fake\.webview;"/);
    assert.match(html, /media\/plan-bar\.js"><\/script>\n<script src="[^"]*media\/chat\.js/, 'the fragment loads before the page script');
    assert.match(html, /markdown-it\.umd\.min\.js/, 'the markdown library is installed and loaded');
    assert.match(html, /media\/chat\.js/);
    assert.doesNotMatch(html, /<script>|style="/, 'no inline script or style');
  } finally { chat.dispose(); }
});

test('the page gets the whole view when it loads, then only what changed', async () => {
  const { panel, conversation, chat } = setup();
  panel.fromPage({ type: 'ready' });
  await settle();
  const reset = panel.posted.find((m) => m.type === 'reset');
  assert.deepEqual(reset.items, []);
  assert.equal(reset.head.model.id, 'us.xai.grok-4.7');
  assert.equal(typeof reset.now, 'number');
  const models = panel.posted.find((m) => m.type === 'models');
  assert.deepEqual(models.models.map((m) => m.id), MODELS.map((m) => m.id));
  assert.equal(models.current, 'us.xai.grok-4.7');

  panel.posted.length = 0;
  panel.fromPage({ type: 'send', text: 'fix the test' });
  await settle(80);
  assert.deepEqual(conversation.sent, ['fix the test']);
  const updates = panel.posted.filter((m) => m.type === 'update');
  assert.ok(updates.length >= 1);
  assert.ok(updates.length < conversation.events.length, 'events are coalesced into fewer posts');
  const ids = updates.flatMap((u) => u.items.map((i) => i.id));
  assert.ok(ids.includes('i1'));
  assert.equal(updates[updates.length - 1].head.status, 'waiting', 'the demo turn stops at its permission request');
  chat.dispose();
});

test('permission answers, diffs, queueing and stop reach the right place', async () => {
  const { vscode, panel, conversation, chat, responses } = setup();
  panel.fromPage({ type: 'ready' });
  panel.fromPage({ type: 'send', text: 'go' });
  await settle(80);
  assert.equal(chat.state.status, 'waiting');

  panel.fromPage({ type: 'viewDiff', requestId: 'perm-1' });
  await settle(5);
  const [cmd, left, right, title] = vscode.rec.commands.find((c) => c[0] === 'vscode.diff');
  assert.equal(cmd, 'vscode.diff');
  /* The request is open, so its diff's title bar gets the buttons: the diff's right-hand path goes into the context key that shows them. */
  assert.deepEqual(vscode.rec.commands.filter((c) => c[0] === 'setContext').pop(), ['setContext', OPEN_DIFFS_KEY, ['/perm-1/after/sum.js']]);
  assert.equal(left.scheme, DIFF_SCHEME);
  assert.equal(left.path, '/perm-1/before/sum.js');
  assert.equal(right.path, '/perm-1/after/sum.js');
  assert.equal(title, 'sum.js (proposed change)');
  const provider = vscode.rec.providers.get(DIFF_SCHEME);
  assert.equal(provider.provideTextDocumentContent(left), 'module.exports = (a, b) => a - b;\n');
  assert.equal(provider.provideTextDocumentContent(right), 'module.exports = (a, b) => a + b;\n');

  panel.fromPage({ type: 'send', text: 'and add a test' });
  await settle(5);
  assert.deepEqual(chat.state.queued.map((q) => q.text), ['and add a test']);

  panel.fromPage({ type: 'permission', requestId: 'perm-1', decision: 'bogus' });
  panel.fromPage({ type: 'permission', requestId: 'perm-1', decision: 'allowOnce' });
  await settle(5);
  assert.deepEqual(responses, [['perm-1', 'allowOnce']]);
  await conversation.idle();
  await settle(30);
  assert.equal(chat.state.status, 'idle');
  assert.deepEqual(chat.state.queued, [], 'the queued message left the queue when its turn began');
  assert.equal(conversation.sent.length, 2);

  conversation.send('one more');
  panel.fromPage({ type: 'abort' });
  await conversation.idle();
  assert.equal(conversation.aborts, 1);
  chat.dispose();
});

test('model choice, copy and links', async () => {
  const { vscode, panel, conversation, chat } = setup();
  panel.fromPage({ type: 'ready' });
  await settle();
  panel.fromPage({ type: 'setModel', id: 'deepseek.v3.2' });
  panel.fromPage({ type: 'setModel', id: 'not.listed' });
  await settle();
  assert.deepEqual(conversation.models.map((m) => m.id), ['deepseek.v3.2']);
  assert.equal(chat.state.model.contextWindow, 128000);

  panel.fromPage({ type: 'copy', text: 'npm test' });
  panel.fromPage({ type: 'openLink', href: 'https://example.com/a' });
  panel.fromPage({ type: 'openLink', href: 'command:workbench.action.reloadWindow' });
  await settle(5);
  assert.equal(vscode.rec.clipboard, 'npm test');
  assert.deepEqual(vscode.rec.opened, ['https://example.com/a']);
  chat.dispose();
});

test('a failed model list shows its error and can be retried', async () => {
  let calls = 0;
  const { panel, chat } = setup({
    listModels: async () => {
      calls++;
      if (calls === 1) throw new Error('AccessDeniedException: bedrock:ListFoundationModels');
      return MODELS;
    },
  });
  panel.fromPage({ type: 'ready' });
  await settle();
  const first = panel.posted.filter((m) => m.type === 'models').pop();
  assert.match(first.error, /AccessDenied/);
  panel.fromPage({ type: 'reloadModels' });
  await settle();
  const second = panel.posted.filter((m) => m.type === 'models').pop();
  assert.equal(second.error, '');
  assert.equal(second.models.length, 2);
  chat.dispose();
});

test('nothing is posted while hidden; showing again redraws the whole view', async () => {
  const { panel, conversation, chat } = setup({ turns: [[{ type: 'text', delta: 'hello' }]] });
  panel.fromPage({ type: 'ready' });
  await settle();
  panel.hide();
  panel.posted.length = 0;
  conversation.send('hi');
  await conversation.idle();
  await settle();
  assert.deepEqual(panel.posted, []);
  panel.show();
  panel.fromPage({ type: 'ready' });
  await settle();
  const reset = panel.posted.find((m) => m.type === 'reset');
  assert.deepEqual(reset.items.map((i) => i.kind), ['user', 'text', 'figures']);
  chat.dispose();
});

test('history loads into the first view; disposing releases the diff provider and the listener', async () => {
  const history = [
    { kind: 'meta', format: 1, id: 's', cwd: '/w', createdAt: 1, providerId: 'bedrock', modelId: 'deepseek.v3.2' },
    { kind: 'message', at: 10, message: { role: 'user', content: [{ type: 'text', text: 'earlier' }] } },
    { kind: 'message', at: 20, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ];
  const { vscode, panel, conversation, chat } = setup({ history });
  assert.deepEqual(chat.state.items.map((i) => i.kind), ['user', 'text', 'figures']);
  assert.equal(chat.state.model.id, 'us.xai.grok-4.7', 'the model passed in wins over the one in the file');
  const second = new ChatPanel({
    vscode, panel: createFakePanel(), extensionUri: Uri.file(ROOT), conversation: createFakeConversation(),
    listModels: async () => [], respond: () => {},
  });
  assert.equal(vscode.rec.providers.size, 1, 'one provider serves every panel');
  panel.dispose();
  assert.equal(vscode.rec.providers.size, 1);
  second.dispose();
  assert.equal(vscode.rec.providers.size, 0);
  conversation.emit({ type: 'text', delta: 'late' });
  assert.equal(chat.state.items.length, 3, 'a disposed panel ignores events');
});

test('onDidChangeState hears status and title changes, not every delta', async () => {
  const vscode = createFakeVscode();
  const conversation = createFakeConversation({ turns: [[{ type: 'title', title: 'Greeting' }, ...'hello'.split('').map((d) => ({ type: 'text', delta: d }))]] });
  const heard = [];
  const chat = new ChatPanel({
    vscode, panel: createFakePanel(), extensionUri: Uri.file(ROOT), conversation,
    listModels: async () => [], respond: () => {}, onDidChangeState: (h) => heard.push(`${h.status}:${h.title}`),
  });
  await conversation.send('hi');
  await conversation.idle();
  assert.deepEqual(heard, ['working:', 'working:Greeting', 'idle:Greeting']);
  chat.dispose();
});
