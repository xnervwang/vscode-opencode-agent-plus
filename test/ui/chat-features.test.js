// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's slash commands, @ files, images and selection, compaction divider, question forms and subagent
 * progress: what the view model draws, what the panel sends both ways, and the page's own helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ChatPanel, MAX_IMAGE_BYTES } = require('../../src/ui/chat-panel');
const vm = require('../../src/ui/view-model');
const composer = require('../../media/composer');
const { rank, excludeGlob, createFileSearch } = require('../../src/host/file-search');
const { createSelectionTracker } = require('../../src/host/selection');
const { createSessionManager } = require('../../src/host/session-manager');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/* The form OpenCode 2.4.1's question tool sent when asked two questions (test/opencode/fixtures/v2-question.jsonl). */
const SCHEMA = {
  type: 'object',
  properties: {
    q0: { type: 'string', title: 'Color', description: 'Do you prefer red or blue?', oneOf: [{ const: 'Red', title: 'Red', description: 'Prefer red' }, { const: 'Blue', title: 'Blue', description: 'Prefer blue' }] },
    q0_custom: { type: 'string', title: 'Color (other)', description: 'Type your own answer' },
    q1: { type: 'array', title: 'Fruit', description: 'Which do you like?', items: { anyOf: [{ const: 'Apple', title: 'Apple' }, { const: 'Pear', title: 'Pear' }, { const: 'Plum', title: 'Plum' }] } },
    q1_custom: { type: 'string', title: 'Fruit (other)', description: 'Add your own answer' },
  },
  required: [],
};
const begin = (s) => vm.reduceAll([{ type: 'turnStart', turnId: 't1', at: 10 }, { type: 'userMessage', text: 'go', at: 10 }], s || vm.initialState(), 10);

function conversation(more = {}) {
  const listeners = new Set();
  const c = {
    sent: [], answers: [],
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fire(ev) { for (const fn of [...listeners]) fn(ev); },
    send(...a) { c.sent.push(a); }, abort() {}, setModel: async () => {},
    commands: () => [{ name: 'compact', description: 'Compact the session' }, { name: 'review', description: 'review changes' }],
    attachments: () => ({ images: true, files: true, selection: true }),
    respondQuestion(id, answer) { c.answers.push([id, answer]); return true; },
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

test('a message names the images and files that went with it', () => {
  const s = vm.reduceAll([{ type: 'turnStart', turnId: 't1', at: 1 },
    { type: 'userMessage', text: 'look', at: 1, attachments: [{ kind: 'image', name: 'shot.png' }, { kind: 'file', name: 'notes.txt', path: '/w/notes.txt' }, { kind: 'bogus' }, null] }]);
  assert.deepEqual(s.items.find((it) => it.kind === 'user').attachments,
    [{ kind: 'image', name: 'shot.png' }, { kind: 'file', name: 'notes.txt' }, { kind: 'bogus', name: 'bogus' }]);
});

test('compacting shows as one divider: in progress, then done with its summary; a failure says so', () => {
  let s = begin();
  s = vm.reduce(s, { type: 'compaction', status: 'running', id: 'c1' }, 20);
  const id = s.items[s.items.length - 1].id;
  assert.equal(s.items[s.items.length - 1].status, 'running');
  s = vm.reduce(s, { type: 'compaction', status: 'running', id: 'c1' }, 21);
  s = vm.reduce(s, { type: 'compaction', status: 'completed', id: 'c1', summary: '## Objective\n- remember OSPREY' }, 30);
  const items = s.items.filter((it) => it.kind === 'compaction');
  assert.equal(items.length, 1, 'the same divider, now done');
  assert.equal(items[0].id, id);
  assert.equal(items[0].status, 'completed');
  assert.match(items[0].summary, /OSPREY/);
  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 40 });
  s = vm.reduce(s, { type: 'compaction', status: 'completed', summary: 'replayed' }, 50);
  assert.equal(s.items[s.items.length - 1].turn, null, 'a replayed one between turns has no turn');
  s = vm.reduce(s, { type: 'compaction', status: 'failed', error: 'Compaction failed' }, 60);
  assert.deepEqual([s.items[s.items.length - 1].status, s.items[s.items.length - 1].error], ['failed', 'Compaction failed']);
  assert.equal(vm.reduce(s, { type: 'compaction', status: 'weird' }), s);
});

