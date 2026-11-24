// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The agent behind the chat pages: src/opencode/index.js (OpenCode's server), or the module NEW_AGENT_TEST_BACKEND
 * names in the window tests. This file is the one place that knows that module's names; the rest of src/host/ sees:
 *
 *   listSessions()               Promise<SessionInfo[]>
 *   onDidChangeSessions(fn)      { dispose }
 *   createSession(cwd)           Promise<SessionInfo>
 *   renameSession(id, title)     Promise
 *   deleteSession(id)            Promise
 *   session(id)                  Promise of the session object: on(listener) of AgentEvents, send(text, images?),
 *                                abort(), setModel(model), respondPermission(requestId, decision), history()
 *   listModels(), defaultModel() Promise<ModelInfo[]>, Promise<ModelInfo | string | null>
 *   dispose()
 *
 * SessionInfo: { id, title, cwd, createdAt, lastActiveAt, status: 'working' | 'waiting' | 'idle', waitingFor?: { tool },
 * lastUserAt, lastReplyAt }, times in epoch milliseconds. The module is required on first use, not at activation.
 */
const num = (v) => {
  const n = typeof v === 'string' && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function normInfo(s) {
  if (!s || typeof s !== 'object') return null;
  const id = String(s.id || s.sessionId || '');
  if (!id) return null;
  const out = {
    id,
    title: typeof s.title === 'string' ? s.title : '',
    cwd: String(s.cwd || s.directory || ''),
    createdAt: num(s.createdAt),
    lastActiveAt: num(s.lastActiveAt) || num(s.updatedAt) || num(s.createdAt),
    status: s.status === 'working' || s.status === 'waiting' ? s.status : 'idle',
    lastUserAt: num(s.lastUserAt),
    lastReplyAt: num(s.lastReplyAt),
  };
  const tool = (s.waitingFor && s.waitingFor.tool) || s.waitingTool || '';
  if (out.status === 'waiting') out.waitingFor = { tool: String(tool) };
  return out;
}

/* `options` go to the module's factory as they are; `load` replaces require for the tests. */
function createBackend({ options = {}, load } = {}) {
  let made = null;
  const get = () => {
    if (made) return made;
    const mod = load ? load() : require(process.env.NEW_AGENT_TEST_BACKEND || '../opencode');
    const factory = mod.createBackend || mod.createOpenCode || mod.create;
    if (typeof factory !== 'function') throw new Error('the agent backend exports no factory');
    made = factory(options);
    return made;
  };
  const call = (name, ...args) => Promise.resolve().then(() => {
    const b = get();
    if (typeof b[name] !== 'function') throw new Error(`the agent backend has no ${name}()`);
    return b[name](...args);
  });
  const listeners = new Set();
  let hooked = null;
  const hook = () => {
    if (hooked) return;
    const b = get();
    const fn = (...a) => { for (const l of [...listeners]) { try { l(...a); } catch (_) { /* the others still run */ } } };
    hooked = typeof b.onDidChangeSessions === 'function' ? b.onDidChangeSessions(fn) : null;
  };

  return {
    /* Whether the module has been loaded, which also says whether its server may be running. */
    get started() { return !!made; },
    listSessions: () => call('listSessions').then((l) => (Array.isArray(l) ? l.map(normInfo).filter(Boolean) : [])),
    onDidChangeSessions(fn) {
      listeners.add(fn);
      if (made) hook();
      return { dispose: () => listeners.delete(fn) };
    },
    /* Starts listening once something has started the module, so activation does not start it. */
    listen() { try { hook(); } catch (_) { /* not available */ } },
    createSession: (cwd) => call('createSession', cwd).then((s) => normInfo(typeof s === 'string' ? { id: s, cwd } : s)),
    renameSession: (id, title) => call('renameSession', id, title),
    deleteSession: (id) => call('deleteSession', id),
    session: (id) => call(typeof get().session === 'function' ? 'session' : 'openSession', id),
    listModels: () => call('listModels'),
    defaultModel: () => (made && typeof made.defaultModel !== 'function' ? Promise.resolve(null) : call('defaultModel')),
    dispose() {
      listeners.clear();
      try { if (hooked && typeof hooked.dispose === 'function') hooked.dispose(); } catch (_) { /* gone */ }
      try { if (made && typeof made.dispose === 'function') made.dispose(); } catch (_) { /* gone */ }
    },
  };
}

module.exports = { createBackend, normInfo };
