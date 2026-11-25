// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The conversations every VS Code window on this machine has open, for Agent Plus's listAllConversations(): without it
 * Agent Plus, and a steward in another window, only see the conversations of the window they ask.
 *
 * Each window writes the ones it has open, in Agent Plus's Conversation shape, to <dir>/<pid>.json (a temporary file,
 * then a rename) whenever they change, and removes the file when it has none or goes away. A reader takes every file
 * whose pid still runs and removes the others, left by a window that crashed. A conversation in two files (two windows
 * should not hold one; see src/host/locks.js) is taken from this window's file if it is there, otherwise from the
 * newest file.
 *
 *   { format: 1, pid, at, conversations: [...] }
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const MAX_FILE = 4 * 1024 * 1024;
const NAME = /^(\d+)\.json$/;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/*
 * deps:
 *   dir                    the folder of the window files
 *   list()                 this window's conversations now
 *   pid, alive(pid), now(), log(line)   optional
 */
function createWindowStates(deps) {
  const pid = deps.pid || process.pid;
  const alive = deps.alive || processAlive;
  const now = deps.now || Date.now;
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const own = path.join(deps.dir, `${pid}.json`);
  let written = '';
  let closed = false;

  function write() {
    if (closed) return false;
    let list = [];
    try { list = Array.isArray(deps.list()) ? deps.list() : []; } catch (e) { log(`window state: ${(e && e.message) || e}`); return false; }
    const key = JSON.stringify(list);
    if (key === written) return false;
    try {
      if (!list.length) {
        try { fs.unlinkSync(own); } catch (_) { /* not there */ }
      } else {
        fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
        const tmp = `${own}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, pid, at: now(), conversations: list }), { mode: 0o600 });
        fs.renameSync(tmp, own);
      }
      written = key;
      return true;
    } catch (e) {
      log(`writing the window state failed: ${(e && e.message) || e}`);
      return false;
    }
  }

  /* Every running window's conversations, this one's from memory. */
  function readAll() {
    const mine = (() => { try { return Array.isArray(deps.list()) ? deps.list() : []; } catch (_) { return []; } })();
    const others = [];
    let names = [];
    try { names = fs.readdirSync(deps.dir); } catch (_) { names = []; }
    for (const name of names) {
      const m = NAME.exec(name);
      if (!m) continue;
      const owner = Number(m[1]);
      if (owner === pid) continue;
      const file = path.join(deps.dir, name);
      if (!alive(owner)) {
        try { fs.unlinkSync(file); } catch (_) { /* another reader took it */ }
        continue;
      }
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_FILE) continue;
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!v || v.format !== FORMAT || !Array.isArray(v.conversations)) continue;
        others.push({ at: Number(v.at) || 0, conversations: v.conversations });
      } catch (_) { /* half written or not ours */ }
    }
    others.sort((a, b) => b.at - a.at);
    const out = [];
    const seen = new Set();
    for (const c of [mine, ...others.map((o) => o.conversations)].flat()) {
      if (!c || typeof c.sessionId !== 'string' || !c.sessionId || seen.has(c.sessionId)) continue;
      seen.add(c.sessionId);
      out.push(c);
    }
    return out;
  }

  return {
    write,
    readAll,
    file: own,
    dispose() {
      if (closed) return;
      closed = true;
      try { fs.unlinkSync(own); } catch (_) { /* never written */ }
    },
  };
}

module.exports = { createWindowStates, processAlive, FORMAT };
