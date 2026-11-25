// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversations backed by OpenCode over the Agent Client Protocol: what the UI and the wiring call. One `opencode acp`
 * process per window (src/opencode/server.js), started on first use and stopped when no conversation has been open
 * for `idleStopMs`. Each conversation object speaks contracts.js AgentEvents (src/opencode/mapper.js).
 *
 * ACP has no rename: on 2.x renameSession goes through /api's session.update (`opencode api ... --standalone`), and
 * 1.x has no way to do it, so it throws there. Deleting uses session/delete where OpenCode offers it (2.x) and
 * `opencode session delete` otherwise.
 *
 * Subagents run in sessions of their own, which 2.x's session/list returns with the rest and nothing to tell them
 * apart. OpenCode names them in opencode/session/child_update, which it sends once the client declares
 * _meta["opencode/child-session-updates"]; those ids, and the ones created here as roots, go into
 * opencode-sessions.json, which every window reads. A listed id none of them knows is looked up once with
 * `opencode api --standalone session.list`, whose rows carry parentID.
 *
 * When a subagent or a background shell finishes, 2.x starts a turn of the parent on its own: no session/prompt
 * answers it and no usage_update follows. Such a turn is reported as a turnStart with `unsolicited: true` and ends
 * once nothing more has come for a while (see OWN_QUIET_MS).
 *
 * The mode and effort that OpenCode lists for a session are read with options() and set with setOption().
 *
 * The rest is used when OpenCode announces it, whatever its version. Slash commands come in available_commands_update
 * (commands()), and images and embedded files are sent as promptCapabilities allow (attachments()). Compaction updates
 * need the client capability session.compaction, and a subagent's progress comes in child_update. The question tool
 * asks with elicitation/create forms once the client declares elicitation.form (respondQuestion()); answering one with
 * cancel or decline makes 2.4.1 end the turn as cancelled.
 *
 * Opening a conversation also runs OpenCode's export of it (`session export` on 2.x, `export` on 1.x), alongside
 * session/load, for the times the replay lacks (src/opencode/times.js); when it fails the replay is shown as it is.
 * Rewinding (2.x, experimental /api) stages the revert, which puts the files back at once and lists them; the caller
 * then commits it or clears it, which puts them back again. A shell command the model moved to the background is
 * reported as a `background` event while its process runs; OpenCode says nothing over ACP when it ends, so
 * checkBackground() looks for the process when a turn starts or ends and when the chat page asks.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const childProcess = require('child_process');
const paths = require('../paths');
const brand = require('../brand');
const server = require('./server');
const { createConnection, METHOD_NOT_FOUND, TIMED_OUT } = require('./client');
const mapper = require('./mapper');
const quietWrites = require('./quiet-writes');
const times = require('./times');

const PROTOCOL_VERSION = 1;
const NEW_SESSION_TIMEOUT_MS = 60000;
const BEDROCK = 'amazon-bedrock';
const CHILD_UPDATES = 'opencode/child-session-updates';
const CHILD_UPDATE = 'opencode/session/child_update';
/* The config options shown next to the model, in this order. */
const SHOWN_OPTIONS = Object.freeze(['mode', 'effort']);
/*
 * How long a turn OpenCode started itself may stay silent before it counts as over: shorter after reply text, which
 * ends a turn, than after anything else. A running tool, an unanswered permission request or question, or a scheduled
 * retry keeps it open. Measured on 2.4.1: the steps of such a turn follow each other within a second.
 */
const OWN_QUIET_MS = 20000;
const OWN_AFTER_TEXT_MS = 4000;
const KINDS_KEPT = 5000;
const LOOKUP_ROWS = 200;
const MAX_TITLE = 200;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
/* Command lists kept for sessions not open yet: 2.4.1 sends one right after answering session/new or session/load. */
const COMMANDS_KEPT = 50;
const CHILD_STATUS = Object.freeze({ created: 'running', running: 'running', completed: 'done', interrupted: 'stopped', failed: 'failed' });
/* The events of a subagent's own stream that its card shows. */
const CHILD_EVENTS = new Set(['text', 'reasoning', 'toolCall', 'toolResult']);
const SUBAGENT_TOOLS = new Set(['subagent', 'task']);
/* Opening a conversation waits this long for its export after session/load has answered. */
const EXPORT_WAIT_MS = 5000;
const EXPORT_BUFFER = 64 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const MIME = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' });

function commandList(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.name === 'string' && c.name)
    .map((c) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : '' }));
}

/* The ACP blocks of the files sent with a message, and what the page shows for them. A file with `text` is a selection
   sent with its text (embedded, when OpenCode takes embedded context; inline text otherwise); one without is a link
   OpenCode reads itself. */
function fileBlocks(files, embedded) {
  const prompt = [];
  const shown = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path)) continue;
    const name = typeof f.name === 'string' && f.name ? f.name : path.basename(f.path);
    let uri;
    try { uri = pathToFileURL(f.path).href; } catch (_) { continue; }
    if (typeof f.text === 'string') {
      const from = Number(f.startLine) > 0 ? Math.floor(Number(f.startLine)) : 0;
      const to = Number(f.endLine) > from ? Math.floor(Number(f.endLine)) : from;
      const label = from ? `${name}:${from}${to > from ? `-${to}` : ''}` : name;
      if (embedded) prompt.push({ type: 'resource', resource: { uri: from ? `${uri}#L${from}${to > from ? `-L${to}` : ''}` : uri, mimeType: f.mimeType || 'text/plain', text: f.text } });
      else prompt.push({ type: 'text', text: `[${f.path}${from ? `:${from}` : ''}]\n${f.text}` });
      shown.push({ kind: 'selection', name: label, path: f.path });
    } else {
      const mime = f.mimeType || MIME[path.extname(f.path).slice(1).toLowerCase()];
      prompt.push({ type: 'resource_link', uri, name, ...(mime ? { mimeType: mime } : {}) });
      shown.push({ kind: 'file', name, path: f.path });
    }
  }
  return { prompt, shown };
}

