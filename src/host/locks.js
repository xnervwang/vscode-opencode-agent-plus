// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One lock file per conversation, <dir>/<id>.lock, naming the extension host that holds it, so that a conversation is
 * open in one window at a time. The file is written whole under another name and then hard-linked into place, so a reader
 * never sees half of one. A lock whose process is gone, or that was written before the machine last booted (its pid
 * may be someone else's now), is taken over.
 *
 * To take over from a live holder, a window writes <id>.takeover; the holder, which watches the folder with fs.watch
 * while it holds any lock, hands the request to onTakeover, releases the lock and answers with <id>.letgo naming the
 * asker. On macOS an event may name the temporary file a request was renamed from, or not come at all when the watch has
 * only just started, so the holder looks for requests on any event, and the asker checks for the answer on a timer and
 * writes its request again every second while it waits. Over Remote-SSH a window whose client went away without closing keeps its extension host running for hours,
 * holding its locks; that host still answers.
 *
 * A lock also names its holder's VS Code window (windowToken), so that a window reloaded while its old extension host
 * lives on (ownWindow) can take its conversations back without asking.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* os.uptime() has whole seconds and the clock can be stepped, so a lock this close to the boot still counts. */
const BOOT_SLACK_MS = 120000;
const TAKEOVER = '.takeover';
const LETGO = '.letgo';
/* A request older than this was left behind by an asker that gave up. */
const REQUEST_TTL_MS = 60000;
const TAKEOVER_WAIT_MS = 10000;
const POLL_MS = 250;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

const bootTime = () => Date.now() - os.uptime() * 1000;

/*
 * A name for this VS Code window that outlasts its reloads, kept in `memo` (the extension's workspaceState) under
 * `key`; '' without one. vscode.env.sessionId changes on every reload. A workspace's state belongs to the client's
 * profile, which opens a workspace in one window at a time, so another host with the same name is this window's own.
 */
function windowToken(memo, key) {
  if (!memo || typeof memo.get !== 'function') return '';
  let token = '';
  try { token = memo.get(key, ''); } catch (_) { token = ''; }
  if (typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token)) return token;
  token = crypto.randomUUID();
  try { Promise.resolve(memo.update(key, token)).catch(() => {}); } catch (_) { /* a new name next time */ }
  return token;
}

