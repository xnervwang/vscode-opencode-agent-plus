// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's coloured code blocks, an edit's change and a todo list in their tool rows, links to the files a reply
 * names, Focus view and the pinned prompt: the logic that runs without the page (media/chat.js's ChatPage), the view
 * model, and what the panel checks, opens and sends the page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('../../src/ui/view-model');
const P = require('../../media/chat.js');
const { ChatPanel } = require('../../src/ui/chat-panel');
const { PAGE_ONLY } = require('../../build/pack-vsix');
const { createFakeVscode, createFakePanel, Uri } = require('./fake-vscode');
const { createFakeConversation } = require('./fake-conversation');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'media', 'chat.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'media', 'chat.css'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const HLJS = path.join(ROOT, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js');
const NO_MODULES = !fs.existsSync(HLJS) ? 'no node_modules' : false;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/* A panel over a fake conversation, with `opts.view`, workspace folders `opts.folders` and VS Code's Range and ViewColumn. */
function setup(opts = {}) {
  const vscode = createFakeVscode();
  vscode.workspace.workspaceFolders = (opts.folders || []).map((f) => ({ uri: Uri.file(f) }));
  vscode.Range = class { constructor(a, b, c, d) { Object.assign(this, { startLine: a, startCharacter: b, endLine: c, endCharacter: d }); } };
  vscode.ViewColumn = { Active: -1, Beside: -2 };
  const panel = createFakePanel();
  const conversation = createFakeConversation({ turns: [] });
  if (opts.cwd) conversation.cwd = opts.cwd;
  const chat = new ChatPanel({ vscode, panel, extensionUri: Uri.file(ROOT), conversation, listModels: async () => [], respond: () => {}, view: opts.view });
  return { vscode, panel, chat, conversation };
}

test('a code block that names a language is coloured with highlight.js; one without, or in a language it does not know, stays plain', { skip: NO_MODULES }, () => {
  const hljs = require(HLJS);
  const js = P.highlightCode(hljs, 'const x = 1; // one\nfunction f(a) { return "s" + a; }', 'js');
  assert.match(js, /<span class="hljs-keyword">const<\/span>/);
  assert.match(js, /<span class="hljs-comment">\/\/ one<\/span>/);
  assert.match(js, /<span class="hljs-string">&quot;s&quot;<\/span>/);
  assert.match(P.highlightCode(hljs, 'def f(x):\n    return x + 1\n', 'Python'), /<span class="hljs-keyword">def<\/span>/, 'the language name in any case');
  assert.match(P.highlightCode(hljs, 'ls -la', 'sh title="x"'), /hljs-built_in|hljs-keyword|ls/, 'an alias, and the info string after the first word ignored');
  for (const lang of ['', undefined, 'no-such-language']) assert.equal(P.highlightCode(hljs, 'x = 1', lang), '', String(lang));
  assert.equal(P.highlightCode(hljs, 'x'.repeat(P.HIGHLIGHT_MAX + 1), 'js'), '', 'a block that long stays plain');
  assert.equal(P.highlightCode(null, 'x = 1', 'js'), '', 'without the library');
  assert.equal(P.highlightCode(hljs, '<b>&', 'js').includes('<b>'), false, 'what the code holds is escaped');
  /* markdown-it with the page's option: the coloured HTML inside its usual pre and code. */
  const md = require(path.join(ROOT, 'node_modules', 'markdown-it'))({ html: false, highlight: (s, l) => P.highlightCode(hljs, s, l) });
  const html = md.render('```js\nlet a = 2;\n```\n\n```\nlet a = 2;\n```\n');
  assert.match(html, /<pre><code class="language-js"><span class="hljs-keyword">let<\/span> a = <span class="hljs-number">2<\/span>;/);
  assert.match(html, /<pre><code>let a = 2;\n<\/code><\/pre>/, 'no language, no colour');
});

