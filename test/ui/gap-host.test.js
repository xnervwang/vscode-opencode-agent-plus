// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's side of the message box and the editor: the helpers in media/composer.js (references in the text,
 * Enter and Ctrl+Enter, a draft after the text, the permission modes, what goes along from the editor, the background
 * pill) and what src/ui/chat-panel.js sends and takes for them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ChatPanel } = require('../../src/ui/chat-panel');
const C = require('../../media/composer');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function conversation(more = {}) {
  const listeners = new Set();
  const c = {
    id: 'ses_gaphost', sent: [], options: () => c.opts, opts: [], set: [],
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send(...a) { c.sent.push(a); }, abort() {}, setModel: async () => {},
    setOption: async (id, v) => { c.set.push([id, v]); const o = c.opts.find((x) => x.id === id); if (o) o.value = v; },
    attachments: () => ({ images: true, files: true, selection: true }),
    dispose() {},
    ...more,
  };
  return c;
}
function panelFor(conv, extra = {}) {
  const vscode = createFakeVscode();
  const panel = createFakePanel();
  const chat = new ChatPanel({ vscode, panel, extensionUri: Uri.file(ROOT), conversation: conv, listModels: async () => [], respond() {}, ...extra });
  return { vscode, panel, chat };
}
const posted = (panel, type) => panel.posted.filter((m) => m.type === type);
const tracker = (ctx, current = null) => ({ describe: () => (ctx.selection ? { label: ctx.selection.label } : null), current: () => current, context: () => ctx,
  onDidChange: () => ({ dispose() {} }) });

test('references in the text: a file as @<rel>, lines as @<rel>#L…, each once and only as a word of its own', () => {
  const file = { path: '/ws/src/sum.js', rel: 'src/sum.js', name: 'sum.js', token: '@src/sum.js' };
  const lines = { path: '/ws/src/sum.js', rel: 'src/sum.js', name: 'sum.js', token: '@src/sum.js#L3-5', startLine: 3, endLine: 5 };
  assert.deepEqual(C.filesInText('look at @src/sum.js#L3-5 and @src/sum.js.', [file, lines, file]), [file, lines]);
  assert.deepEqual(C.filesInText('only @src/sum.js#L3-5', [file, lines]), [lines], 'the file is not named by the lines alone');
  assert.deepEqual(C.filesInText('@src/sum.js#L3-50 is another range', [lines]), []);
  assert.deepEqual(C.filesInText('picked with @: @src/sum.js', [{ path: '/ws/src/sum.js', rel: 'src/sum.js', name: 'sum.js' }]).length, 1, 'one picked with @ has no token');
});

test('references go in at the caret, set off by spaces; a draft goes after what the box holds', () => {
  assert.deepEqual(C.insertRefs('see', 3, [{ token: '@a.js' }]), { text: 'see @a.js ', caret: 10 });
  assert.deepEqual(C.insertRefs('see  now', 4, [{ token: '@a.js' }, { token: '@b.js#L2' }]), { text: 'see @a.js @b.js#L2 now', caret: 18 }, 'a space after the caret is not doubled');
  assert.deepEqual(C.insertRefs('', undefined, [{ token: '@a.js' }]), { text: '@a.js ', caret: 6 });
  assert.equal(C.appendDraft('', 'Fix this'), 'Fix this');
  assert.equal(C.appendDraft('I was typing  \n', 'Fix this'), 'I was typing\n\nFix this', 'what was typed stays');
  assert.equal(C.appendDraft('keep', ''), 'keep');
});

test('Enter sends; with Ctrl+Enter to send, Enter makes a new line and Ctrl or Cmd with Enter sends', () => {
  assert.equal(C.enterAction({ key: 'Enter' }), 'send');
  assert.equal(C.enterAction({ key: 'Enter', shiftKey: true }), null);
  assert.equal(C.enterAction({ key: 'Enter', composing: true }), null, 'an IME choosing a word');
  assert.equal(C.enterAction({ key: 'Enter', ctrlEnter: true }), null);
  assert.equal(C.enterAction({ key: 'Enter', ctrlEnter: true, ctrlKey: true }), 'send');
  assert.equal(C.enterAction({ key: 'Enter', ctrlEnter: true, metaKey: true }), 'send');
  assert.equal(C.enterAction({ key: 'Enter', menu: true }), 'accept');
  assert.equal(C.enterAction({ key: 'Tab', menu: true }), 'accept');
  assert.equal(C.enterAction({ key: 'Enter', menu: true, ctrlEnter: true, ctrlKey: true }), 'send', 'Ctrl+Enter sends past an open list');
  assert.equal(C.enterAction({ key: 'a' }), null);
});

