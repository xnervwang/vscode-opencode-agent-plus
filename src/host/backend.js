// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The agent behind the chat pages: src/opencode/index.js (OpenCode's server), or the module OPENCODE_PLUS_TEST_BACKEND
 * names in the window tests. This file is the one place that knows that module's names; the rest of src/host/ sees:
 *
 *   listSessions()               Promise<SessionInfo[]>
 *   onDidChangeSessions(fn)      { dispose }
 *   createSession(cwd, opts)     Promise of the new session object
 *   renameSession(id, title)     Promise; OpenCode 1 refuses it
 *   canRename()                  whether this OpenCode can rename (version 2 or later); asking loads the module but does
 *                                not start OpenCode
 *   deleteSession(id)            Promise
 *   forkSession(id), canFork()   a copy of the whole conversation: Promise of { id, cwd }; whether OpenCode offers it
 *                                (known once it has started)
 *   rewindStage(id, messageId), rewindCommit(id), rewindClear(id), canRewind()
 *                                rewinding to before a user message (OpenCode 2): stage restores the files and lists
 *                                them ({ messageId, tracked, files }), commit removes the messages, clear undoes stage
 *   userMessages(id)             Promise of [{ id, text, at }], the user's messages as OpenCode stored them
 *   mcpList()                    Promise of the text `opencode mcp list` prints
 *   dataPaths()                  Promise of OpenCode's folders ({ db, data, ... })
 *   info()                       the running OpenCode: { path, version, pid, agent, capabilities }, or null
 *   session(id, { cwd })         Promise of the session object: id, cwd, title, status, waitingTool, waitingKind,
 *                                lastUserAt, lastReplyAt, on(listener) of AgentEvents, send(text, { images, files }?),
 *                                abort(), setModel(model), getModel(), options(), setOption(id, value), commands(),
 *                                attachments(), respondPermission(requestId, decision), respondQuestion(requestId,
 *                                answer), history(), reload(), checkBackground(), dispose()
 *   isChild(id)                  whether a session is a subagent's; false until the module is loaded
 *   listModels(), defaultModel() Promise<ModelInfo[]>, Promise<ModelInfo | string | null>
 *   bedrockStatus(), restart(settings), detect()   passed through
 *   dispose()                    Promise
 *
 * SessionInfo (normInfo): { id, title, cwd, createdAt, lastActiveAt, status: 'working' | 'waiting' | 'idle',
 * waitingFor?: { kind, tool }, lastUserAt, lastReplyAt }, times in epoch milliseconds. The module is required on first use,
 * not at activation.
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
  if (s.open === true) out.open = true;
  if (out.status === 'waiting') out.waitingFor = s.waitingFor && s.waitingFor.kind === 'question' ? { kind: 'question', tool: '' } : { kind: 'permission', tool: String(tool) };
  return out;
}

/* `options` (an object, or a function returning one when the module is loaded) go to the module's factory
   (createOpenCode) as they are; `load` replaces require for the tests. */
function createBackend({ options = {}, load } = {}) {
  let made = null;
  const get = () => {
    if (made) return made;
    const mod = load ? load() : require(process.env.OPENCODE_PLUS_TEST_BACKEND || '../opencode');
    const factory = mod.createOpenCode || mod.createBackend || mod.create;
    if (typeof factory !== 'function') throw new Error('the agent backend exports no factory');
    made = factory(typeof options === 'function' ? options() : options);
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
    get started() { return !!made; },
    listSessions: () => call('listSessions').then((l) => (Array.isArray(l) ? l.map(normInfo).filter(Boolean) : [])),
    onDidChangeSessions(fn) {
      listeners.add(fn);
      if (made) hook();
      return { dispose: () => listeners.delete(fn) };
    },
    /* Subscribes to the module's session changes. It loads the module, so it is called only after something else has. */
    listen() { try { hook(); } catch (_) { /* not available */ } },
    createSession: (cwd, opts) => call('createSession', cwd, opts || {}),
    renameSession: (id, title) => call('renameSession', id, title),
    canRename: () => {
      try {
        const b = get();
        return typeof b.canRename === 'function' ? b.canRename() === true : typeof b.renameSession === 'function';
      } catch (_) { return false; }
    },
    deleteSession: (id) => call('deleteSession', id),
    forkSession: (id) => call('forkSession', id),
    canFork: () => { try { const b = made; return !!b && typeof b.canFork === 'function' && b.canFork() === true; } catch (_) { return false; } },
    canRewind: () => { try { const b = get(); return typeof b.canRewind === 'function' && b.canRewind() === true; } catch (_) { return false; } },
    rewindStage: (id, messageId) => call('rewindStage', id, messageId),
    rewindCommit: (id) => call('rewindCommit', id),
    rewindClear: (id) => call('rewindClear', id),
    userMessages: (id) => call('userMessages', id),
    mcpList: () => call('mcpList'),
    dataPaths: () => call('dataPaths'),
    info: () => { try { return made && typeof made.info === 'function' ? made.info() || null : null; } catch (_) { return null; } },
    session: (id, opts) => call(typeof get().session === 'function' ? 'session' : 'openSession', id, opts || {}),
    isChild: (id) => { try { return !!made && typeof made.isChild === 'function' && made.isChild(id) === true; } catch (_) { return false; } },
    listModels: () => call('listModels').then((l) => (Array.isArray(l) ? l : [])),
    defaultModel: () => (made && typeof made.defaultModel !== 'function' ? Promise.resolve(null) : call('defaultModel')),
    bedrockStatus: () => (made && typeof made.bedrockStatus !== 'function' ? Promise.resolve(null) : call('bedrockStatus')),
    detect: () => call('detect'),
    restart: (next) => (made && typeof made.restart === 'function' ? Promise.resolve().then(() => made.restart(next)) : Promise.resolve()),
    dispose() {
      listeners.clear();
      try { if (hooked && typeof hooked.dispose === 'function') hooked.dispose(); } catch (_) { /* gone */ }
      return Promise.resolve().then(() => (made && typeof made.dispose === 'function' ? made.dispose() : undefined)).catch(() => {});
    },
  };
}

module.exports = { createBackend, normInfo };
