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
 *   folders    the window's folders and the folders below them, and the linked worktrees of their repositories, which
 *              OpenCode keeps under its own data folder: a session moved into one is still this project's, and opens
 *              here. A row in such a worktree carries its name; every row carries the branch its folder has out.
 *   lastUserAt from this window or another one when they have the conversation open, as they saw each message sent;
 *              otherwise when OpenCode last began a turn of it.
 *   processes  this window, another VS Code window holding it, and each place elsewhere: more than one is a warning.
 *   delete     only what nothing has open and nothing runs: not this window, not another one, not a terminal
 *              interface, not a turn anywhere. The core adds its own rules (archived, not pinned) before it asks.
 *   seen       written back to OpenCode's own record of what was read (/api/session/:id/view), which the terminal
 *              interface reads.
 *   notice     why the rows could not be read, above the list: OpenCode not found (no rows, with a button to download
 *              it where a build exists for this platform), or the error; gone once a reading succeeds.
 */

const { within } = require('../opencode/session-index');

const SCAN_MS = 10000;
const DB_POLL_MS = 3000;
/* How long a reading of Account & usage is given as it is. */
const ACCOUNT_MS = 5000;

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
 *   git              optional: src/host/git-info.js, for branches and worktrees
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
 *   canDownload()    optional: whether OpenCode can be downloaded for this platform
 *   commands         { download, logs }: the commands the notice's buttons run
 *   noted(records)   optional: called with OpenCode's records each time they are read for the list
 *   now, setInterval, clearInterval, log
 */
