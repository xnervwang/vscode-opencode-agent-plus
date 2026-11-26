// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * This extension's part of Agent Plus's session list (its docs/protocol.md, Session list): the conversations of the
 * window's folders as rows, and the actions on them.
 *
 *   rows       OpenCode's own records (src/opencode/session-index.js), with what this window knows of the ones it has
 *              open (src/host/session-manager.js: a turn, a prompt, background work) and what the other windows of
 *              this machine report (allConversations).
 *   elsewhere  the terminal interface, `opencode run`, the background service (src/opencode/elsewhere.js), read every
 *              SCAN_MS while the list asks for rows. The core finds the other VS Code windows itself.
 *   kind       'subagent' for a session with a parent, 'background' for one an `opencode run` created, 'empty' for one
 *              that never ran a turn, else 'user'.
 *   delete     only what nothing has open and nothing runs: not this window, not another one, not a terminal
 *              interface, not a turn anywhere. The core adds its own rules (archived, not pinned) before it asks.
 *   seen       written back to OpenCode's own record of what was read (/api/session/:id/view), which the terminal
 *              interface reads.
 */

const SCAN_MS = 10000;
const DB_POLL_MS = 3000;

function emitter() {
  const listeners = new Set();
  return {
    event(listener, thisArgs, disposables) {
      const fn = (v) => listener.call(thisArgs, v);
      listeners.add(fn);
      const d = { dispose: () => { listeners.delete(fn); } };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    },
    fire(v) { for (const fn of [...listeners]) { try { fn(v); } catch (_) { /* the others still run */ } } },
    clear() { listeners.clear(); },
  };
}