test('a question becomes a form: one choice and many choices with their own-answer boxes', () => {
  const fields = vm.formFields(SCHEMA);
  assert.deepEqual(fields.map((f) => [f.key, f.type, f.otherKey]), [['q0', 'choice', 'q0_custom'], ['q1', 'multi', 'q1_custom']]);
  assert.deepEqual(fields[0].options.map((o) => o.value), ['Red', 'Blue']);
  assert.equal(fields[0].otherLabel, 'Type your own answer');
  const more = vm.formFields({
    properties: {
      name: { type: 'string', title: 'Name', maxLength: 5 },
      sure: { type: 'boolean', title: 'Sure' },
      n: { type: 'integer', title: 'Count', minimum: 1, maximum: 3 },
      x: { type: 'number' },
      size: { type: 'string', enum: ['s', 'm'], enumNames: ['Small', 'Medium'] },
    },
    required: ['name', 'n'],
  });
  assert.deepEqual(more.map((f) => [f.key, f.type, f.required]), [['name', 'text', true], ['sure', 'boolean', false], ['n', 'integer', true], ['x', 'number', false], ['size', 'choice', false]]);
  assert.deepEqual(more[4].options.map((o) => o.label), ['Small', 'Medium']);
  assert.deepEqual(vm.formFields(null), []);

  assert.deepEqual(vm.formContent(fields, { q0: 'Blue', q1: ['Apple', 'Plum', 'Grape'], q0_custom: '', q1_custom: ' fig ' }),
    { content: { q0: 'Blue', q1: ['Apple', 'Plum'], q1_custom: 'fig' }, errors: [] });
  assert.deepEqual(vm.formContent(fields, {}).content, {}, 'nothing filled in: nothing sent');
  const bad = vm.formContent(more, { name: 'toolong', n: '2.5', x: 'abc' });
  assert.deepEqual(bad.errors, ['Name: at most 5 characters.', 'Count: enter a whole number.', 'x: enter a number.']);
  assert.deepEqual(vm.formContent(more, { name: 'Ann', n: '3', sure: true, size: 'm' }).content, { name: 'Ann', sure: true, n: 3, size: 'm' });
  assert.deepEqual(vm.formContent(more, { name: '', n: '9' }).errors, ['Name: needs an answer.', 'Count: at most 3.']);
});

test("the question tool's card is summed up by its questions", () => {
  assert.equal(vm.summarizeInput('question', { questions: [{ question: 'Do you prefer red or blue?', header: 'Colour' }, { header: 'Fruit' }] }), 'Do you prefer red or blue? · Fruit');
  assert.equal(vm.summarizeInput('question', { questions: [] }), '{"questions":[]}');
});

test('a question waits for the user, settles once answered, and is let go when the turn ends', () => {
  let s = begin();
  s = vm.reduce(s, { type: 'question', requestId: 'q1', message: 'Questions', schema: SCHEMA, toolId: 'call_1' }, 20);
  const q = s.items[s.items.length - 1];
  assert.equal(q.kind, 'question');
  assert.equal(q.fields.length, 2);
  assert.equal(s.status, 'waiting');
  assert.equal(vm.head(s).waitingFor, 'question');
  s = vm.reduce(s, { type: 'questionSettled', requestId: 'q1', action: 'accept' }, 30);
  assert.equal(s.items[s.items.length - 1].decision, 'answered');
  assert.equal(s.status, 'working');
  s = vm.reduce(s, { type: 'question', requestId: 'q2', message: 'Questions', schema: SCHEMA }, 40);
  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'aborted', at: 50 });
  assert.equal(s.items.find((it) => it.requestId === 'q2').decision, 'cancelled');
  assert.equal(s.status, 'idle');
  const p = vm.reduce(begin(), { type: 'permission', requestId: 'p1', request: { kind: 'command', tool: 'shell', summary: 'Run echo' } }, 20);
  assert.equal(vm.head(p).waitingFor, 'permission');
});

