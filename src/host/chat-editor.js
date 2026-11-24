// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page as a read-only custom editor, opencodePlus.chat, of opencodeplus-session:/<session id>: each conversation has
 * its own URI, so a tab knows its conversation and VS Code reopens the tabs after a reload. There is no
 * file behind the URI; the provider hands each webview panel to the chat panel of src/ui/chat-panel.js.
 */
const vscode = require('vscode');
const { sessionOfUri } = require('./agentplus-source');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BUSY_PAGE = 'Another VS Code window has this conversation open, or had it open before it lost its connection. '
  + 'Choose "Take over here" in the notification to continue it in this window.';
const TAKING_BACK_PAGE = 'Opening the conversation this window had open before it reloaded…';
const page = (text) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head>
<body><p>${esc(text)}</p></body></html>`;

/*
 * deps:
 *   manager                  src/host/session-manager.js
 *   show(panel, entry)       puts the chat page into `panel` for the open conversation `entry`; returns something with
 *                            dispose(), or nothing
 *   focus(sessionId)         the panel came to the front
 *   busy(sessionId, pid)     another window runs it: offer to take it over; resolves true when this window may now
 *                            open it, and the tab then shows it
 *   ownWindow(sessionId)     optional: the holder is this window's own host from before a reload, which busy takes
 *                            back without asking
 *   label(snapshot)          optional: the tab's title for the conversation's snapshot (its title with an envelope
 *                            while a reply is unread); the title alone otherwise
 *   iconFor(activity)        optional: the tab's icon for 'working', 'waiting' or 'stopped' ({ light, dark } Uris),
 *                            or undefined to leave it
 *   onDidChangeLook(fn)      optional: fires when the label or icon for the same state changes (the colour theme)
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
    let r = await manager.open(id);
    if (!gone && !r.ok && r.pid && this.deps.busy) {
      let own = false;
      try { own = !!(this.deps.ownWindow && this.deps.ownWindow(id)); } catch (_) { own = false; }
      panel.webview.html = page(own ? TAKING_BACK_PAGE : BUSY_PAGE);
      let taken = false;
      try { taken = (await this.deps.busy(id, r.pid)) === true; } catch (_) { /* told nothing */ }
      if (taken && !gone) r = await manager.open(id);
    }
    if (gone) {
      if (r.ok && !manager.panelOf(id)) manager.close(id);
      return;
    }
    if (!r.ok) {
      panel.webview.html = page(r.pid ? BUSY_PAGE : `This conversation could not be opened: ${r.error || 'unknown error'}`);
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
    /* The tab's title and icon, and the page's title when the conversation's own events did not bring it there. */
    let icon;
    const retitle = () => {
      const s = manager.snapshot(id);
      if (!s) return;
      let label = s.title;
      try { if (this.deps.label) label = this.deps.label(s) || s.title; } catch (_) { label = s.title; }
      if (label && panel.title !== label) panel.title = label;
      let next;
      try { next = this.deps.iconFor ? this.deps.iconFor(s.activity) : undefined; } catch (_) { next = undefined; }
      if (next && next !== icon) { icon = next; panel.iconPath = next; }
      if (s.title && view && typeof view.dispatch === 'function' && view.state && view.state.title !== s.title) view.dispatch({ type: 'title', title: s.title });
    };
    retitle();
    subs.push(manager.onDidChange((e) => { if (e && e.sessionId === id) retitle(); }));
    if (this.deps.onDidChangeLook) subs.push(this.deps.onDidChangeLook(retitle));
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
