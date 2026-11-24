// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's third batch: answering a request from its diff's title bar, rewinding, the info box, the chimes and
 * their mute button, images in replies, the Background line, Esc and the ring's outline, with what the page decides
 * without a page (media/composer.js) and what the view model keeps for them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ChatPanel, OPEN_DIFFS_KEY, answerFromDiff } = require('../../src/ui/chat-panel');
const vm = require('../../src/ui/view-model');
const C = require('../../media/composer.js');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');
const { createFakeConversation, demoTurns } = require('./fake-conversation');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = { id: 'us.xai.grok-4.7', name: 'Grok 4.7', vendor: 'xAI', contextWindow: 200000 };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const posted = (panel, type) => panel.posted.filter((m) => m.type === type);

function setup(extra = {}, turns = demoTurns()) {
  const vscode = createFakeVscode();
  const panel = createFakePanel();
  const conversation = createFakeConversation({ turns });
  const responses = [];
  const chat = new ChatPanel({
    vscode, panel, extensionUri: Uri.file(ROOT), conversation, listModels: async () => [MODEL], model: MODEL,
    respond: (id, decision) => { responses.push([id, decision]); conversation.respond(id, decision); },
    ...extra,
  });
  return { vscode, panel, conversation, chat, responses };
}

test('a diff opened while its request is open gets the title bar answers, which reach the request once', async () => {
  const { vscode, panel, chat, responses } = setup();
  panel.fromPage({ type: 'ready' });
  panel.fromPage({ type: 'send', text: 'go' });
  await settle(80);
  assert.equal(chat.state.status, 'waiting');
  panel.fromPage({ type: 'viewDiff', requestId: 'perm-1' });
  await settle(5);
  const right = vscode.rec.commands.find((c) => c[0] === 'vscode.diff')[2];
  assert.deepEqual(vscode.rec.commands.filter((c) => c[0] === 'setContext').pop(), ['setContext', OPEN_DIFFS_KEY, [right.path]]);
  assert.equal(answerFromDiff(right, 'maybe'), false, 'only the three decisions');
  assert.equal(answerFromDiff(right, 'allowSession'), true);
  await settle(5);
  assert.deepEqual(responses, [['perm-1', 'allowSession']]);
  assert.deepEqual(vscode.rec.commands.filter((c) => c[0] === 'setContext').pop(), ['setContext', OPEN_DIFFS_KEY, []]);
  assert.equal(answerFromDiff(right, 'deny'), false, 'answered already');
  chat.dispose();
});

test('a request answered in the page, or a turn that ends, takes its diff off the list', async () => {
  const { vscode, panel, chat } = setup();
  panel.fromPage({ type: 'ready' });
  panel.fromPage({ type: 'send', text: 'go' });
  await settle(80);
  panel.fromPage({ type: 'viewDiff', requestId: 'perm-1' });
  await settle(5);
  panel.fromPage({ type: 'permission', requestId: 'perm-1', decision: 'allowOnce' });
  await settle(40);
  assert.deepEqual(vscode.rec.commands.filter((c) => c[0] === 'setContext').pop()[2], []);
  /* A diff of a request no longer open is shown without the buttons. */
  vscode.rec.commands.length = 0;
  panel.fromPage({ type: 'viewDiff', requestId: 'perm-1' });
  await settle(5);
  assert.equal(vscode.rec.commands.filter((c) => c[0] === 'setContext').length, 0);
  chat.dispose();
});

test('the title bar buttons are in package.json for those diffs only, and Fork shows where OpenCode can fork', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const title = pkg.contributes.menus['editor/title'];
  const buttons = title.filter((m) => /^opencodePlus\.diff/.test(m.command));
  assert.deepEqual(buttons.map((b) => b.command), ['opencodePlus.diffAllowOnce', 'opencodePlus.diffAllowInProject', 'opencodePlus.diffDeny']);
  for (const b of buttons) {
    assert.equal(b.when, 'resourceScheme =~ /^opencodeplus-diff$/i && resourcePath in opencodePlus.openDiffs');
    assert.match(b.group, /^navigation@/);
  }
  const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
  assert.deepEqual(buttons.map((b) => titles[b.command]), ['Allow Once', 'Allow in This Project', 'Deny']);
  const fork = Object.entries(pkg.contributes.menus).flatMap(([where, list]) => list.filter((m) => m.command === 'opencodePlus.forkConversation').map((m) => [where, m.when]));
  assert.deepEqual(fork.map((f) => f[0]).sort(), ['commandPalette', 'editor/title', 'editor/title/context', 'view/item/context', 'webview/context']);
  for (const [, when] of fork) assert.match(when, /opencodePlus\.canFork/);
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'opencodePlus.showMcpServers' && c.title === 'Show MCP Servers'));
});