test("a subagent's progress is drawn on the call that started it; a request from it says which", () => {
  let s = begin();
  s = vm.reduce(s, { type: 'toolCall', id: 'call_sub', name: 'subagent', input: { description: 'List files' }, at: 11 });
  const sub = (extra) => ({ type: 'subagent', childId: 'ses_c', title: 'List files', status: 'running', toolId: 'call_sub', ...extra });
  s = vm.reduceAll([
    sub(),
    sub({ event: { type: 'reasoning', delta: 'Listing ' } }),
    sub({ event: { type: 'reasoning', delta: 'files.' } }),
    sub({ event: { type: 'toolCall', id: 'ses_c:call_g', name: 'glob', input: { pattern: '*' } } }),
    sub({ event: { type: 'toolResult', id: 'ses_c:call_g', content: '/w/notes.txt', isError: false } }),
    sub({ event: { type: 'text', delta: 'The code word\nis KIWI-93' } }),
  ], s, 12);
  const tool = s.items.find((it) => it.kind === 'tool' && it.toolId === 'call_sub');
  assert.deepEqual(tool.child.entries.map((e) => e.kind), ['reasoning', 'tool', 'text']);
  assert.equal(tool.child.entries[0].text, 'Listing files.');
  assert.deepEqual([tool.child.entries[1].name, tool.child.entries[1].summary, tool.child.entries[1].state], ['glob', '*', 'done']);
  assert.equal(tool.child.last, 'is KIWI-93');
  assert.ok(!s.items.some((it) => it.kind === 'subagent'), 'no card of its own');
  s = vm.reduce(s, sub({ status: 'done' }), 13);
  assert.equal(s.items.find((it) => it.toolId === 'call_sub').child.status, 'done');
  s = vm.reduce(s, { type: 'permission', requestId: 'p1', request: { kind: 'command', tool: 'shell', summary: 'Run echo' }, subagent: { childId: 'ses_c', title: 'List files' } }, 14);
  assert.deepEqual(s.items[s.items.length - 1].subagent, { childId: 'ses_c', title: 'List files' });

  let t = begin();
  t = vm.reduce(t, { type: 'subagent', childId: 'ses_x', title: 'Alone', status: 'running' }, 20);
  assert.equal(t.items[t.items.length - 1].kind, 'subagent', 'no call known: a card of its own');
  t = vm.reduce(t, { type: 'subagent', childId: 'ses_x', title: 'Alone', status: 'done' }, 21);
  assert.equal(t.items.filter((it) => it.kind === 'subagent').length, 1);
  assert.equal(t.items[t.items.length - 1].status, 'done');

  let u = begin();
  u = vm.reduceAll([{ type: 'toolCall', id: 'a', name: 'subagent', input: {}, at: 1 }, { type: 'toolCall', id: 'b', name: 'subagent', input: {}, at: 1 }], u, 1);
  u = vm.reduce(u, { type: 'subagent', childId: 'ses_y', title: 'Y', status: 'running', toolId: 'a' }, 2);
  u = vm.reduce(u, { type: 'subagent', childId: 'ses_y', title: 'Y', status: 'running', toolId: 'b' }, 3);
  assert.equal(u.items.find((it) => it.toolId === 'a').child, null, 'moved off the call guessed first');
  assert.equal(u.items.find((it) => it.toolId === 'b').child.childId, 'ses_y');
});

test('only the last steps of a long-running subagent are kept', () => {
  let s = vm.reduce(begin(), { type: 'toolCall', id: 'call_sub', name: 'subagent', input: {}, at: 11 });
  for (let i = 0; i < 70; i++) {
    s = vm.reduce(s, { type: 'subagent', childId: 'c', title: 'T', status: 'running', toolId: 'call_sub', event: { type: 'toolCall', id: `t${i}`, name: 'read', input: { path: `/f${i}` } } }, 12);
  }
  const child = s.items.find((it) => it.toolId === 'call_sub').child;
  assert.equal(child.entries.length, 60);
  assert.equal(child.dropped, 10);
  assert.equal(child.entries[0].summary, '/f10');
});

