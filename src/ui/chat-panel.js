// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One conversation's chat page in a WebviewPanel that the caller already has (a custom editor's resolveCustomEditor
 * or a serializer gives it). This class sets the panel's options and HTML, keeps the view model (src/ui/view-model.js)
 * from the conversation's events, and answers the page. Creating, titling and restoring the panel is the caller's.
 *
 * The panel does not keep its page while hidden; the page asks for the whole view again when it loads ('ready'), and
 * updates are held back while it is hidden. Between loads only the items that changed are posted, at most once per
 * frame.
 *
 * The conversation's settings (its options(): mode, effort) go to the page as they are, in an 'options' message, and
 * again whenever an `options` event says they changed; a conversation without options() shows none. Its slash
 * commands (commands(), `commands` events) and what a message may carry (attachments()) go the same way, as
 * 'commands' and 'caps'. The page asks for workspace files as @ is typed (`findFiles`) and for the editor's selection
 * (`selection`); both are the caller's, and without them the page offers neither.
 */
const path = require('path');
const fs = require('fs');
const vm = require('./view-model');
const { PERMISSION_DECISIONS } = require('../contracts');

const DIFF_SCHEME = 'opencodePlus-diff';
/* What a message may carry: as many images, each of at most this many bytes once decoded. */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;
const MARKDOWN_IT = ['node_modules', 'markdown-it', 'dist', 'browser'];
const FLUSH_MS = 16;

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
   *     commands?(): object[], attachments?(): object, respondQuestion?(requestId: string, answer: object): unknown },
   *   listModels: () => Promise<object[]>,
   *   respond: (requestId: string, decision: string) => unknown,
   *   history?: object[],
   *   model?: object,
   *   modelInfo?: (providerId: string, modelId: string) => object | null,
   *   onDidChangeState?: (head: object) => void,
   *   findFiles?: (query: string) => Promise<Array<{ path: string, rel: string, name: string }>>,
   *   selection?: { describe(): ({ label: string } | null), current(): object | null, onDidChange(fn: () => void): { dispose(): void } },
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
    this.subs = [
      subscribe(this.conversation, (ev) => this.dispatch(ev)),
      toOff(webview.onDidReceiveMessage((msg) => this.onMessage(msg))),
      toOff(this.panel.onDidChangeViewState(() => {
        if (!this.panel.visible) this.ready = false;
      })),
      toOff(this.panel.onDidDispose(() => this.dispose())),
    ];
    if (this.selection) this.subs.push(toOff(this.selection.onDidChange(() => { if (this.ready) this.postSelection(); })));
  }

  html(webview, mdDir) {
    const media = (name) => webview.asWebviewUri(this.vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const mdFile = path.join(mdDir.fsPath || '', 'markdown-it.umd.min.js');
    const md = mdDir.fsPath && fs.existsSync(mdFile)
      ? `<script src="${webview.asWebviewUri(this.vscode.Uri.joinPath(mdDir, 'markdown-it.umd.min.js'))}"></script>`
      : '';
    const src = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data:; style-src ${src}; font-src ${src}; script-src ${src};">
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
  <span id="ring" class="ring"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6"></circle><circle class="fill" cx="8" cy="8" r="6"></circle></svg></span>
</header>
<main id="log" aria-live="polite"></main>
<footer id="bottom">
  <div id="status" hidden></div>
  <div id="queued"></div>
  <div id="menu" role="listbox" hidden></div>
  <div id="attachments"></div>
  <div id="note" hidden></div>
  <form id="composer">
    <textarea id="input" rows="1" placeholder="Ask anything. Enter to send, Shift+Enter for a new line"></textarea>
    <button id="addSelection" class="secondary" type="button" hidden></button>
    <button id="stop" type="button" title="Stop" hidden>Stop</button>
    <button id="send" type="submit" title="Send">Send</button>
  </form>
</footer>
${md}
<script src="${media('composer.js')}"></script>
<script src="${media('chat.js')}"></script>
</body>
</html>`;
  }

  /* Applies one AgentEvent or ui.* action and schedules a post. onDidChangeState hears of status and title changes. */
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
    if (!this.ready || this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
  }

  flush() {
    if (!this.ready || this.disposed) return;
    const items = vm.changedItems(this.posted, this.state);
    this.posted = this.state;
    this.post({ type: 'update', items, head: vm.head(this.state) });
  }

  /* `now` lets the page correct for a clock that differs from the extension host's, as over Remote-SSH. */
  post(msg) {
    if (this.disposed) return;
    Promise.resolve(this.panel.webview.postMessage({ ...msg, now: this.now() })).catch(() => {});
  }

  sendReset() {
    this.posted = this.state;
    this.post({ type: 'reset', ...vm.toView(this.state) });
    this.postOptions();
    this.postCommands();
    this.postCaps();
    this.postSelection();
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

  /* What the conversation's method `name` returns, or `fallback` when it has none or it fails. */
  read(name, fallback) {
    try {
      const v = typeof this.conversation[name] === 'function' ? this.conversation[name]() : fallback;
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }

  postCommands() {
    this.post({ type: 'commands', commands: Array.isArray(this.commands) ? this.commands : [] });
  }

  /* Files need the caller's search; a selection needs the caller's editor tracking. */
  postCaps() {
    const a = this.read('attachments', {});
    this.post({ type: 'caps', images: a.images === true, files: a.files === true && !!this.findFiles, selection: a.selection === true && !!this.selection });
  }

  postSelection() {
    let label = '';
    try { const d = this.selection && this.selection.describe(); label = d && d.label ? String(d.label) : ''; } catch (_) { /* none */ }
    this.post({ type: 'selection', label });
  }

  /* contracts.js send extra from what the page sent: images it pasted, files it picked, selections it added. */
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
        this.sendReset();
        break;
      case 'send': {
        const text = String(msg.text || '');
        if (!text.trim()) break;
        const extra = this.extraOf(msg);
        if (this.state.status !== 'idle') this.dispatch({ type: 'ui.queued', text });
        Promise.resolve().then(() => (Object.keys(extra).length ? this.conversation.send(text, extra) : this.conversation.send(text))).catch((err) => this.showError(err));
        break;
      }
      case 'question':
        this.answerQuestion(msg);
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
    releaseDiffProvider();
  }
}

function toOff(disposable) {
  return () => disposable && disposable.dispose && disposable.dispose();
}

module.exports = { ChatPanel, DIFF_SCHEME, MAX_IMAGE_BYTES, MAX_IMAGES };