test('rewinding: offered with a rewinder, it hands over the message and its place, and is refused while working', async () => {
  const asked = [];
  const { panel, chat, conversation, vscode } = setup({ rewind: (t) => { asked.push(t); } }, []);
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(panel, 'caps').pop().rewind, true);
  conversation.emit({ type: 'turnStart', turnId: 'replay-1', at: 10 });
  conversation.emit({ type: 'userMessage', text: 'first', at: 10, messageId: 'msg_20dacb8aa001b0TY7agRN2JAFo' });
  conversation.emit({ type: 'turnEnd', turnId: 'replay-1', reason: 'endTurn', at: 20 });
  conversation.emit({ type: 'turnStart', turnId: 't2', at: 30 });
  conversation.emit({ type: 'userMessage', text: 'second', at: 30 });
  const second = chat.state.items.filter((i) => i.kind === 'user')[1];
  panel.fromPage({ type: 'rewind', itemId: second.id });
  await settle(5);
  assert.deepEqual(asked, [], 'not while the turn runs');
  assert.match(vscode.rec.errors.pop(), /wait for the turn to end/);
  conversation.emit({ type: 'turnEnd', turnId: 't2', reason: 'endTurn', at: 40 });
  const first = chat.state.items.find((i) => i.kind === 'user');
  assert.equal(first.messageId, 'msg_20dacb8aa001b0TY7agRN2JAFo');
  panel.fromPage({ type: 'rewind', itemId: first.id });
  panel.fromPage({ type: 'rewind', itemId: second.id });
  panel.fromPage({ type: 'rewind', itemId: 'i999' });
  await settle(5);
  assert.deepEqual(asked, [
    { itemId: first.id, messageId: 'msg_20dacb8aa001b0TY7agRN2JAFo', text: 'first', ordinal: 0 },
    { itemId: second.id, messageId: '', text: 'second', ordinal: 1 },
  ]);
  chat.dispose();
  const none = setup({}, []);
  none.panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(none.panel, 'caps').pop().rewind, false, 'no rewinder, no rewinding');
  none.chat.dispose();
});

test('a new history redraws the page whole, keeps the model, and puts the rewound message back in the box', async () => {
  const { panel, chat, conversation } = setup({ rewind: () => {} }, []);
  panel.fromPage({ type: 'ready' });
  await settle();
  conversation.emit({ type: 'turnStart', turnId: 't1', at: 10 });
  conversation.emit({ type: 'userMessage', text: 'keep', at: 10 });
  conversation.emit({ type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 20 });
  conversation.emit({ type: 'turnStart', turnId: 't2', at: 30 });
  conversation.emit({ type: 'userMessage', text: 'drop', at: 30 });
  conversation.emit({ type: 'turnEnd', turnId: 't2', reason: 'endTurn', at: 40 });
  panel.posted.length = 0;
  chat.replaceHistory([{ type: 'turnStart', turnId: 'replay-1', at: 10 }, { type: 'userMessage', text: 'keep', at: 10, messageId: 'msg_aaaaaaaaaaaa' }, { type: 'turnEnd', turnId: 'replay-1', reason: 'endTurn', at: 20 }], 'drop');
  const reset = posted(panel, 'reset').pop();
  assert.deepEqual(reset.items.filter((i) => i.kind === 'user').map((i) => [i.text, i.at, i.messageId]), [['keep', 10, 'msg_aaaaaaaaaaaa']]);
  assert.equal(reset.head.model.id, MODEL.id);
  assert.deepEqual(posted(panel, 'draft').pop().text, 'drop');
  chat.dispose();
});

