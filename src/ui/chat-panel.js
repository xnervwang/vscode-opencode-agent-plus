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
 *   beforeSend runs before a message goes to the conversation, such as saving edited files; its failure does not stop it
 *
 * The plan bar's fragment brings its own style element, so the page's policy lets inline styles in. A diff opened from
 * a permission card gets Allow once, Allow in this project and Deny in its editor's title bar (see answerFromDiff);
 * its right side's path is listed under the context key opencodeAgentPlus.openDiffs while the request is open.
 */
const path = require('path');
const fs = require('fs');
const vm = require('./view-model');
const { PERMISSION_DECISIONS } = require('../contracts');

const DIFF_SCHEME = 'opencodeAgentPlus-diff';
const OPEN_DIFFS_KEY = 'opencodeAgentPlus.openDiffs';
/* Limits per message. Image bytes are counted after base64 decoding; MAX_FILES covers files and selections together. */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;
const MARKDOWN_IT = ['node_modules', 'markdown-it', 'dist', 'browser'];
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

function modelForPage(m) {
  return { id: m.id, name: m.name || m.id, vendor: m.vendor || '', contextWindow: m.contextWindow || 0 };
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

    let state = Array.isArray(opts.history) ? vm.fromRecords(opts.history, { modelInfo: opts.modelInfo }) : vm.initialState();
    if (opts.model) state = vm.reduce(state, { type: 'ui.model', model: opts.model });
    this.state = state;

    const webview = this.panel.webview;
    const mdDir = vscode.Uri.joinPath(this.extensionUri, ...MARKDOWN_IT);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), mdDir],
    };
    webview.html = this.html(webview, mdDir);

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
  }

  html(webview, mdDir) {
    const media = (name) => webview.asWebviewUri(this.vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const mdFile = path.join(mdDir.fsPath || '', 'markdown-it.umd.min.js');
    const md = mdDir.fsPath && fs.existsSync(mdFile)
      ? `<script src="${webview.asWebviewUri(this.vscode.Uri.joinPath(mdDir, 'markdown-it.umd.min.js'))}"></script>`
      : '';
    const src = webview.cspSource;
    /* The ring's size and fill are on its elements too: without them, a page drawn before chat.css applies shows the
       ring as a black disc as wide as the page. */
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data:; style-src ${src} 'unsafe-inline'; font-src ${src}; script-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('chat.css')}">
</head>
<body>
<header id="top">
  <div id="title"></div>
  <div class="spacer"></div>
  <select id="model" title="Model"><option>Loading models…</option></select>
  <select id="mode" class="option" hidden></select>
  <select id="effort" class="option" hidden></select>
  <span id="ring" class="ring"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6" fill="none"></circle><circle class="fill" cx="8" cy="8" r="6" fill="none"></circle></svg></span>
  <button id="subBtn" class="toggle" type="button" aria-pressed="false" hidden>Subagents</button>
  <button id="navBtn" class="toggle" type="button" aria-pressed="false" hidden>Outline</button>
  <button id="infoBtn" class="icon" type="button" title="About this conversation" hidden>i</button>
</header>
<div id="infoBox" role="dialog" hidden></div>
<div id="middle">
<main id="log" aria-live="polite"></main>
<nav id="outline" aria-label="Your messages" hidden><div class="outline-head">Your messages</div><div class="outline-list"></div></nav>
</div>
<footer id="bottom">
  <details id="background" hidden><summary></summary><div class="bg-list"></div></details>
  <div id="status" hidden></div>
  <div id="queued"></div>
  <div id="menu" role="listbox" hidden></div>
  <div id="attachments"></div>
  <div id="note" hidden></div>
  <form id="composer">
    <textarea id="input" rows="1" placeholder="Ask anything. Enter to send, Shift+Enter for a new line"></textarea>
    <button id="addSelection" class="secondary" type="button" hidden></button>
    <button id="sound" class="icon" type="button" hidden></button>
    <button id="stop" type="button" title="Stop (Esc)" hidden>Stop</button>
    <button id="send" type="submit" title="Send">Send</button>
  </form>
</footer>
${md}
<script src="${media('kit.js')}"></script>
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
    if (this.models || this.modelsError) this.postModels();
    else this.loadModels();
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
      rewind: !!this.rewind, info: !!this.info, replyImages: !!this.loadImage });
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

  postSelection() {
    let label = '';
    try { const d = this.selection && this.selection.describe(); label = d && d.label ? String(d.label) : ''; } catch (_) { /* none */ }
    this.post({ type: 'selection', label });
  }

  /* Posts the conversations a reply may link to, with this one as `self` so the page can leave it out. */
  postConversations() {
    if (!this.links) return;
    let got = null;
    try { got = this.links.current(); } catch (_) { got = null; }
    const id = typeof this.conversation.id === 'string' ? this.conversation.id : '';
    this.post({ type: 'conversations', rev: got && Number(got.rev) || 0, list: got && Array.isArray(got.list) ? got.list : [], self: { sourceId: SOURCE_ID, sessionId: id } });
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
    const out = {};
    if (images.length) out.images = images;
    if (files.length) out.files = files.slice(0, MAX_FILES);
    return out;
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
    this.post({ type: 'models', models: (this.models || []).map(modelForPage), current, error: this.modelsError });
  }

  onMessage(msg) {
    if (!msg || typeof msg.type !== 'string' || this.disposed) return;
    switch (msg.type) {
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
        if (!text.trim()) break;
        const extra = this.extraOf(msg);
        if (this.state.status !== 'idle') this.dispatch({ type: 'ui.queued', text });
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
      case 'background':
        Promise.resolve().then(() => (typeof this.conversation.checkBackground === 'function' ? this.conversation.checkBackground() : undefined)).catch(() => {});
        break;
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