test('the page loads highlight.js before its own script, and colours its classes with the theme\'s variables', () => {
  const { panel, chat } = setup();
  try {
    assert.match(panel.webview.html, /cdn-assets\/highlight\.min\.js"><\/script>\n<script src="[^"]*media\/kit\.js/);
    assert.match(PAGE, /window\.markdownit\(\{ html: false, linkify: true, breaks: true, highlight: codeHtml \}\)/);
    for (const [cls, v] of [['keyword', 'debugTokenExpression-boolean'], ['string', 'debugTokenExpression-string'], ['number', 'debugTokenExpression-number'],
      ['title', 'symbolIcon-functionForeground'], ['type', 'symbolIcon-classForeground'], ['variable', 'symbolIcon-variableForeground'], ['comment', 'charts-green']]) {
      assert.match(CSS, new RegExp(`\\.hljs-${cls}\\b[^{]*\\{[^}]*--vscode-${v}`), cls);
    }
  } finally { panel.dispose(); }
  assert.deepEqual(PAGE_ONLY['@highlightjs/cdn-assets'], ['package.json', 'LICENSE', 'highlight.min.js'], 'only the browser build and its licence are packed');
  assert.equal(PKG.dependencies['@highlightjs/cdn-assets'], '11.12.0');
  const notices = fs.readFileSync(path.join(ROOT, 'ThirdPartyNotices.txt'), 'utf8');
  assert.match(notices, /highlight\.js 11\.12\.0[\s\S]*BSD 3-Clause/);
});

test("an edit's change: its old and new strings line by line, unchanged runs folded, in snake_case and camelCase", () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
  const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l'].join('\n');
  const c = vm.changeOf('edit', { filePath: '/w/a.js', oldString: before, newString: after });
  assert.equal(c.kind, 'edit');
  assert.equal(c.path, '/w/a.js');
  assert.deepEqual([c.added, c.removed, c.more], [3, 2, 0]);
  assert.deepEqual(c.rows.map((r) => (r.k === '~' ? `~${r.count}` : `${r.k}${r.t}`)), [' a', '-b', '+B', ' c', ' d', ' e', '~2', ' h', ' i', ' j', '-k', '+K', '+l']);
  assert.ok(c.rows.every((r) => r.o === undefined && r.n === undefined), 'a snippet has no line numbers of the file');
  const snake = vm.changeOf('edit_file', { path: 'sum.js', old_string: 'a - b', new_string: 'a + b' });
  assert.deepEqual(snake.rows, [{ k: '-', t: 'a - b' }, { k: '+', t: 'a + b' }]);
  const multi = vm.changeOf('multiedit', { filePath: 'm.js', edits: [{ oldString: 'x', newString: 'y' }, { old_string: 'p', new_string: 'q' }] });
  assert.deepEqual(multi.rows.map((r) => r.k), ['-', '+', '@', '-', '+']);
  assert.equal(vm.changeOf('bash', { command: 'ls' }), null);
  assert.equal(vm.changeOf('read', { filePath: 'x', content: 'y' }), null, 'content alone makes a change only for a write');
});

test("a write's content as added lines, and a patch's rows in OpenCode's and in unified form", () => {
  const w = vm.changeOf('write', { path: 'src/export.js', content: 'one\ntwo\n' });
  assert.deepEqual([w.kind, w.added, w.removed, w.rows.map((r) => r.k + r.t)], ['write', 2, 0, ['+one', '+two']]);
  const p = vm.changeOf('apply_patch', { patchText: '*** Begin Patch\n*** Update File: src/a.js\n@@ function f\n-old\n+new\n same\n*** End Patch' });
  let s = vm.reduce(vm.initialState(), { type: 'turnStart', turnId: 't' }, 1);
  s = vm.reduce(s, { type: 'toolCall', id: 'p', name: 'apply_patch', input: { patchText: '*** Begin Patch\n*** Update File: src/a.js\n-x\n+y\n*** End Patch' } }, 2);
  assert.deepEqual([s.items[0].summary, s.items[0].file], ['src/a.js', { path: 'src/a.js' }], "a patch's row names its file, not its first line");
  assert.equal(p.path, 'src/a.js');
  assert.deepEqual(p.rows.map((r) => r.k + r.t), ['fUpdate src/a.js', '@@@ function f', '-old', '+new', ' same']);
  const u = vm.changeOf('patch', { patch: 'diff --git a/x.sql b/x.sql\nindex 1..2\n--- a/x.sql\n+++ b/x.sql\n@@ -1,2 +1,2 @@\n--- a comment removed\n+-- a comment added\n select 1;\n\\ No newline at end of file' });
  assert.equal(u.path, 'x.sql');
  assert.deepEqual(u.rows.map((r) => r.k + r.t), ['fx.sql', '@@@ -1,2 +1,2 @@', '--- a comment removed', '+-- a comment added', ' select 1;'],
    'a removed line starting with -- is a line, not a header');
});

test('a long change shows its first rows and counts the rest; a long line is clipped', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const c = vm.changeOf('write', { path: 'big.txt', content: lines });
  assert.equal(c.added, 500, 'counted over the whole change');
  assert.equal(c.rows.length + c.more, 500);
  assert.ok(c.more > 300 && c.rows.length <= 200, `${c.rows.length} shown, ${c.more} more`);
  const wide = vm.changeOf('write', { path: 'w.txt', content: 'x'.repeat(5000) });
  assert.ok(wide.rows[0].t.length < 500 && wide.rows[0].t.endsWith('…'));
  /* Too many line pairs to compare: removed, then added, still counted right. */
  const a = Array.from({ length: 1000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 1000 }, (_, i) => `b${i}`).join('\n');
  const big = vm.changeOf('edit', { filePath: 'x', oldString: a, newString: b });
  assert.deepEqual([big.added, big.removed], [1000, 1000]);
});

