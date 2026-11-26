// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One conversation's chat page in a WebviewPanel that the caller already has (a custom editor's resolveCustomEditor
 * or a serializer gives it). This class sets the panel's options and HTML, builds the view model (src/ui/view-model.js)
 * from the conversation's events, and answers the page's messages. The caller creates, titles and restores the panel.
 *
 * VS Code keeps a hidden tab's page (retainContextWhenHidden, in src/host/trust-gate.js). Each time the page loads it
 * asks for the whole view ('ready'); after that, only the items that changed are posted, at most once per frame.
 *
 * From the conversation, options() (mode, effort), commands() and attachments() go to the page as 'options',
 * 'commands' and 'caps', and again on each `options` or `commands` event.
 *
 * Without one of these constructor options, the page leaves out its feature:
 *   findFiles  workspace files for @
 *   selection  the editor's selection, to send with a message
 *   planBar    Agent Plus's summary of the conversation's work plan (src/host/plan-bar.js), drawn above the input box
 *              by Agent Plus's fragment (media/plan-bar.js); a null summary hides the bar
 *   rewind     back to before a user message
 *   info       the conversation's ids and paths, for the info box
 *   sound      whether the page chimes; the caller keeps the setting
 *   loadImage  reads a local image a reply shows and sends it back as a data: URL, so the page's resource roots never
 *              widen (VS Code reloads a page whose options change)
 *   links      the conversations a reply may name (src/host/conversation-links.js), which the page turns into links
 *              ('conversations' { rev, list, self }); a click opens one
 *   beforeSend runs before a message is sent to the conversation, for example to save edited files; if it fails, the
 *              message is still sent
 *   view       the Focus view and pinned-prompt settings ('view' { focus, pin, toggle }); the page's Focus button sets the
 *              first through it ('setFocusView')
 *
 * The page asks which paths in a reply are files ('checkPaths' { paths }, at most MAX_PATHS at a time) and
 * links those ('paths' { results: [{ path, ok }] }). A relative path counts only inside a workspace folder or the
 * conversation's folder, an absolute one anywhere; answers are kept for a while in FILE_CACHE, which the paths listed in
 * `fresh` skip. 'openFile' { path, line } opens one beside the chat, at that line, after checking it again.
 *   visibleModels  (list, current) => src/host/models.js visibleModels
 *   connectProvider   opens OpenCode's sign-in for a model provider; the model list offers it (reloadModels() lists
 *              the models again afterwards)
 *   composer   () => { ctrlEnter, attachFile, attachSelection }, the settings of the message box; settingsChanged()
 *              sends them again
 *   permissionMode   { get(), set(on), onDidChange(fn) }: whether this conversation's edits are allowed without asking
 *              (src/host/auto-edit.js), which the mode pill sets
 *   forkFrom   copies the history before a user message into a new conversation and opens it (OpenCode 2)
 *   detached   () => [{ pid, command, startedAt }] or a promise of them: the conversation's detached commands
 *              (src/host/detached.js), looked for when a turn starts or ends and when the background list opens
 *   readRange  (path, startLine, endLine) => text or null: lines of a file named with @<path>#L.. in a message
 *
 * compose({ refs, draft }) puts @ references or a draft into the message box, after any text already there, and
 * focuses it; before the page has loaded, it waits. prefill(text, ms) does the same when Agent Plus asks, and
 * resolves with the page's answer ('prefill' { id, text } out, 'prefilled' { id, ok } back).
 *
 * The plan bar's fragment brings its own style element, so the page's policy lets inline styles in. A diff opened from
 * a permission card gets Allow once, Allow in this project and Deny in its editor's title bar (see answerFromDiff);
 * its right side's path is listed under the context key opencodeAgentPlus.openDiffs while the request is open.
 */
const path = require('path');
const fs = require('fs');
const vm = require('./view-model');
const { groupOf } = require('../host/models');
const { PERMISSION_DECISIONS } = require('../contracts');

const DIFF_SCHEME = 'opencodeAgentPlus-diff';
const OPEN_DIFFS_KEY = 'opencodeAgentPlus.openDiffs';
/* Limits per message. Image bytes are counted after base64 decoding; MAX_FILES covers files and selections together. */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;
const MARKDOWN_IT = ['node_modules', 'markdown-it', 'dist', 'browser'];
/* VS Code's icon font, for the page's buttons; without it the buttons show their tooltips' words only. */
const CODICONS = ['node_modules', '@vscode', 'codicons', 'dist'];
/* highlight.js's browser build, with its common languages. Code blocks in replies stay plain without it. */
const HIGHLIGHT = ['node_modules', '@highlightjs', 'cdn-assets'];
const MAX_PATHS = 200;
/* A file found is trusted for FILE_OK_MS and a missing one for FILE_MISS_MS, as a reply may name a file about to be written. */
const FILE_OK_MS = 60000;
const FILE_MISS_MS = 5000;
const FILE_CACHE = new Map();
const FLUSH_MS = 16;
/* This extension's source id at Agent Plus (src/host/agentplus-source.js). */
const SOURCE_ID = 'opencode-plus';

/* One read-only content provider for every panel; it holds the before/after texts of recent diffs. */
const diffDocs = new Map();
let diffRegistration = null;
let diffUsers = 0;

function acquireDiffProvider(vscode) {
  if (!diffRegistration) {
    diffRegistration = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: (uri) => diffDocs.get(uri.toString()) || '',
    });
  }
  diffUsers++;
}

function releaseDiffProvider() {
  if (--diffUsers > 0 || !diffRegistration) return;
  diffRegistration.dispose();
  diffRegistration = null;
  diffDocs.clear();
}

/* Diffs of permission requests still open: right side's path -> { panel, requestId }. */
const openDiffs = new Map();
let diffKeyVscode = null;
function publishDiffs() {
  if (!diffKeyVscode) return;
  Promise.resolve(diffKeyVscode.commands.executeCommand('setContext', OPEN_DIFFS_KEY, [...openDiffs.keys()])).catch(() => {});
}
function forgetDiffs(panel, requestId) {
  let gone = false;
  for (const [k, v] of openDiffs) if (v.panel === panel && (requestId === undefined || v.requestId === requestId)) { openDiffs.delete(k); gone = true; }
  if (gone) publishDiffs();
}

