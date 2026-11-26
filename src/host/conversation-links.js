// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversation links in the chat page (media/chat.js): when a reply names a conversation, the page shows the name as a
 * link.
 *
 * When Agent Plus offers allConversations (its docs/protocol.md), that list gives the conversations of every agent it
 * reads, as in Claude Code Plus. Agent Plus lists only the conversations open in some window, so this extension's saved
 * conversations are added from the backend's session list. A click on another agent's conversation goes to
 * agentPlus.openConversation: Agent Plus brings forward the window that shows it, or has its agent open it. One of this
 * extension's conversations opens in this window unless another window has it open. Without Agent Plus, only this
 * extension's conversations are linked, and open here.
 *
 * Nothing is read unless a chat page is open and the setting is on. No editor API here.
 */
const SOURCE = 'opencode-plus';
const LABEL = 'OpenCode Agent Plus';
const MAX_LISTED = 2000;
const MAX_TITLE = 300;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function entryOf(c, sourceId = '', label = '') {
  if (!c || typeof c.sessionId !== 'string' || !c.sessionId || c.sessionId.length > 200) return null;
  const at = typeof c.lastActiveAt === 'number' ? c.lastActiveAt : Date.parse(c.lastActiveAt || '');
  return { sourceId: text(c.sourceId, 80) || sourceId, label: text(c.label, 80) || label, sessionId: c.sessionId, title: text(c.title, MAX_TITLE),
    cwd: text(c.cwd, 1000), lastActiveAt: Number.isFinite(at) && at > 0 ? at : 0 };
}

/* `lists` joined, each conversation once (the first one listed wins). */
function entries(...lists) {
  const out = [], seen = new Set();
  for (const list of lists) {
    for (const c of Array.isArray(list) ? list : []) {
      const e = entryOf(c);
      if (!e || !e.sourceId) continue;
      const key = `${e.sourceId}\n${e.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= MAX_LISTED) return out;
    }
  }
  return out;
}

/* This extension's sessions (src/host/backend.js SessionInfo) in the same shape. */
const ownEntries = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string')
  .map((r) => ({ sourceId: SOURCE, label: LABEL, sessionId: r.id, title: r.title || '', cwd: r.cwd || '', lastActiveAt: r.lastActiveAt || 0 }));

/*
 * deps:
 *   on()                     the setting opencodeAgentPlus.conversationLinks
 *   active()                 whether a chat page is open in this window
 *   own()                    Promise of this extension's sessions ({ id, title, cwd, lastActiveAt })
 *   openCore(target)         runs agentPlus.openConversation with { sourceId, sessionId, title, cwd }
 *   openOwn(sessionId, handOff)
 *                            opens one of this extension's conversations here; with `handOff` true it resolves false
 *                            instead when another window has it open
 *   log(line)                optional
 */
function createConversationLinks(deps) {
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const enabled = () => { try { return deps.on() !== false; } catch (_) { return false; } };
  const active = () => { try { return deps.active() === true; } catch (_) { return false; } };
  const listeners = new Set();
  let core = null, sub = null, coreList = [], ownList = [], ownRead = false, reading = null, again = false;
  let list = [], key = '', rev = 0, closed = false, wasOn = null;

  const fire = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { log(`conversation links: ${(e && e.message) || e}`); } } };
  const usesCore = () => !!(core && Array.isArray(core.features) && core.features.includes('allConversations')
    && typeof core.allConversations === 'function' && typeof core.onDidChangeAllConversations === 'function');
  const recompute = () => {
    const next = entries(coreList, ownList);
    const k = JSON.stringify(next.map((e) => [e.sourceId, e.sessionId, e.title, e.cwd]));
    list = next;
    if (k !== key) { key = k; rev++; fire(); }
  };
  const fromCore = () => {
    let got = [];
    try { got = core.allConversations(); } catch (_) { got = []; }
    coreList = Array.isArray(got) ? got.slice() : [];
    recompute();
  };
  /* A change that comes while the sessions are being read may be missing from that reading: it is read again after. */
  const readOwn = () => {
    if (reading) { again = true; return reading; }
    ownRead = true;
    reading = Promise.resolve().then(() => deps.own()).then((rows) => { ownList = ownEntries(rows); },
      (e) => log(`conversation links: listing the backend's sessions failed: ${(e && e.message) || e}`))
      .then(() => {
        reading = null;
        if (closed) return;
        recompute();
        if (again) { again = false; readOwn(); }
      });
    return reading;
  };
  const unhook = () => { if (sub) { try { sub.dispose(); } catch (_) { /* gone */ } sub = null; } };
  /* Subscribes to Agent Plus only while a page wants the list: as long as anyone is subscribed, Agent Plus reads the
     list of every source. */
  const follow = () => {
    if (closed) return;
    if (!enabled() || !active()) { unhook(); return; }
    if (usesCore() && !sub) {
      try { sub = core.onDidChangeAllConversations(() => { if (!closed && enabled()) fromCore(); }); } catch (e) { sub = null; log(`conversation links: ${(e && e.message) || e}`); }
      if (sub) fromCore();
    }
    if (!ownRead) readOwn();
  };

  return {
    /* Called with the agentPlus interface once registration with Agent Plus succeeds. */
    attach(next) { unhook(); core = next || null; coreList = []; follow(); recompute(); },
    refresh() { if (!closed && enabled() && active()) { follow(); readOwn(); } },
    /* The setting changed, or a page opened or closed. */
    settingChanged() {
      const now = enabled();
      follow();
      if (wasOn !== null && now !== wasOn) { rev++; fire(); }
      wasOn = now;
    },
    current() {
      wasOn = enabled();
      if (!wasOn) return { rev, list: [] };
      follow();
      return { rev, list };
    },
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    /* Resolves to 'here', 'agentPlus' or 'nowhere'. */
    async open(sourceId, sessionId) {
      if (typeof sourceId !== 'string' || typeof sessionId !== 'string' || !sessionId) return 'nowhere';
      const c = list.find((e) => e.sourceId === sourceId && e.sessionId === sessionId);
      const target = { sourceId, sessionId, title: c ? c.title : '', cwd: c ? c.cwd : '' };
      if (sourceId === SOURCE && (await deps.openOwn(sessionId, !!core)) !== false) return 'here';
      if (core) { await deps.openCore(target); return 'agentPlus'; }
      return 'nowhere';
    },
    list: () => list,
    dispose() { closed = true; unhook(); listeners.clear(); },
  };
}

module.exports = { createConversationLinks, entries, ownEntries, SOURCE, LABEL, MAX_LISTED };
