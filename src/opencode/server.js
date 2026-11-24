// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Finds the opencode executable and starts `opencode acp` for this window. ACP runs over the child's stdin/stdout, so
 * every window has its own process; all conversations open in the window share it.
 *
 * OpenCode 1.x serves an HTTP API from inside `acp` as well, on 127.0.0.1 and without a password unless
 * OPENCODE_SERVER_PASSWORD is set, which would let any local user run tools as us; so a random one is always set.
 * OpenCode 2.x `acp` starts a private server of its own (`serve --stdio --port 0`) that inherits the environment set
 * here (AWS credentials, the permission rules below), whether or not the machine's shared background service runs.
 *
 * Its other subcommands are different: `opencode api`, `session list`, `session export` and the like connect to the
 * shared background service, and start a lasting one with our environment when none runs, which the user's own
 * OpenCode would then use. On 2.x every subcommand this extension runs goes through subcommandArgs(), which adds
 * `--standalone` (a private server for that one command).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const INSTALL_HINT = 'Install it with `curl -fsSL https://opencode.ai/install | bash` or `npm install -g opencode-ai`, '
  + 'then reload the window. If it is installed somewhere else, set its path in the settings.';

class OpenCodeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

function candidates({ env, platform, home }) {
  const names = platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  dirs.push(
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
  );
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'opencode', 'bin'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }
  const out = [];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (!out.includes(p)) out.push(p); }
  return out;
}

function isExecutable(p, platform) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], text: m[0] } : null;
}

const versionCache = new Map();

function readVersion(bin) {
  let key = bin;
  try { const st = fs.statSync(bin); key = `${bin}\0${st.mtimeMs}\0${st.size}`; } catch (_) { /* uncached */ }
  if (versionCache.has(key)) return versionCache.get(key);
  const r = childProcess.spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const v = parseVersion(`${r.stdout || ''} ${r.stderr || ''}`);
  versionCache.set(key, v);
  return v;
}

/*
 * The configured path, then PATH, then the places the installers use. Returns { path, version } (version may be null
 * when `--version` printed nothing usable) or throws an OpenCodeError whose message tells the user what to do.
 */
function findOpenCode(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const executable = opts.isExecutable || ((p) => isExecutable(p, platform));
  const version = opts.readVersion || readVersion;
  const configured = typeof opts.configured === 'string' ? opts.configured.trim() : '';
  if (configured) {
    const p = expandHome(configured, home);
    if (!executable(p)) throw new OpenCodeError('configuredNotFound', `The OpenCode path in the settings (${p}) is not an executable file. ${INSTALL_HINT}`);
    return { path: p, version: version(p) };
  }
  for (const p of candidates({ env, platform, home })) {
    if (executable(p)) return { path: p, version: version(p) };
  }
  throw new OpenCodeError('notFound', `OpenCode was not found. ${INSTALL_HINT}`);
}

/* The first OpenCode its question tool's forms were seen to work with: 2.4.1 asks them as elicitation/create once the
   client declares elicitation.form. An earlier 2.x was not tried, and if it does not send them, a question would wait
   for an answer nobody can give. */
const QUESTIONS_FROM = Object.freeze({ major: 2, minor: 4, patch: 1 });

