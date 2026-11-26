// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Where, outside VS Code, an OpenCode session is open or runs (the session list's `elsewhere`), and which sessions
 * `opencode run` started (their `kind` is 'background').
 *
 *   terminal interface   `opencode` with no subcommand, or `opencode mini`. It keeps the tabs it shows, by folder, in
 *                        state/<channel>/tui/tabs.json, and leaves the file as it is when it exits so as to bring the
 *                        tabs back, so a tab counts as open only while a terminal interface runs in that folder.
 *   opencode run         a process `opencode run …`. A session it creates appears within seconds of the process
 *                        starting, in its folder; with -s or -c it continues one, which keeps the kind it had.
 *   background service   its /api/session/active lists the sessions in a turn there: the terminal interface's, an
 *                        `opencode run`'s that went through it, the web and desktop clients'.
 *
 * Processes: on Linux from /proc (argv, folder, the terminal of fd 0, start time). On macOS `ps` gives argv, terminal and
 * start time and `lsof` the folder. Windows lets no process read another's folder, so a terminal interface there is
 * placed in the folder its command line names, or in none.
 */
const fsDefault = require('fs');
const path = require('path');
const os = require('os');

const SUBCOMMANDS = new Set(['upgrade', 'update', 'uninstall', 'acp', 'api', 'debug', 'auth', 'mcp', 'plugin', 'models', 'stats', 'mini',
  'run', 'session', 'service', 'reload', 'machine', 'pair', 'serve']);
/* Flags of `opencode` and `opencode run` that take a value, so that the value is not taken for a subcommand. */
const WITH_VALUE = new Set(['-s', '--session', '--prompt', '--server', '--log-level', '-m', '--model', '--agent', '--title', '--format',
  '-f', '--file', '-w', '--worktree', '--completions']);
const RUN_CREATES_WITHIN_MS = 60000;
const RUN_STARTS_BEFORE_MS = 2000;

const isOpenCode = (argv0) => /^opencode(\.exe)?$/i.test(String(argv0 || '').split(/[\\/]/).pop());

/* What an OpenCode process is: { role: 'terminal' | 'run' | 'other', dir, session, continues, fork } from its argv. */
function roleOf(argv) {
  if (!Array.isArray(argv) || !argv.length || !isOpenCode(argv[0])) return null;
  let sub = '';
  let dir = '';
  let session = '';
  let continues = false;
  let fork = false;
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '-s' || a === '--session') { session = String(argv[i + 1] || ''); i++; continue; }
    if (a.startsWith('--session=')) { session = a.slice(10); continue; }
    if (a === '-c' || a === '--continue') { continues = true; continue; }
    if (a === '--fork') { fork = true; continue; }
    if (WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (!sub && !dir) {
      if (SUBCOMMANDS.has(a)) { sub = a; continue; }
      dir = a;
      continue;
    }
    if (sub) break;
  }
  if (!sub || sub === 'mini') return { role: 'terminal', dir, session, continues, fork };
  if (sub === 'run') return { role: 'run', dir: '', session, continues: continues || !!session, fork };
  return { role: 'other', dir: '', session: '', continues: false, fork: false };
}

/* ---------- processes ---------- */