test('the info box gets the rows the host gives, or what went wrong', async () => {
  let fail = false;
  const { panel, chat } = setup({ info: async () => { if (fail) throw new Error('OpenCode is not running'); return [{ label: 'Session', value: 'ses_x' }, { label: 'Folder', value: '/w' }, { value: 'no label' }]; } }, []);
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(panel, 'caps').pop().info, true);
  panel.fromPage({ type: 'info' });
  await settle(5);
  assert.deepEqual(posted(panel, 'info').pop().rows, [{ label: 'Session', value: 'ses_x' }, { label: 'Folder', value: '/w' }]);
  fail = true;
  panel.fromPage({ type: 'info' });
  await settle(5);
  assert.deepEqual([posted(panel, 'info').pop().rows, posted(panel, 'info').pop().error], [[], 'OpenCode is not running']);
  chat.dispose();
});

test('the mute button follows what the host keeps, and a change reaches it', async () => {
  let on = true;
  const sets = [];
  const sound = { on: () => on, set: (v) => { sets.push(v); on = v; } };
  const { panel, chat } = setup({ sound }, []);
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(posted(panel, 'sound').pop(), { type: 'sound', shown: true, on: true, now: posted(panel, 'sound').pop().now });
  panel.fromPage({ type: 'setSound', on: false });
  await settle(5);
  assert.deepEqual(sets, [false]);
  chat.postSound();
  assert.equal(posted(panel, 'sound').pop().on, false);
  chat.dispose();
  const none = setup({}, []);
  none.panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(none.panel, 'sound').pop().shown, false);
  none.chat.dispose();
});

test('a local image a reply shows goes to the host and comes back as a data: URL, or as why not', async () => {
  const asked = [];
  const { panel, chat } = setup({ loadImage: async (src) => { asked.push(src); return src.endsWith('.png') ? { ok: true, dataUrl: 'data:image/png;base64,AAAA' } : { ok: false, reason: 'There is no such file.' }; } }, []);
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(panel, 'caps').pop().replyImages, true);
  panel.fromPage({ type: 'image', id: 'img1', src: '/tmp/chart.png' });
  panel.fromPage({ type: 'image', id: 'img2', src: '/tmp/gone.jpg' });
  await settle(5);
  const answers = posted(panel, 'image');
  assert.deepEqual(answers.map((a) => [a.id, a.ok, a.dataUrl || a.reason]), [['img1', true, 'data:image/png;base64,AAAA'], ['img2', false, 'There is no such file.']]);
  assert.deepEqual(asked, ['/tmp/chart.png', '/tmp/gone.jpg']);
  chat.dispose();
});

test('opening the Background line asks the conversation to look at its background work again', async () => {
  const { panel, chat, conversation } = setup({}, []);
  let looked = 0;
  conversation.checkBackground = () => { looked++; };
  panel.fromPage({ type: 'ready' });
  panel.fromPage({ type: 'background' });
  await settle(5);
  assert.equal(looked, 1);
  chat.dispose();
});

test('the view model keeps what runs in the background: subagents not done and commands left running', () => {
  let s = vm.initialState();
  s = vm.reduce(s, { type: 'turnStart', turnId: 't1', at: 100 });
  s = vm.reduce(s, { type: 'toolCall', id: 'call_1', name: 'shell', input: { command: 'sleep 20', background: true }, at: 110 });
  s = vm.reduce(s, { type: 'toolResult', id: 'call_1', content: 'Command moved to the background', isError: false, at: 111 });
  s = vm.reduce(s, { type: 'background', id: 'call_1', kind: 'shell', title: 'sleep 20', status: 'running', pid: 42, at: 112 });
  s = vm.reduce(s, { type: 'subagent', childId: 'ses_child', title: 'List files', status: 'running', at: 113 });
  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 120 });
  const tool = s.items.find((i) => i.kind === 'tool');
  assert.deepEqual(vm.head(s).background.map((b) => [b.kind, b.title, b.since, b.itemId, b.detail]), [
    ['shell', 'sleep 20', 112, tool.id, 'process 42'],
    ['subagent', 'List files', 113, s.items.find((i) => i.kind === 'subagent').id, ''],
  ]);
  s = vm.reduce(s, { type: 'background', id: 'call_1', kind: 'shell', title: 'sleep 20', status: 'done', at: 130 });
  s = vm.reduce(s, { type: 'subagent', childId: 'ses_child', title: 'List files', status: 'done', at: 131 });
  assert.deepEqual(vm.head(s).background, []);
  assert.equal(vm.reduce(s, { type: 'background', id: '', status: 'running' }), s, 'a nameless one is ignored');
});