/*
 * Answers the permission request whose diff has `uri` as its right side. Returns false when no such request is open
 * or `decision` is not one of PERMISSION_DECISIONS. The title bar's buttons call it.
 */
function answerFromDiff(uri, decision) {
  const key = uri && typeof uri.path === 'string' ? uri.path : '';
  const d = openDiffs.get(key);
  if (!d || !PERMISSION_DECISIONS.includes(decision)) return false;
  forgetDiffs(d.panel, d.requestId);
  Promise.resolve().then(() => d.panel.respond(d.requestId, decision)).catch((err) => d.panel.showError(err));
  return true;
}

function putDiffDoc(uri, text) {
  const key = uri.toString();
  diffDocs.delete(key);
  diffDocs.set(key, String(text == null ? '' : text));
  while (diffDocs.size > 100) diffDocs.delete(diffDocs.keys().next().value);
}

function subscribe(conversation, listener) {
  const off = conversation.on(listener);
  if (typeof off === 'function') return off;
  if (off && typeof off.dispose === 'function') return () => off.dispose();
  return () => {};
}

const fileRef = (p) => (typeof p === 'string' && p && p.length <= 1024 && !/[\0\r\n]/.test(p) ? p : '');

/* The regular file `ref` names: an absolute path as it is, a relative one inside one of `roots` without leaving it. '' when
   there is none. */
async function findFile(ref, roots) {
  const candidates = [];
  if (path.isAbsolute(ref)) candidates.push(path.normalize(ref));
  else {
    for (const root of roots) {
      const abs = path.resolve(root, ref);
      const rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) candidates.push(abs);
    }
  }
  for (const c of candidates) {
    try { if ((await fs.promises.stat(c)).isFile()) return c; } catch (_) { /* not there */ }
  }
  return '';
}

function modelForPage(m) {
  return { id: m.id, name: m.name || m.id, vendor: m.vendor || '', group: groupOf(m), contextWindow: m.contextWindow || 0 };
}

class ChatPanel {
  /**
   * @param {{
   *   panel: import('vscode').WebviewPanel,
   *   extensionUri: import('vscode').Uri,
   *   conversation: { on(listener: (ev: object) => void): (Function|{dispose(): void}), send(text: string, extra?: object): unknown,
   *     abort(): unknown, setModel(model: object): unknown, options?(): object[], setOption?(id: string, value: string): unknown,
   *     commands?(): object[], attachments?(): object, respondQuestion?(requestId: string, answer: object): unknown,
   *     checkBackground?(): unknown, id?: string },
   *   listModels: () => Promise<object[]>,
   *   respond: (requestId: string, decision: string) => unknown,
   *   history?: object[],
   *   model?: object,
   *   modelInfo?: (providerId: string, modelId: string) => object | null,
   *   onDidChangeState?: (head: object) => void,
   *   findFiles?: (query: string) => Promise<Array<{ path: string, rel: string, name: string }>>,
   *   selection?: { describe(): ({ label: string } | null), current(): object | null, onDidChange(fn: () => void): { dispose(): void } },
   *   planBar?: { summary(): (object | null), onDidChange(fn: (summary: object | null) => void): { dispose(): void }, open(part: string): unknown },
   *   onTimeZone?: (zone: string) => void,
   *   rewind?: (target: { itemId: string, messageId: string, text: string, ordinal: number }) => unknown,
   *   info?: () => (Array<{ label: string, value: string }> | Promise<Array<{ label: string, value: string }>>),
   *   sound?: { on(): boolean, set(on: boolean): unknown },
   *   loadImage?: (src: string) => Promise<{ ok: true, dataUrl: string } | { ok: false, reason: string }>,
   *   links?: { current(): { rev: number, list: object[] }, onDidChange(fn: () => void): { dispose(): void }, open(sourceId: string, sessionId: string): unknown },
   *   vscode?: object,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    const vscode = opts.vscode || require('vscode');
    this.vscode = vscode;
    this.panel = opts.panel;
    this.conversation = opts.conversation;
    this.listModels = opts.listModels;
    this.respond = opts.respond;
    this.onDidChangeState = opts.onDidChangeState || null;
    this.now = opts.now || Date.now;
    this.extensionUri = opts.extensionUri;
    this.models = null;
    this.modelsError = '';
    this.loadingModels = null;
    this.ready = false;
    this.posted = null;
    this.timer = null;
    this.disposed = false;
    this.lastKey = '';
    this.options = this.readOptions();
    this.commands = this.read('commands', []);
    this.findFiles = typeof opts.findFiles === 'function' ? opts.findFiles : null;
    this.selection = opts.selection || null;
    this.planBar = opts.planBar || null;
    this.onTimeZone = typeof opts.onTimeZone === 'function' ? opts.onTimeZone : null;
    this.rewind = typeof opts.rewind === 'function' ? opts.rewind : null;
    this.info = typeof opts.info === 'function' ? opts.info : null;
    this.sound = opts.sound && typeof opts.sound.on === 'function' ? opts.sound : null;
    this.loadImage = typeof opts.loadImage === 'function' ? opts.loadImage : null;
    this.links = opts.links && typeof opts.links.current === 'function' ? opts.links : null;
    this.beforeSend = typeof opts.beforeSend === 'function' ? opts.beforeSend : null;
    this.view = opts.view && typeof opts.view.focus === 'function' ? opts.view : null;
    this.connectProvider = typeof opts.connectProvider === 'function' ? opts.connectProvider : null;
    this.visibleModels = typeof opts.visibleModels === 'function' ? opts.visibleModels : null;
    this.composer = typeof opts.composer === 'function' ? opts.composer : null;
    this.permissionMode = opts.permissionMode && typeof opts.permissionMode.get === 'function' ? opts.permissionMode : null;
    this.forkFrom = typeof opts.forkFrom === 'function' ? opts.forkFrom : null;
    this.detached = typeof opts.detached === 'function' ? opts.detached : null;
    this.readRange = typeof opts.readRange === 'function' ? opts.readRange : null;
    /* Messages for the page held until it has loaded: compose, prefill and focus. */
    this.waiting = [];
    this.prefills = new Map();
    this.prefillSeq = 0;
    this.detachedTimer = null;