function clientVersion() {
  try { return require('../../package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; }
}

function emitter() {
  const listeners = new Set();
  return {
    event(fn) { listeners.add(fn); return { dispose: () => { listeners.delete(fn); } }; },
    fire(v) { for (const fn of [...listeners]) { try { fn(v); } catch (_) { /* the others still run */ } } },
    clear() { listeners.clear(); },
  };
}

function modelValue(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (typeof m.providerID === 'string' && typeof m.modelID === 'string') return `${m.providerID}/${m.modelID}`;
  if (typeof m.id === 'string' && m.id.includes('/')) return m.id;
  if (typeof m.providerId === 'string' && (m.invokeId || m.id)) return `${m.providerId}/${m.invokeId || m.id}`;
  return typeof m.id === 'string' ? m.id : '';
}

/* Whether a process with this id still runs. EPERM also means it runs, as another user's process. */
function processAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/* The fields of `opencode debug paths`: one "<name>  <absolute path>" per line. */
function parsePaths(text) {
  const out = {};
  for (const line of String(text || '').replace(ANSI, '').split('\n')) {
    const m = /^\s*([a-z]+)\s+((?:\/|[A-Za-z]:[\\/]).*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* The help text for reaching Bedrock, with the config example in the dialect of OpenCode `major`. */
function bedrockHelp(major) {
  const config = major >= 2
    ? '{ "providers": { "amazon-bedrock": { "settings": { "profile": "<profile>", "region": "us-east-1" } } } }'
    : '{ "provider": { "amazon-bedrock": { "options": { "profile": "<profile>", "region": "us-east-1" } } } }';
  return [
    'OpenCode reaches Amazon Bedrock with the AWS credential chain. Either:',
    `- an AWS profile: add ${config} to ~/.config/opencode/opencode.json, or start VS Code with AWS_PROFILE and AWS_REGION set;`,
    '- a Bedrock API key: set AWS_BEARER_TOKEN_BEDROCK in the environment VS Code starts with;',
    '- access keys: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
    'Then reload the window so OpenCode starts again with them.',
  ].join('\n');
}

/*
 * opts:
 *   binaryPath     the opencode path from the settings ('' searches PATH and the installers' locations)
 *   env            extra environment for OpenCode (AWS_PROFILE, AWS_REGION, AWS_BEARER_TOKEN_BEDROCK, ...)
 *   permissions    false leaves OpenCode's own permission policy alone (by default edits, commands, web fetches and
 *                  paths outside the project ask first)
 *   config         more inline OpenCode configuration, merged over ours: an object, or line => object where line is
 *                  the version line found (1 or 2), whose config keys differ ("plugin" vs "plugins")
 *   quietFolder    sessionId => a folder, or null: under our permission rules, a write or edit only inside it is
 *                  allowed once without asking (quiet-writes.js)
 *   root, idleStopMs, now, log
 *   newSessionTimeoutMs  how long session/new may take (60 s)
 *   exportWaitMs   overrides EXPORT_WAIT_MS
 *   ownQuietMs, ownAfterTextMs   override OWN_QUIET_MS and OWN_AFTER_TEXT_MS
 *   findOpenCode, startAcp, execFile, isAlive(pid)   test seams
 */
function createOpenCode(opts = {}) {
  const now = opts.now || Date.now;
  const log = (line) => { try { if (opts.log) opts.log(line); } catch (_) { /* not logged */ } };
  const root = opts.root || paths.root();
  const cacheFile = path.join(root, 'opencode-models.json');
  const idleStopMs = typeof opts.idleStopMs === 'number' ? opts.idleStopMs : 10 * 60 * 1000;
  const newSessionTimeoutMs = opts.newSessionTimeoutMs > 0 ? opts.newSessionTimeoutMs : NEW_SESSION_TIMEOUT_MS;
  const ownQuietMs = opts.ownQuietMs > 0 ? opts.ownQuietMs : OWN_QUIET_MS;
  const ownAfterTextMs = opts.ownAfterTextMs > 0 ? opts.ownAfterTextMs : OWN_AFTER_TEXT_MS;
  const find = opts.findOpenCode || server.findOpenCode;
  const start = opts.startAcp || server.startAcp;
  const execFile = opts.execFile || childProcess.execFile;
  const isAlive = opts.isAlive || processAlive;
  const exportWaitMs = opts.exportWaitMs > 0 ? opts.exportWaitMs : EXPORT_WAIT_MS;
  /* The session capabilities OpenCode last said it has, kept when its process stops. */
  let knownSessionCaps = null;
  let settings = { binaryPath: opts.binaryPath || '', env: { ...(opts.env || {}) }, permissions: opts.permissions !== false, config: opts.config || null,
    quietFolder: typeof opts.quietFolder === 'function' ? opts.quietFolder : null };

  let proc = null;
  let gen = 0;
  let idleTimer = null;
  let lastAuthError = null;
  let disposed = false;
  let permSeq = 0;
  let turnSeq = 0;
  const handles = new Map();
  const commandsOf = new Map();
  let promptCaps = {};
  const changed = emitter();
  const fireChanged = (sessionId) => changed.fire({ sessionId });

  let cache = { current: '', option: null, contextWindows: {}, major: 0 };
  try {
    const v = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (v && typeof v === 'object') cache = { ...cache, ...v, contextWindows: { ...(v.contextWindows || {}) } };
  } catch (_) { /* no cache yet */ }
  function saveCache() {
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
    } catch (e) { log(`saving the model list failed: ${e.message}`); }
  }
  function noteModels(configOptions, isNewSessionDefault) {
    const opt = Array.isArray(configOptions) ? configOptions.find((o) => o && (o.id === 'model' || o.category === 'model')) : null;
    if (!opt) return '';
    const before = JSON.stringify(cache.option ? cache.option.options : null);
    const current = typeof opt.currentValue === 'string' ? opt.currentValue : '';
    let dirty = JSON.stringify(opt.options) !== before;
    if (dirty) cache.option = { id: opt.id, options: opt.options };
    if (isNewSessionDefault && current && current !== cache.current) { cache.current = current; dirty = true; }
    if (dirty) saveCache();
    return current;
  }
  function noteContextWindow(model, size) {
    if (!model || !(size > 0) || cache.contextWindows[model] === size) return;
    cache.contextWindows[model] = size;
    saveCache();
  }

  /* Session id -> its parent session's id, '' for a root. Other windows add to the same file, so it is read again
     before each list and merged before each write; it holds the newest KINDS_KEPT ids. */
  const kindsFile = path.join(root, 'opencode-sessions.json');
  function readKinds() {
    try {
      const v = JSON.parse(fs.readFileSync(kindsFile, 'utf8'));
      if (v && v.parents && typeof v.parents === 'object') return new Map(Object.entries(v.parents).filter(([, p]) => typeof p === 'string'));
    } catch (_) { /* none yet */ }
    return new Map();
  }
  let parents = readKinds();
  function noteKinds(pairs) {
    const merged = readKinds();
    for (const [k, v] of parents) if (!merged.has(k)) merged.set(k, v);
    let dirty = false;
    for (const [id, parent] of pairs) {
      if (merged.get(id) === parent) continue;
      merged.delete(id);
      merged.set(id, parent);
      dirty = true;
    }
    while (merged.size > KINDS_KEPT) merged.delete(merged.keys().next().value);
    parents = merged;
    if (!dirty) return;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const tmp = `${kindsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ format: 1, parents: Object.fromEntries(merged) }), { mode: 0o600 });
      fs.renameSync(tmp, kindsFile);
    } catch (e) { log(`saving which sessions are subagents' failed: ${e.message}`); }
  }
  const isChild = (id) => !!parents.get(id);

  /* Parents of `ids` from the rows of OpenCode 2's /api session.list; an id it does not list is taken as a root, so
     each is looked up once. */
  let lookingUp = null;
  function lookUpParents(p, ids) {
    if (lookingUp) return lookingUp;
    lookingUp = new Promise((resolve) => {
      const args = server.subcommandArgs(p.found.version, ['api', 'session.list', '--param', `limit=${LOOKUP_ROWS}`]);
      execFile(p.found.path, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, env: server.subcommandEnv(settings.env), windowsHide: true }, (err, stdout) => {
        const found = [];
        if (err) log(`looking up which sessions are subagents' failed: ${String(err.message).slice(0, 300)}`);
        else {
          try {
            const v = JSON.parse(String(stdout));
            for (const s of (v && Array.isArray(v.data) ? v.data : [])) {
              if (s && typeof s.id === 'string') found.push([s.id, typeof s.parentID === 'string' ? s.parentID : '']);
            }
          } catch (e) { log(`OpenCode's session.list was not JSON: ${e.message}`); }
        }
        const seen = new Set(found.map(([id]) => id));
        for (const id of ids) if (!seen.has(id)) found.push([id, '']);
        noteKinds(found);
        resolve();
      });
    }).finally(() => { lookingUp = null; });
    return lookingUp;
  }

  /* ---------- the process ---------- */

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (handles.size || !proc || !(idleStopMs > 0)) return;
    idleTimer = setTimeout(() => { idleTimer = null; if (!handles.size) stopProcess(); }, idleStopMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function onExit(g, info) {
    if (!proc || proc.gen !== g) return;
    const tail = proc.stderrTail ? proc.stderrTail().trim().split('\n').slice(-3).join(' ') : '';
    proc = null;
    if (!disposed) log(`OpenCode stopped: ${info.message}${tail ? ` — ${tail}` : ''}`);
    for (const h of handles.values()) h.processGone();
  }

  function stopProcess() {
    const p = proc;
    proc = null;
    if (!p) return Promise.resolve();
    for (const h of handles.values()) h.processGone();
    return server.stopAcp(p.child);
  }

  async function onRequest(method, params) {
    if (method === 'session/request_permission') {
      const h = handles.get(params.sessionId);
      if (!h) return { outcome: { outcome: 'cancelled' } };
      /* Only under our rules: with `permissions: false` every request goes to the user. */
      const quiet = settings.permissions ? quietWrites.answer(params, settings.quietFolder) : null;
      if (quiet) {
        log(`allowed without asking: ${(params.toolCall && params.toolCall.name) || 'a tool'} writing in the conversation's own folder`);
        return quiet;
      }
      return h.askPermission(params);
    }
    if (method === 'elicitation/create') {
      const h = handles.get(params.sessionId);
      const schema = params.requestedSchema;
      if (!h || params.mode !== 'form' || !schema || typeof schema !== 'object') return { action: 'decline' };
      return h.askQuestion(params);
    }
    throw { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` };
  }

  function onNotification(method, params) {
    if (method === CHILD_UPDATE) {
      const child = params && typeof params.childSessionId === 'string' ? params.childSessionId : '';
      const parent = params ? String(params.parentSessionId || params.rootSessionId || '') : '';
      if (child && parent && !isChild(child)) { noteKinds([[child, parent]]); fireChanged(child); }
      const h = params && (handles.get(params.rootSessionId) || handles.get(params.parentSessionId));
      if (!h) return;
      /* A subagent's permission request draws its tool in the parent; only these updates say how that tool ends. */
      if (params.type === 'update' && params.update) h.childTool(params.update);
      h.childUpdate(params);
      return;
    }
    if (method !== 'session/update' || !params) return;
    const u = params.update || {};
    if (u.sessionUpdate === 'config_option_update') noteModels(u.configOptions, false);
    if (u.sessionUpdate === 'available_commands_update' && typeof params.sessionId === 'string') {
      commandsOf.delete(params.sessionId);
      commandsOf.set(params.sessionId, commandList(u.availableCommands));
      while (commandsOf.size > COMMANDS_KEPT) commandsOf.delete(commandsOf.keys().next().value);
    }
    const h = handles.get(params.sessionId);
    if (h) h.onUpdate(u);
  }

  function ensure() {
    if (disposed) return Promise.reject(new server.OpenCodeError('disposed', 'OpenCode integration was disposed'));
    if (proc && !proc.conn.closed) return proc.ready;
    let found;
    try {
      found = find({ configured: settings.binaryPath, env: { ...process.env, ...settings.env } });
    } catch (e) {
      return Promise.reject(e);
    }
    const g = ++gen;
    try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch (_) { /* cwd falls back below */ }
    const line = (found.version && found.version.major) || 1;
    let config = null;
    try {
      config = typeof settings.config === 'function' ? settings.config(line) : settings.config;
    } catch (e) {
      log(`building the extra OpenCode config failed: ${e.message}`);
    }
    const started = start({ bin: found.path, version: found.version, env: settings.env, permissions: settings.permissions, config, cwd: fs.existsSync(root) ? root : undefined });
    const conn = createConnection(started.child, { log, onRequest, onNotification, onExit: (info) => onExit(g, info) });
    const p = { gen: g, conn, child: started.child, stderrTail: started.stderrTail, found, info: null, ready: null };
    p.ready = conn.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      /* Child updates also keep a subagent's output out of its parent's stream, where 2.x puts it otherwise. */
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
        session: { compaction: {} },
        _meta: { [CHILD_UPDATES]: true },
      },
      clientInfo: { name: brand.packageName, version: clientVersion() },
    }, { timeoutMs: 60000 }).then((r) => {
      if (!r || r.protocolVersion !== PROTOCOL_VERSION) {
        throw new server.OpenCodeError('protocol', `OpenCode at ${found.path} speaks ACP version ${r && r.protocolVersion}, not ${PROTOCOL_VERSION}.`);
      }
      p.info = {
        version: found.version,
        agent: r.agentInfo || null,
        capabilities: r.agentCapabilities || {},
      };
      knownSessionCaps = (p.info.capabilities && p.info.capabilities.sessionCapabilities) || {};
      const pc = p.info.capabilities.promptCapabilities;
      promptCaps = pc && typeof pc === 'object' ? pc : {};
      const major = (found.version && found.version.major) || 0;
      if (major && cache.major !== major) { cache.major = major; saveCache(); }
      return p;
    }).catch((e) => {
      if (proc === p) proc = null;
      server.stopAcp(started.child);
      const tail = started.stderrTail().trim().split('\n').slice(-3).join(' ');
      const err = e instanceof server.OpenCodeError ? e : new server.OpenCodeError('startFailed', `OpenCode did not start: ${e.message}${tail ? ` (${tail})` : ''}`);
      throw err;
    });
    proc = p;
    armIdle();
    return p.ready;
  }

  const caps = (p) => (p && p.info && p.info.capabilities) || {};
  const sessionCaps = (p) => caps(p).sessionCapabilities || {};

  /* ---------- subcommands ---------- */

  /* The OpenCode in use, or the one that would start; throws like findOpenCode. */
  const foundNow = () => (proc && proc.found ? proc.found : find({ configured: settings.binaryPath, env: { ...process.env, ...settings.env } }));

  /* Runs `opencode <args>` (subcommandArgs adds --standalone on 2.x); resolves { stdout, stderr }, or rejects with an
     OpenCodeError of `code` carrying OpenCode's error message. */
  function runSub(found, args, code, { timeout = 30000, maxBuffer = 8 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(found.path, server.subcommandArgs(found.version, args), { timeout, maxBuffer, env: server.subcommandEnv(settings.env), windowsHide: true }, (err, stdout, stderr) => {
        if (!err) { resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') }); return; }
        let why = '';
        try { const v = JSON.parse(String(stdout)); if (v && typeof v.message === 'string') why = v.message; } catch (_) { /* not JSON */ }
        reject(new server.OpenCodeError(code, (why || String(stderr || err.message)).replace(ANSI, '').trim().slice(0, 300)));
      });
    });
  }

  /* The export of a session, parsed, or null; never rejects. */
  function exportOf(found, id) {
    const major = (found && found.version && found.version.major) || 1;
    return runSub(found, major >= 2 ? ['session', 'export', id] : ['export', id], 'exportFailed', { timeout: 60000, maxBuffer: EXPORT_BUFFER })
      .then((r) => JSON.parse(r.stdout), (e) => { log(`exporting ${id} for its times failed: ${e.message}`); return null; })
      .catch((e) => { log(`the export of ${id} was not JSON: ${e.message}`); return null; });
  }

  /* Waits for the export at most `waitMs` after `after` settles; resolves with its times lookup, or null. */
  async function timesAfter(exporting, after, waitMs) {
    try { await after; } catch (_) { /* the caller handles it */ }
    let t = null;
    const late = new Promise((resolve) => { t = setTimeout(() => resolve(null), waitMs); if (t.unref) t.unref(); });
    const v = await Promise.race([exporting, late]);
    clearTimeout(t);
    if (!v) return null;
    return times.lookupOf(v);
  }

  /* ---------- one conversation ---------- */

  function makeHandle(id, cwd, title) {
    const m = mapper.createMapper({ now });
    const subs = new Set();
    const queue = [];
    const asks = new Map();
    /* Forms OpenCode's question tool is waiting on: requestId -> { resolve }. */
    const questions = new Map();
    /* Subagents of this conversation: child session id -> { title, status, mapper, toolId }; and the subagent tool
       call each was started by, once known. */
    const children = new Map();
    const childTool = new Map();
    const h = {
      id,
      cwd,
      title: title || '',
      status: 'idle',
      waitingTool: '',
      waitingKind: '',
      commandList: commandsOf.get(id) || [],
      lastUserAt: 0,
      lastReplyAt: 0,
      model: '',
      modelGen: 0,
      loadedGen: 0,
      events: [],
      /* What each replayed event came from: { mid, call }, for its time in the export. */
      metas: [],
      replay: null,
      /* Shell commands moved to the background: tool call id -> { pid, title, status }. */
      background: new Map(),
      running: null,
      /* A turn OpenCode began on its own: { turnId, timer, afterText, tools, retrying }. */
      own: null,
      /* The shown config options as OpenCode last reported them, and values chosen here not yet sent. */
      config: [],
      pendingOptions: new Map(),
      disposed: false,
    };
    let optionsKey = '[]';

    function emit(evs) {
      for (const ev of evs) {
        if (ev.type === 'title') h.title = ev.title;
        if (ev.type === 'usage' && m.contextWindow) noteContextWindow(h.model, m.contextWindow);
        for (const fn of [...subs]) { try { fn(ev); } catch (e) { log(`a listener of ${id} failed: ${(e && e.stack) || e}`); } }
      }
    }
    function setStatus(status, tool, kind) {
      const waitingTool = status === 'waiting' ? (tool || h.waitingTool) : '';
      const waitingKind = status === 'waiting' ? (kind || h.waitingKind || 'permission') : '';
      if (h.status === status && h.waitingTool === waitingTool && h.waitingKind === waitingKind) return;
      h.status = status;
      h.waitingTool = waitingTool;
      h.waitingKind = waitingKind;
      fireChanged(id);
    }
    /* The status once an answer has come: waiting on the newest request still open, otherwise working or idle. */
    function settleStatus() {
      const open = [...asks.values(), ...questions.values()].sort((a, b) => a.seq - b.seq).pop();
      if (open) setStatus('waiting', open.tool, open.kind);
      else setStatus(h.running || h.own ? 'working' : 'idle');
    }
    function cancelAsks() {
      for (const a of asks.values()) a.resolve({ outcome: { outcome: 'cancelled' } });
      asks.clear();
      for (const q of questions.values()) q.resolve({ action: 'cancel' });
      questions.clear();
    }

    /* contracts.js ConfigOption[] of the shown options. */
    function publicOptions() {
      return h.config.map((o) => ({
        id: o.id,
        name: String(o.name || o.id),
        value: typeof o.currentValue === 'string' ? o.currentValue : '',
        values: o.options.filter((x) => x && typeof x.value === 'string').map((x) => {
          const v = { value: x.value, name: String(x.name || x.value) };
          if (typeof x.description === 'string' && x.description) v.description = x.description;
          return v;
        }),
      }));
    }
    /* OpenCode's configOptions, from any reply or config_option_update. Setting the mode answers with the old value and
       sends the new one in a config_option_update right after (2.4.1), so `asked` keeps the value just requested. */
    function noteConfig(configOptions, asked) {
      if (!Array.isArray(configOptions)) return;
      h.config = SHOWN_OPTIONS.map((k) => configOptions.find((o) => o && o.id === k && Array.isArray(o.options))).filter(Boolean).map((o) => ({ ...o }));
      for (const [k, v] of [...(asked || []), ...h.pendingOptions]) {
        const o = h.config.find((x) => x.id === k);
        if (o && o.options.some((x) => x && x.value === v)) o.currentValue = v;
      }
      const opts = publicOptions();
      const key = JSON.stringify(opts);
      if (key === optionsKey) return;
      optionsKey = key;
      emit([{ type: 'options', options: opts }]);
    }
    /* The effort a turn runs with, for the figures under its reply; '' for OpenCode's 'default'. A value chosen
       here and not yet answered counts: the message that follows goes only after it has been set. */
    function effortNow() {
      const o = h.config.find((x) => x.id === 'effort');
      const v = h.pendingOptions.has('effort') ? h.pendingOptions.get('effort') : (o && typeof o.currentValue === 'string' ? o.currentValue : '');
      return v && v !== 'default' ? v : '';
    }
    /* A value stays pending until OpenCode has answered, so a config_option_update of an earlier change arriving
       meanwhile (seen on 2.4.1) does not show the old value again. One loop at a time sends them, in the order chosen,
       and takes in values chosen while it runs. */
    let applying = null;
    function applyOptions(p) {
      if (applying) return applying;
      applying = (async () => {
        while (h.pendingOptions.size && !p.conn.closed) {
          const [k, v] = h.pendingOptions.entries().next().value;
          let r;
          try {
            r = await p.conn.request('session/set_config_option', { sessionId: id, configId: k, value: v });
          } finally {
            if (h.pendingOptions.get(k) === v) h.pendingOptions.delete(k);
          }
          noteConfig(r && r.configOptions, [[k, v]]);
        }
      })().finally(() => { applying = null; });
      return applying;
    }

    /* ---------- a turn OpenCode started itself ---------- */

    function ownBegin() {
      if (h.running || h.own || h.disposed) return;
      const turnId = `t${now().toString(36)}-${++turnSeq}`;
      h.own = { turnId, timer: null, afterText: false, tools: new Set(), retrying: false };
      setStatus('working');
      emit(m.beginOwn(turnId, now(), h.model || undefined, effortNow() || undefined));
      checkBackground();
    }
    function ownArm() {
      const own = h.own;
      if (!own) return;
      if (own.timer) clearTimeout(own.timer);
      own.timer = null;
      if (asks.size || questions.size || own.tools.size || own.retrying) return;
      own.timer = setTimeout(() => { if (h.own === own) ownEnd(); }, own.afterText ? ownAfterTextMs : ownQuietMs);
      if (typeof own.timer.unref === 'function') own.timer.unref();
    }
    /* Notes from an update which tools are running, whether a retry is waiting and whether the latest output is reply
       text. */
    function ownNote(u) {
      const own = h.own;
      if (!own) return;
      const k = u.sessionUpdate;
      if ((k === 'tool_call' || k === 'tool_call_update') && typeof u.toolCallId === 'string') {
        if (u.status === 'completed' || u.status === 'failed') own.tools.delete(u.toolCallId);
        else own.tools.add(u.toolCallId);
      }
      if (k === 'session_info_update' && u._meta && Object.prototype.hasOwnProperty.call(u._meta, mapper.RETRY_META)) own.retrying = !!u._meta[mapper.RETRY_META];
      if (k === 'agent_message_chunk' || k === 'agent_thought_chunk' || k === 'tool_call' || k === 'tool_call_update') own.afterText = k === 'agent_message_chunk';
      ownArm();
    }
    /* Whether an update that comes while no turn runs here shows OpenCode working: output, a new tool call, a retry,
       a compaction starting. */
    function startsOwn(u) {
      const k = u.sessionUpdate;
      if (k === 'agent_message_chunk' || k === 'agent_thought_chunk') return !!(u.content && u.content.type === 'text' && u.content.text);
      if (k === 'tool_call') return true;
      if (k === 'tool_call_update') return typeof u.toolCallId === 'string' && !m.toolName(u.toolCallId);
      if (k === 'session_info_update') return !!(u._meta && u._meta[mapper.RETRY_META]);
      if (k === 'compaction_update') return u.status === 'in_progress';
      return false;
    }
    function ownEnd(error, aborted) {
      const own = h.own;
      if (!own) return;
      if (own.timer) clearTimeout(own.timer);
      h.own = null;
      const evs = m.end(aborted ? { stopReason: 'cancelled' } : { stopReason: 'end_turn' }, error || undefined);
      emit(evs);
      const endEv = evs.find((e) => e.type === 'turnEnd');
      if (endEv && endEv.reason !== 'aborted') h.lastReplyAt = endEv.at;
      settleStatus();
      checkBackground();
      const p = proc;
      if (p && !p.conn.closed && !error) refreshTitle(p);
    }

    /* ---------- subagents ---------- */

    function subagentEvent(cid, c) {
      const ev = { type: 'subagent', childId: cid, title: c.title, status: c.status };
      if (c.toolId) ev.toolId = c.toolId;
      return ev;
    }
    /* Which subagent a tool call belongs to, from an id of the form `<child session id>:<call id>`; null if none. */
    function subagentOf(toolCallId) {
      const i = typeof toolCallId === 'string' ? toolCallId.indexOf(':') : -1;
      if (i <= 0) return null;
      const cid = toolCallId.slice(0, i);
      const c = children.get(cid);
      if (!c && !/^ses_/.test(cid)) return null;
      return { childId: cid, title: c ? c.title : '' };
    }
    /* The subagent tool call that started `cid`, named by the call's result once it completes. */
    function linkChild(cid, toolId) {
      childTool.set(cid, toolId);
      const c = children.get(cid);
      if (!c || c.toolId === toolId) return;
      c.toolId = toolId;
      emit([subagentEvent(cid, c)]);
    }
    /* Before that, a guess among the subagent calls not linked yet: the newest whose description equals the
       subagent's title (OpenCode titles the child session with it), else the newest. */
    function guessTool(cid, title) {
      const linked = new Set([...children.values()].map((c) => c.toolId).filter(Boolean));
      const calls = m.toolCalls().filter((t) => SUBAGENT_TOOLS.has(t.name) && !linked.has(t.id)).reverse();
      const named = calls.find((t) => t.input && t.input.description === title);
      const pick = named || calls[0];
      return pick ? pick.id : '';
    }

    /* ---------- shell commands in the background ---------- */

    /* A shell tool call that ended by moving its command to the background (2.4.1: rawOutput.metadata holds shellID,
       pid and status "running"). Returns the event to emit, or null. */
    function backgroundOf(u, live) {
      if (!u || u.sessionUpdate !== 'tool_call_update' || u.status !== 'completed' || typeof u.toolCallId !== 'string') return null;
      const meta = u.rawOutput && u.rawOutput.metadata;
      const pid = meta && Number(meta.pid);
      if (!meta || typeof meta.shellID !== 'string' || meta.status !== 'running' || !(pid > 0)) return null;
      if (h.background.has(u.toolCallId)) return null;
      const call = ((h.replay && h.replay.mapper) || m).toolCalls().find((t) => t.id === u.toolCallId);
      const title = String((call && call.input && call.input.command) || (u.rawInput && u.rawInput.command) || u.title || meta.shellID).split('\n')[0].slice(0, 200);
      if (!live && !isAlive(pid)) return null;
      const b = { pid, title, status: 'running', shellId: meta.shellID };
      h.background.set(u.toolCallId, b);
      return { type: 'background', id: u.toolCallId, kind: 'shell', title, status: 'running', pid, at: now() };
    }
    /* Each background command whose process has gone is reported done. */
    function checkBackground() {
      const evs = [];
      for (const [cid, b] of h.background) {
        if (b.status !== 'running' || isAlive(b.pid)) continue;
        b.status = 'done';
        evs.push({ type: 'background', id: cid, kind: 'shell', title: b.title, status: 'done', pid: b.pid, at: now() });
      }
      if (evs.length) emit(evs);
    }

    async function applyModel(p) {
      if (!h.model) return;
      try {
        const r = await p.conn.request('session/set_config_option', { sessionId: id, configId: 'model', value: h.model });
        noteConfig(r && r.configOptions);
      } catch (e) {
        if (e.code !== METHOD_NOT_FOUND) throw e;
        await p.conn.request('session/set_model', { sessionId: id, modelId: h.model });
      }
      h.modelGen = p.gen;
    }

    /* A process started after this conversation was opened has not seen it: load it there without replaying. */
    async function ensureLoaded(p) {
      if (h.loadedGen === p.gen) return;
      h.replay = { mapper: null, events: null };
      try {
        const r = await p.conn.request('session/load', { sessionId: id, cwd: h.cwd, mcpServers: [] }, { timeoutMs: 120000 });
        noteModels(r && r.configOptions, false);
        noteConfig(r && r.configOptions);
      } finally {
        h.replay = null;
      }
      h.loadedGen = p.gen;
      h.modelGen = 0;
    }

    async function refreshTitle(p) {
      if (!sessionCaps(p).list) return;
      try {
        const r = await p.conn.request('session/list', { cwd: h.cwd });
        const s = r && Array.isArray(r.sessions) ? r.sessions.find((x) => x.sessionId === id) : null;
        const t = s ? mapper.normalizeTitle(s.title) : '';
        if (t && t !== h.title) emit([{ type: 'title', title: t }]);
        fireChanged(id);
      } catch (e) { log(`reading the title of ${id} failed: ${e.message}`); }
    }

    async function runOne(item) {
      /* A message from the user ends the turn OpenCode started on its own; on OpenCode's side the message joins that
         turn or starts the next one. */
      if (h.own) ownEnd();
      h.running = item;
      const turnId = `t${now().toString(36)}-${++turnSeq}`;
      h.lastUserAt = now();
      setStatus('working');
      emit(m.begin(turnId, item.text, h.lastUserAt, h.model || undefined, effortNow() || undefined, item.attachments));
      let p = null;
      let result;
      let error;
      try {
        p = await ensure();
        await ensureLoaded(p);
        if (h.model && h.modelGen !== p.gen) await applyModel(p);
        if (h.pendingOptions.size) await applyOptions(p);
        if (item.aborted) result = { stopReason: 'cancelled' };
        else result = await p.conn.request('session/prompt', { sessionId: id, prompt: item.prompt }, { timeoutMs: 0 });
      } catch (e) {
        error = e;
      }
      cancelAsks();
      if (item.aborted && error) error = { message: 'aborted', code: 0 };
      const evs = m.end(result, error);
      emit(evs);
      const endEv = evs.find((e) => e.type === 'turnEnd');
      if (endEv && endEv.reason !== 'aborted') h.lastReplyAt = endEv.at;
      if (endEv && endEv.error && endEv.error.kind === 'auth') lastAuthError = { at: now(), model: h.model, message: endEv.error.message };
      else if (endEv && endEv.reason !== 'error' && h.model.startsWith(`${BEDROCK}/`)) lastAuthError = null;
      h.running = null;
      settleStatus();
      checkBackground();
      item.done(endEv || null);
      if (p && !error) refreshTitle(p);
    }

    async function drain() {
      while (queue.length && !h.running && !h.disposed) await runOne(queue.shift());
    }

    Object.assign(h, {
      on(listener) {
        if (typeof listener !== 'function') return () => {};
        subs.add(listener);
        return () => { subs.delete(listener); };
      },
      /* Resolves with the turnEnd event once this message's turn is over; never rejects. `extra` is { images, files },
         or an array taken as the images. */
      send(text, extra) {
        const x = Array.isArray(extra) ? { images: extra } : (extra && typeof extra === 'object' ? extra : {});
        const prompt = [{ type: 'text', text: String(text || '') }];
        const attachments = [];
        for (const img of Array.isArray(x.images) ? x.images : []) {
          if (!img || typeof img.data !== 'string' || !img.data) continue;
          prompt.push({ type: 'image', mimeType: img.mediaType || img.mimeType || 'image/png', data: img.data });
          attachments.push({ kind: 'image', name: typeof img.name === 'string' && img.name ? img.name : 'image' });
        }
        const files = fileBlocks(x.files, promptCaps.embeddedContext === true);
        prompt.push(...files.prompt);
        attachments.push(...files.shown);
        if (h.disposed) return Promise.resolve(null);
        return new Promise((resolve) => {
          queue.push({ text: String(text || ''), prompt, attachments, done: resolve, aborted: false });
          drain();
        });
      },
      /* Stops the running turn and drops the messages queued behind it. */
      abort() {
        for (const item of queue.splice(0)) item.done(null);
        cancelAsks();
        if (h.running || h.own) {
          if (h.running) h.running.aborted = true;
          if (proc && !proc.conn.closed) proc.conn.notify('session/cancel', { sessionId: id });
        }
        if (h.own) ownEnd(null, true);
      },
      async setModel(model) {
        const v = modelValue(model);
        if (!v) return;
        h.model = v;
        const p = proc;
        if (p && !p.conn.closed && h.loadedGen === p.gen && !h.running) await applyModel(p);
      },
      getModel() { return h.model; },
      /* The mode and effort OpenCode offers for this conversation (contracts.js ConfigOption[]); [] when it offers none. */
      options() { return publicOptions(); },
      /* Takes effect from the next turn: sent now when nothing runs, otherwise before the next message goes. */
      async setOption(optionId, value) {
        const o = h.config.find((x) => x.id === optionId);
        if (!o) throw new server.OpenCodeError('unsupported', `OpenCode offers no ${optionId} setting for this conversation.`);
        const v = String(value);
        if (!o.options.some((x) => x && x.value === v)) throw new server.OpenCodeError('badRequest', `${v} is not one of the ${optionId} values OpenCode offers.`);
        h.pendingOptions.delete(optionId);
        h.pendingOptions.set(optionId, v);
        noteConfig(h.config);
        const p = proc;
        if (p && !p.conn.closed && h.loadedGen === p.gen && !h.running && !h.own) await applyOptions(p);
      },
      respondPermission(requestId, decision) {
        const a = asks.get(requestId);
        if (!a) return false;
        asks.delete(requestId);
        const kinds = decision === 'allowSession' ? ['allow_always', 'allow_once']
          : decision === 'allowOnce' ? ['allow_once'] : ['reject_once', 'reject_always'];
        const opt = kinds.map((k) => a.options.find((o) => o && o.kind === k)).find(Boolean);
        a.resolve(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
        emit(m.settled(requestId, decision));
        settleStatus();
        ownArm();
        return true;
      },
      /*
       * Answers a form OpenCode's question tool asked: { action: 'accept', content } with the values by property name,
       * or { action: 'decline' } / { action: 'cancel' }, after which 2.4.1 ends the turn as cancelled. False when the
       * request is no longer open.
       */
      respondQuestion(requestId, answer) {
        const q = questions.get(requestId);
        if (!q) return false;
        questions.delete(requestId);
        const action = answer && (answer.action === 'accept' || answer.action === 'decline') ? answer.action : 'cancel';
        const content = answer && answer.content && typeof answer.content === 'object' && !Array.isArray(answer.content) ? answer.content : {};
        q.resolve(action === 'accept' ? { action, content } : { action });
        emit([{ type: 'questionSettled', requestId, action }]);
        settleStatus();
        ownArm();
        return true;
      },
      /* The slash commands OpenCode offers this conversation, as it last listed them: [{ name, description }]. */
      commands() { return h.commandList.slice(); },
      /* What a message may carry besides text: images when OpenCode's promptCapabilities allow them, files and
         selections always. */
      attachments() { return { images: promptCaps.image === true, files: true, selection: true }; },
      /* The saved conversation as AgentEvents, for the UI to redraw (empty for one created in this window). */
      history() { return Promise.resolve(h.events.slice()); },
      checkBackground() { checkBackground(); },
      /* Loads the conversation again from OpenCode (after a rewind) and resolves with its history, as history() gives
         it. Refused while a turn runs. */
      async reload() {
        if (h.running || h.own) throw new server.OpenCodeError('busy', 'Wait for the turn to end, or stop it.');
        const p = await ensure();
        const r = await replayInto(p, h);
        noteConfig(r && r.configOptions);
        /* The page starts its sums again from this history, which carries no cost. */
        m.resetCost();
        return h.events.slice();
      },
      /* A subagent running in the background asks through its parent, possibly while the parent's turn is over. Its
         tool call id starts with the subagent's session id. */
      askPermission(params) {
        return new Promise((resolve) => {
          if (!h.running && !h.own) ownBegin();
          const requestId = `p${++permSeq}`;
          const r = m.permission(requestId, params.toolCall);
          const from = subagentOf(params.toolCall && params.toolCall.toolCallId);
          if (from) for (const ev of r.events) if (ev.type === 'permission' || ev.type === 'toolCall') ev.subagent = from;
          asks.set(requestId, { resolve, options: Array.isArray(params.options) ? params.options : [], tool: r.tool, kind: 'permission', seq: permSeq });
          ownArm();
          setStatus('waiting', r.tool, 'permission');
          emit(r.events);
        });
      },
      askQuestion(params) {
        return new Promise((resolve) => {
          if (!h.running && !h.own) ownBegin();
          const requestId = `q${++permSeq}`;
          questions.set(requestId, { resolve, tool: 'question', kind: 'question', seq: permSeq });
          ownArm();
          setStatus('waiting', 'question', 'question');
          const ev = { type: 'question', requestId, message: String(params.message || ''), schema: params.requestedSchema };
          if (typeof params.toolCallId === 'string' && params.toolCallId) ev.toolId = params.toolCallId;
          const from = subagentOf(params.toolCallId);
          if (from) ev.subagent = from;
          emit([ev]);
        });
      },
      onUpdate(u) {
        if (u && u.sessionUpdate === 'config_option_update') noteConfig(u.configOptions);
        if (u && u.sessionUpdate === 'available_commands_update') {
          h.commandList = commandList(u.availableCommands);
          emit([{ type: 'commands', commands: h.commandList.slice() }]);
          return;
        }
        if (h.replay) {
          if (h.replay.mapper) {
            for (const e of h.replay.mapper.update(u)) { h.replay.events.push(e); h.replay.metas.push({ mid: u.messageId, call: u.toolCallId }); }
            const bg = backgroundOf(u, false);
            if (bg) h.replay.background.push(bg);
          }
          return;
        }
        if (u && !h.running && !h.own && startsOwn(u)) ownBegin();
        emit(m.update(u));
        const bg = backgroundOf(u, true);
        if (bg) emit([bg]);
        if (u && h.own) ownNote(u);
        if (u && u.sessionUpdate === 'tool_call_update' && u.rawOutput && u.rawOutput.metadata) {
          const cid = u.rawOutput.metadata.sessionID;
          if (typeof cid === 'string' && cid && typeof u.toolCallId === 'string' && SUBAGENT_TOOLS.has(m.toolName(u.toolCallId))) linkChild(cid, u.toolCallId);
        }
      },
      takeConfig(configOptions) { noteConfig(configOptions); },
      /* The title a rename set, which this conversation's stream does not report. */
      retitle(t) { if (t && t !== h.title) emit([{ type: 'title', title: t }]); },
      childTool(u) {
        if (u && (u.sessionUpdate === 'tool_call_update' || u.sessionUpdate === 'tool_call') && typeof u.toolCallId === 'string' && m.toolName(u.toolCallId)) h.onUpdate(u);
      },
      /* A subagent's status or one update of its own stream, from opencode/session/child_update. */
      childUpdate(params) {
        const cid = typeof params.childSessionId === 'string' ? params.childSessionId : '';
        if (!cid || h.replay) return;
        let c = children.get(cid);
        if (!c) {
          c = { title: '', status: 'running', mapper: mapper.createMapper({ now }), toolId: '' };
          children.set(cid, c);
        }
        if (typeof params.title === 'string' && params.title) c.title = params.title;
        if (!c.toolId) c.toolId = childTool.get(cid) || guessTool(cid, c.title);
        if (params.type === 'status') {
          c.status = CHILD_STATUS[params.status] || c.status;
          const ev = subagentEvent(cid, c);
          if (c.status === 'failed' && params.error) ev.error = typeof params.error === 'string' ? params.error : String(params.error.message || JSON.stringify(params.error));
          emit([ev]);
        } else if (params.type === 'update' && params.update) {
          for (const e of c.mapper.update(params.update)) if (CHILD_EVENTS.has(e.type)) emit([{ ...subagentEvent(cid, c), event: e }]);
        }
      },
      processGone() {
        cancelAsks();
        if (h.own) ownEnd({ message: 'OpenCode stopped', code: -32000 });
        h.loadedGen = 0;
        h.modelGen = 0;
      },
      dispose() {
        if (h.disposed) return;
        h.abort();
        h.disposed = true;
        subs.clear();
        handles.delete(id);
        const p = proc;
        if (p && !p.conn.closed && sessionCaps(p).close) p.conn.request('session/close', { sessionId: id }).catch(() => {});
        fireChanged(id);
        armIdle();
      },
    });
    return h;
  }

  function summary(s, h) {
    const out = {
      id: h ? h.id : s.sessionId,
      title: (h && h.title) || mapper.normalizeTitle(s && s.title) || '',
      cwd: (h && h.cwd) || (s && s.cwd) || '',
      lastActiveAt: Math.max(Date.parse((s && s.updatedAt) || '') || 0, h ? Math.max(h.lastUserAt, h.lastReplyAt) : 0),
      status: h ? h.status : 'idle',
      lastUserAt: h ? h.lastUserAt : 0,
      lastReplyAt: h ? h.lastReplyAt : 0,
      open: !!h,
    };
    if (h && h.status === 'waiting') out.waitingFor = h.waitingKind === 'question' ? { kind: 'question' } : { kind: 'permission', tool: h.waitingTool };
    return out;
  }

  async function findSession(p, id, cwd) {
    if (!sessionCaps(p).list) return null;
    let cursor;
    for (let i = 0; i < 20; i++) {
      const params = {};
      if (cwd) params.cwd = cwd;
      if (cursor) params.cursor = cursor;
      const r = await p.conn.request('session/list', params);
      const s = r && Array.isArray(r.sessions) ? r.sessions.find((x) => x.sessionId === id) : null;
      if (s) return s;
      cursor = r && r.nextCursor;
      if (!cursor) return null;
    }
    return null;
  }

  const opening = new Map();
  let pathsCache = null;

  /* The OpenCode to rewind `id` with; throws unless it is 2.x and the conversation is not in a turn here. */
  function rewindable(id) {
    if (!SESSION_ID.test(String(id || ''))) throw new server.OpenCodeError('badRequest', `Not a conversation id: ${String(id).slice(0, 80)}`);
    const found = foundNow();
    if (!found.version || found.version.major < 2) throw new server.OpenCodeError('unsupported', 'Rewinding needs OpenCode 2.');
    const h = handles.get(id);
    if (h && (h.running || h.own)) throw new server.OpenCodeError('busy', 'Stop the turn or wait for it to end before rewinding.');
    return found;
  }

  /*
   * Replays session `h.id` into `h.events` with session/load, and runs its export at the same time to date the events;
   * resolves with session/load's answer. The live mapper is left as it is.
   */
  async function replayInto(p, h) {
    const rm = mapper.createMapper({ now });
    rm.replayStart();
    h.replay = { mapper: rm, events: [], metas: [], background: [] };
    const exporting = exportOf(p.found, h.id);
    let r;
    try {
      const loading = p.conn.request('session/load', { sessionId: h.id, cwd: h.cwd, mcpServers: [] }, { timeoutMs: 120000 });
      r = await loading;
      const tail = rm.replayEnd();
      const events = [...h.replay.events, ...tail];
      const metas = [...h.replay.metas, ...tail.map(() => ({}))];
      const look = await timesAfter(exporting, loading, exportWaitMs);
      h.events = look ? times.fillTimes(events, metas, look) : events;
      h.metas = metas;
      h.events.push(...h.replay.background);
      if (h.title) h.events.push({ type: 'title', title: h.title });
    } finally {
      h.replay = null;
    }
    return r;
  }

  async function openOne(id, cwd) {
    const p = await ensure();
    let dir = cwd;
    let title = '';
    if (!dir) {
      const s = await findSession(p, id);
      if (!s) throw new server.OpenCodeError('noConversation', `OpenCode has no conversation ${id}`);
      dir = s.cwd;
      title = mapper.normalizeTitle(s.title);
    }
    if (handles.has(id)) return handles.get(id);
    const h = makeHandle(id, dir, title);
    handles.set(id, h);
    armIdle();
    try {
      const r = await replayInto(p, h);
      const current = noteModels(r && r.configOptions, false);
      h.takeConfig(r && r.configOptions);
      h.model = current;
      h.modelGen = p.gen;
      h.loadedGen = p.gen;
    } catch (e) {
      handles.delete(id);
      armIdle();
      throw e;
    }
    fireChanged(id);
    return h;
  }

  const api = {
    /* Which opencode would run and its version line (1 or 2), without starting it. Throws like findOpenCode. */
    detect() {
      const found = find({ configured: settings.binaryPath, env: { ...process.env, ...settings.env } });
      return { path: found.path, version: found.version, line: (found.version && found.version.major) || 1 };
    },

    /* Starts OpenCode now instead of on first use; resolves { path, version, line, agent, capabilities }. */
    async start() {
      const p = await ensure();
      return { path: p.found.path, version: p.found.version, line: (p.found.version && p.found.version.major) || 1, agent: p.info.agent, capabilities: p.info.capabilities };
    },

    /* Root conversations, newest first. `cwd` limits them to one folder (OpenCode matches it exactly). */
    async listSessions({ cwd, limit = 200 } = {}) {
      const p = await ensure();
      armIdle();
      let rows = [];
      const seen = new Set();
      if (sessionCaps(p).list) {
        let cursor;
        for (let page = 0; page < 20 && rows.length < limit; page++) {
          const params = {};
          if (cwd) params.cwd = cwd;
          if (cursor) params.cursor = cursor;
          const r = await p.conn.request('session/list', params);
          let added = 0;
          for (const s of (r && Array.isArray(r.sessions) ? r.sessions : [])) {
            if (!s || typeof s.sessionId !== 'string' || seen.has(s.sessionId)) continue;
            seen.add(s.sessionId);
            rows.push(summary(s, handles.get(s.sessionId)));
            added += 1;
          }
          cursor = r && r.nextCursor;
          if (!cursor || !added) break;
        }
      }
      for (const h of handles.values()) if (!seen.has(h.id) && (!cwd || h.cwd === cwd)) rows.push(summary(null, h));
      noteKinds([]);
      const unknown = rows.filter((r) => !parents.has(r.id)).map((r) => r.id);
      if (unknown.length && ((p.found.version && p.found.version.major) || 1) >= 2) await lookUpParents(p, unknown);
      rows = rows.filter((r) => !isChild(r.id));
      rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return rows.slice(0, limit);
    },

    /* Whether OpenCode runs this session for a subagent of another one, as far as this window has learned. */
    isChild(id) { return isChild(id); },

    onDidChangeSessions: changed.event,

    async createSession(cwd, { model } = {}) {
      const p = await ensure();
      let r;
      try {
        r = await p.conn.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: newSessionTimeoutMs });
      } catch (e) {
        if (!e || e.code !== TIMED_OUT) throw e;
        /* Seen once on 2.4.1, with initialize answered and nothing after, and gone once OpenCode started again: the
           process is stopped unless a turn runs on it, so the next try starts a new one. */
        const busy = [...handles.values()].some((x) => x.running);
        log(`session/new got no answer in ${newSessionTimeoutMs / 1000}s${busy ? '' : '; stopping OpenCode'}`);
        if (proc === p && !busy) stopProcess();
        const err = new server.OpenCodeError('unavailable', `OpenCode did not start the conversation within ${Math.round(newSessionTimeoutMs / 1000)} seconds. Try again.`);
        err.kind = 'unavailable';
        throw err;
      }
      const current = noteModels(r && r.configOptions, true);
      noteKinds([[r.sessionId, '']]);
      const h = makeHandle(r.sessionId, cwd, '');
      h.takeConfig(r && r.configOptions);
      h.loadedGen = p.gen;
      h.model = current;
      h.modelGen = p.gen;
      handles.set(h.id, h);
      armIdle();
      if (model) await h.setModel(model);
      fireChanged(h.id);
      return h;
    },

    /* The conversation object for a saved session, with its history loaded. `cwd` saves a lookup when known. */
    openSession(id, { cwd } = {}) {
      if (handles.has(id) && !opening.has(id)) return Promise.resolve(handles.get(id));
      if (!opening.has(id)) opening.set(id, openOne(id, cwd).finally(() => opening.delete(id)));
      return opening.get(id);
    },

    /* Whether this OpenCode can rename conversations (2.x); false when none is found. */
    canRename() {
      try {
        const found = proc && proc.found ? proc.found : find({ configured: settings.binaryPath, env: { ...process.env, ...settings.env } });
        return !!(found.version && found.version.major >= 2);
      } catch (_) { return false; }
    },

    /* 2.x only, in a private server of its own (subcommandArgs), without starting `acp`. The conversation, when open,
       reports the new title as a title event. */
    async renameSession(id, title) {
      const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
      if (!SESSION_ID.test(String(id || ''))) throw new server.OpenCodeError('badRequest', `Not a conversation id: ${String(id).slice(0, 80)}`);
      if (!t) throw new server.OpenCodeError('badRequest', 'A title cannot be empty.');
      const found = proc && proc.found ? proc.found : find({ configured: settings.binaryPath, env: { ...process.env, ...settings.env } });
      if (!found.version || found.version.major < 2) throw new server.OpenCodeError('unsupported', 'Renaming a conversation needs OpenCode 2.');
      const args = server.subcommandArgs(found.version, ['api', 'session.update', '--param', `sessionID=${id}`, '-d', JSON.stringify({ title: t })]);
      await new Promise((resolve, reject) => {
        execFile(found.path, args, { timeout: 30000, env: server.subcommandEnv(settings.env), windowsHide: true }, (err, stdout, stderr) => {
          if (!err) { resolve(); return; }
          let why = '';
          try { const v = JSON.parse(String(stdout)); if (v && typeof v.message === 'string') why = v.message; } catch (_) { /* not JSON */ }
          reject(new server.OpenCodeError('renameFailed', `OpenCode did not rename the conversation: ${(why || String(stderr || err.message)).trim().slice(0, 300)}`));
        });
      });
      const h = handles.get(id);
      if (h) h.retitle(t);
      fireChanged(id);
    },

    /* Whether OpenCode can fork a conversation (session/fork), as it last said; false before it has started here. */
    canFork() {
      const c = proc && proc.info ? sessionCaps(proc) : knownSessionCaps;
      return !!(c && c.fork);
    },

    /* Copies the whole conversation into a new one with session/fork; resolves { id, cwd }. */
    async forkSession(id) {
      if (!SESSION_ID.test(String(id || ''))) throw new server.OpenCodeError('badRequest', `Not a conversation id: ${String(id).slice(0, 80)}`);
      const p = await ensure();
      if (!sessionCaps(p).fork) throw new server.OpenCodeError('unsupported', 'This version of OpenCode cannot fork conversations.');
      const h = handles.get(id);
      let cwd = h ? h.cwd : '';
      if (!cwd) {
        const s = await findSession(p, id);
        if (!s) throw new server.OpenCodeError('noConversation', `OpenCode has no conversation ${id}`);
        cwd = s.cwd;
      }
      const r = await p.conn.request('session/fork', { sessionId: id, cwd, mcpServers: [] }, { timeoutMs: newSessionTimeoutMs });
      if (!r || typeof r.sessionId !== 'string' || !r.sessionId) throw new server.OpenCodeError('forkFailed', 'OpenCode did not return the forked conversation.');
      noteModels(r.configOptions, false);
      noteKinds([[r.sessionId, '']]);
      fireChanged(r.sessionId);
      return { id: r.sessionId, cwd };
    },

    /* Whether this OpenCode can rewind a conversation (2.x, through /api); false when none is found. */
    canRewind() {
      try { const found = foundNow(); return !!(found.version && found.version.major >= 2); } catch (_) { return false; }
    },

    /*
     * Stages the rewind of `id` to before its user message `messageId` (see the top of this file). Resolves
     * { messageId, tracked, files: [{ file, status, additions, deletions, patch }] }; `tracked` is false where OpenCode
     * keeps no snapshots of the folder (no git repository), and then only the conversation goes back. rewindCommit()
     * removes the messages, rewindClear() puts the files back again.
     */
    async rewindStage(id, messageId) {
      const found = rewindable(id);
      if (!/^msg_[0-9A-Za-z]{8,64}$/.test(String(messageId || ''))) throw new server.OpenCodeError('badRequest', 'That message cannot be rewound to: it has no OpenCode message id.');
      const r = await runSub(found, ['api', 'session.revert.stage', '--param', `sessionID=${id}`, '-d', JSON.stringify({ messageID: messageId })], 'rewindFailed');
      let v;
      try { v = JSON.parse(r.stdout); } catch (_) { throw new server.OpenCodeError('rewindFailed', 'OpenCode\'s reply to the rewind could not be read.'); }
      const d = (v && v.data) || {};
      const files = (Array.isArray(d.files) ? d.files : []).filter((f) => f && typeof f.file === 'string').map((f) => ({
        file: f.file, status: String(f.status || 'modified'), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0,
        patch: typeof f.patch === 'string' ? f.patch : '',
      }));
      return { messageId: String(d.messageID || messageId), tracked: typeof d.snapshot === 'string' && !!d.snapshot, files };
    },
    async rewindCommit(id) {
      await runSub(rewindable(id), ['api', 'session.revert.commit', '--param', `sessionID=${id}`], 'rewindFailed');
      fireChanged(id);
    },
    async rewindClear(id) {
      await runSub(rewindable(id), ['api', 'session.revert.clear', '--param', `sessionID=${id}`], 'rewindFailed');
    },

    /* A session's user messages from OpenCode's export, oldest first: [{ id, text, at }]. */
    async userMessages(id) {
      const look = times.lookupOf(await exportOf(foundNow(), id));
      if (!look) throw new server.OpenCodeError('exportFailed', 'OpenCode did not list the conversation\'s messages.');
      return look.users;
    },

    /* What `opencode mcp list` prints: the configured MCP servers and the state of each. */
    async mcpList() {
      const found = foundNow();
      const r = await runSub(found, ['mcp', 'list'], 'mcpFailed', { timeout: 60000 });
      return `${r.stdout}${r.stderr && r.stderr.trim() ? `\n${r.stderr}` : ''}`.replace(ANSI, '').trim();
    },

    /* OpenCode's folders as `opencode debug paths` names them. When it leaves out `db`, the session database, and
       <data>/opencode.db exists, `db` is that file. */
    async dataPaths() {
      const found = foundNow();
      const key = `${found.path}\0${(found.version && found.version.text) || ''}`;
      if (pathsCache && pathsCache.key === key) return { ...pathsCache.value };
      const r = await runSub(found, ['debug', 'paths'], 'pathsFailed');
      const value = parsePaths(r.stdout);
      if (!value.db && value.data && fs.existsSync(path.join(value.data, 'opencode.db'))) value.db = path.join(value.data, 'opencode.db');
      pathsCache = { key, value };
      return { ...value };
    },

    async deleteSession(id) {
      const h = handles.get(id);
      if (h) h.dispose();
      const p = await ensure();
      if (sessionCaps(p).delete) {
        await p.conn.request('session/delete', { sessionId: id });
      } else {
        await new Promise((resolve, reject) => {
          execFile(p.found.path, server.subcommandArgs(p.found.version, ['session', 'delete', id]), { timeout: 60000, env: server.subcommandEnv(settings.env), windowsHide: true },
            (err, stdout, stderr) => (err ? reject(new server.OpenCodeError('deleteFailed', `opencode session delete failed: ${String(stderr || err.message).trim().slice(0, 300)}`)) : resolve()));
        });
      }
      fireChanged(id);
    },

    /* The models OpenCode offered in the last session it opened here (cached across restarts). */
    listModels() {
      return mapper.modelsFromConfig(cache.option ? [cache.option] : [], cache.contextWindows).models;
    },

    /* The model OpenCode gives a new session, or null before it has opened one. */
    defaultModel() {
      if (!cache.current) return null;
      return api.listModels().find((m) => m.id === cache.current) || null;
    },

    /*
     * Whether Bedrock is usable and what to tell the user when not. state: 'listed' (OpenCode offers Bedrock models;
     * 1.x only lists providers it can sign in to, 2.x lists them before trying), 'authFailed' (a Bedrock turn failed
     * on credentials and none has succeeded since), 'notListed', or 'unknown' (no session opened yet).
     */
    bedrockStatus() {
      const models = api.listModels();
      const bedrock = models.filter((x) => x.providerId === BEDROCK);
      const major = (proc && proc.found && proc.found.version && proc.found.version.major) || cache.major || 1;
      const state = !models.length ? 'unknown'
        : !bedrock.length ? 'notListed'
          : lastAuthError && lastAuthError.model.startsWith(`${BEDROCK}/`) ? 'authFailed' : 'listed';
      const out = { state, models: bedrock.length, opencodeMajor: major, help: state === 'listed' ? '' : bedrockHelp(major) };
      if (state === 'authFailed') out.error = lastAuthError.message;
      return out;
    },

    /* New settings take effect by starting OpenCode again; turns that are running end with an error. */
    async restart(next = {}) {
      settings = {
        binaryPath: next.binaryPath !== undefined ? next.binaryPath : settings.binaryPath,
        env: next.env !== undefined ? { ...next.env } : settings.env,
        permissions: next.permissions !== undefined ? next.permissions !== false : settings.permissions,
        config: next.config !== undefined ? next.config : settings.config,
        quietFolder: next.quietFolder !== undefined ? (typeof next.quietFolder === 'function' ? next.quietFolder : null) : settings.quietFolder,
      };
      lastAuthError = null;
      await stopProcess();
    },

    info() {
      const p = proc;
      return p && p.info ? { path: p.found.path, version: p.found.version, line: (p.found.version && p.found.version.major) || 1, agent: p.info.agent, pid: p.child.pid, capabilities: p.info.capabilities } : null;
    },

    async dispose() {
      if (disposed) return;
      for (const h of [...handles.values()]) h.dispose();
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      changed.clear();
      const p = proc;
      proc = null;
      if (p) await server.stopAcp(p.child);
    },
  };
  return api;
}

module.exports = { createOpenCode, modelValue, bedrockHelp, fileBlocks, parsePaths, processAlive, OpenCodeError: server.OpenCodeError };