test('replayed times reach the items: a user message and its reply are dated by their events', () => {
  let s = vm.initialState();
  for (const ev of [
    { type: 'turnStart', turnId: 'replay-1', at: 1000 },
    { type: 'userMessage', text: 'q', at: 1000, messageId: 'msg_1' },
    { type: 'text', delta: 'a', at: 2000 },
    { type: 'turnEnd', turnId: 'replay-1', reason: 'endTurn', at: 5000 },
  ]) s = vm.reduce(s, ev, 9e12);
  assert.deepEqual(s.items.map((i) => [i.kind, i.at]), [['user', 1000], ['text', 2000], ['figures', 5000]]);
  assert.equal(s.items.find((i) => i.kind === 'figures').durationMs, 4000);
});

test('what the page decides without a page: Esc, chimes, the outline, images and the Background summary', () => {
  assert.equal(C.escapeAction({ box: true, menu: true, status: 'working' }), 'closeBox');
  assert.equal(C.escapeAction({ menu: true, status: 'working' }), 'closeMenu');
  assert.equal(C.escapeAction({ status: 'working' }), 'abort');
  assert.equal(C.escapeAction({ status: 'waiting' }), 'abort');
  assert.equal(C.escapeAction({ status: 'idle' }), null);
  const head = (status, pending = 0, waitingFor = 'permission') => ({ status, pending, waitingFor });
  assert.equal(C.chimeKind(null, head('idle')), null, 'nothing for the first view');
  assert.equal(C.chimeKind(head('working'), head('waiting', 1)), 'permission');
  assert.equal(C.chimeKind(head('working'), head('waiting', 1, 'question')), 'question');
  assert.equal(C.chimeKind(head('waiting', 1), head('working', 0)), null, 'answering is not a chime');
  assert.equal(C.chimeKind(head('working'), head('idle')), 'done');
  assert.equal(C.chimeKind(head('idle'), head('idle')), null);
  assert.deepEqual([84, 85, 86, 100, null, undefined].map(C.ringLow), [false, true, true, true, false, false]);
  assert.equal(C.imageKind('data:image/png;base64,AAA', true), 'data');
  assert.equal(C.imageKind('data:image/svg+xml;base64,AAA', false), 'data');
  assert.equal(C.imageKind('/tmp/a.png', true), 'local');
  assert.equal(C.imageKind('file:///tmp/a.png', true), 'local');
  assert.equal(C.imageKind('C:\\\\Users\\\\a.png', true), 'local');
  assert.equal(C.imageKind('/tmp/a.png', false), 'link', 'without the host nothing is read');
  assert.equal(C.imageKind('https://example.com/a.png', true), 'link', 'the web is never fetched');
  assert.equal(C.imageKind('chart.png', true), 'link', 'a relative path names no folder');
  assert.equal(C.backgroundSummary([]), '');
  assert.equal(C.backgroundSummary([{ kind: 'subagent' }]), 'Background: 1 subagent running');
  assert.equal(C.backgroundSummary([{ kind: 'subagent' }, { kind: 'shell' }, { kind: 'shell' }]), 'Background: 1 subagent, 2 commands running');
});

test('the page loads Agent Plus\'s kit for the chimes before its own script, and the kit has the three', () => {
  const { panel, chat } = setup({}, []);
  assert.match(panel.webview.html, /media\/kit\.js"><\/script>\n<script src="[^"]*media\/composer\.js/);
  chat.dispose();
  const kit = require('../../media/kit.js');
  assert.deepEqual(Object.keys(kit.TONES).sort(), ['approval', 'done', 'permission', 'question']);
  assert.equal(typeof kit.chime, 'function');
  const page = fs.readFileSync(path.join(ROOT, 'media', 'chat.js'), 'utf8');
  assert.match(page, /addEventListener\('keydown'[\s\S]{0,200}Escape/, 'Esc is listened for on the page');
});