    let state = Array.isArray(opts.history) ? vm.fromRecords(opts.history, { modelInfo: opts.modelInfo }) : vm.initialState();
    if (opts.model) state = vm.reduce(state, { type: 'ui.model', model: opts.model });
    this.state = state;

    const webview = this.panel.webview;
    const mdDir = vscode.Uri.joinPath(this.extensionUri, ...MARKDOWN_IT);
    const iconDir = vscode.Uri.joinPath(this.extensionUri, ...CODICONS);
    const hlDir = vscode.Uri.joinPath(this.extensionUri, ...HIGHLIGHT);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), mdDir, iconDir, hlDir],
    };
    webview.html = this.html(webview, mdDir, iconDir, hlDir);

    acquireDiffProvider(vscode);
    diffKeyVscode = vscode;
    this.subs = [
      subscribe(this.conversation, (ev) => this.dispatch(ev)),
      toOff(webview.onDidReceiveMessage((msg) => this.onMessage(msg))),
      toOff(this.panel.onDidChangeViewState(() => {
        if (this.panel.visible) this.schedule();
      })),
      toOff(this.panel.onDidDispose(() => this.dispose())),
    ];
    if (this.selection) this.subs.push(toOff(this.selection.onDidChange(() => { if (this.ready) this.postSelection(); })));
    if (this.planBar) this.subs.push(toOff(this.planBar.onDidChange((summary) => { if (this.ready) this.post({ type: 'planBar', summary: summary || null }); })));
    if (this.links) this.subs.push(toOff(this.links.onDidChange(() => { if (this.ready) this.postConversations(); })));
    if (this.permissionMode && typeof this.permissionMode.onDidChange === 'function') {
      this.subs.push(toOff(this.permissionMode.onDidChange(() => { if (this.ready) this.postPermissionMode(); })));
    }
  }

  html(webview, mdDir, iconDir, hlDir) {
    const media = (name) => webview.asWebviewUri(this.vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const mdFile = path.join(mdDir.fsPath || '', 'markdown-it.umd.min.js');
    const md = mdDir.fsPath && fs.existsSync(mdFile)
      ? `<script src="${webview.asWebviewUri(this.vscode.Uri.joinPath(mdDir, 'markdown-it.umd.min.js'))}"></script>`
      : '';
    const hl = hlDir && hlDir.fsPath && fs.existsSync(path.join(hlDir.fsPath, 'highlight.min.js'))
      ? `<script src="${webview.asWebviewUri(this.vscode.Uri.joinPath(hlDir, 'highlight.min.js'))}"></script>\n`
      : '';
    const icons = iconDir && iconDir.fsPath && fs.existsSync(path.join(iconDir.fsPath, 'codicon.css'))
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(this.vscode.Uri.joinPath(iconDir, 'codicon.css'))}">\n`
      : '';
    const src = webview.cspSource;
    const icon = (name) => `<i class="codicon codicon-${name}" aria-hidden="true"></i>`;
    /* The rail's glyphs are SVG drawn here so they look the same on every system: a bar with a triangle for the two
       ends, a small triangle for one message, a chevron on the handle. */
    const glyph = (body, size = 13) => `<svg class="rail-glyph" width="${size}" height="${size}" viewBox="0 0 10 10" aria-hidden="true">${body}</svg>`;
    const bar = (y) => `<path d="M1.6 ${y}h6.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>`;
    const tri = (d) => `<path d="${d}" fill="currentColor"/>`;
    const chevron = (d) => `<path d="${d}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    /* Each svg carries its own size and fill: drawn before chat.css applies, one without them fills the page's
       width with a black disc. */
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data:; style-src ${src} 'unsafe-inline'; font-src ${src}; script-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${icons}<link rel="stylesheet" href="${media('chat.css')}">
</head>
<body>
<header id="top">
  <div id="title"></div>
</header>
<div id="middle">
<main id="log" aria-live="polite"></main>
<div id="welcome" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M16 10V18H8V10H16Z" fill="currentColor" fill-opacity="0.35"/><path fill-rule="evenodd" clip-rule="evenodd" d="M20 22H4V2H20V22ZM16 6H8V18H16V6Z" fill="currentColor"/></svg><p>Ask OpenCode about this project, or tell it what to change.</p></div>
<div id="rail" hidden>
  <button id="railTop" class="rail-btn" type="button" title="To the first message">${glyph(bar(1.6) + tri('M2.1 7.6h5.8L5 3.6z'))}</button>
  <button id="railPrev" class="rail-btn" type="button" title="To the message before">${glyph(tri('M1.6 7.4h6.8L5 2.6z'))}</button>
  <button id="navBtn" class="rail-btn toggle" type="button" aria-pressed="false" hidden>${glyph(chevron('M6.2 2.2L3.4 5l2.8 2.8'), 16)}${glyph(chevron('M3.8 2.2L6.6 5 3.8 7.8'), 16)}</button>
  <button id="railNext" class="rail-btn" type="button" title="To the message after">${glyph(tri('M1.6 2.6h6.8L5 7.4z'))}</button>
  <button id="railBottom" class="rail-btn" type="button" title="To the end">${glyph(bar(8.4) + tri('M2.1 2.4h5.8L5 6.4z'))}</button>
</div>
<nav id="outline" aria-label="Your messages" hidden><input class="outline-filter" type="text" placeholder="Filter your messages" aria-label="Filter your messages"><div class="outline-list"></div></nav>
</div>
<footer id="bottom">
  <div id="status" hidden></div>
  <div id="dock">
    <div id="infoBox" role="dialog" hidden></div>
    <div id="queued"></div>
    <div id="note" hidden></div>
    <div id="menu" role="listbox" hidden></div>
    <div id="modelMenu" role="dialog" aria-label="Models" hidden><input class="model-filter" type="text" placeholder="Filter models" aria-label="Filter models"><div class="model-actions"></div><div class="model-list" role="listbox"></div></div>
    <form id="composer">
      <div id="attachments"></div>
      <textarea id="input" rows="1" placeholder="Ask OpenCode…"></textarea>
      <div id="tools">
        <button id="attach" class="tool-btn" type="button" title="Add images" hidden>${icon('add')}</button>
        <input id="attachFile" type="file" accept="image/*" multiple hidden>
        <button id="slashBtn" class="tool-btn slash" type="button" title="Commands (/)" hidden><span>/</span></button>
        <span id="ring" class="ring tool-btn"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6" fill="none"></circle><circle class="fill" cx="8" cy="8" r="6" fill="none"></circle></svg></span>
        <details id="background" class="pill" hidden><summary></summary><div class="bg-list"></div></details>
        <span class="pill model-pill"><button id="model" type="button" title="Model" aria-haspopup="listbox" aria-expanded="false">Loading models…</button><select id="effort" class="option" hidden></select></span>
        <span id="ctxPill" class="pill ctx-pill" hidden><button id="addSelection" type="button" hidden></button><button id="ctxDrop" class="ctx-drop" type="button" title="Do not send this with the message" aria-label="Do not send this with the message" hidden>×</button></span>
        <span class="spacer"></span>
        <button id="infoBtn" class="tool-btn" type="button" title="About this conversation" hidden>&#8505;</button>
        <button id="subBtn" class="pill toggle" type="button" aria-pressed="false" hidden>Subagents</button>
        <button id="sound" class="tool-btn" type="button" hidden></button>
        <label class="mode-pick">${icon('robot')}<select id="mode" class="option" hidden></select></label>
        <button id="stop" class="send-btn" type="button" title="Stop (Esc)" aria-label="Stop" hidden><span class="stop-mark" aria-hidden="true"></span></button>
        <button id="send" class="send-btn" type="submit" title="Send (Enter)" aria-label="Send">${icon('arrow-up')}</button>
      </div>
    </form>
  </div>
</footer>
${md}
${hl}<script src="${media('kit.js')}"></script>
<script src="${media('composer.js')}"></script>
<script src="${media('plan-bar.js')}"></script>
<script src="${media('chat.js')}"></script>
</body>
</html>`;
  }

  /* Applies one AgentEvent or ui.* action and schedules a post. */
  dispatch(ev) {
    if (this.disposed) return;
    if (ev && ev.type === 'options') {
      this.options = Array.isArray(ev.options) ? ev.options : [];
      if (this.ready) this.postOptions();
      return;
    }
    if (ev && ev.type === 'commands') {
      this.commands = Array.isArray(ev.commands) ? ev.commands : [];
      if (this.ready) this.postCommands();
      return;
    }
    this.state = vm.reduce(this.state, ev, this.now());
    if (ev && (ev.type === 'permissionSettled' || ev.type === 'turnEnd')) forgetDiffs(this, ev.type === 'turnEnd' ? undefined : ev.requestId);
    if (ev && (ev.type === 'turnStart' || ev.type === 'turnEnd')) this.lookForDetached(ev.type === 'turnStart' ? 3000 : 500);
    const key = `${this.state.status}\n${this.state.title}`;
    if (this.onDidChangeState && key !== this.lastKey) {
      this.lastKey = key;
      try {
        this.onDidChangeState(vm.head(this.state));
      } catch (e) { /* the caller's listener must not break the panel */ }
    }
    this.schedule();
  }

  schedule() {
    if (!this.ready || !this.panel.visible || this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
  }

  flush() {
    if (!this.ready || !this.panel.visible || this.disposed) return;
    const items = vm.changedItems(this.posted, this.state);
    this.posted = this.state;
    this.post({ type: 'update', items, head: vm.head(this.state) });
  }

  /* `now` lets the page correct for a clock that differs from the extension host's, as over Remote-SSH. */
  post(msg) {
    if (this.disposed) return;
    Promise.resolve(this.panel.webview.postMessage({ ...msg, now: this.now() })).catch(() => {});
  }

  /* Shows the view of another page of the same conversation. The pages can share the state because a view's state is
     replaced, never changed in place. */
  adopt(state) {
    if (this.disposed || !state) return;
    this.state = state;
    if (this.ready) this.sendReset();
  }

  /* After a rewind: rebuilds the view from `events`, sends it whole, and offers `draft` for the input. */
  replaceHistory(events, draft) {
    if (this.disposed) return;
    const model = this.state.model;
    let state = vm.initialState();
    if (model) state = vm.reduce(state, { type: 'ui.model', model });
    for (const ev of Array.isArray(events) ? events : []) state = vm.reduce(state, ev, this.now());
    this.state = state;
    forgetDiffs(this);
    if (this.ready) this.sendReset();
    if (typeof draft === 'string' && draft) this.post({ type: 'draft', text: draft });
  }

  sendReset() {
    this.posted = this.state;
    this.post({ type: 'reset', ...vm.toView(this.state) });
    this.postSound();
    this.postOptions();
    this.postCommands();
    this.postCaps();
    this.postSelection();
    this.postPlanBar();
    this.postConversations();
    this.postView();
    this.postComposer();
    this.postPermissionMode();
    if (this.models || this.modelsError) this.postModels();
    else this.loadModels();
    this.lookForDetached(0);
    for (const m of this.waiting.splice(0)) this.post(m);
  }

  postComposer() {
    let c = {};
    try { c = this.composer ? this.composer() || {} : {}; } catch (_) { c = {}; }
    this.post({ type: 'composer', ctrlEnter: c.ctrlEnter === true, attachFile: c.attachFile !== false, attachSelection: c.attachSelection !== false });
  }

  /* Called when a message box setting changes: sends the page the new settings and selection. */
  settingsChanged() {
    if (!this.ready || this.disposed) return;
    this.postComposer();
    this.postSelection();
  }

  postPermissionMode() {
    let auto = false;
    try { auto = this.permissionMode ? this.permissionMode.get() === true : false; } catch (_) { auto = false; }
    this.post({ type: 'permissionMode', shown: !!this.permissionMode, auto });
  }

  /* `payload` is { refs?: [{ token, path, name, rel, startLine?, endLine? }], draft?: string }. */
  compose(payload) {
    if (this.disposed || !payload) return;
    const refs = (Array.isArray(payload.refs) ? payload.refs : []).filter((r) => r && typeof r.token === 'string' && typeof r.path === 'string' && path.isAbsolute(r.path))
      .slice(0, MAX_FILES).map((r) => ({ token: r.token, path: r.path, name: String(r.name || path.basename(r.path)), rel: String(r.rel || r.path),
        ...(Number(r.startLine) > 0 ? { startLine: Number(r.startLine), endLine: Number(r.endLine) || Number(r.startLine) } : {}) }));
    const msg = { type: 'compose', refs, draft: typeof payload.draft === 'string' ? payload.draft : '' };
    if (this.ready) this.post(msg); else this.waiting.push(msg);
  }

  prefill(text, ms) {
    if (this.disposed || typeof text !== 'string' || !text) return Promise.resolve(false);
    const id = `p${++this.prefillSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.prefills.delete(id); resolve(null); }, Math.max(0, ms));
      this.prefills.set(id, (ok) => { clearTimeout(timer); this.prefills.delete(id); resolve(ok === true); });
      const msg = { type: 'prefill', id, text };
      if (this.ready) this.post(msg); else this.waiting.push(msg);
    });
  }

  /* The text in the page's message box, or '' when the page gives none within `ms`. */
  draftText(ms) {
    if (this.disposed || !this.ready) return Promise.resolve('');
    const id = `d${++this.prefillSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.prefills.delete(id); resolve(''); }, Math.max(0, ms));
      this.prefills.set(id, (text) => { clearTimeout(timer); this.prefills.delete(id); resolve(typeof text === 'string' ? text : ''); });
      this.post({ type: 'draftText', id });
    });
  }

  focusInput() {
    if (this.disposed) return;
    if (this.ready) this.post({ type: 'focus' }); else this.waiting.push({ type: 'focus' });
  }

  /* Looks for detached commands `ms` from now, once. */
  lookForDetached(ms) {
    if (!this.detached || this.disposed) return;
    if (this.detachedTimer) clearTimeout(this.detachedTimer);
    this.detachedTimer = setTimeout(() => {
      this.detachedTimer = null;
      Promise.resolve().then(() => this.detached()).then((list) => {
        if (this.ready) this.post({ type: 'detached', list: (Array.isArray(list) ? list : []).filter((d) => d && Number(d.pid) > 0)
          .map((d) => ({ pid: Number(d.pid), command: String(d.command || ''), startedAt: Number(d.startedAt) || 0 })) });
      }, () => {});
    }, ms);
    if (typeof this.detachedTimer.unref === 'function') this.detachedTimer.unref();
  }

  readOptions() {
    try {
      const list = typeof this.conversation.options === 'function' ? this.conversation.options() : [];
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  postOptions() {
    this.post({ type: 'options', options: this.options });
  }

  /* Calls the conversation's optional method `name`; `fallback` if it is missing, throws or returns null. */
  read(name, fallback) {
    try {
      const v = typeof this.conversation[name] === 'function' ? this.conversation[name]() : fallback;
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }

  postCommands() {
    this.post({ type: 'commands', commands: Array.isArray(this.commands) ? this.commands : [] });
  }

  postCaps() {
    const a = this.read('attachments', {});
    this.post({ type: 'caps', images: a.images === true, files: a.files === true && !!this.findFiles, selection: a.selection === true && !!this.selection,
      rewind: !!this.rewind, info: !!this.info, replyImages: !!this.loadImage, connect: !!this.connectProvider, forkFrom: !!this.forkFrom,
      detached: !!this.detached });
  }

  /* Lists the models again, as is done after a provider is connected; the page then shows the new list. */
  reloadModels() {
    if (this.disposed) return;
    this.models = null;
    this.modelsError = '';
    if (this.ready) this.loadModels();
  }

  postSound() {
    let on = false;
    try { on = this.sound ? this.sound.on() === true : false; } catch (_) { on = false; }
    this.post({ type: 'sound', shown: !!this.sound, on });
  }

  /* Finds the user message `itemId` and its 0-based position among the user's messages, or returns null. */
  userItem(itemId) {
    let ordinal = -1;
    for (const it of this.state.items) {
      if (it.kind !== 'user') continue;
      ordinal += 1;
      if (it.id === itemId) return { item: it, ordinal };
    }
    return null;
  }

  /* The selection the page's button adds, and what goes with a message automatically: { selection, file }
     (selection.js context()). */
  postSelection() {
    let label = '';
    try { const d = this.selection && this.selection.describe(); label = d && d.label ? String(d.label) : ''; } catch (_) { /* none */ }
    let context = { selection: null, file: null };
    try { if (this.selection && typeof this.selection.context === 'function') context = this.selection.context() || context; } catch (_) { /* none */ }
    const pick = (x) => (x ? { path: String(x.path), name: String(x.name), label: String(x.label), key: String(x.key) } : null);
    this.post({ type: 'selection', label, context: { selection: pick(context.selection), file: pick(context.file) } });
  }

  /* Posts the conversations a reply may link to, with this one as `self` so the page can leave it out. */
  postConversations() {
    if (!this.links) return;
    let got = null;
    try { got = this.links.current(); } catch (_) { got = null; }
    const id = typeof this.conversation.id === 'string' ? this.conversation.id : '';
    this.post({ type: 'conversations', rev: got && Number(got.rev) || 0, list: got && Array.isArray(got.list) ? got.list : [], self: { sourceId: SOURCE_ID, sessionId: id } });
  }

  postView() {
    let focus = false;
    let pin = true;
    try {
      focus = this.view ? this.view.focus() === true : false;
      pin = this.view && typeof this.view.pin === 'function' ? this.view.pin() !== false : true;
    } catch (_) { /* the defaults */ }
    this.post({ type: 'view', focus, pin, toggle: !!(this.view && typeof this.view.setFocus === 'function') });
  }

  /* Folders a relative path in a reply is resolved against: the workspace folders and the conversation's own folder. */
  fileRoots() {
    const out = [];
    for (const f of (this.vscode.workspace && this.vscode.workspace.workspaceFolders) || []) if (f && f.uri && f.uri.scheme === 'file') out.push(f.uri.fsPath);
    const cwd = this.conversation && typeof this.conversation.cwd === 'string' ? this.conversation.cwd : '';
    if (cwd && path.isAbsolute(cwd) && !out.includes(cwd)) out.push(cwd);
    return out;
  }

  /* The absolute path of the file `ref` names, or ''. */
  async resolveFile(ref, fresh) {
    const roots = this.fileRoots();
    const key = `${roots.join('\0')}\0${ref}`;
    const now = Date.now();
    const got = FILE_CACHE.get(key);
    if (!fresh && got && now - got.at < (got.file ? FILE_OK_MS : FILE_MISS_MS)) return got.file;
    const file = await findFile(ref, roots);
    FILE_CACHE.delete(key);
    FILE_CACHE.set(key, { file, at: now });
    while (FILE_CACHE.size > 2000) FILE_CACHE.delete(FILE_CACHE.keys().next().value);
    return file;
  }

  checkPaths(list, fresh) {
    const refs = [...new Set((Array.isArray(list) ? list : []).map(fileRef).filter(Boolean))].slice(0, MAX_PATHS);
    if (!refs.length) return Promise.resolve();
    const again = new Set(Array.isArray(fresh) ? fresh : []);
    return Promise.all(refs.map((r) => this.resolveFile(r, again.has(r)).then((file) => ({ path: r, ok: !!file }), () => ({ path: r, ok: false }))))
      .then((results) => this.post({ type: 'paths', results }));
  }

  async openFile(ref, line, col) {
    const file = ref ? await this.resolveFile(ref, true) : '';
    if (!file) { this.post({ type: 'paths', results: [{ path: ref, ok: false }] }); throw new Error(`${ref || 'That file'} is not there any more.`); }
    const { Uri, Range, ViewColumn, commands } = this.vscode;
    const options = { preview: true };
    if (ViewColumn) options.viewColumn = ViewColumn.Beside;
    if (line > 0 && typeof Range === 'function') {
      const c = col > 0 ? col - 1 : 0;
      options.selection = new Range(line - 1, c, line - 1, c);
    }
    await commands.executeCommand('vscode.open', Uri.file(file), options);
  }

  postPlanBar() {
    let summary = null;
    try { summary = this.planBar ? this.planBar.summary() || null : null; } catch (_) { summary = null; }
    this.post({ type: 'planBar', summary });
  }

  /* Builds send()'s `extra` (contracts.js) from the page's images, @-files and selections, dropping malformed and
     duplicate entries and anything over the limits. */
  extraOf(msg) {
    const images = (Array.isArray(msg.images) ? msg.images : []).filter((i) => i && typeof i.data === 'string' && /^image\/[\w.+-]+$/.test(String(i.mediaType || ''))
      && Math.floor(i.data.length * 3 / 4) <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES).map((i) => ({ mediaType: i.mediaType, data: i.data, name: String(i.name || 'image') }));
    const files = [];
    for (const f of Array.isArray(msg.files) ? msg.files : []) {
      if (f && typeof f.path === 'string' && path.isAbsolute(f.path) && !files.some((x) => x.path === f.path && x.text === undefined)) files.push({ path: f.path, name: String(f.name || path.basename(f.path)) });
    }
    for (const f of Array.isArray(msg.selections) ? msg.selections : []) {
      if (f && typeof f.path === 'string' && path.isAbsolute(f.path) && typeof f.text === 'string') {
        files.push({ path: f.path, name: String(f.name || path.basename(f.path)), text: f.text, startLine: Number(f.startLine) || 0, endLine: Number(f.endLine) || 0 });
      }
    }
    for (const f of Array.isArray(msg.ranges) ? msg.ranges : []) {
      if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path) || !(Number(f.startLine) > 0) || !this.readRange) continue;
      const from = Math.floor(Number(f.startLine));
      const to = Math.max(from, Math.floor(Number(f.endLine) || from));
      if (files.some((x) => x.path === f.path && x.startLine === from && x.endLine === to)) continue;
      let text = null;
      try { text = this.readRange(f.path, from, to); } catch (_) { text = null; }
      if (typeof text === 'string') files.push({ path: f.path, name: String(f.name || path.basename(f.path)), text, startLine: from, endLine: to });
      else if (!files.some((x) => x.path === f.path && x.text === undefined)) files.push({ path: f.path, name: String(f.name || path.basename(f.path)) });
    }
    this.addContext(msg.context, files);
    const out = {};
    if (images.length) out.images = images;
    if (files.length) out.files = files.slice(0, MAX_FILES);
    return out;
  }

  /* The editor item ({ kind, key }) the page showed as going with the message, if the editor still has it. */
  addContext(want, files) {
    if (!want || typeof want.key !== 'string' || !this.selection) return;
    let ctx = null;
    try { ctx = typeof this.selection.context === 'function' ? this.selection.context() : null; } catch (_) { ctx = null; }
    if (!ctx) return;
    if (want.kind === 'selection' && ctx.selection && ctx.selection.key === want.key) {
      let item = null;
      try { item = this.selection.current(); } catch (_) { item = null; }
      if (item && !files.some((x) => x.path === item.path && x.startLine === item.startLine && x.endLine === item.endLine && x.text !== undefined)) {
        files.push({ path: item.path, name: item.name, text: item.text, startLine: item.startLine, endLine: item.endLine });
      }
    } else if (want.kind === 'file' && ctx.file && ctx.file.key === want.key && !files.some((x) => x.path === ctx.file.path && x.text === undefined)) {
      files.push({ path: ctx.file.path, name: ctx.file.name });
    }
  }

  answerQuestion(msg) {
    const requestId = String(msg.requestId || '');
    const item = [...this.state.items].reverse().find((it) => it.kind === 'question' && it.requestId === requestId);
    if (!item || item.decision || typeof this.conversation.respondQuestion !== 'function') return;
    let answer = { action: 'cancel' };
    if (msg.action === 'accept') {
      const { content, errors } = vm.formContent(item.fields, msg.values);
      if (errors.length) { this.post({ type: 'questionErrors', requestId, errors }); return; }
      answer = { action: 'accept', content };
    }
    Promise.resolve().then(() => this.conversation.respondQuestion(requestId, answer)).then((ok) => {
      if (ok === false) this.post({ type: 'questionErrors', requestId, errors: ['The question is no longer open.'] });
    }, (err) => this.showError(err));
  }

  loadModels() {
    if (this.loadingModels) return this.loadingModels;
    this.loadingModels = Promise.resolve()
      .then(() => this.listModels())
      .then((list) => {
        this.models = Array.isArray(list) ? list : [];
        this.modelsError = '';
      }, (err) => {
        this.models = null;
        this.modelsError = (err && err.message) || String(err);
      })
      .then(() => {
        this.loadingModels = null;
        this.postModels();
      });
    return this.loadingModels;
  }

  postModels() {
    const current = this.state.model ? this.state.model.id : '';
    let shown = this.models || [];
    try { if (this.visibleModels) shown = this.visibleModels(shown, current); } catch (_) { /* all of them */ }
    this.post({ type: 'models', models: shown.map(modelForPage), current, error: this.modelsError });
  }

  onMessage(msg) {
    if (!msg || typeof msg.type !== 'string' || this.disposed) return;
    switch (msg.type) {
      case 'draftText': {
        const done = typeof msg.id === 'string' ? this.prefills.get(msg.id) : null;
        if (done) done(msg.text);
        break;
      }
      case 'prefilled': {
        const done = typeof msg.id === 'string' ? this.prefills.get(msg.id) : null;
        if (done) done(msg.ok === true);
        break;
      }
      case 'ready':
        this.ready = true;
        /* The page runs on the user's machine, so this is the user's time zone even over Remote-SSH. */
        if (this.onTimeZone && typeof msg.tz === 'string' && msg.tz.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(msg.tz)) {
          try { this.onTimeZone(msg.tz); } catch (_) { /* the caller's */ }
        }
        this.sendReset();
        break;
      case 'send': {
        const text = String(msg.text || '');
        const extra = this.extraOf(msg);
        /* Without text, a message goes when the user attached something to it: images or a selection added with its
           button. The file or selection the editor offers on its own does not count. */
        const attached = (extra.images && extra.images.length) || (Array.isArray(msg.selections) && msg.selections.length);
        if (!text.trim() && !attached) break;
        if (this.state.status !== 'idle') {
          this.dispatch({ type: 'ui.queued', text, images: (extra.images || []).length, selections: Array.isArray(msg.selections) ? msg.selections.length : 0 });
        }
        Promise.resolve().then(() => (this.beforeSend ? this.beforeSend() : undefined)).catch(() => {})
          .then(() => (Object.keys(extra).length ? this.conversation.send(text, extra) : this.conversation.send(text))).catch((err) => this.showError(err));
        break;
      }
      case 'question':
        this.answerQuestion(msg);
        break;
      case 'rewind': {
        const found = this.rewind && this.userItem(String(msg.itemId || ''));
        if (!found) break;
        if (this.state.status !== 'idle') { this.showError(new Error('Stop the turn or wait for it to end before rewinding.')); break; }
        Promise.resolve().then(() => this.rewind({ itemId: found.item.id, messageId: found.item.messageId || '', text: found.item.text, ordinal: found.ordinal }))
          .catch((err) => this.showError(err));
        break;
      }
      case 'info':
        if (!this.info) break;
        Promise.resolve().then(() => this.info()).then(
          (rows) => this.post({ type: 'info', rows: (Array.isArray(rows) ? rows : []).filter((r) => r && r.label).map((r) => ({ label: String(r.label), value: String(r.value == null ? '' : r.value) })) }),
          (err) => this.post({ type: 'info', rows: [], error: (err && err.message) || String(err) }));
        break;
      case 'setSound':
        if (this.sound) Promise.resolve().then(() => this.sound.set(msg.on === true)).catch(() => {});
        break;
      case 'image': {
        const id = String(msg.id || '').slice(0, 40);
        const src = String(msg.src || '').slice(0, 4096);
        if (!id || !this.loadImage) break;
        Promise.resolve().then(() => this.loadImage(src)).then(
          (r) => this.post(r && r.ok ? { type: 'image', id, ok: true, dataUrl: r.dataUrl } : { type: 'image', id, ok: false, reason: (r && r.reason) || 'The image could not be read.' }),
          (err) => this.post({ type: 'image', id, ok: false, reason: (err && err.message) || String(err) }));
        break;
      }
      case 'openConversation': {
        const sourceId = String(msg.sourceId || '').slice(0, 80);
        const sessionId = String(msg.sessionId || '').slice(0, 200);
        if (!this.links || !sourceId || !sessionId) break;
        Promise.resolve().then(() => this.links.open(sourceId, sessionId)).catch((err) => this.showError(err));
        break;
      }
      case 'checkPaths':
        this.checkPaths(msg.paths, msg.fresh).catch(() => {});
        break;
      case 'openFile': {
        const line = Math.floor(Number(msg.line)) || 0;
        const col = Math.floor(Number(msg.col)) || 0;
        this.openFile(fileRef(msg.path), line, col).catch((err) => this.showError(err));
        break;
      }
      case 'setFocusView':
        if (this.view && typeof this.view.setFocus === 'function') Promise.resolve().then(() => this.view.setFocus(msg.on === true)).catch((err) => this.showError(err));
        break;
      case 'background':
        Promise.resolve().then(() => (typeof this.conversation.checkBackground === 'function' ? this.conversation.checkBackground() : undefined)).catch(() => {});
        this.lookForDetached(0);
        break;
      case 'setPermissionMode':
        this.setPermissionMode(String(msg.mode || ''));
        break;
      case 'forkFrom': {
        const found = this.forkFrom && this.userItem(String(msg.itemId || ''));
        if (!found) break;
        if (this.state.status !== 'idle') { this.showError(new Error('Stop the turn or wait for it to end before forking.')); break; }
        Promise.resolve().then(() => this.forkFrom({ itemId: found.item.id, messageId: found.item.messageId || '', text: found.item.text, ordinal: found.ordinal }))
          .catch((err) => this.showError(err));
        break;
      }
      case 'findFiles': {
        const seq = Number(msg.seq) || 0;
        const query = String(msg.query || '').slice(0, 200);
        if (!this.findFiles) { this.post({ type: 'files', seq, query, items: [] }); break; }
        Promise.resolve().then(() => this.findFiles(query)).then(
          (items) => this.post({ type: 'files', seq, query, items: Array.isArray(items) ? items : [] }),
          (err) => this.post({ type: 'files', seq, query, items: [], error: (err && err.message) || String(err) }));
        break;
      }
      case 'addSelection': {
        let item = null;
        try { item = this.selection ? this.selection.current() : null; } catch (_) { item = null; }
        if (item) this.post({ type: 'selectionAdded', item });
        else this.postSelection();
        break;
      }
      case 'abort':
        Promise.resolve().then(() => this.conversation.abort()).catch((err) => this.showError(err));
        break;
      case 'planBarOpen':
        if (this.planBar) Promise.resolve().then(() => this.planBar.open(msg.part === 'answer' ? 'answer' : 'plan')).catch((err) => this.showError(err));
        break;
      case 'permission':
        if (PERMISSION_DECISIONS.includes(msg.decision) && msg.requestId) {
          Promise.resolve().then(() => this.respond(String(msg.requestId), msg.decision)).catch((err) => this.showError(err));
        }
        break;
      case 'viewDiff':
        this.openDiff(String(msg.requestId || '')).catch((err) => this.showError(err));
        break;
      case 'setModel': {
        const model = (this.models || []).find((m) => m.id === msg.id);
        if (!model) break;
        Promise.resolve().then(() => this.conversation.setModel(model)).then(
          () => this.dispatch({ type: 'ui.model', model }),
          (err) => {
            this.showError(err);
            this.postModels();
          });
        break;
      }
      case 'setOption': {
        const id = String(msg.id || '');
        const value = String(msg.value || '');
        const opt = this.options.find((o) => o && o.id === id);
        if (!opt || !Array.isArray(opt.values) || !opt.values.some((v) => v && v.value === value)) break;
        Promise.resolve().then(() => this.conversation.setOption(id, value)).then(
          () => { this.options = this.readOptions(); this.postOptions(); },
          (err) => { this.showError(err); this.options = this.readOptions(); this.postOptions(); });
        break;
      }
      case 'reloadModels':
        this.models = null;
        this.modelsError = '';
        this.loadModels();
        break;
      case 'connectProvider':
        if (this.connectProvider) Promise.resolve().then(() => this.connectProvider()).catch((err) => this.showError(err));
        break;
      case 'copy':
        Promise.resolve(this.vscode.env.clipboard.writeText(String(msg.text || ''))).catch(() => {});
        break;
      case 'openLink': {
        const href = String(msg.href || '');
        if (/^https?:\/\//i.test(href)) Promise.resolve(this.vscode.env.openExternal(this.vscode.Uri.parse(href))).catch(() => {});
        break;
      }
      default:
        break;
    }
  }

  /* 'build' is OpenCode's build mode, in which each edit asks first, and 'build:auto' the same mode with edits allowed
     without asking (composer.js permissionModes); any other value selects that OpenCode mode, where edits ask first. */
  setPermissionMode(mode) {
    const pm = this.permissionMode;
    const auto = mode === 'build:auto';
    const modeOpt = this.options.find((o) => o && o.id === 'mode');
    const values = modeOpt && Array.isArray(modeOpt.values) ? modeOpt.values : [];
    const offered = (v) => values.some((x) => x && x.value === v);
    let want = '';
    if (mode === 'build' || mode === 'build:auto') want = offered('build') ? 'build' : '';
    else if (offered(mode)) want = mode;
    else return;
    if (pm && typeof pm.set === 'function') { try { pm.set(auto); } catch (err) { this.showError(err); } }
    const after = () => { this.options = this.readOptions(); this.postOptions(); this.postPermissionMode(); };
    if (!want || (modeOpt && modeOpt.value === want) || typeof this.conversation.setOption !== 'function') { after(); return; }
    Promise.resolve().then(() => this.conversation.setOption('mode', want)).then(after, (err) => { this.showError(err); after(); });
  }

  async openDiff(requestId) {
    const diff = this.state.diffs[requestId];
    if (!diff) return;
    const { Uri, commands } = this.vscode;
    const name = path.basename(diff.path || 'file') || 'file';
    const left = Uri.from({ scheme: DIFF_SCHEME, path: `/${requestId}/before/${name}` });
    const right = Uri.from({ scheme: DIFF_SCHEME, path: `/${requestId}/after/${name}` });
    putDiffDoc(left, diff.before);
    putDiffDoc(right, diff.after);
    if (this.state.pending[requestId]) {
      openDiffs.set(right.path, { panel: this, requestId });
      publishDiffs();
    }
    await commands.executeCommand('vscode.diff', left, right, `${name} (proposed change)`, { preview: true });
  }

  showError(err) {
    const text = (err && err.message) || String(err);
    Promise.resolve(this.vscode.window.showErrorMessage(text)).catch(() => {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.detachedTimer) clearTimeout(this.detachedTimer);
    this.detachedTimer = null;
    this.waiting = [];
    for (const done of [...this.prefills.values()]) done(false);
    for (const off of this.subs) {
      try {
        off();
      } catch (e) { /* already gone */ }
    }
    this.subs = [];
    forgetDiffs(this);
    releaseDiffProvider();
  }
}

function toOff(disposable) {
  return () => disposable && disposable.dispose && disposable.dispose();
}

module.exports = { ChatPanel, DIFF_SCHEME, OPEN_DIFFS_KEY, MAX_IMAGE_BYTES, MAX_IMAGES, answerFromDiff };
