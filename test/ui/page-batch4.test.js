// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's links to other conversations a reply names, the outline of the user's messages, and the subagent
 * filter: the logic that runs without the page (media/composer.js, Agent Plus's kit), and what the panel sends the page
 * and opens for it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ChatPanel } = require('../../src/ui/chat-panel');
const C = require('../../media/composer.js');
const kit = require('../../media/kit.js');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');
const { createFakeConversation } = require('./fake-conversation');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = { id: 'us.xai.grok-4.7', name: 'Grok 4.7', vendor: 'xAI', contextWindow: 200000 };
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const PAGE = fs.readFileSync(path.join(ROOT, 'media', 'chat.js'), 'utf8');

test('the outline lists the user\'s messages, numbered, and the compaction points, in order', () => {
  const rows = C.outlineRows([
    { id: 'i1', kind: 'user', text: 'First   question\nwith two lines', at: 10 },
    { id: 'i2', kind: 'text', text: 'a reply' },
    { id: 'i3', kind: 'compaction', status: 'completed', at: 20 },
    { id: 'i4', kind: 'user', text: 'x'.repeat(100), at: 30 },
    { id: 'i5', kind: 'user', text: 'hidden', hidden: true },
    { id: 'i6', kind: 'compaction', status: 'running' },
    { id: 'i7', kind: 'user', text: '   ' },
    null,
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.n || 0, r.label]), [
    ['i1', 'user', 1, 'First question with two lines'],
    ['i3', 'compaction', 0, 'Compacted'],
    ['i4', 'user', 2, `${'x'.repeat(79)}…`],
    ['i6', 'compaction', 0, 'Compacting…'],
    ['i7', 'user', 3, '(no text)'],
  ]);
  assert.deepEqual(C.outlineRows(undefined), []);
});

test('the subagent filter hides what subagents did, folds the call that started each, and still shows their requests while they wait', () => {
  const sub = { childId: 'ses_child', title: 'Look around' };
  assert.equal(C.subagentShare({ kind: 'subagent', childId: 'ses_child' }), 'hide', "a subagent's own card");
  assert.equal(C.subagentShare({ kind: 'tool', subagent: sub }), 'hide', 'a tool call a subagent made');
  assert.equal(C.subagentShare({ kind: 'permission', subagent: sub, decision: 'allowOnce' }), 'hide', 'its request once answered');
  assert.equal(C.subagentShare({ kind: 'permission', subagent: sub, decision: null }), '', 'its request while it waits');
  assert.equal(C.subagentShare({ kind: 'question', subagent: sub, decision: null }), '');
  assert.equal(C.subagentShare({ kind: 'question', subagent: sub, decision: 'answered' }), 'hide');
  assert.equal(C.subagentShare({ kind: 'tool', name: 'task', child: { childId: 'ses_child' } }), 'fold', 'the call that started it stays, folded');
  for (const own of [{ kind: 'tool', name: 'bash' }, { kind: 'text' }, { kind: 'user' }, { kind: 'permission', decision: null }, null]) {
    assert.equal(C.subagentShare(own), '', JSON.stringify(own));
  }
});

const SELF = { sourceId: 'opencode-plus', sessionId: 'ses_selfselfselfselfselfself' };
const opencodeRow = (sessionId, title = '', lastActiveAt = 1) => ({ sourceId: 'opencode-plus', label: 'OpenCode Plus', sessionId, title, lastActiveAt });

test("Agent Plus's kit finds an OpenCode session id in a reply whole and as written, not inside a path or a file name", () => {
  const ix = kit.mentionIndex([opencodeRow('ses_df2751c45ffeo343ehNzaBtgRH'), opencodeRow('ses_other00000000000000000')], SELF);
  const t = 'See ses_df2751c45ffeo343ehNzaBtgRH. Also `ses_other00000000000000000`, not /x/ses_df2751c45ffeo343ehNzaBtgRH or ses_df2751c45ffeo343ehNzaBtgRH.json or ses_df2751c45ffeo343ehNzaBtgRHx or ses_df2751c45ffeo343ehnzabtgrh.';
  assert.deepEqual(kit.mentions(t, ix).map((r) => [r.kind, r.sessionId, t.slice(r.start, r.end)]), [
    ['id', 'ses_df2751c45ffeo343ehNzaBtgRH', 'ses_df2751c45ffeo343ehNzaBtgRH'],
    ['id', 'ses_other00000000000000000', 'ses_other00000000000000000'],
  ]);
  assert.deepEqual(kit.mentions(t, kit.mentionIndex([], SELF)), []);
  assert.deepEqual(kit.mentions('', ix), []);
});