test('the permission modes: build twice (asking, and editing automatically), then plan and the others', () => {
  const mode = { id: 'mode', value: 'build', values: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan', description: 'Plans only' }, { value: 'review', name: 'Review' }] };
  const r = C.permissionModes(mode, false);
  /* OpenCode's own values stay the options' values, so picking 'build' or 'plan' does what it did before. */
  assert.deepEqual(r.entries.map((e) => [e.value, e.name]), [['build', 'Ask before edits'], ['build:auto', 'Edit automatically'], ['plan', 'Plan'], ['review', 'Review']]);
  assert.equal(r.value, 'build');
  assert.equal(C.permissionModes(mode, true).value, 'build:auto');
  assert.equal(C.permissionModes({ ...mode, value: 'plan' }, true).value, 'plan', 'in plan, edits do not happen at all');
  assert.deepEqual(C.permissionModes(null, true).entries.map((e) => e.value), ['build', 'build:auto'], 'an agent with no modes still gets the two');
});

test('what goes along from the editor: the selection, else the open file, unless removed or added already', () => {
  const ctx = { selection: { key: '/w/a.js:2-3', label: 'a.js:2-3', path: '/w/a.js' }, file: { key: '/w/a.js', label: 'a.js', path: '/w/a.js' } };
  const all = { selection: true, file: true };
  assert.equal(C.autoContext(ctx, all).kind, 'selection');
  assert.equal(C.autoContext(ctx, { selection: false, file: true }).kind, 'file', 'with attachSelection off, the file');
  assert.equal(C.autoContext({ file: ctx.file }, { selection: true, file: false }), null, 'with attachOpenFile off, a file only with a selection');
  assert.equal(C.autoContext(ctx, all, new Set(['/w/a.js:2-3'])), null, 'removed for this message');
  assert.equal(C.autoContext(ctx, all, new Set(), new Set(['/w/a.js:2-3'])), null, 'the same lines were added with the button');
  assert.equal(C.autoContext({}, all), null);
  /* The pill shows it all the same: lit while it goes, plain when it was removed, added or is only offered. */
  assert.deepEqual(C.contextPill(ctx, all), { item: { kind: 'selection', ...ctx.selection }, goes: true });
  assert.deepEqual(C.contextPill(ctx, all, new Set(['/w/a.js:2-3'])), { item: { kind: 'selection', ...ctx.selection }, goes: false });
  assert.deepEqual(C.contextPill(ctx, all, new Set(), new Set(['/w/a.js:2-3'])), { item: { kind: 'selection', ...ctx.selection }, goes: false, pinned: true });
  assert.deepEqual(C.contextPill(ctx, { selection: false, file: false }), { item: { kind: 'selection', ...ctx.selection }, goes: false }, 'a selection is still offered to add');
  assert.equal(C.contextPill({ file: ctx.file }, { selection: true, file: false }), null);
});

test('the background pill counts detached commands, and only OpenCode\'s free models count as "free only"', () => {
  assert.equal(C.backgroundSummary([], 0), '');
  assert.equal(C.backgroundSummary([], 1), '1 detached');
  assert.equal(C.backgroundSummary([{ kind: 'shell' }], 1), '1 command running · 1 detached');
  assert.equal(C.backgroundSummary([{ kind: 'subagent' }, { kind: 'shell' }]), '1 subagent, 1 command running', 'as before without any');
  assert.equal(C.onlyFreeModels([{ id: 'opencode/big-pickle' }]), true);
  assert.equal(C.onlyFreeModels([{ id: 'opencode/big-pickle' }, { id: 'amazon-bedrock/x' }]), false);
  assert.equal(C.onlyFreeModels([]), false);
});

test('the panel tells the page the composer settings, what the editor offers, and the permission mode; settingsChanged() again', async () => {
  const conv = conversation();
  let settings = { ctrlEnter: false, attachFile: true, attachSelection: true };
  let auto = false;
  const ctx = { selection: { path: '/w/a.js', name: 'a.js', label: 'a.js:2', key: '/w/a.js:2-2', startLine: 2, endLine: 2 }, file: { path: '/w/a.js', name: 'a.js', label: 'a.js', key: '/w/a.js' } };
  const { panel, chat } = panelFor(conv, { composer: () => settings, selection: tracker(ctx), permissionMode: { get: () => auto, set: (on) => { auto = on; }, onDidChange: () => ({ dispose() {} }) } });
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(posted(panel, 'composer').map(({ now, ...m }) => m), [{ type: 'composer', ctrlEnter: false, attachFile: true, attachSelection: true }]);
  assert.deepEqual(posted(panel, 'selection').pop().context, { selection: { path: '/w/a.js', name: 'a.js', label: 'a.js:2', key: '/w/a.js:2-2' }, file: { path: '/w/a.js', name: 'a.js', label: 'a.js', key: '/w/a.js' } });
  assert.deepEqual(posted(panel, 'permissionMode').map(({ now, ...m }) => m), [{ type: 'permissionMode', shown: true, auto: false }]);
  settings = { ctrlEnter: true, attachFile: false, attachSelection: true };
  chat.settingsChanged();
  assert.equal(posted(panel, 'composer').pop().ctrlEnter, true);
  chat.dispose();
});

test('a message takes along what the page showed from the editor, and the lines its references name', async () => {
  const conv = conversation();
  const ctx = { selection: { path: '/w/a.js', name: 'a.js', label: 'a.js:2', key: '/w/a.js:2-2', startLine: 2, endLine: 2 }, file: { path: '/w/b.js', name: 'b.js', label: 'b.js', key: '/w/b.js' } };
  const current = { path: '/w/a.js', name: 'a.js', startLine: 2, endLine: 2, text: 'line two', label: 'a.js:2' };
  const read = [];
  const { panel, chat } = panelFor(conv, { selection: tracker(ctx, current), readRange: (p, a, b) => { read.push([p, a, b]); return p === '/w/gone.js' ? null : `lines ${a}-${b}`; } });
  panel.fromPage({ type: 'ready' });
  await settle();
  panel.fromPage({ type: 'send', text: 'one', context: { kind: 'selection', key: '/w/a.js:2-2' } });
  panel.fromPage({ type: 'send', text: 'two', context: { kind: 'file', key: '/w/b.js' } });
  panel.fromPage({ type: 'send', text: 'three', context: { kind: 'selection', key: '/w/a.js:9-9' } });
  panel.fromPage({ type: 'send', text: 'four', ranges: [{ path: '/w/c.js', name: 'c.js', startLine: 3, endLine: 5 }, { path: '/w/gone.js', name: 'gone.js', startLine: 1, endLine: 1 }, { path: 'rel.js', startLine: 1 }] });
  await settle();
  assert.deepEqual(conv.sent[0], ['one', { files: [{ path: '/w/a.js', name: 'a.js', text: 'line two', startLine: 2, endLine: 2 }] }]);
  assert.deepEqual(conv.sent[1], ['two', { files: [{ path: '/w/b.js', name: 'b.js' }] }]);
  assert.deepEqual(conv.sent[2], ['three'], 'the editor moved on: what the page showed is not there any more');
  assert.deepEqual(conv.sent[3], ['four', { files: [{ path: '/w/c.js', name: 'c.js', text: 'lines 3-5', startLine: 3, endLine: 5 }, { path: '/w/gone.js', name: 'gone.js' }] }],
    'lines that cannot be read go as the file; a relative path not at all');
  assert.deepEqual(read, [['/w/c.js', 3, 5], ['/w/gone.js', 1, 1]]);
  chat.dispose();
});

test('compose() and focusInput() wait for the page, then go in order after the whole view', async () => {
  const conv = conversation();
  const { panel, chat } = panelFor(conv);
  chat.compose({ refs: [{ token: '@a.js#L1-2', path: '/w/a.js', name: 'a.js', rel: 'a.js', startLine: 1, endLine: 2 }, { token: '@x', path: 'relative' }], draft: '' });
  chat.focusInput();
  assert.equal(posted(panel, 'compose').length, 0, 'nothing before the page has loaded');
  panel.fromPage({ type: 'ready' });
  await settle();
  const types = panel.posted.map((m) => m.type);
  assert.ok(types.indexOf('compose') > types.indexOf('reset'));
  assert.ok(types.indexOf('focus') > types.indexOf('compose'));
  assert.deepEqual(posted(panel, 'compose')[0].refs, [{ token: '@a.js#L1-2', path: '/w/a.js', name: 'a.js', rel: 'a.js', startLine: 1, endLine: 2 }], 'a reference to a relative path is dropped');
  chat.compose({ draft: 'Fix this' });
  assert.equal(posted(panel, 'compose').pop().draft, 'Fix this');
  chat.dispose();
});

test('the permission mode: Edit automatically and Ask before edits switch to build, Plan to plan with edits asking', async () => {
  const conv = conversation();
  conv.opts = [{ id: 'mode', name: 'Mode', value: 'plan', values: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] }];
  let auto = false;
  const { panel, chat } = panelFor(conv, { permissionMode: { get: () => auto, set: (on) => { auto = on; }, onDidChange: () => ({ dispose() {} }) } });
  panel.fromPage({ type: 'ready' });
  await settle();
  panel.fromPage({ type: 'setPermissionMode', mode: 'build:auto' });
  await settle();
  assert.equal(auto, true);
  assert.deepEqual(conv.set, [['mode', 'build']]);
  assert.equal(posted(panel, 'permissionMode').pop().auto, true);
  panel.fromPage({ type: 'setPermissionMode', mode: 'build' });
  await settle();
  assert.equal(auto, false);
  assert.deepEqual(conv.set, [['mode', 'build']], 'already in build: only the asking changes');
  panel.fromPage({ type: 'setPermissionMode', mode: 'build:auto' });
  panel.fromPage({ type: 'setPermissionMode', mode: 'plan' });
  await settle();
  assert.equal(auto, false, 'plan asks');
  assert.deepEqual(conv.set.pop(), ['mode', 'plan']);
  panel.fromPage({ type: 'setPermissionMode', mode: 'nonsense' });
  panel.fromPage({ type: 'setPermissionMode', mode: 'mode:plan' });
  await settle();
  assert.equal(conv.set.length, 1);
  chat.dispose();
});