test("a permission request's whole file replaces its call's change, with line numbers and folded runs", () => {
  let s = vm.initialState();
  s = vm.reduce(s, { type: 'turnStart', turnId: 't1' }, 1);
  s = vm.reduce(s, { type: 'toolCall', id: 'c1', name: 'edit', input: { filePath: '/w/s.js', oldString: 'old', newString: 'new' } }, 2);
  const fromInput = s.items[0].change;
  assert.deepEqual(fromInput.rows, [{ k: '-', t: 'old' }, { k: '+', t: 'new' }]);
  const file = (mid) => `${'x\n'.repeat(20)}${mid}\n${'y\n'.repeat(20)}`;
  s = vm.reduce(s, { type: 'permission', requestId: 'p1', request: { kind: 'edit', tool: 'edit', path: '/w/s.js', diff: { path: '/w/s.js', before: file('old'), after: file('new') } } }, 3);
  const c = s.items[0].change;
  assert.notEqual(c, fromInput);
  assert.deepEqual(c.rows.map((r) => (r.k === '~' ? `~${r.count}` : `${r.k}${r.o || ''}/${r.n || ''}`)), ['~17', ' 18/18', ' 19/19', ' 20/20', '-21/', '+/21', ' 22/22', ' 23/23', ' 24/24', '~17']);
  assert.ok(s.items[1].request.hasDiff, 'the request keeps its View diff');
  assert.equal(s.diffs.p1.before, file('old'));
  /* A request for another tool, or once the call is done, leaves the row as it is. */
  let t = vm.reduce(vm.initialState(), { type: 'turnStart', turnId: 't' }, 1);
  t = vm.reduce(t, { type: 'toolCall', id: 'c', name: 'read', input: { filePath: 'r' } }, 2);
  t = vm.reduce(t, { type: 'permission', requestId: 'p', request: { tool: 'edit', path: 'r', diff: { path: 'r', before: 'a', after: 'b' } } }, 3);
  assert.equal(t.items[0].change, undefined);
});