test('the page gets the commands and what a message may carry; files and selection need the host', async () => {
  const conv = conversation();
  const { panel, chat } = panelFor(conv);
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(posted(panel, 'commands')[0].commands.map((c) => c.name), ['compact', 'review']);
  assert.deepEqual(posted(panel, 'caps').pop(), { type: 'caps', images: true, files: false, selection: false, rewind: false, info: false, replyImages: false, now: posted(panel, 'caps').pop().now });
  conv.fire({ type: 'commands', commands: [{ name: 'init', description: '' }] });
  assert.deepEqual(posted(panel, 'commands').pop().commands, [{ name: 'init', description: '' }]);
  assert.equal(chat.state.items.length, 0, 'a commands event draws nothing in the log');
  chat.dispose();

  const bare = panelFor(conversation({ commands: undefined, attachments: undefined }), { findFiles: async () => [], selection: { describe: () => null, current: () => null, onDidChange: () => ({ dispose() {} }) } });
  bare.panel.fromPage({ type: 'ready' });
  await settle();
  assert.deepEqual(posted(bare.panel, 'commands').pop().commands, []);
  const caps = posted(bare.panel, 'caps').pop();
  assert.deepEqual([caps.images, caps.files, caps.selection], [false, false, false], 'an agent that says nothing gets nothing');
  bare.chat.dispose();
});

test('a message goes with its images, @ files and selections; what does not fit is left out', async () => {
  const conv = conversation();
  const { panel, chat } = panelFor(conv, { findFiles: async () => [] });
  panel.fromPage({ type: 'ready' });
  await settle();
  const big = 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8);
  panel.fromPage({
    type: 'send', text: 'what is in these?',
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' }, { mediaType: 'text/html', data: 'PGI+' }, { mediaType: 'image/png', data: big }],
    files: [{ path: '/w/notes.txt', name: 'notes.txt' }, { path: 'relative.txt' }, { path: '/w/notes.txt' }],
    selections: [{ path: '/w/a.js', name: 'a.js', text: 'x = 1', startLine: 3, endLine: 4 }],
  });
  panel.fromPage({ type: 'send', text: 'plain' });
  await settle();
  assert.deepEqual(conv.sent[0], ['what is in these?', {
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' }],
    files: [{ path: '/w/notes.txt', name: 'notes.txt' }, { path: '/w/a.js', name: 'a.js', text: 'x = 1', startLine: 3, endLine: 4 }],
  }]);
  assert.deepEqual(conv.sent[1], ['plain'], 'a bare message goes as before');
  chat.dispose();
});

test('@ asks the host for files and gets them back under the same number; the selection is fetched when added', async () => {
  const asked = [];
  let label = 'a.js:3-4';
  let changed = null;
  const selection = {
    describe: () => (label ? { label } : null),
    current: () => (label ? { path: '/w/a.js', name: 'a.js', startLine: 3, endLine: 4, text: 'x = 1', label } : null),
    onDidChange: (fn) => { changed = fn; return { dispose() { changed = null; } }; },
  };
  const { panel, chat } = panelFor(conversation(), { findFiles: async (q) => { asked.push(q); return [{ path: '/w/notes.txt', rel: 'notes.txt', name: 'notes.txt' }]; }, selection });
  panel.fromPage({ type: 'ready' });
  await settle();
  assert.equal(posted(panel, 'caps').pop().files, true);
  assert.equal(posted(panel, 'selection').pop().label, 'a.js:3-4');
  panel.fromPage({ type: 'findFiles', query: 'not', seq: 7 });
  await settle();
  assert.deepEqual(asked, ['not']);
  const files = posted(panel, 'files').pop();
  assert.equal(files.seq, 7);
  assert.equal(files.items[0].rel, 'notes.txt');
  panel.fromPage({ type: 'addSelection' });
  assert.equal(posted(panel, 'selectionAdded').pop().item.text, 'x = 1');
  label = '';
  changed();
  assert.equal(posted(panel, 'selection').pop().label, '');
  panel.fromPage({ type: 'addSelection' });
  assert.equal(posted(panel, 'selectionAdded').length, 1, 'nothing to add without a selection');
  chat.dispose();
  assert.equal(changed, null, 'stops listening with the panel');
});

