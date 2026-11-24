// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversations backed by OpenCode over the Agent Client Protocol: what the UI and the wiring call. One `opencode acp`
 * process per window (src/opencode/server.js), started on first use and stopped when no conversation has been open
 * for `idleStopMs`. Each conversation object speaks contracts.js AgentEvents (src/opencode/mapper.js).
 *
 * ACP has no rename, so renameSession throws; deleting uses session/delete where OpenCode offers it (2.x) and
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
 * The mode and effort config options are offered as options() / setOption() when OpenCode lists them.
 */
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const paths = require('../paths');
const brand = require('../brand');
const server = require('./server');
const { createConnection, METHOD_NOT_FOUND, TIMED_OUT } = require('./client');
const mapper = require('./mapper');

const PROTOCOL_VERSION = 1;
const NEW_SESSION_TIMEOUT_MS = 60000;
const BEDROCK = 'amazon-bedrock';
const CHILD_UPDATES = 'opencode/child-session-updates';
const CHILD_UPDATE = 'opencode/session/child_update';
/* The config options shown next to the model, in this order. */
const SHOWN_OPTIONS = Object.freeze(['mode', 'effort']);
/*
 * How long a turn OpenCode started itself may stay silent before it counts as over: shorter after reply text, which
 * ends a turn, than after anything else. A running tool, an unanswered permission request or a scheduled retry keeps
 * it open. Measured on 2.4.1: the steps of such a turn follow each other within a second.
 */
const OWN_QUIET_MS = 20000;
const OWN_AFTER_TEXT_MS = 4000;
const KINDS_KEPT = 5000;
const LOOKUP_ROWS = 200;

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