test('Fork from here goes with the message\'s place while idle; Connect a provider and the model list again', async () => {
  const conv = conversation();
  const forks = [];
  let connects = 0;
  let lists = 0;
  const { panel, chat } = panelFor(conv, { forkFrom: (t) => { forks.push(t); }, connectProvider: () => { connects++; }, listModels: async () => { lists++; return [{ id: 'opencode/big-pickle', name: 'Big Pickle' }]; } });
  conv.fire({ type: 'turnStart', turnId: 't1' });
  conv.fire({ type: 'userMessage', text: 'first' });
  conv.fire({ type: 'turnEnd', turnId: 't1', reason: 'endTurn' });
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(panel, 'caps').pop().forkFrom, true);
  assert.equal(posted(panel, 'caps').pop().connect, true);
  const user = chat.state.items.find((i) => i.kind === 'user');
  panel.fromPage({ type: 'forkFrom', itemId: user.id });
  panel.fromPage({ type: 'forkFrom', itemId: 'nope' });
  await settle();
  assert.deepEqual(forks, [{ itemId: user.id, messageId: '', text: 'first', ordinal: 0 }]);
  panel.fromPage({ type: 'connectProvider' });
  await settle();
  assert.equal(connects, 1);
  const before = lists;
  chat.reloadModels();
  await settle();
  assert.equal(lists, before + 1);
  assert.deepEqual(posted(panel, 'models').pop().models.map((m) => m.id), ['opencode/big-pickle']);
  chat.dispose();
});