test("a form's answer is checked, then goes to the conversation; Cancel goes as cancel", async () => {
  const conv = conversation();
  const { panel, chat } = panelFor(conv);
  panel.fromPage({ type: 'ready' });
  chat.dispatch({ type: 'turnStart', turnId: 't1', at: 1 });
  chat.dispatch({ type: 'question', requestId: 'q1', message: 'Questions', schema: { properties: { n: { type: 'integer', title: 'Count' } }, required: ['n'] } });
  panel.fromPage({ type: 'question', requestId: 'q1', action: 'accept', values: { n: 'x' } });
  await settle();
  assert.deepEqual(posted(panel, 'questionErrors').pop().errors, ['Count: enter a whole number.']);
  assert.equal(conv.answers.length, 0);
  panel.fromPage({ type: 'question', requestId: 'q1', action: 'accept', values: { n: '4' } });
  await settle();
  assert.deepEqual(conv.answers, [['q1', { action: 'accept', content: { n: 4 } }]]);
  chat.dispatch({ type: 'questionSettled', requestId: 'q1', action: 'accept' });
  panel.fromPage({ type: 'question', requestId: 'q1', action: 'accept', values: { n: '5' } });
  chat.dispatch({ type: 'question', requestId: 'q2', message: 'Questions', schema: SCHEMA });
  panel.fromPage({ type: 'question', requestId: 'q2', action: 'cancel' });
  panel.fromPage({ type: 'question', requestId: 'nope', action: 'cancel' });
  await settle();
  assert.deepEqual(conv.answers.slice(1), [['q2', { action: 'cancel' }]], 'an answered request and an unknown one send nothing');
  chat.dispose();
});

test('the page finds what is typed after / and @, and puts the pick in place', () => {
  assert.deepEqual(composer.slashToken('/comp', 5), { start: 0, end: 5, query: 'comp' });
  assert.equal(composer.slashToken('/compact now', 12), null, 'past the command name');
  assert.equal(composer.slashToken('say /compact', 12), null, 'only at the start');
  const cmds = [{ name: 'init', description: 'guided AGENTS.md setup' }, { name: 'review', description: 'review changes' }, { name: 'compact', description: 'Compact the session' }];
  assert.deepEqual(composer.filterCommands(cmds, '').map((c) => c.name), ['init', 'review', 'compact']);
  assert.deepEqual(composer.filterCommands(cmds, 'c').map((c) => c.name), ['compact', 'review'], 'review by its description');
  assert.deepEqual(composer.filterCommands(cmds, 'session').map((c) => c.name), ['compact']);
  assert.deepEqual(composer.atToken('look at @src/ma', 15), { start: 8, end: 15, query: 'src/ma' });
  assert.deepEqual(composer.atToken('@', 1), { start: 0, end: 1, query: '' });
  assert.equal(composer.atToken('mail me@host', 12), null, 'not inside a word');
  assert.deepEqual(composer.insertToken('look at @src/ma please', { start: 8, end: 15 }, '@src/main.js'), { text: 'look at @src/main.js please', caret: 20 });
  assert.deepEqual(composer.insertToken('/comp', { start: 0, end: 5 }, '/compact'), { text: '/compact ', caret: 9 });
  const picked = [{ path: '/w/a.js', rel: 'a.js' }, { path: '/w/b.js', rel: 'b.js' }, { path: '/w/a.js', rel: 'a.js' }, { path: '/w/a.json', rel: 'a.json' }];
  assert.deepEqual(composer.filesInText('see @a.js, not b', picked).map((f) => f.path), ['/w/a.js'], 'one removed from the text is not sent');
  assert.deepEqual(composer.imageOfDataUrl('data:image/png;base64,AAAA'), { mediaType: 'image/png', data: 'AAAA', bytes: 3 });
  assert.equal(composer.imageOfDataUrl('data:text/plain;base64,AAAA'), null);
});