/* Where Bedrock is configured, per OpenCode's config dialect. */
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
 *   root, idleStopMs, now, log
 *   newSessionTimeoutMs  how long session/new may take (60 s)
 *   ownQuietMs, ownAfterTextMs   when a turn OpenCode started itself counts as over (OWN_QUIET_MS, OWN_AFTER_TEXT_MS)
 *   findOpenCode, startAcp, execFile   test seams
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
  let settings = { binaryPath: opts.binaryPath || '', env: { ...(opts.env || {}) }, permissions: opts.permissions !== false, config: opts.config || null };

  let proc = null;
  let gen = 0;
  let idleTimer = null;
  let lastAuthError = null;
  let disposed = false;
  let permSeq = 0;
  let turnSeq = 0;
  const handles = new Map();
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
     before each list and merged before each write; the newest KINDS_KEPT are kept. */
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
      return h.askPermission(params);
    }
    throw { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` };
  }

  function onNotification(method, params) {
    if (method === CHILD_UPDATE) {
      const child = params && typeof params.childSessionId === 'string' ? params.childSessionId : '';
      const parent = params ? String(params.parentSessionId || params.rootSessionId || '') : '';
      if (child && parent && !isChild(child)) { noteKinds([[child, parent]]); fireChanged(child); }
      /* A subagent's permission request draws its tool in the parent; how that tool ends comes only from here. */
      const h = params && (handles.get(params.rootSessionId) || handles.get(params.parentSessionId));
      if (h && params.type === 'update' && params.update) h.childTool(params.update);
      return;
    }
    if (method !== 'session/update' || !params) return;
    const u = params.update || {};
    if (u.sessionUpdate === 'config_option_update') noteModels(u.configOptions, false);
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
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { [CHILD_UPDATES]: true } },
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

  /* ---------- one conversation ---------- */

  function makeHandle(id, cwd, title) {
    const m = mapper.createMapper({ now });
    const subs = new Set();
    const queue = [];
    const asks = new Map();
    const h = {
      id,
      cwd,
      title: title || '',
      status: 'idle',
      waitingTool: '',
      lastUserAt: 0,
      lastReplyAt: 0,
      model: '',
      modelGen: 0,
      loadedGen: 0,
      events: [],
      replay: null,
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
    function setStatus(status, tool) {
      const waitingTool = status === 'waiting' ? (tool || h.waitingTool) : '';
      if (h.status === status && h.waitingTool === waitingTool) return;
      h.status = status;
      h.waitingTool = waitingTool;
      fireChanged(id);
    }
    function cancelAsks() {
      for (const a of asks.values()) a.resolve({ outcome: { outcome: 'cancelled' } });
      asks.clear();
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
    /* The effort a turn runs with, for the figures under its reply; OpenCode's 'default' is left unsaid. */
    function effortNow() {
      const o = h.config.find((x) => x.id === 'effort');
      const v = o && typeof o.currentValue === 'string' ? o.currentValue : '';
      return v && v !== 'default' ? v : '';
    }
    /* A value stays pending until OpenCode has answered, so a config_option_update of an earlier change arriving
       meanwhile (seen on 2.4.1) does not show the old value again. */
    async function applyOptions(p) {
      for (const [k, v] of [...h.pendingOptions]) {
        let r;
        try {
          r = await p.conn.request('session/set_config_option', { sessionId: id, configId: k, value: v });
        } finally {
          if (h.pendingOptions.get(k) === v) h.pendingOptions.delete(k);
        }
        noteConfig(r && r.configOptions, [[k, v]]);
      }
    }

    /* ---------- a turn OpenCode started itself ---------- */

    function ownBegin() {
      if (h.running || h.own || h.disposed) return;
      const turnId = `t${now().toString(36)}-${++turnSeq}`;
      h.own = { turnId, timer: null, afterText: false, tools: new Set(), retrying: false };
      setStatus('working');
      emit(m.beginOwn(turnId, now(), h.model || undefined, effortNow() || undefined));
    }
    function ownArm() {
      const own = h.own;
      if (!own) return;
      if (own.timer) clearTimeout(own.timer);
      own.timer = null;
      if (asks.size || own.tools.size || own.retrying) return;
      own.timer = setTimeout(() => { if (h.own === own) ownEnd(); }, own.afterText ? ownAfterTextMs : ownQuietMs);
      if (typeof own.timer.unref === 'function') own.timer.unref();
    }
    /* What an update says about the turn: tools running, a retry waiting, the last thing being reply text. */
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
    /* Whether an update, coming while no turn runs here, is OpenCode working: output, a new tool call, a retry. */
    function startsOwn(u) {
      const k = u.sessionUpdate;
      if (k === 'agent_message_chunk' || k === 'agent_thought_chunk') return !!(u.content && u.content.type === 'text' && u.content.text);
      if (k === 'tool_call') return true;
      if (k === 'tool_call_update') return typeof u.toolCallId === 'string' && !m.toolName(u.toolCallId);
      if (k === 'session_info_update') return !!(u._meta && u._meta[mapper.RETRY_META]);
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
      setStatus(asks.size ? 'waiting' : 'idle');
      const p = proc;
      if (p && !p.conn.closed && !error) refreshTitle(p);
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
      /* The user writing ends a turn OpenCode started itself; OpenCode takes the message into it or starts the next. */
      if (h.own) ownEnd();
      h.running = item;
      const turnId = `t${now().toString(36)}-${++turnSeq}`;
      h.lastUserAt = now();
      setStatus('working');
      emit(m.begin(turnId, item.text, h.lastUserAt, h.model || undefined, effortNow() || undefined));
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
      setStatus(asks.size ? 'waiting' : 'idle');
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
      /* Resolves with the turnEnd event once this message's turn is over; never rejects. */
      send(text, images) {
        const prompt = [{ type: 'text', text: String(text || '') }];
        for (const img of Array.isArray(images) ? images : []) {
          if (img && typeof img.data === 'string') prompt.push({ type: 'image', mimeType: img.mediaType || img.mimeType || 'image/png', data: img.data });
        }
        if (h.disposed) return Promise.resolve(null);
        return new Promise((resolve) => {
          queue.push({ text: String(text || ''), prompt, done: resolve, aborted: false });
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
        h.pendingOptions.set(optionId, v);
        const p = proc;
        if (p && !p.conn.closed && h.loadedGen === p.gen && !h.running && !h.own) await applyOptions(p);
        else noteConfig(h.config);
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
        setStatus(asks.size ? 'waiting' : (h.running || h.own ? 'working' : 'idle'), asks.size ? [...asks.values()].pop().tool : '');
        ownArm();
        return true;
      },
      /* The saved conversation as AgentEvents, for the UI to redraw (empty for one created in this window). */
      history() { return Promise.resolve(h.events.slice()); },
      /* A subagent running in the background asks through its parent, possibly while the parent's turn is over. */
      askPermission(params) {
        return new Promise((resolve) => {
          if (!h.running && !h.own) ownBegin();
          const requestId = `p${++permSeq}`;
          const r = m.permission(requestId, params.toolCall);
          asks.set(requestId, { resolve, options: Array.isArray(params.options) ? params.options : [], tool: r.tool });
          ownArm();
          setStatus('waiting', r.tool);
          emit(r.events);
        });
      },
      onUpdate(u) {
        if (u && u.sessionUpdate === 'config_option_update') noteConfig(u.configOptions);
        if (h.replay) {
          if (h.replay.mapper) h.replay.events.push(...h.replay.mapper.update(u));
          return;
        }
        if (u && !h.running && !h.own && startsOwn(u)) ownBegin();
        emit(m.update(u));
        if (u && h.own) ownNote(u);
      },
      takeConfig(configOptions) { noteConfig(configOptions); },
      childTool(u) {
        if (u && (u.sessionUpdate === 'tool_call_update' || u.sessionUpdate === 'tool_call') && typeof u.toolCallId === 'string' && m.toolName(u.toolCallId)) h.onUpdate(u);
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
    if (h && h.status === 'waiting') out.waitingFor = { kind: 'permission', tool: h.waitingTool };
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

  async function openOne(id, cwd) {
    const p = await ensure();
    let dir = cwd;
    let title = '';
    if (!dir) {
      const s = await findSession(p, id);
      if (!s) throw new server.OpenCodeError('notFound', `OpenCode has no conversation ${id}`);
      dir = s.cwd;
      title = mapper.normalizeTitle(s.title);
    }
    if (handles.has(id)) return handles.get(id);
    const h = makeHandle(id, dir, title);
    handles.set(id, h);
    armIdle();
    const rm = mapper.createMapper({ now });
    rm.replayStart();
    h.replay = { mapper: rm, events: [] };
    try {
      const r = await p.conn.request('session/load', { sessionId: id, cwd: dir, mcpServers: [] }, { timeoutMs: 120000 });
      const current = noteModels(r && r.configOptions, false);
      h.takeConfig(r && r.configOptions);
      h.events = [...h.replay.events, ...rm.replayEnd()];
      if (title) h.events.push({ type: 'title', title });
      h.model = current;
      h.modelGen = p.gen;
      h.loadedGen = p.gen;
    } catch (e) {
      handles.delete(id);
      armIdle();
      throw e;
    } finally {
      h.replay = null;
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

    /* Starts OpenCode now instead of on first use; resolves with what it reported. */
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

    renameSession() {
      return Promise.reject(new server.OpenCodeError('unsupported', 'OpenCode has no way to rename a conversation over ACP.'));
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
     * 1.x only lists providers it can sign in to, 2.x lists them before trying), 'authFailed' (a Bedrock turn was
     * refused for credentials since), 'notListed', or 'unknown' (no session opened yet).
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

module.exports = { createOpenCode, modelValue, bedrockHelp, OpenCodeError: server.OpenCodeError };
