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
 */
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const paths = require('../paths');
const brand = require('../brand');
const server = require('./server');
const { createConnection, METHOD_NOT_FOUND } = require('./client');
const mapper = require('./mapper');

const PROTOCOL_VERSION = 1;
const BEDROCK = 'amazon-bedrock';

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
 *   findOpenCode, startAcp, execFile   test seams
 */
function createOpenCode(opts = {}) {
  const now = opts.now || Date.now;
  const log = (line) => { try { if (opts.log) opts.log(line); } catch (_) { /* not logged */ } };
  const root = opts.root || paths.root();
  const cacheFile = path.join(root, 'opencode-models.json');
  const idleStopMs = typeof opts.idleStopMs === 'number' ? opts.idleStopMs : 10 * 60 * 1000;
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
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
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
      disposed: false,
    };

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

    async function applyModel(p) {
      if (!h.model) return;
      try {
        await p.conn.request('session/set_config_option', { sessionId: id, configId: 'model', value: h.model });
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
      h.running = item;
      const turnId = `t${now().toString(36)}-${++turnSeq}`;
      h.lastUserAt = now();
      setStatus('working');
      emit(m.begin(turnId, item.text, h.lastUserAt, h.model || undefined));
      let p = null;
      let result;
      let error;
      try {
        p = await ensure();
        await ensureLoaded(p);
        if (h.model && h.modelGen !== p.gen) await applyModel(p);
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
        if (h.running) {
          h.running.aborted = true;
          if (proc && !proc.conn.closed) proc.conn.notify('session/cancel', { sessionId: id });
        }
      },
      async setModel(model) {
        const v = modelValue(model);
        if (!v) return;
        h.model = v;
        const p = proc;
        if (p && !p.conn.closed && h.loadedGen === p.gen && !h.running) await applyModel(p);
      },
      getModel() { return h.model; },
      respondPermission(requestId, decision) {
        const a = asks.get(requestId);
        if (!a) return false;
        asks.delete(requestId);
        const kinds = decision === 'allowSession' ? ['allow_always', 'allow_once']
          : decision === 'allowOnce' ? ['allow_once'] : ['reject_once', 'reject_always'];
        const opt = kinds.map((k) => a.options.find((o) => o && o.kind === k)).find(Boolean);
        a.resolve(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
        emit(m.settled(requestId, decision));
        setStatus(asks.size ? 'waiting' : (h.running ? 'working' : 'idle'), asks.size ? [...asks.values()].pop().tool : '');
        return true;
      },
      /* The saved conversation as AgentEvents, for the UI to redraw (empty for one created in this window). */
      history() { return Promise.resolve(h.events.slice()); },
      askPermission(params) {
        return new Promise((resolve) => {
          const requestId = `p${++permSeq}`;
          const r = m.permission(requestId, params.toolCall);
          asks.set(requestId, { resolve, options: Array.isArray(params.options) ? params.options : [], tool: r.tool });
          setStatus('waiting', r.tool);
          emit(r.events);
        });
      },
      onUpdate(u) {
        if (h.replay) {
          if (h.replay.mapper) h.replay.events.push(...h.replay.mapper.update(u));
          return;
        }
        emit(m.update(u));
      },
      processGone() {
        cancelAsks();
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
      const rows = [];
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
      rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return rows.slice(0, limit);
    },

    onDidChangeSessions: changed.event,

    async createSession(cwd, { model } = {}) {
      const p = await ensure();
      const r = await p.conn.request('session/new', { cwd, mcpServers: [] });
      const current = noteModels(r && r.configOptions, true);
      const h = makeHandle(r.sessionId, cwd, '');
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
          execFile(p.found.path, ['session', 'delete', id], { timeout: 60000, env: { ...process.env, ...settings.env }, windowsHide: true },
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