function createLocks({ dir, pid = process.pid, window = '', alive = processAlive, booted = bootTime, now = Date.now, watch = fs.watch, log } = {}) {
  if (!dir) throw new Error('createLocks needs a dir');
  const note = (line) => { try { if (log) log(line); } catch (_) { /* not logged */ } };
  const held = new Set();
  const file = (id) => path.join(dir, `${id}.lock`);
  const readJson = (p) => {
    try {
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      return rec && typeof rec === 'object' ? rec : null;
    } catch (_) { return null; }
  };
  const read = (id) => readJson(file(id));
  const writeWhole = (p, rec) => {
    const tmp = path.join(dir, `.${path.basename(p)}.${pid}.${now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, p);
  };
  const unlink = (p) => { try { fs.unlinkSync(p); } catch (_) { /* gone */ } };
  const othersLive = (rec) => !!rec && rec.pid !== pid && alive(rec.pid) && !(Number(rec.at) < booted() - BOOT_SLACK_MS);

  let onTakeover = null;
  let watcher = null;
  const answering = new Set();

  async function answer(id) {
    if (answering.has(id) || !held.has(id)) return;
    const req = readJson(path.join(dir, `${id}${TAKEOVER}`));
    if (!req || req.pid === pid || !(now() - Number(req.at) < REQUEST_TTL_MS)) return;
    answering.add(id);
    try {
      note(`process ${req.pid} asks to take over ${id}`);
      try { if (onTakeover) await onTakeover(id, req); } catch (e) { note(`stopping ${id} for the takeover failed: ${(e && e.message) || e}`); }
      release(id);
      try { writeWhole(path.join(dir, `${id}${LETGO}`), { pid, for: req.pid, at: now() }); } catch (e) { note(`replying to the takeover request for ${id} failed: ${e.message}`); }
    } finally {
      answering.delete(id);
    }
  }

  function syncWatcher() {
    if (held.size && !watcher) {
      try {
        watcher = watch(dir, () => { for (const id of [...held]) answer(id); });
        if (watcher && typeof watcher.on === 'function') watcher.on('error', () => { closeWatcher(); });
        if (watcher && typeof watcher.unref === 'function') watcher.unref();
      } catch (e) {
        note(`watching ${dir} failed: ${e.message}`);
        watcher = null;
      }
    } else if (!held.size && watcher) closeWatcher();
  }
  function closeWatcher() {
    const w = watcher;
    watcher = null;
    try { if (w) w.close(); } catch (_) { /* closed */ }
  }

  /*
   * Returns { ok: true }, { ok: false, pid } when another live process holds the lock, or { ok: false, pid: 0, error }.
   * `force` takes it from a live holder too, which may still be running the conversation.
   */
  function acquire(id, { force = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${id}.${pid}.${now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ pid, at: now(), host: os.hostname(), ...(window ? { window } : {}) }));
    try {
      for (let i = 0; i < 3; i++) {
        try {
          fs.linkSync(tmp, file(id));
          held.add(id);
          syncWatcher();
          return { ok: true };
        } catch (e) {
          if (!e || e.code !== 'EEXIST') return { ok: false, pid: 0, error: String((e && e.message) || e) };
        }
        const rec = read(id);
        if (rec && rec.pid === pid) { held.add(id); syncWatcher(); return { ok: true }; }
        if (othersLive(rec) && !force) return { ok: false, pid: rec.pid };
        unlink(file(id));
      }
      return { ok: false, pid: 0, error: 'the lock kept changing' };
    } finally {
      unlink(tmp);
    }
  }

  /* The pid of another live process holding the lock, or 0. */
  function holder(id) {
    const rec = read(id);
    return othersLive(rec) ? rec.pid : 0;
  }

  function ownWindow(id) {
    if (!window) return false;
    const rec = read(id);
    return othersLive(rec) && rec.window === window && rec.host === os.hostname();
  }

  function release(id) {
    held.delete(id);
    const rec = read(id);
    if (rec && rec.pid === pid) unlink(file(id));
    syncWatcher();
  }

  function releaseAll() { for (const id of [...held]) release(id); }

  /*
   * Waits at most `timeoutMs`. Resolves 'free' (nobody else held it), 'released' (the holder let go, or went away)
   * or 'timeout'.
   */
  function requestTakeover(id, { timeoutMs = TAKEOVER_WAIT_MS } = {}) {
    const first = holder(id);
    if (!first) return Promise.resolve('free');
    fs.mkdirSync(dir, { recursive: true });
    const reqFile = path.join(dir, `${id}${TAKEOVER}`);
    const letgoFile = path.join(dir, `${id}${LETGO}`);
    unlink(letgoFile);
    writeWhole(reqFile, { pid, at: now(), host: os.hostname() });
    return new Promise((resolve) => {
      let w = null;
      let timer = null;
      let poll = null;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        try { if (w) w.close(); } catch (_) { /* closed */ }
        const req = readJson(reqFile);
        if (req && req.pid === pid) unlink(reqFile);
        const ans = readJson(letgoFile);
        if (ans && ans.for === pid) unlink(letgoFile);
        resolve(outcome);
      };
      const check = () => {
        const ans = readJson(letgoFile);
        if (ans && ans.for === pid) return finish('released');
        if (holder(id) !== first) return finish('released');
        return undefined;
      };
      try { w = watch(dir, () => check()); } catch (e) { note(`watching ${dir} failed: ${e.message}`); }
      timer = setTimeout(() => finish(holder(id) === first ? 'timeout' : 'released'), timeoutMs);
      let ticks = 0;
      poll = setInterval(() => {
        check();
        if (settled || ++ticks % 4) return;
        try { writeWhole(reqFile, { pid, at: now(), host: os.hostname() }); } catch (_) { /* written again on the next round */ }
      }, POLL_MS);
      check();
    });
  }

  return {
    acquire,
    holder,
    ownWindow,
    release,
    releaseAll,
    requestTakeover,
    /* fn(id, request) stops the conversation here; the lock is released after it returns. */
    onTakeover(fn) { onTakeover = typeof fn === 'function' ? fn : null; },
    held: () => [...held],
    file,
    dispose() { closeWatcher(); },
  };
}

module.exports = { createLocks, processAlive, windowToken, BOOT_SLACK_MS, TAKEOVER_WAIT_MS };
