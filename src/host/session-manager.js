// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The conversations open in this window. Each has its session object from the backend (src/host/backend.js), the
 * panels showing it, and the state that Agent Plus and the Conversations view read through snapshot(). That state
 * starts from the session object's own fields; after that its AgentEvents update it, and later session lists bring only
 * titles and times. A lock (src/host/locks.js), when given, keeps a conversation to one window: each window runs its
 * own OpenCode process, and two of them driving one session would talk over each other.
 */
const { EventEmitter } = require('events');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const validId = (id) => typeof id === 'string' && SESSION_ID.test(id);
const num = (v) => {
  const n = typeof v === 'string' && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* Same shape as vscode.Event, so the module needs no vscode. */
function emitter() {
  const listeners = new Set();
  return {
    event(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    fire(v) { for (const fn of [...listeners]) { try { fn(v); } catch (_) { /* the other listeners still run */ } } },
    dispose() { listeners.clear(); },
  };
}

/*
 * Subscribes to a conversation's AgentEvents whichever way it offers them: a vscode-style onEvent(fn), a Node
 * EventEmitter's on('event', fn), or on(fn). Returns a function that unsubscribes.
 */
function subscribe(conv, fn) {
  const undo = (d) => () => {
    try { if (typeof d === 'function') d(); else if (d && typeof d.dispose === 'function') d.dispose(); } catch (_) { /* gone */ }
  };
  if (conv && typeof conv.onEvent === 'function') return undo(conv.onEvent(fn));
  if (conv && typeof conv.on === 'function') {
    if (conv instanceof EventEmitter) {
      conv.on('event', fn);
      return () => { conv.removeListener('event', fn); };
    }
    return undo(conv.on(fn));
  }
  return () => {};
}

function stateOfInfo(info) {
  const s = info && info.status;
  if (s === 'working' || s === 'busy') return 'working';
  if (s === 'waiting') return 'waiting';
  return 'stopped';
}
const kindOfInfo = (info) => {
  if (!info || stateOfInfo(info) !== 'waiting') return '';
  const w = info.waitingFor;
  return (w && w.kind === 'question') || info.waitingKind === 'question' ? 'question' : 'permission';
};
const toolOfInfo = (info) => {
  if (!info) return '';
  const w = info.waitingFor;
  return String((w && w.tool) || info.waitingTool || info.tool || '');
};

/*
 * deps:
 *   makeConversation({ id })      its session object, or a Promise of it; throws when there is no such session
 *   info(id, conversation)        optional: the session's { title, cwd, createdAt, lastActiveAt, status, waitingFor,
 *                                 lastUserAt, lastReplyAt }, or null for none; the conversation's own fields otherwise
 *   isLooking(id)                 whether the user sees its panel in a focused window now
 *   locks                         optional, src/host/locks.js
 *   now(), log(line)              optional
 */
function createSessionManager(deps) {
  const now = deps.now || Date.now;
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const locks = deps.locks || null;
  const entries = new Map();
  const opening = new Map();
  const changed = emitter();
  const fire = (id) => changed.fire({ sessionId: id });
  const looking = (id) => { try { return deps.isLooking ? deps.isLooking(id) === true : false; } catch (_) { return false; } };

  function snapshot(e) {
    const out = {
      sessionId: e.id,
      title: e.title || 'New conversation',
      cwd: e.cwd,
      activity: e.state,
      unseen: e.unseen,
      lastActiveAt: e.lastActiveAt,
      running: true,
      lastUserAt: e.lastUserAt,
      lastReplyAt: e.lastReplyAt,
    };
    if (e.state === 'waiting') out.waitingFor = e.waitingKind === 'question' ? { kind: 'question' } : { kind: 'permission', tool: e.waitingTool || '' };
    return out;
  }

  function stillAsking(e) {
    const last = [...e.asking.values()].pop();
    if (last) { e.waitingTool = last.tool; e.waitingKind = last.kind; } else if (e.state === 'waiting') { e.state = 'working'; e.waitingTool = ''; e.waitingKind = ''; }
  }

  function onEvent(e, ev) {
    if (!ev || typeof ev !== 'object') return;
    const at = num(ev.at) || now();
    switch (ev.type) {
      case 'turnStart':
        e.state = 'working'; e.lastActiveAt = at; break;
      case 'userMessage':
        if (ev.synthetic === true) return;
        e.lastUserAt = at; e.lastActiveAt = at;
        if (!e.title && typeof ev.text === 'string' && ev.text.trim()) e.title = ev.text.trim().split('\n')[0].slice(0, 80);
        break;
      case 'permission':
        e.asking.set(ev.requestId, { tool: (ev.request && ev.request.tool) || '', kind: 'permission' });
        e.state = 'waiting'; e.waitingTool = (ev.request && ev.request.tool) || ''; e.waitingKind = 'permission'; break;
      case 'question':
        e.asking.set(ev.requestId, { tool: 'question', kind: 'question' });
        e.state = 'waiting'; e.waitingTool = 'question'; e.waitingKind = 'question'; break;
      case 'permissionSettled':
      case 'questionSettled':
        e.asking.delete(ev.requestId);
        stillAsking(e);
        break;
      case 'turnEnd':
        e.asking.clear(); e.waitingTool = ''; e.waitingKind = '';
        e.state = 'stopped'; e.lastActiveAt = at;
        if (ev.reason !== 'aborted') { e.lastReplyAt = at; e.unseen = !looking(e.id); }
        break;
      case 'title':
        if (typeof ev.title === 'string' && ev.title.trim()) e.title = ev.title.trim(); break;
      case 'options':
      case 'commands':
        return;
      default:
        e.lastActiveAt = now();
        return;
    }
    fire(e.id);
  }

  async function start(id) {
    if (locks) {
      const lock = locks.acquire(id);
      if (!lock.ok) return { ok: false, pid: lock.pid || 0, error: lock.error || '' };
    }
    let conversation = null;
    try {
      conversation = await deps.makeConversation({ id });
      const info = deps.info ? await deps.info(id, conversation) : conversation;
      if (!info) throw new Error('there is no such conversation');
      const e = {
        id, conversation, cwd: String(info.cwd || ''), panels: new Set(), asking: new Map(),
        state: stateOfInfo(info), waitingTool: toolOfInfo(info), waitingKind: kindOfInfo(info), unseen: false,
        title: typeof info.title === 'string' ? info.title : '',
        lastUserAt: num(info.lastUserAt), lastReplyAt: num(info.lastReplyAt),
        lastActiveAt: num(info.lastActiveAt) || num(info.createdAt) || now(),
        unsub: () => {},
      };
      e.unsub = subscribe(conversation, (ev) => onEvent(e, ev));
      entries.set(id, e);
      fire(id);
      return { ok: true, entry: e };
    } catch (err) {
      try { if (conversation && typeof conversation.dispose === 'function') conversation.dispose(); } catch (_) { /* gone */ }
      if (locks) locks.release(id);
      log(`opening ${id} failed: ${(err && err.stack) || err}`);
      return { ok: false, pid: 0, error: String((err && err.message) || err) };
    }
  }

  /* { ok: true, entry } | { ok: false, pid } (another window has it) | { ok: false, error }. */
  function open(id) {
    if (!validId(id)) return Promise.resolve({ ok: false, pid: 0, error: `not a conversation id: ${String(id).slice(0, 80)}` });
    if (entries.has(id)) return Promise.resolve({ ok: true, entry: entries.get(id) });
    if (!opening.has(id)) opening.set(id, start(id).finally(() => opening.delete(id)));
    return opening.get(id);
  }

  /* Lets go of a conversation here. The backend keeps it; a turn still running is stopped only with `abort`. */
  function close(id, { abort = false } = {}) {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    e.unsub();
    if (abort && e.state !== 'stopped') { try { if (typeof e.conversation.abort === 'function') e.conversation.abort(); } catch (_) { /* already stopped */ } }
    try { if (typeof e.conversation.dispose === 'function') e.conversation.dispose(); } catch (_) { /* already disposed */ }
    if (locks) locks.release(id);
    fire(id);
  }

  function update(infos) {
    for (const info of Array.isArray(infos) ? infos : []) {
      const e = info && entries.get(info.id);
      if (!e) continue;
      let moved = false;
      if (typeof info.title === 'string' && info.title.trim() && info.title !== e.title) { e.title = info.title; moved = true; }
      for (const k of ['lastUserAt', 'lastReplyAt', 'lastActiveAt']) {
        const v = num(info[k]);
        if (v > e[k]) { e[k] = v; moved = true; }
      }
      if (moved) fire(e.id);
    }
  }

  return {
    open,
    close,
    update,
    get: (id) => entries.get(id) || null,
    has: (id) => entries.has(id),
    ids: () => [...entries.keys()],
    list: () => [...entries.values()].map(snapshot),
    snapshot: (id) => (entries.has(id) ? snapshot(entries.get(id)) : null),
    attach(id, panel) { const e = entries.get(id); if (e) e.panels.add(panel); },
    /* The last panel to go closes the conversation here and aborts a running turn: users close the tab to stop one. */
    detach(id, panel) {
      const e = entries.get(id);
      if (!e) return;
      e.panels.delete(panel);
      if (!e.panels.size) close(id, { abort: true });
    },
    panelOf(id) { const e = entries.get(id); return e && e.panels.size ? [...e.panels][e.panels.size - 1] : null; },
    seen(id) { const e = entries.get(id); if (e && e.unseen) { e.unseen = false; fire(id); } },
    /* A turn in progress queues the text. */
    send(id, text) {
      const e = entries.get(id);
      if (!e) throw new Error('the conversation is not open in this window');
      const r = e.conversation.send(text);
      if (r && typeof r.catch === 'function') r.catch((err) => log(`send to ${id} failed: ${(err && err.message) || err}`));
    },
    /* For the window's shutdown: closes every conversation, aborting running turns when `abort` is set. */
    disposeAll({ abort = false } = {}) { for (const id of [...entries.keys()]) close(id, { abort }); if (locks) locks.releaseAll(); },
    onDidChange: changed.event,
    dispose() { changed.dispose(); },
  };
}

module.exports = { createSessionManager, subscribe, validId, emitter, stateOfInfo, SESSION_ID };