/* Whether `version` ({ major, minor, patch }) is QUESTIONS_FROM or later; a bare major number is not enough to tell. */
function asksQuestions(version) {
  if (!version || typeof version !== 'object') return false;
  const a = [version.major, version.minor, version.patch].map((n) => Number(n) || 0);
  const b = [QUESTIONS_FROM.major, QUESTIONS_FROM.minor, QUESTIONS_FROM.patch];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/* Default rules: ask before edits, commands, web fetches and paths outside the project. From QUESTIONS_FROM on, the
 * question tool asks through forms the chat page answers; before it (1.x has no way to ask over ACP at all) the tool
 * is off. Written once per config dialect: 1.x reads `permission`, 2.x reads `permissions`. `version` is the one
 * findOpenCode() read, or just its major. */
function permissionConfig(version) {
  const major = typeof version === 'number' ? version : (version && version.major) || 1;
  const questions = asksQuestions(version);
  if (major >= 2) {
    const rules = [
      { action: 'edit', resource: '*', effect: 'ask' },
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'webfetch', resource: '*', effect: 'ask' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
    ];
    if (!questions) rules.push({ action: 'question', resource: '*', effect: 'deny' });
    return { permissions: rules };
  }
  return { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask', question: 'deny' } };
}

/* Objects merge key by key, arrays concatenate (so rules added later come later and win), anything else is replaced. */
function deepMerge(base, extra) {
  if (Array.isArray(base) && Array.isArray(extra)) return [...base, ...extra];
  if (base && extra && typeof base === 'object' && typeof extra === 'object' && !Array.isArray(base) && !Array.isArray(extra)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return extra === undefined ? base : extra;
}

/* Our keys go in only where the inherited OPENCODE_CONFIG_CONTENT does not already set them. */
function mergeConfigContent(existing, ours) {
  let base = {};
  if (existing) {
    try { const v = JSON.parse(existing); if (v && typeof v === 'object' && !Array.isArray(v)) base = v; } catch (_) { /* replaced */ }
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(ours)) if (!(k in out)) out[k] = v;
  return JSON.stringify(out);
}

/*
 * What to run: { command, args, env }. `permissions: false` leaves OpenCode's own policy alone. `config` is more inline
 * configuration (a plugin, rules of its own) in the dialect of this version line, merged over ours. Autoupdate is off:
 * 1.x would otherwise fetch 2.x in the background and the next start would speak another dialect.
 */
function acpLaunch({ bin, version, env = {}, permissions = true, config = null, baseEnv = process.env, password }) {
  const major = (version && version.major) || 1;
  const merged = { ...baseEnv, ...env };
  merged.OPENCODE_SERVER_PASSWORD = password || crypto.randomBytes(24).toString('base64url');
  merged.OPENCODE_DISABLE_AUTOUPDATE = '1';
  let ours = permissions ? permissionConfig(version || major) : {};
  if (config && typeof config === 'object') ours = deepMerge(ours, config);
  if (Object.keys(ours).length) merged.OPENCODE_CONFIG_CONTENT = mergeConfigContent(merged.OPENCODE_CONFIG_CONTENT, ours);
  const args = major >= 2 ? ['acp'] : ['acp', '--hostname', '127.0.0.1'];
  return { command: bin, args, env: merged };
}

/* The arguments of an OpenCode subcommand other than `acp` (see the top of this file); 1.x has no `--standalone`. */
function subcommandArgs(version, args) {
  return (version && version.major >= 2) ? [...args, '--standalone'] : [...args];
}

/* The environment of such a subcommand. */
function subcommandEnv(env = {}, baseEnv = process.env) {
  return { ...baseEnv, ...env, OPENCODE_DISABLE_AUTOUPDATE: '1' };
}

/*
 * Starts the process. stderr is kept as a short tail for error messages. The child exits on its own when stdin
 * closes, so a crashed extension host does not leave it behind.
 */
function startAcp(opts) {
  const launch = acpLaunch(opts);
  const spawn = opts.spawn || childProcess.spawn;
  const cwd = opts.cwd || os.homedir();
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let tail = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
  }
  return { child, stderrTail: () => tail, args: launch.args };
}

/* Ends stdin, then kills if it has not gone after `graceMs`. */
function stopAcp(child, graceMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } resolve(); }, graceMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.stdin.end(); } catch (_) { /* closed */ }
    try { child.kill('SIGTERM'); } catch (_) { /* gone */ }
  });
}

module.exports = {
  OpenCodeError,
  INSTALL_HINT,
  findOpenCode,
  parseVersion,
  permissionConfig,
  asksQuestions,
  QUESTIONS_FROM,
  mergeConfigContent,
  deepMerge,
  acpLaunch,
  startAcp,
  stopAcp,
  candidates,
  subcommandArgs,
  subcommandEnv,
};
