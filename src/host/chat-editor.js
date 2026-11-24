// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page as a read-only custom editor, newAgent.chat, of newagent-session:/<session id>: each conversation has
 * its own URI, so a tab knows its conversation and VS Code reopens the tabs after a reload. There is no
 * file behind the URI; the provider hands each webview panel to the chat panel of src/ui/chat-panel.js.
 */
const vscode = require('vscode');
const { sessionOfUri } = require('./agentplus-source');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const page = (text) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head>
<body><p>${esc(text)}</p></body></html>`;

/*
 * deps:
 *   manager                  src/host/session-manager.js
 *   show(panel, entry)       puts the chat page into `panel` for the open conversation `entry`; returns something with
 *                            dispose(), or nothing
 *   focus(sessionId)         the panel came to the front
 *   busy(sessionId, pid)     another window runs it; tell the user
 *   log(line)                optional
 */
class ChatEditorProvider {
  constructor(deps) { this.deps = deps; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const { manager } = this.deps;
    const id = sessionOfUri(document.uri);
    let gone = false;
    const subs = [];
    subs.push(panel.onDidDispose(() => { gone = true; }));
    if (!id) { panel.webview.html = page('This tab does not name a conversation.'); return; }
    const r = await manager.open(id);
    if (gone) {
      if (r.ok && !manager.panelOf(id)) manager.close(id);
      return;
    }
    if (!r.ok) {
      panel.webview.html = page(r.pid
        ? 'This conversation is open in another window. Close it there to continue it here.'
        : `This conversation could not be opened: ${r.error || 'unknown error'}`);
      if (r.pid && this.deps.busy) { try { this.deps.busy(id, r.pid); } catch (_) { /* told nothing */ } }
      return;
    }
    manager.attach(id, panel);
    let view = null;
    try { view = this.deps.show(panel, r.entry) || null; } catch (e) {
      this.log(`showing ${id} failed: ${(e && e.stack) || e}`);
      panel.webview.html = page(`The chat page could not be shown: ${(e && e.message) || e}`);
    }
    const front = () => {
      if (!panel.active) return;
      manager.seen(id);
      try { this.deps.focus(id); } catch (_) { /* nobody listening */ }
    };
    /* The tab's title, and the page's when the conversation's own events did not bring it there. */
    const retitle = () => {
      const s = manager.snapshot(id);
      if (!s || !s.title || panel.title === s.title) return;
      panel.title = s.title;
      if (view && typeof view.dispatch === 'function' && view.state && view.state.title !== s.title) view.dispatch({ type: 'title', title: s.title });
    };
    retitle();
    subs.push(manager.onDidChange((e) => { if (e && e.sessionId === id) retitle(); }));
    subs.push(panel.onDidChangeViewState(front));
    subs.push(panel.onDidDispose(() => {
      for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
      try { if (view && typeof view.dispose === 'function') view.dispose(); } catch (_) { /* gone */ }
      manager.detach(id, panel);
    }));
    front();
  }

  log(line) { try { if (this.deps.log) this.deps.log(line); } catch (_) { /* not logged */ } }
}

module.exports = { ChatEditorProvider, page };