function linuxProcesses(proc, fs) {
  const out = [];
  let boot = 0;
  let hz = 100;
  try { boot = Number((/^btime\s+(\d+)/m.exec(fs.readFileSync(path.join(proc, 'stat'), 'utf8')) || [])[1]) * 1000; } catch (_) { boot = 0; }
  let names = [];
  try { names = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch (_) { return out; }
  for (const n of names) {
    const dir = path.join(proc, n);
    let argv;
    try { argv = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0').filter((x, i, a) => x || i < a.length - 1); } catch (_) { continue; }
    if (!argv.length || !isOpenCode(argv[0])) continue;
    let cwd = '';
    let tty = '';
    let startedAt = 0;
    try { cwd = fs.readlinkSync(path.join(dir, 'cwd')); } catch (_) { cwd = ''; }
    try { const t = fs.readlinkSync(path.join(dir, 'fd', '0')); if (/^\/dev\/(pts\/\d+|tty\w*)$/.test(t)) tty = t.slice(5); } catch (_) { tty = ''; }
    try {
      const st = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      const after = st.slice(st.lastIndexOf(')') + 2).split(' ');
      startedAt = boot ? Math.round(boot + (Number(after[19]) / hz) * 1000) : 0;
    } catch (_) { startedAt = 0; }
    out.push({ pid: Number(n), argv, cwd, tty, startedAt });
  }
  return out;
}

function run(execFile, file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

/* `ps -axo pid=,lstart=,tty=,command=` lines, then `lsof -a -d cwd -Fpn -p <pids>` for their folders. */
async function macProcesses(execFile) {
  const out = [];
  for (const line of (await run(execFile, 'ps', ['-axo', 'pid=,lstart=,tty=,command='])).split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const argv = m[4].trim().split(/\s+/);
    if (!isOpenCode(argv[0])) continue;
    const t = Date.parse(m[2]);
    out.push({ pid: Number(m[1]), argv, cwd: '', tty: m[3] === '??' ? '' : m[3], startedAt: isFinite(t) ? t : 0 });
  }
  if (out.length) {
    let pid = 0;
    for (const line of (await run(execFile, 'lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', out.map((p) => p.pid).join(',')])).split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n')) { const p = out.find((x) => x.pid === pid); if (p) p.cwd = line.slice(1); }
    }
  }
  return out;
}

/* Win32_Process through PowerShell: id, command line and creation time; no folder. */
async function windowsProcesses(execFile) {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Select-Object ProcessId,CommandLine,@{n='Started';e={[DateTimeOffset]$_.CreationDate | ForEach-Object { $_.ToUnixTimeMilliseconds() }}} | ConvertTo-Json -Compress";
  const text = await run(execFile, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  let v;
  try { v = JSON.parse(text || '[]'); } catch (_) { return []; }
  return (Array.isArray(v) ? v : [v]).filter((p) => p && p.ProcessId).map((p) => ({
    pid: Number(p.ProcessId), argv: splitWindows(String(p.CommandLine || '')), cwd: '', tty: '', startedAt: Number(p.Started) || 0,
  })).filter((p) => isOpenCode(p.argv[0]));
}

/* A Windows command line split the way the C runtime splits it, near enough for program names and flags. */
function splitWindows(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (any || cur) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

/* ---------- the terminal interface's tabs ---------- */

/* { folder: Set of session ids } from every state/<channel>/tui/tabs.json. */
function readTabs(stateDir, fs) {
  const out = new Map();
  if (!stateDir) return out;
  let channels = [];
  try { channels = fs.readdirSync(stateDir); } catch (_) { return out; }
  for (const c of channels) {
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(stateDir, c, 'tui', 'tabs.json'), 'utf8')); } catch (_) { continue; }
    for (const [folder, part] of Object.entries((v && v.cwd) || {})) {
      const ids = (part && Array.isArray(part.tabs) ? part.tabs : []).map((t) => t && t.sessionID).filter((x) => typeof x === 'string');
      if (!ids.length) continue;
      const set = out.get(folder) || new Set();
      for (const id of ids) set.add(id);
      out.set(folder, set);
    }
  }
  return out;
}

/* ---------- putting them together ---------- */

/* `dir` with the home folder written ~, whether `homes` names the home folder as given or as its real path. */
const short = (dir, homes) => {
  for (const h of homes) if (h && (dir === h || dir.startsWith(h + path.sep))) return `~${dir.slice(h.length)}`;
  return dir;
};
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');

/*
 * deps:
 *   platform, proc ('/proc'), fs, execFile, home
 *   stateDir()    Promise of OpenCode's state folder
 *   active()      Promise of the Set of session ids in a turn in the background service
 *   memory        { get(): object, set(object) } where the sessions `opencode run` created are kept: { id: at }
 *   ours(id)      whether this extension created the session
 */
function createElsewhere(deps) {
  const fs = deps.fs || fsDefault;
  const platform = deps.platform || process.platform;
  const home = deps.home || os.homedir();
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch (_) { realHome = home; }
  const homes = [...new Set([home, realHome])];

  async function processes() {
    if (platform === 'linux') return linuxProcesses(deps.proc || '/proc', fs);
    if (platform === 'darwin') return macProcesses(deps.execFile);
    if (platform === 'win32') return windowsProcesses(deps.execFile);
    return [];
  }

  async function scan() {
    const [procs, stateDir, active] = await Promise.all([
      processes().catch(() => []),
      Promise.resolve().then(() => deps.stateDir()).catch(() => ''),
      Promise.resolve().then(() => deps.active()).catch(() => new Set()),
    ]);
    const roles = [];
    for (const p of procs) {
      const r = roleOf(p.argv);
      if (!r || r.role === 'other') continue;
      let folder = r.dir ? path.resolve(p.cwd || '/', r.dir) : p.cwd;
      /* OpenCode keeps a session's folder as a real path. */
      if (folder && r.dir) { try { folder = fs.realpathSync(folder); } catch (_) { /* as given */ } }
      roles.push({ ...p, ...r, folder });
    }
    return { at: Date.now(), procs: roles, tabs: readTabs(stateDir, fs), active };
  }

  /* Marks the session each `opencode run` in `reading` created: the first one in its folder within a minute of its start. */
  function noteRuns(records, reading) {
    const known = { ...(deps.memory.get() || {}) };
    let changed = false;
    for (const p of reading.procs) {
      if (p.role !== 'run' || (p.continues && !p.fork) || !p.startedAt || !p.folder) continue;
      const made = records.filter((r) => r.cwd === p.folder && !r.parentId && !deps.ours(r.id) && !known[r.id]
        && r.createdAt >= p.startedAt - RUN_STARTS_BEFORE_MS && r.createdAt <= p.startedAt + RUN_CREATES_WITHIN_MS)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (made) { known[made.id] = made.createdAt; changed = true; }
    }
    if (changed) deps.memory.set(known);
    return known;
  }

  /* 'subagent', 'background' or 'user'. */
  function kindOf(record, known = deps.memory.get() || {}) {
    if (record.parentId) return 'subagent';
    if (known[record.id]) return 'background';
    return 'user';
  }

  function placesOf(record, reading, known = deps.memory.get() || {}) {
    const out = [];
    const running = reading.active.has(record.id);
    for (const p of reading.procs) {
      if (p.role !== 'terminal' || !p.folder) continue;
      const tabs = reading.tabs.get(p.folder);
      if (!tabs || !tabs.has(record.id)) continue;
      out.push({
        kind: 'terminal',
        label: `terminal${p.tty ? ` ${p.tty}` : ''} in ${short(p.folder, homes)}`.slice(0, 80),
        detail: [`OpenCode's terminal interface, process ${p.pid}`, `Folder: ${p.folder}`, ...(p.startedAt ? [`Started ${when(p.startedAt)}`] : [])],
        running,
      });
    }
    if (known[record.id]) {
      for (const p of reading.procs) {
        if (p.role !== 'run' || p.folder !== record.cwd || !p.startedAt || Math.abs(known[record.id] - p.startedAt) > RUN_CREATES_WITHIN_MS) continue;
        out.push({
          kind: 'exec',
          label: `opencode run in ${short(p.folder, homes)}`.slice(0, 80),
          detail: [`Process ${p.pid}${p.tty ? ` on ${p.tty}` : ''}`, `Folder: ${p.folder}`, ...(p.startedAt ? [`Started ${when(p.startedAt)}`] : [])],
          running: true,
        });
      }
    }
    if (running && !out.length) {
      out.push({ kind: 'other', label: "OpenCode's background service", detail: ['A turn runs in the background service OpenCode\'s terminal interface, its web and desktop apps and `opencode run` share'], running: true });
    }
    return out.slice(0, 8).map((x) => ({ ...x, detail: x.detail.map((d) => d.slice(0, 200)) }));
  }

  return { scan, noteRuns, kindOf, placesOf, processes };
}

module.exports = { createElsewhere, roleOf, readTabs, linuxProcesses, macProcesses, windowsProcesses, splitWindows, isOpenCode, RUN_CREATES_WITHIN_MS };
