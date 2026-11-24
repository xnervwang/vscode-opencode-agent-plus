// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One lock file per conversation, <dir>/<id>.lock, naming the extension host that runs it, so that a conversation runs
 * in one window at a time. The file is written whole under another name and then hard-linked into place, so a reader
 * never sees half of one. A lock whose process is gone, or that was written before the machine last booted (its pid
 * may be someone else's now), is taken over.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* os.uptime() has whole seconds and the clock can be stepped, so a lock this close to the boot still counts. */
const BOOT_SLACK_MS = 120000;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

const bootTime = () => Date.now() - os.uptime() * 1000;

function createLocks({ dir, pid = process.pid, alive = processAlive, booted = bootTime, now = Date.now } = {}) {
  if (!dir) throw new Error('createLocks needs a dir');
  const held = new Set();
  const file = (id) => path.join(dir, `${id}.lock`);
  const read = (id) => {
    try {
      const rec = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      return rec && typeof rec === 'object' ? rec : null;
    } catch (_) { return null; }
  };
  /* Another live process holds it. */
  const othersLive = (rec) => !!rec && rec.pid !== pid && alive(rec.pid) && !(Number(rec.at) < booted() - BOOT_SLACK_MS);

  /* { ok: true } when this process holds the lock now; { ok: false, pid } when another live process does. */
  function acquire(id) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${id}.${pid}.${now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ pid, at: now(), host: os.hostname() }));
    try {
      for (let i = 0; i < 3; i++) {
        try {
          fs.linkSync(tmp, file(id));
          held.add(id);
          return { ok: true };
        } catch (e) {
          if (!e || e.code !== 'EEXIST') return { ok: false, pid: 0, error: String((e && e.message) || e) };
        }
        const rec = read(id);
        if (rec && rec.pid === pid) { held.add(id); return { ok: true }; }
        if (othersLive(rec)) return { ok: false, pid: rec.pid };
        try { fs.unlinkSync(file(id)); } catch (_) { /* someone else removed it first */ }
      }
      return { ok: false, pid: 0, error: 'the lock kept changing' };
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
    }
  }

  /* The pid of another live process holding the lock, or 0. */
  function holder(id) {
    const rec = read(id);
    return othersLive(rec) ? rec.pid : 0;
  }

  function release(id) {
    held.delete(id);
    const rec = read(id);
    if (rec && rec.pid === pid) { try { fs.unlinkSync(file(id)); } catch (_) { /* gone */ } }
  }

  function releaseAll() { for (const id of [...held]) release(id); }

  return { acquire, holder, release, releaseAll, held: () => [...held], file };
}

module.exports = { createLocks, processAlive, BOOT_SLACK_MS };