test("Agent Plus's kit finds OpenCode conversations by title and by id, and never the page's own", () => {
  const known = [
    opencodeRow('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Fix the flaky upload test', 1),
    { sourceId: 'claude-code', label: 'Claude Code', sessionId: '0f9e8d7c-1111-4222-8333-444455556666', title: '整理测试清单', lastActiveAt: 2 },
    opencodeRow(SELF.sessionId, 'This one', 3),
  ];
  const ix = kit.mentionIndex(known, SELF);
  const text = 'As in Fix the flaky upload test and 「整理测试清单」 (0f9e8d7c-1111-4222-8333-444455556666); see ses_aaaaaaaaaaaaaaaaaaaaaaaaaa; 「This one」 is here, ses_selfselfselfselfselfself.';
  const got = kit.mentions(text, ix).map((r) => [r.kind, r.sessionId]);
  assert.deepEqual(got, [['title', 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa'], ['quoted', '0f9e8d7c-1111-4222-8333-444455556666'],
    ['id', '0f9e8d7c-1111-4222-8333-444455556666'], ['id', 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa']]);
  assert.ok(kit.mentionIndex([known[2]], SELF).size === 0, 'a list of only the page itself names nothing');
  assert.match(kit.mentionTip({ ...known[0], others: [] }, 61000), /OpenCode Plus conversation ses_aaaa, active 1m ago/);
});

test("Agent Plus's kit links an OpenCode session id in a reply's text and inline code, not in a code block or a link", () => {
  /* The page walks its DOM with linkMentions; the HAST walk follows the same rules and needs no DOM here. */
  const ID = 'ses_df2751c45ffeo343ehNzaBtgRH';
  const ix = kit.mentionIndex([opencodeRow(ID)], SELF);
  const txt = (value) => ({ type: 'text', value });
  const node = (tagName, children, properties = {}) => ({ type: 'element', tagName, properties, children });
  const root = node('div', [
    node('p', [txt(`see ${ID} and `), node('code', [txt(ID)])]),
    node('pre', [node('code', [txt(ID)])]),
    node('p', [node('a', [txt(ID)], { href: 'https://example.com/' })]),
  ]);
  const made = kit.linkMentionsTree(root, ix, (r, text) => node('a', [txt(text)], { className: ['conv-link'], session: r.sessionId }));
  assert.equal(made, 2);
  const shape = (n) => (n.type === 'text' ? n.value : `${n.tagName}${n.properties.session ? `:${n.properties.session}` : ''}[${n.children.map(shape).join('')}]`);
  assert.deepEqual(root.children.map(shape), [
    `p[see a:${ID}[${ID}] and code[a:${ID}[${ID}]]]`,
    `pre[code[${ID}]]`,
    `p[a[${ID}]]`,
  ]);
});

test('the page links conversations as it renders a reply, opens one through the extension, and keeps the outline and the filter in its state', () => {
  assert.match(PAGE, /placeImages\(target\);\n\s*linkConversations\(target\);/, 'every rendered reply');
  assert.match(PAGE, /KIT\.linkMentions\(target, convIx/);
  assert.match(PAGE, /KIT\.mentionIndex\(list, /, "the kit is given every conversation of the list, OpenCode's included");
  assert.match(PAGE, /closest\('a\.conv-link'\)[\s\S]{0,200}type: 'openConversation', sourceId/);
  assert.match(PAGE, /keep\(\{ outline: outlineOpen \}\)/);
  assert.match(PAGE, /keep\(\{ hideSubagents: hideSubs \}\)/);
  const css = fs.readFileSync(path.join(ROOT, 'media', 'chat.css'), 'utf8');
  assert.match(css, /body\.hide-subagents \.sub-hide \{\s*display: none;/);
  assert.match(css, /body\.hide-subagents \.sub-fold \.child \{\s*display: none;/);
  /* scrollIntoView moves the page too, by the few pixels it is taller than its frame; only the log may scroll. */
  assert.doesNotMatch(PAGE, /\.scrollIntoView\(/);
  assert.match(PAGE, /function scrollLogTo\(el, center\)/);
  /* The header's buttons wrap to a second row in a narrow pane rather than push out of it. */
  assert.match(css, /#top \{\s*display: flex;\s*flex-wrap: wrap;/);
});

function setup(extra = {}) {
  const vscode = createFakeVscode();
  const panel = createFakePanel();
  const conversation = createFakeConversation({ turns: [] });
  conversation.id = 'ses_selfselfselfselfselfself';
  const chat = new ChatPanel({ vscode, panel, extensionUri: Uri.file(ROOT), conversation, listModels: async () => [MODEL], model: MODEL,
    respond: () => {}, ...extra });
  return { vscode, panel, conversation, chat };
}

function fakeLinks() {
  const fns = new Set();
  const opened = [];
  const links = {
    now: { rev: 1, list: [{ sourceId: 'opencode-plus', sessionId: 'ses_a', title: 'A', cwd: '/w', lastActiveAt: 1 }] },
    current: () => links.now,
    onDidChange: (fn) => { fns.add(fn); return { dispose: () => fns.delete(fn) }; },
    open: async (sourceId, sessionId) => { opened.push([sourceId, sessionId]); },
    fire: () => { for (const fn of [...fns]) fn(); },
    fns,
    opened,
  };
  return links;
}

test('the page gets the conversations it may link to when it loads and when they change, and is told which one is its own', async () => {
  const links = fakeLinks();
  const { panel, chat } = setup({ links });
  assert.match(panel.webview.html, /<div id="middle">\n<main id="log"[^>]*><\/main>\n<nav id="outline"[^>]*hidden>/);
  assert.match(panel.webview.html, /<button id="subBtn" class="toggle"[^>]*hidden>Subagents<\/button>/);
  assert.match(panel.webview.html, /<button id="navBtn" class="toggle"[^>]*hidden>Outline<\/button>/);
  links.fire();
  assert.equal(panel.posted.filter((m) => m.type === 'conversations').length, 0, 'nothing before the page is ready');
  panel.fromPage({ type: 'ready' });
  await settle();
  let sent = panel.posted.filter((m) => m.type === 'conversations');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].self, { sourceId: 'opencode-plus', sessionId: 'ses_selfselfselfselfselfself' });
  assert.equal(sent[0].rev, 1);
  assert.deepEqual(sent[0].list.map((c) => c.sessionId), ['ses_a']);
  links.now = { rev: 2, list: [] };
  links.fire();
  await settle();
  sent = panel.posted.filter((m) => m.type === 'conversations');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].rev, 2);
  chat.dispose();
  assert.equal(links.fns.size, 0, 'stops listening with the panel');
});

test('a link clicked in the page opens that conversation through the extension; a bad one does nothing', async () => {
  const links = fakeLinks();
  const { panel, chat } = setup({ links });
  panel.fromPage({ type: 'ready' });
  panel.fromPage({ type: 'openConversation', sourceId: 'claude-code', sessionId: '0f9e8d7c-1111-4222-8333-444455556666' });
  panel.fromPage({ type: 'openConversation', sourceId: '', sessionId: 'ses_a' });
  panel.fromPage({ type: 'openConversation', sourceId: 'opencode-plus' });
  await settle();
  assert.deepEqual(links.opened, [['claude-code', '0f9e8d7c-1111-4222-8333-444455556666']]);
  chat.dispose();
});

test('without links the page is sent no conversations and a click goes nowhere', async () => {
  const { panel, chat } = setup();
  panel.fromPage({ type: 'ready' });
  panel.fromPage({ type: 'openConversation', sourceId: 'opencode-plus', sessionId: 'ses_a' });
  await settle();
  assert.equal(panel.posted.filter((m) => m.type === 'conversations').length, 0);
  chat.dispose();
});
