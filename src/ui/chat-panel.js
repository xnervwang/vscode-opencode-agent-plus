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
 */
const path = require('path');
const fs = require('fs');
const vm = require('./view-model');
const { PERMISSION_DECISIONS } = require('../contracts');

const DIFF_SCHEME = 'newAgent-diff';
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
   *   conversation: { on(listener: (ev: object) => void): (Function|{dispose(): void}), send(text: string): unknown,
   *     abort(): unknown, setModel(model: object): unknown },
   *   listModels: () => Promise<object[]>,
   *   respond: (requestId: string, decision: string) => unknown,
   *   history?: object[],
   *   model?: object,
   *   modelInfo?: (providerId: string, modelId: string) => object | null,
   *   onDidChangeState?: (head: object) => void,
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
  <span id="ring" class="ring"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6"></circle><circle class="fill" cx="8" cy="8" r="6"></circle></svg></span>
</header>
<main id="log" aria-live="polite"></main>
<footer id="bottom">
  <div id="status" hidden></div>
  <div id="queued"></div>
  <form id="composer">
    <textarea id="input" rows="1" placeholder="Ask anything. Enter to send, Shift+Enter for a new line"></textarea>
    <button id="stop" type="button" title="Stop" hidden>Stop</button>
    <button id="send" type="submit" title="Send">Send</button>
  </form>
</footer>
${md}
<script src="${media('chat.js')}"></script>
</body>
</html>`;
  }

  /* Applies one AgentEvent or ui.* action and schedules a post. onDidChangeState hears of status and title changes. */
  dispatch(ev) {
    if (this.disposed) return;
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
    if (this.models || this.modelsError) this.postModels();
    else this.loadModels();
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
        if (this.state.status !== 'idle') this.dispatch({ type: 'ui.queued', text });
        Promise.resolve().then(() => this.conversation.send(text)).catch((err) => this.showError(err));
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

module.exports = { ChatPanel, DIFF_SCHEME };