test('files for @ are ranked by name, then path, then letters in order; excludes come from the settings', async () => {
  const files = ['src/main.js', 'src/util/maintain.js', 'test/main.test.js', 'docs/a.md', 'm/a/i/n.md'].map((rel) => ({ rel, path: `/w/${rel}` }));
  assert.deepEqual(rank(files, 'main').map((f) => f.rel), ['src/main.js', 'test/main.test.js', 'src/util/maintain.js', 'm/a/i/n.md']);
  assert.deepEqual(rank(files, 'MAIN.T').map((f) => f.rel), ['test/main.test.js']);
  assert.deepEqual(rank(files, 'srcmn').map((f) => f.rel), ['src/main.js', 'src/util/maintain.js']);
  assert.equal(rank(files, '', 2).length, 2);
  assert.equal(excludeGlob((k) => (k === 'files.exclude' ? { '**/.DS_Store': true, '**/x': false, '**/*.{a,b}': true } : { '**/dist': true })),
    '{**/node_modules/**,**/.git/**,**/.DS_Store,**/dist}');
  let calls = 0;
  let t = 1000;
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: () => ({}) }),
      findFiles: async (inc, exc, max) => { calls += 1; assert.equal(max, 5000); return [Uri.file('/w/src/main.js'), Uri.from({ scheme: 'untitled', path: 'x' })]; },
      asRelativePath: (u, withFolder) => { assert.equal(withFolder, undefined, "VS Code names the folder only when there are several"); return u.path.replace('/w/', ''); },
    },
  };
  const search = createFileSearch({ vscode, now: () => t });
  assert.deepEqual(await search.search('main'), [{ path: '/w/src/main.js', rel: 'src/main.js', name: 'main.js' }]);
  await search.search('ma');
  assert.equal(calls, 1, 'listed once while @ is typed');
  t += 31000;
  await search.search('ma');
  assert.equal(calls, 2);
});

test("the selection is the last one made in a file editor still shown; VS Code is listened to only while asked", async () => {
  const sel = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d }, isEmpty: a === c && b === d });
  const doc = { uri: { scheme: 'file', fsPath: '/w/src/a.js' }, getText: () => 'line three\nline four\n' };
  const editor = { document: doc, selection: sel(2, 0, 4, 0) };
  let onSel = null;
  let hooked = 0;
  const vscode = {
    window: {
      visibleTextEditors: [editor],
      onDidChangeTextEditorSelection: (fn) => { onSel = fn; hooked += 1; return { dispose() { onSel = null; } }; },
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    },
  };
  const tracker = createSelectionTracker({ vscode, settleMs: 1 });
  assert.equal(tracker.describe(), null, 'nothing before a panel listens');
  let heard = 0;
  const sub = tracker.onDidChange(() => { heard += 1; });
  assert.equal(hooked, 1);
  assert.deepEqual(tracker.describe(), { label: 'a.js:3-4' }, 'a selection ending at a line start leaves that line out');
  assert.deepEqual(tracker.current(), { path: '/w/src/a.js', name: 'a.js', startLine: 3, endLine: 4, text: 'line three\nline four\n', label: 'a.js:3-4' });
  editor.selection = sel(2, 0, 2, 0);
  onSel({ textEditor: editor });
  await settle(10);
  assert.equal(heard, 1);
  assert.equal(tracker.current(), null);
  sub.dispose();
  assert.equal(onSel, null, 'let go with the last listener');
});

test('a conversation waiting on a question says so to the session list and Agent Plus', () => {
  const listeners = new Set();
  const conv = { id: 'ses_a', on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, status: 'idle', dispose() {} };
  const manager = createSessionManager({ makeConversation: () => conv });
  return manager.open('ses_a').then(() => {
    const fire = (ev) => { for (const fn of listeners) fn(ev); };
    fire({ type: 'turnStart', turnId: 't', at: 1 });
    fire({ type: 'question', requestId: 'q1', message: 'Questions', schema: SCHEMA });
    assert.deepEqual(manager.snapshot('ses_a').waitingFor, { kind: 'question' });
    fire({ type: 'permission', requestId: 'p2', request: { tool: 'shell' } });
    assert.deepEqual(manager.snapshot('ses_a').waitingFor, { kind: 'permission', tool: 'shell' });
    fire({ type: 'permissionSettled', requestId: 'p2', decision: 'allowOnce' });
    assert.deepEqual(manager.snapshot('ses_a').waitingFor, { kind: 'question' }, 'back to the question still open');
    fire({ type: 'questionSettled', requestId: 'q1', action: 'accept' });
    assert.equal(manager.snapshot('ses_a').activity, 'working');
    const before = manager.snapshot('ses_a').lastActiveAt;
    fire({ type: 'commands', commands: [] });
    assert.equal(manager.snapshot('ses_a').lastActiveAt, before, 'a command list is no activity');
  });
});