const startOfDay = (now, timeZone) => {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const since = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + (now % 1000);
    return now - since;
  } catch (_) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
};
const money = (usd) => (usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

/*
 * deps:
 *   index            src/opencode/session-index.js
 *   elsewhere        src/opencode/elsewhere.js
 *   manager          src/host/session-manager.js
 *   ours(id)         whether this extension created the session
 *   holder(id)       another window that holds the conversation's lock, or null
 *   otherWindows()   optional: Promise of the conversations the other windows on this machine report
 *   open(id, where)  Promise<boolean>: opens it in a tab here
 *   create(where)    Promise<string>: starts a conversation in a tab here and answers its id
 *   canRename()      whether OpenCode can rename (2.x)
 *   rename(id, t)    Promise
 *   remove(id)       Promise: deletes it and its subagents' sessions
 *   canFork()        whether OpenCode can fork
 *   fork(id)         Promise: opens a copy of the conversation
 *   markViewed(id, idle)  optional Promise: OpenCode's record that the turn that ended at `idle` was seen
 *   stats(from, to, timeZone)  optional Promise of OpenCode's session statistics for that span
 *   providerName(id) optional: a provider id's display name
 *   timeZone()       optional: the user's IANA time zone
 *   now, setInterval, clearInterval, log
 */
function createSessionSource(deps) {
  const now = deps.now || (() => Date.now());
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const changed = emitter();
  const accountChanged = emitter();
  let reading = { at: 0, procs: [], tabs: new Map(), active: new Set() };
  let readingKey = '';
  let pages = null;
  let timers = [];
  let dbStamp = '';
  let today = { day: 0, at: 0, stats: null };

  const fire = () => changed.fire();

  /* Scans only while the list reads rows: the first listSessions call starts them. */
  function startWatching() {
    if (timers.length) return;
    const every = deps.setInterval || setInterval;
    timers.push(every(() => { rescan().catch((e) => log(`scanning for OpenCode elsewhere failed: ${e.message}`)); }, SCAN_MS));
    timers.push(every(() => { pollDb().catch(() => {}); }, DB_POLL_MS));
    for (const t of timers) if (t && typeof t.unref === 'function') t.unref();
  }

  async function pollDb() {
    const s = typeof deps.index.stamp === 'function' ? await deps.index.stamp() : '';
    if (s && dbStamp && s !== dbStamp) { fire(); accountChanged.fire(); }
    if (s) dbStamp = s;
  }

  const keyOf = (r) => JSON.stringify([r.procs.map((p) => [p.pid, p.role, p.folder]), [...r.tabs].map(([k, v]) => [k, [...v]]), [...r.active]]);

  async function rescan() {
    const r = await deps.elsewhere.scan();
    const k = keyOf(r);
    reading = r;
    if (k !== readingKey) { readingKey = k; fire(); }
    return r;
  }

  /* What the other windows of this machine report of their conversations, by id. */
  async function others() {
    if (typeof deps.otherWindows !== 'function') return new Map();
    try { return new Map(((await deps.otherWindows()) || []).filter((c) => c && c.sessionId).map((c) => [c.sessionId, c])); } catch (_) { return new Map(); }
  }

  function backgroundLines(list) {
    return (Array.isArray(list) ? list : []).slice(0, 6).map((b) => (b.kind === 'subagent'
      ? `Subagent still running: ${b.title || 'untitled'}`
      : `Command still running: ${b.title || 'a command'}${b.pid ? ` (process ${b.pid})` : ''}`).slice(0, 200));
  }

  function rowOf(r, known, far) {
    const here = deps.manager.has(r.id) ? deps.manager.snapshot(r.id) : null;
    const away = far.get(r.id);
    const places = deps.elsewhere.placesOf(r, reading, known);
    const row = {
      sessionId: r.id,
      title: String((here && here.title !== 'New conversation' && here.title) || r.title || 'New conversation').slice(0, 500),
      cwd: r.cwd,
      createdAt: r.createdAt,
      lastActiveAt: Math.max(r.lastActiveAt, here ? here.lastUserAt || 0 : 0, here ? here.lastReplyAt || 0 : 0),
      lastReplyAt: Math.max(r.lastReplyAt, here ? here.lastReplyAt || 0 : 0),
      kind: deps.elsewhere.kindOf(r, known) === 'user' && !r.busy && !r.lastReplyAt && !here ? 'empty' : deps.elsewhere.kindOf(r, known),
    };
    if (r.parentId) row.parentId = r.parentId;
    if (r.viewedAt) row.viewedAt = r.viewedAt;
    const state = here || away;
    if (state && ['working', 'waiting', 'background'].includes(state.activity)) {
      row.activity = state.activity;
      row.running = true;
      if (state.waitingFor) row.waitingFor = state.waitingFor;
    } else if (places.some((p) => p.running)) {
      row.activity = 'working';
      row.running = true;
    } else {
      row.activity = 'stopped';
      row.running = false;
    }
    if (places.length) row.elsewhere = places;
    const hover = backgroundLines(here && here.background);
    if (hover.length) row.hover = hover;
    if (deps.canFork && deps.canFork() && !r.parentId) row.actions = ['fork'];
    return row;
  }

  async function allRows(folders) {
    startWatching();
    if (!reading.at) await rescan().catch(() => {});
    const records = await deps.index.list({ folders });
    const known = deps.elsewhere.noteRuns(records, reading);
    const far = await others();
    if (typeof deps.index.stamp === 'function') dbStamp = await deps.index.stamp().catch(() => dbStamp);
    return records.map((r) => rowOf(r, known, far));
  }

  /* What a conversation has open or running, or '' when nothing does. */
  async function busyReason(id) {
    if (deps.manager.has(id)) return 'it is open in this window; close its tab first';
    if (deps.holder(id)) return 'it is open in another VS Code window; close it there first';
    const r = (await deps.index.all()).find((x) => x.id === id);
    if (!r) return '';
    const fresh = await rescan().catch(() => reading);
    const places = deps.elsewhere.placesOf(r, fresh);
    if (places.length) return `it is open or runs elsewhere (${places[0].label}); close it there first`;
    if (r.busy && fresh.active.has(id)) return 'a turn of it is running';
    return '';
  }

  async function one(action, id, args) {
    switch (action) {
      case 'open': {
        const why = await busyReason(id).catch(() => '');
        if (why && !why.startsWith('it is open in this window')) return { sessionId: id, outcome: 'refused', reason: `Not opened: ${why}.` };
        return (await deps.open(id, (args && args.where) || 'tab')) ? { sessionId: id, outcome: 'done' } : { sessionId: id, outcome: 'failed', reason: 'The conversation could not be opened.' };
      }
      case 'rename': {
        const title = String((args && args.title) || '').trim();
        if (!title) return { sessionId: id, outcome: 'refused', reason: 'A title cannot be empty.' };
        if (!deps.canRename()) return { sessionId: id, outcome: 'refused', reason: 'Renaming a conversation needs OpenCode 2.' };
        await deps.rename(id, title);
        deps.index.invalidate();
        return { sessionId: id, outcome: 'done' };
      }
      case 'delete': {
        const why = await busyReason(id);
        if (why) return { sessionId: id, outcome: 'refused', reason: `Not deleted: ${why}.` };
        await deps.remove(id);
        deps.index.invalidate();
        return { sessionId: id, outcome: 'done' };
      }
      case 'fork': {
        if (!deps.canFork || !deps.canFork()) return { sessionId: id, outcome: 'refused', reason: 'This version of OpenCode cannot fork conversations.' };
        await deps.fork(id);
        deps.index.invalidate();
        return { sessionId: id, outcome: 'done' };
      }
      default:
        return { sessionId: id, outcome: 'refused', reason: `${action} is not something OpenCode Agent Plus does.` };
    }
  }

  const source = {
    features: ['sessions', 'sessionImport', 'sessionSeen', 'accountInfo'],
    onDidChangeSessions: changed.event,
    onDidChangeAccountInfo: accountChanged.event,

    async listSessions({ folders = [], cursor = null, limit = 500 } = {}) {
      const max = Math.max(1, Math.min(Number(limit) || 500, 2000));
      if (!cursor || !pages) pages = await allRows((Array.isArray(folders) ? folders : []).filter((f) => typeof f === 'string' && f));
      const from = cursor ? Number(cursor) || 0 : 0;
      const sessions = pages.slice(from, from + max);
      const next = from + max < pages.length ? String(from + max) : null;
      if (!next) pages = cursor ? null : pages;
      return { sessions, cursor: next };
    },

    get sessionActions() {
      return Object.freeze({ open: ['tab'], create: ['tab'], rename: !!deps.canRename(), delete: true,
        own: deps.canFork && deps.canFork() ? [{ id: 'fork', title: 'Fork Conversation' }] : [] });
    },

    async runSessionAction(action, sessionIds, args) {
      if (action === 'create') {
        try {
          const id = await deps.create((args && args.where) || 'tab');
          fire();
          return { results: [{ sessionId: id || '', outcome: 'done' }] };
        } catch (e) { return { results: [{ sessionId: '', outcome: 'failed', reason: String((e && e.message) || e).slice(0, 300) }] }; }
      }
      const results = [];
      for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
        try { results.push(await one(action, String(id), args || {})); } catch (e) {
          results.push({ sessionId: String(id), outcome: 'failed', reason: String((e && e.message) || e).slice(0, 300) });
        }
      }
      fire();
      return { results };
    },

    async describeDeletion(sessionIds) {
      const all = await deps.index.all().catch(() => []);
      return (Array.isArray(sessionIds) ? sessionIds : []).map((id) => {
        const children = all.filter((r) => r.parentId === id).length;
        return { sessionId: id, what: children ? `The conversation and the sessions of its ${children} subagent${children === 1 ? '' : 's'}, from OpenCode's database` : "The conversation, from OpenCode's database" };
      });
    },

    /* Every row comes with its state read: nothing is left to read later. */
    wantSessionDetail() {},

    async importSessions({ folders = [] } = {}) {
      const records = await deps.index.list({ folders });
      return { archived: records.filter((r) => r.archivedAt).map((r) => ({ sessionId: r.id, at: r.archivedAt })), groups: [], pinned: [], colors: {} };
    },

    async noteSeen(sessionIds, seen) {
      if (seen !== true || typeof deps.markViewed !== 'function') return;
      const all = await deps.index.all().catch(() => []);
      for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
        const r = all.find((x) => x.id === id);
        if (!r || !r.lastReplyAt || r.viewedAt >= r.lastReplyAt) continue;
        try { await deps.markViewed(id, r.lastReplyAt); } catch (e) { log(`marking ${id} viewed in OpenCode failed: ${e.message}`); }
      }
      deps.index.invalidate();
    },

    async accountInfo({ sessionId = '' } = {}) {
      const rows = [];
      const all = await deps.index.all().catch(() => []);
      const r = sessionId ? all.find((x) => x.id === sessionId) : null;
      const here = sessionId && deps.manager.has(sessionId) ? deps.manager.snapshot(sessionId) : null;
      const model = (here && here.model) || (r && r.model) || '';
      if (model) {
        const provider = model.split('/')[0];
        rows.push({ label: 'Provider', value: (deps.providerName && deps.providerName(provider)) || provider });
        rows.push({ label: 'Model', value: model.slice(provider.length + 1) || model });
      }
      if (typeof deps.stats === 'function') {
        const t = now();
        const day = startOfDay(t, deps.timeZone ? deps.timeZone() : '');
        if (today.day !== day || t - today.at > 60000) {
          try { today = { day, at: t, stats: await deps.stats(day, t, deps.timeZone ? deps.timeZone() : '') }; } catch (e) { log(`reading OpenCode's statistics failed: ${e.message}`); }
        }
        if (today.stats) rows.push({ label: 'Today, all conversations', value: money(Number(today.stats.cost) || 0), tooltip: 'What OpenCode recorded for every conversation since midnight' });
      }
      const conversation = r ? {
        title: r.title || 'New conversation',
        rows: [
          { label: 'Cost', value: money(r.cost) },
          { label: 'Tokens', value: `${count(r.tokens.input)} in · ${count(r.tokens.output)} out`, tooltip: `Cache read ${count(r.tokens.cacheRead)}, cache write ${count(r.tokens.cacheWrite)}, reasoning ${count(r.tokens.reasoning)}` },
        ],
      } : undefined;
      if (!rows.length && !conversation) return null;
      return { rows: rows.slice(0, 12), bars: [], links: [], ...(conversation ? { conversation } : {}) };
    },

    /* For the extension: a change it knows of, such as a conversation it opened or closed. */
    changed() { fire(); accountChanged.fire(); },
    dispose() {
      const clear = deps.clearInterval || clearInterval;
      for (const t of timers) clear(t);
      timers = [];
      changed.clear();
      accountChanged.clear();
    },
  };
  return source;
}

module.exports = { createSessionSource, startOfDay, SCAN_MS };