function createSessionSource(deps) {
  const now = deps.now || (() => Date.now());
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const changed = emitter();
  const accountChanged = emitter();
  const noticeChanged = emitter();
  let notice = null;
  const commands = deps.commands || {};
  function setNotice(next) {
    if (JSON.stringify(next) === JSON.stringify(notice)) return;
    notice = next;
    noticeChanged.fire();
  }
  /* The notice for an error reading the rows; true when it means there is nothing to list rather than a failed list. */
  function noteFailure(e) {
    const text = String((e && e.message) || e).replace(/\s+/g, ' ').trim();
    const logs = commands.logs ? [{ label: 'Show Logs', command: commands.logs, arguments: [] }] : [];
    if (e && e.code === 'notFound') {
      const download = commands.download && deps.canDownload && deps.canDownload() ? [{ label: 'Download OpenCode', command: commands.download, arguments: [] }] : [];
      setNotice({ text: text.slice(0, 300), actions: [...download, ...logs] });
      return true;
    }
    setNotice({ text: `Couldn't list OpenCode's conversations: ${text}`.slice(0, 300), actions: logs });
    return false;
  }
  let reading = { at: 0, procs: [], tabs: new Map(), active: new Set() };
  let readingKey = '';
  let pages = null;
  let timers = [];
  let dbStamp = '';
  let today = { day: 0, at: 0, stats: null };
  let account = { id: null, at: 0, record: null };
  let accountReading = null;
  let accountKey = '';

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
    if (s && dbStamp && s !== dbStamp) { account.at = 0; fire(); accountChanged.fire(); }
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

  /* The record of the conversation in front, and today's statistics, read for accountOf(). */
  function readAccount(sessionId) {
    if (accountReading) return;
    accountReading = (async () => {
      const all = await deps.index.all().catch(() => []);
      const record = sessionId ? all.find((x) => x.id === sessionId) || null : null;
      if (typeof deps.stats === 'function') {
        const t = now();
        const zone = deps.timeZone ? deps.timeZone() : '';
        const day = startOfDay(t, zone);
        if (today.day !== day || t - today.at > 60000) {
          try { today = { day, at: t, stats: await deps.stats(day, t, zone) }; } catch (e) { log(`reading OpenCode's statistics failed: ${e.message}`); }
        }
      }
      account = { id: sessionId, at: now(), record };
    })().catch((e) => log(`reading Account & usage failed: ${e.message}`)).finally(() => {
      accountReading = null;
      const k = JSON.stringify(accountOf(account.id));
      if (k !== accountKey) { accountKey = k; accountChanged.fire(); }
    });
  }

  /* This extension's part of Account & usage, from the last reading. */
  function accountOf(sessionId) {
    const rows = [];
    const r = account.id === sessionId ? account.record : null;
    const here = sessionId && deps.manager.has(sessionId) ? deps.manager.snapshot(sessionId) : null;
    const model = (here && here.model) || (r && r.model) || '';
    if (model) {
      const provider = model.split('/')[0];
      rows.push({ label: 'Provider', value: (deps.providerName && deps.providerName(provider)) || provider });
      rows.push({ label: 'Model', value: model.slice(provider.length + 1) || model });
    }
    if (today.stats) rows.push({ label: 'Today, all conversations', value: money(Number(today.stats.cost) || 0), tooltip: 'What OpenCode recorded for every conversation since midnight' });
    const conversation = r ? {
      title: r.title || 'New conversation',
      rows: [
        { label: 'Cost', value: money(r.cost) },
        { label: 'Tokens', value: `${count(r.tokens.input)} in · ${count(r.tokens.output)} out`, tooltip: `Cache read ${count(r.tokens.cacheRead)}, cache write ${count(r.tokens.cacheWrite)}, reasoning ${count(r.tokens.reasoning)}` },
      ],
    } : undefined;
    if (!rows.length && !conversation) return null;
    return { rows: rows.slice(0, 12), bars: [], links: [], ...(conversation ? { conversation } : {}) };
  }

  function backgroundLines(list) {
    return (Array.isArray(list) ? list : []).slice(0, 6).map((b) => (b.kind === 'subagent'
      ? `Subagent still running: ${b.title || 'untitled'}`
      : `Command still running: ${b.title || 'a command'}${b.pid ? ` (process ${b.pid})` : ''}`).slice(0, 200));
  }

  const platform = deps.platform || process.platform;
  const same = (a, b) => within(a, b, platform) && within(b, a, platform);

  /* The folders to list: the window's, and the linked worktrees of their repositories that are not among them. */
  async function scope(folders) {
    let trees = [];
    if (deps.git) {
      for (const f of folders) {
        for (const t of await deps.git.worktreesOf(f).catch(() => [])) {
          if (!folders.some((x) => same(x, t.dir)) && !trees.some((x) => same(x.dir, t.dir))) trees.push(t);
        }
      }
    }
    const dirs = [...folders, ...trees.filter((t) => !folders.some((f) => within(t.dir, f, platform))).map((t) => t.dir)];
    return { dirs, trees };
  }

  /* The worktree a folder is in, the innermost when one is inside another. */
  function treeOf(cwd, trees) {
    let best = null;
    for (const t of trees) if (within(cwd, t.dir, platform) && (!best || t.dir.length > best.dir.length)) best = t;
    return best ? best.name : '';
  }

  function rowOf(r, known, far, trees, branches) {
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
      kind: deps.elsewhere.kindOf(r, known) === 'user' && !r.busy && !r.lastReplyAt && !(here && here.lastUserAt) ? 'empty' : deps.elsewhere.kindOf(r, known),
    };
    const sent = Math.max(here ? here.lastUserAt || 0 : 0, away ? away.lastUserAt || 0 : 0);
    if (sent || r.lastTurnAt) row.lastUserAt = sent || r.lastTurnAt;
    if (r.parentId) row.parentId = r.parentId;
    if (r.viewedAt) row.viewedAt = r.viewedAt;
    const branch = branches.get(r.cwd);
    if (branch) row.branch = branch.slice(0, 200);
    const tree = treeOf(r.cwd, trees);
    if (tree) row.worktree = tree.slice(0, 100);
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
    const processes = (here ? 1 : 0) + (deps.holder(r.id) ? 1 : 0) + places.length;
    if (processes > 1) row.processes = processes;
    const hover = backgroundLines(here && here.background);
    if (hover.length) row.hover = hover;
    if (deps.canFork && deps.canFork() && !r.parentId) row.actions = ['fork'];
    return row;
  }

  async function allRows(folders) {
    startWatching();
    if (!reading.at) await rescan().catch(() => {});
    const { dirs, trees } = await scope(folders);
    let records;
    try { records = await deps.index.list({ folders: dirs }); } catch (e) {
      if (noteFailure(e)) return [];
      throw e;
    }
    setNotice(null);
    if (typeof deps.noted === 'function') { try { deps.noted(records); } catch (e) { log(`noting OpenCode's records failed: ${e.message}`); } }
    const known = deps.elsewhere.noteRuns(records, reading);
    const far = await others();
    const branches = new Map();
    if (deps.git) {
      for (const cwd of new Set(records.map((r) => r.cwd).filter(Boolean))) branches.set(cwd, await deps.git.branchOf(cwd).catch(() => ''));
    }
    if (typeof deps.index.stamp === 'function') dbStamp = await deps.index.stamp().catch(() => dbStamp);
    return records.map((r) => rowOf(r, known, far, trees, branches));
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
    features: ['sessions', 'sessionImport', 'sessionSeen', 'sessionsNotice', 'accountInfo'],
    onDidChangeSessions: changed.event,
    onDidChangeAccountInfo: accountChanged.event,
    onDidChangeSessionsNotice: noticeChanged.event,
    sessionsNotice() { return notice ? { text: notice.text, actions: notice.actions.map((a) => ({ ...a })) } : null; },

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
      const records = await deps.index.list({ folders: (await scope((Array.isArray(folders) ? folders : []).filter((f) => typeof f === 'string' && f))).dirs });
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

    /* Agent Plus reads this at once, without waiting: it gives what was last read, and reads again (telling the core
       through onDidChangeAccountInfo when that changes anything) when the reading is of another conversation or older
       than ACCOUNT_MS. */
    accountInfo({ sessionId = '' } = {}) {
      if (account.id !== sessionId || now() - account.at > ACCOUNT_MS) readAccount(sessionId);
      return accountOf(sessionId);
    },

    /* For the extension: a change it knows of, such as a conversation it opened or closed. */
    changed() { account.at = 0; fire(); accountChanged.fire(); },
    dispose() {
      const clear = deps.clearInterval || clearInterval;
      for (const t of timers) clear(t);
      timers = [];
      changed.clear();
      accountChanged.clear();
      noticeChanged.clear();
    },
  };
  return source;
}

module.exports = { createSessionSource, startOfDay, SCAN_MS };