test("a todowrite call carries its list for the row, a short summary, and the file of a read, edit or write call", () => {
  let s = vm.reduce(vm.initialState(), { type: 'turnStart', turnId: 't' }, 1);
  s = vm.reduce(s, { type: 'toolCall', id: 'td', name: 'todowrite', input: { todos: [
    { content: 'Read the exporter', status: 'completed' }, { content: 'Write the CSV export', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' }, { content: 'Ask about Excel', status: 'cancelled' }, { content: 'Odd', status: 'whatever' }, { content: '  ' }, null] } }, 2);
  const it = s.items[0];
  assert.deepEqual(it.todos, [{ content: 'Read the exporter', status: 'completed' }, { content: 'Write the CSV export', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' }, { content: 'Ask about Excel', status: 'cancelled' }, { content: 'Odd', status: 'pending' }]);
  assert.equal(it.summary, '5 items · 1 done');
  assert.equal(vm.todosOf('todoread', { todos: [{ content: 'x', status: 'pending' }] }), null);
  assert.equal(vm.todosOf('todowrite', { todos: [] }), null);
  assert.deepEqual(vm.fileOf({ filePath: '/w/a.js', offset: 40, limit: 10 }), { path: '/w/a.js', line: 40 });
  assert.deepEqual(vm.fileOf({ path: 'src/x.js' }), { path: 'src/x.js' });
  assert.deepEqual(vm.fileOf({ patchText: '' }, { path: 'p.js' }), { path: 'p.js' }, "a patch's first file");
  assert.equal(vm.fileOf({ command: 'ls' }), null);
  assert.equal(vm.fileOf({ path: 'a\nb' }), null);
});

test('the paths a reply names: relative, with a line or a line and column, absolute on either system; a sentence\'s full stop is not one', () => {
  const t = 'See src/ui/view-model.js:120 and README.md. Then C:\\work\\a.ts:3:4, ./b.json#L9, /abs/dir/file.txt and lib/x.js:5-9.';
  assert.deepEqual(P.pathRefs(t).map((r) => [r.path, r.line || 0, r.col || 0, t.slice(r.index, r.index + r.length)]), [
    ['src/ui/view-model.js', 120, 0, 'src/ui/view-model.js:120'], ['README.md', 0, 0, 'README.md'], ['C:\\work\\a.ts', 3, 4, 'C:\\work\\a.ts:3:4'],
    ['./b.json', 9, 0, './b.json#L9'], ['/abs/dir/file.txt', 0, 0, '/abs/dir/file.txt'], ['lib/x.js', 5, 0, 'lib/x.js:5-9']]);
  for (const no of ['version 1.5', 'a web address https://example.com/a.js', 'just words here', '2026/11', 'x:12']) {
    assert.deepEqual(P.pathRefs(no).filter((r) => !/example\.com/.test(r.path)).map((r) => r.path).filter((p) => p !== 'example.com/a.js'), [], no);
  }
  assert.deepEqual(P.codePathRef(' src/sum.js:1 '), { index: 0, length: 12, path: 'src/sum.js', line: 1 });
  assert.equal(P.codePathRef('npm test'), null);
  assert.equal(P.codePathRef('see src/a.js'), null, 'inline code that is more than a path');
});

test('the panel says which paths are files: inside a workspace folder or the conversation\'s, or absolute; never a folder or a way out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-files-'));
  const ws = path.join(root, 'ws');
  const own = path.join(root, 'own');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(ws, 'src', 'sum.js'), 'x\n');
  fs.writeFileSync(path.join(own, 'notes.txt'), 'n\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'o\n');
  const { panel, chat } = setup({ folders: [ws], cwd: own });
  try {
    panel.fromPage({ type: 'ready' });
    panel.fromPage({ type: 'checkPaths', paths: ['src/sum.js', 'notes.txt', path.join(root, 'outside.txt'), '../outside.txt', 'src', 'missing.js', 'src/sum.js', 'a\nb', 7] });
    await settle(80);
    const got = panel.posted.filter((m) => m.type === 'paths').pop();
    assert.deepEqual(got.results, [{ path: 'src/sum.js', ok: true }, { path: 'notes.txt', ok: true }, { path: path.join(root, 'outside.txt'), ok: true },
      { path: '../outside.txt', ok: false }, { path: 'src', ok: false }, { path: 'missing.js', ok: false }], 'each once, bad ones dropped');
    panel.fromPage({ type: 'checkPaths', paths: Array.from({ length: 500 }, (_, i) => `f${i}.js`) });
    await settle(120);
    assert.equal(panel.posted.filter((m) => m.type === 'paths').pop().results.length, 200, 'at most 200 at a time');
    /* A file written just after it was found missing: the cached answer stands until the page asks past it. */
    fs.writeFileSync(path.join(ws, 'missing.js'), 'now here\n');
    panel.fromPage({ type: 'checkPaths', paths: ['missing.js'] });
    await settle(60);
    assert.deepEqual(panel.posted.filter((m) => m.type === 'paths').pop().results, [{ path: 'missing.js', ok: false }], 'cached for a moment');
    panel.fromPage({ type: 'checkPaths', paths: ['missing.js'], fresh: ['missing.js'] });
    await settle(60);
    assert.deepEqual(panel.posted.filter((m) => m.type === 'paths').pop().results, [{ path: 'missing.js', ok: true }], 'fresh skips the cache');
  } finally { panel.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  void chat;
});

test('a click on a file link opens the file beside the chat at its line, after checking it again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-open-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'one\ntwo\n');
  const { panel, vscode } = setup({ folders: [root] });
  try {
    panel.fromPage({ type: 'ready' });
    panel.fromPage({ type: 'openFile', path: 'a.js', line: 2, col: 3 });
    await settle(60);
    const open = vscode.rec.commands.find((c) => c[0] === 'vscode.open');
    assert.ok(open, 'vscode.open was called');
    assert.equal(open[1].fsPath, path.join(root, 'a.js'));
    assert.deepEqual({ ...open[2], selection: { ...open[2].selection } }, { preview: true, viewColumn: -2, selection: { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 2 } });
    fs.rmSync(path.join(root, 'a.js'));
    panel.fromPage({ type: 'openFile', path: 'a.js', line: 1 });
    await settle(60);
    assert.equal(vscode.rec.commands.filter((c) => c[0] === 'vscode.open').length, 1, 'a file gone since is not opened');
    assert.match(vscode.rec.errors.pop(), /a\.js is not there any more/);
    assert.deepEqual(panel.posted.filter((m) => m.type === 'paths').pop().results, [{ path: 'a.js', ok: false }], 'and the page drops its link');
  } finally { panel.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the page links files only once the extension says so, asks in batches, and opens one on a click', () => {
  assert.match(PAGE, /setTimeout\(askFiles, 120\)/, 'paths are gathered for a moment, then asked about together');
  assert.match(PAGE, /linkConversations\(target\);\n\s*linkFiles\(target\);/, 'every rendered reply');
  assert.match(PAGE, /closest\('a, pre, code'\)/, 'code blocks and links stay as they are');
  assert.match(PAGE, /closest\('\.file-link'\)[\s\S]{0,200}type: 'openFile', path: file\.dataset\.path/);
  assert.match(PAGE, /getAttribute\('href'\) !== `http:\/\/\$\{text\}`/, 'a web link markdown-it guessed from a file name is checked as a file');
  assert.match(PAGE, /paintToolFile\(entry, !!prev && prev\.state === 'running' && item\.state !== 'running'\)/, 'a call that has just ended has its file checked again');
  assert.match(PAGE, /type: 'checkPaths', paths, \.\.\.\(fresh\.length \? \{ fresh \} : \{\}\)/);
});

test('Focus view and the pinned prompt: their settings, the command and its key, and what the panel sends the page', async () => {
  const props = PKG.contributes.configuration.properties;
  assert.deepEqual([props['opencodeAgentPlus.focusView'].default, props['opencodeAgentPlus.pinPrompt'].default, props['opencodeAgentPlus.todoList'].default], [false, true, true]);
  assert.ok(PKG.contributes.commands.some((c) => c.command === 'opencodeAgentPlus.toggleFocusView'));
  const key = PKG.contributes.keybindings.find((k) => k.command === 'opencodeAgentPlus.toggleFocusView');
  assert.deepEqual(key, { command: 'opencodeAgentPlus.toggleFocusView', key: 'ctrl+alt+f', when: "activeCustomEditorId == 'opencodeAgentPlus.chat'" });
  const ext = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  assert.match(ext, /registerCommand\(`\$\{brand\.prefix\}\.toggleFocusView`/);
  assert.match(ext, /affectsConfiguration\(`\$\{brand\.prefix\}\.focusView`\)[\s\S]{0,120}for \(const c of chats\) c\.postView\(\)/);
  let focus = false;
  const set = [];
  const { panel } = setup({ view: { focus: () => focus, pin: () => false, setFocus: (on) => { set.push(on); focus = on; } } });
  try {
    panel.fromPage({ type: 'ready' });
    assert.deepEqual(panel.posted.filter((m) => m.type === 'view').map(({ now, ...m }) => m), [{ type: 'view', focus: false, pin: false, toggle: true }]);
    panel.fromPage({ type: 'setFocusView', on: true });
    await settle();
    assert.deepEqual(set, [true]);
  } finally { panel.dispose(); }
  const bare = setup();
  try {
    bare.panel.fromPage({ type: 'ready' });
    assert.deepEqual(bare.panel.posted.filter((m) => m.type === 'view').map(({ now, ...m }) => m), [{ type: 'view', focus: false, pin: true, toggle: false }], 'without the option: off, pinned, no button');
  } finally { bare.panel.dispose(); }
});

test('Focus view keeps your messages, the last text of each turn and what waits for you; it hides the rest', () => {
  const items = [
    { id: 'i1', kind: 'user', turn: 't1' }, { id: 'i2', kind: 'reasoning', turn: 't1' }, { id: 'i3', kind: 'text', turn: 't1' },
    { id: 'i4', kind: 'tool', turn: 't1' }, { id: 'i5', kind: 'permission', turn: 't1', decision: 'allowOnce' }, { id: 'i6', kind: 'text', turn: 't1' },
    { id: 'i7', kind: 'figures', turn: 't1' }, { id: 'i8', kind: 'user', turn: 't2' }, { id: 'i9', kind: 'subagent', turn: 't2' },
    { id: 'i10', kind: 'permission', turn: 't2', decision: null }, { id: 'i11', kind: 'question', turn: 't2', decision: null },
    { id: 'i12', kind: 'notice', level: 'info', turn: 't2' }, { id: 'i13', kind: 'notice', level: 'error', turn: 't2' }, { id: 'i14', kind: 'compaction' },
  ];
  assert.deepEqual([...P.focusHidden(items)], ['i2', 'i3', 'i4', 'i5', 'i9', 'i12']);
  assert.deepEqual([...P.focusHidden([])], []);
  assert.match(CSS, /body\.focus-view \.focus-out \{\s*display: none !important;/);
});

test('the pinned prompt is the last of your messages scrolled out above, until the next one reaches the top', () => {
  assert.equal(P.pinIndex([{ top: -100, bottom: -60 }, { top: 200, bottom: 230 }], 40), 0);
  assert.equal(P.pinIndex([{ top: -300, bottom: -260 }, { top: -100, bottom: -60 }, { top: 500, bottom: 530 }], 40), 1);
  assert.equal(P.pinIndex([{ top: -100, bottom: -60 }, { top: 20, bottom: 50 }], 40), -1, 'the next one is coming in under the pin');
  assert.equal(P.pinIndex([{ top: -10, bottom: 20 }], 40), -1, 'still partly in sight');
  assert.equal(P.pinIndex([{ top: -100, bottom: -60 }], 40), 0, 'the last message of the conversation');
  assert.equal(P.pinIndex([], 40), -1);
});

test('the page: thinking starts folded, a todo list starts open, an edit row opens to its change, Submit looks idle until answered', () => {
  assert.match(PAGE, /entry\.el = el\('details', 'reasoning tl'\);/, 'thinking is a closed details element');
  assert.doesNotMatch(PAGE, /reasoning[^\n]*\.open = true/);
  assert.match(PAGE, /if \(todos && !entry\.shownOnce\) \{ entry\.shownOnce = true; setOpen\(entry, true\); \}/);
  assert.match(PAGE, /entry\.inBox\.hidden = !item\.input \|\| item\.input === '\{\}' \|\| !!change \|\| !!todos;/, 'the change takes the place of IN');
  assert.match(PAGE, /entry\.submit\.classList\.toggle\('idle', !answered\(\)\)/);
  assert.match(PAGE, /box\.replaceChildren\(list\);\n\s*if \(change\.more\) box\.appendChild\(el\('div', 'diff-more'/, 'the count of rows left out sits outside the scrolling rows');
  assert.match(CSS, /\.diff-rows \{\s*max-height: 360px;\s*overflow: auto;/);
  assert.match(CSS, /button\.q-submit\.idle \{\s*opacity: 0\.5;/);
  for (const sel of ['.diff-row.d-add', '.diff-row.d-del', '.todo-completed .todo-text', '.todo-cancelled', '#pinned']) assert.ok(CSS.includes(sel), sel);
});

test('in a light theme grey text is lighter; an open request has a paler frame; the rail has no borders between its buttons', () => {
  assert.match(CSS, /body\.vscode-light \{\s*--muted: color-mix\(/, 'grey text, the times and figures among it, is lighter in a light theme');
  assert.match(CSS, /\n\.permission:not\(\.settled\), \.question:not\(\.settled\) \{\s*border-color: color-mix\(/);
  assert.match(CSS, /#log \{\s*scrollbar-color: auto;/, "VS Code's scrollbar-color would turn the log's own thin bar off");
  assert.match(CSS, /\.tool\.state-running \.tool-state \{\s*color: var\(--vscode-foreground\);/);
  assert.doesNotMatch(CSS, /\.rail-btn \+ \.rail-btn/);
  assert.match(CSS, /container-type: inline-size;/);
  assert.match(CSS, /@container \(max-width: 600px\) \{\s*\.tl > \.meta, \.msg\.user \.meta \{\s*float: none;\s*display: block;/, 'in a narrow log the time takes a line of its own');
  assert.match(CSS, /\.perm-actions button\.diff \{\s*justify-content: flex-start;\s*border-color: transparent;/, 'View diff has no frame of its own beside the highlighted answer');
});