test('detached commands are looked for when the page loads, a turn ends and the background list opens', async () => {
  const conv = conversation();
  let asked = 0;
  const { panel, chat } = panelFor(conv, { detached: () => { asked++; return [{ pid: 777, command: 'sleep 287', startedAt: 5 }, { pid: 0, command: 'bad' }]; } });
  panel.fromPage({ type: 'ready' });
  await settle(40);
  assert.equal(asked, 1);
  assert.deepEqual(posted(panel, 'detached').pop().list, [{ pid: 777, command: 'sleep 287', startedAt: 5 }]);
  panel.fromPage({ type: 'background' });
  await settle(40);
  assert.equal(asked, 2);
  conv.fire({ type: 'turnStart', turnId: 't2' });
  conv.fire({ type: 'turnEnd', turnId: 't2', reason: 'endTurn' });
  await settle(700);
  assert.equal(asked, 3, 'once for the start and end close together');
  assert.equal(posted(panel, 'caps').pop().detached, true);
  chat.dispose();
});

test('without text a message goes when it has images or a selection added with its button, not on what the editor offers alone', async () => {
  const conv = conversation();
  const ctx = { selection: null, file: { path: '/w/b.js', name: 'b.js', label: 'b.js', key: '/w/b.js' } };
  const { panel, chat } = panelFor(conv, { selection: tracker(ctx) });
  panel.fromPage({ type: 'ready' });
  await settle();
  panel.fromPage({ type: 'send', text: '  ', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'square.png' }] });
  panel.fromPage({ type: 'send', text: '', selections: [{ path: '/w/a.js', name: 'a.js', text: 'two', startLine: 2, endLine: 2 }] });
  panel.fromPage({ type: 'send', text: '', context: { kind: 'file', key: '/w/b.js' } });
  panel.fromPage({ type: 'send', text: '' });
  await settle();
  assert.equal(conv.sent.length, 2);
  assert.deepEqual(conv.sent[0][1].images.map((i) => i.name), ['square.png']);
  assert.deepEqual(conv.sent[1][1].files.map((f) => f.name), ['a.js']);
  chat.dispose();
});
