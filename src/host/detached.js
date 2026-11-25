// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Detached commands: processes a conversation's shell started that left OpenCode behind, such as `nohup job &`, and
 * still run. OpenCode 2.4.1 gives every command its shell tool runs OPENCODE_SESSION_ID=<the ACP session id>, and a
 * detached one keeps it while its parent becomes init. So on Linux, a process whose environment names the conversation
 * and that is not under the `opencode acp` this window started is one of them. /proc is read only when asked (a turn
 * starts or ends, the background list opens); a process whose environment cannot be read (another user's) is skipped.
 * Other systems have no such list.
 */
const fs = require('fs');
const path = require('path');

const MAX_LISTED = 20;
const CMDLINE_CHARS = 300;

/* The parent pid and start time (clock ticks after boot) from /proc/<pid>/stat, or null. */
function statOf(proc, pid) {
  let text;
  try { text = fs.readFileSync(path.join(proc, pid, 'stat'), 'utf8'); } catch (_) { return null; }
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 2).split(' ');
  return { ppid: Number(rest[1]) || 0, start: Number(rest[19]) || 0 };
}

/* The system's boot time in epoch seconds from /proc/stat, or 0. */
function bootTime(proc) {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync(path.join(proc, 'stat'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch (_) { return 0; }
}

/*
 * Processes of conversation `sessionId` outside the tree of `rootPid`: [{ pid, command, startedAt }], oldest first,
 * at most MAX_LISTED. `proc` is the /proc folder (a test gives another), `ticks` the clock ticks per second (100 on
 * Linux).
 */
function scan({ sessionId, rootPid = 0, proc = '/proc', ticks = 100, self = process.pid } = {}) {
  if (!sessionId) return [];
  let names;
  try { names = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch (_) { return []; }
  const want = `OPENCODE_SESSION_ID=${sessionId}`;
  const stats = new Map();
  const ofPid = (pid) => {
    if (!stats.has(pid)) stats.set(pid, statOf(proc, String(pid)));
    return stats.get(pid);
  };
  /* Whether `pid` is `rootPid` or below it. */
  const under = (pid) => {
    let p = pid;
    for (let i = 0; i < 64 && p > 1; i++) {
      if (p === rootPid) return true;
      const s = ofPid(p);
      if (!s) return false;
      p = s.ppid;
    }
    return false;
  };
  const boot = bootTime(proc);
  const out = [];
  for (const name of names) {
    const pid = Number(name);
    if (pid === self) continue;
    let env;
    try { env = fs.readFileSync(path.join(proc, name, 'environ'), 'utf8'); } catch (_) { continue; }
    if (!env.split('\0').includes(want)) continue;
    if (rootPid && under(pid)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(path.join(proc, name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch (_) { continue; }
    if (!cmd) continue;
    const s = ofPid(pid);
    const startedAt = s && boot ? Math.round((boot + s.start / ticks) * 1000) : 0;
    out.push({ pid, command: cmd.length > CMDLINE_CHARS ? `${cmd.slice(0, CMDLINE_CHARS - 1)}…` : cmd, startedAt });
  }
  out.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
  return out.slice(0, MAX_LISTED);
}

/* Whether this system can list them: Linux, with a readable /proc. */
function supported(platform = process.platform, proc = '/proc') {
  if (platform !== 'linux') return false;
  try { return fs.statSync(path.join(proc, 'self')).isDirectory(); } catch (_) { return false; }
}

module.exports = { scan, supported, statOf, bootTime, MAX_LISTED };
