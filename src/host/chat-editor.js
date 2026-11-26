// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page is a read-only custom editor (view type opencodeAgentPlus.chat) for opencodeagentplus-session:/<session id>
 * URIs. The session id is in the URI, so each tab knows its conversation and VS Code can reopen the tabs after a reload. There is no
 * file behind the URI; the provider hands each webview panel to the chat panel of src/ui/chat-panel.js.
 */
const vscode = require('vscode');
const { sessionOfUri } = require('./agentplus-source');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BUSY_PAGE = 'This conversation is open in another VS Code window, which may have lost its connection. '
  + 'Choose "Take over here" in the notification to continue it.';
const TAKING_BACK_PAGE = 'Reopening this conversation from before the window reloaded…';
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
 *                            open it
 *   ownWindow(sessionId)     optional: the holder is this window's own host from before a reload, which busy takes
 *                            back without asking
 *   label(snapshot)          optional: the tab's title for the conversation's snapshot (its title with an envelope
 *                            while a reply is unread); the title alone otherwise
 *   titleOf(sessionId)       optional: the conversation's title before it is open, or ''
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
    if (!id) { panel.webview.html = page('This tab has no valid conversation id.'); return; }
    /* The title goes on the tab before the conversation opens, and stays when it cannot (another window has it, or
       opening failed): VS Code saves a tab's title for the next window, and without one it names the tab after its
       resource. */
    let known = '';
    try { known = (this.deps.titleOf && this.deps.titleOf(id)) || ''; } catch (_) { known = ''; }
    if (known && panel.title !== known) panel.title = known;
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
