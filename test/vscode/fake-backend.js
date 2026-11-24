// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * OPENCODE_PLUS_TEST_BACKEND for the window tests: createOpenCode's shape (src/opencode/index.js) with task three's scripted
 * conversation (test/ui/fake-conversation.js) as each session, so no OpenCode and no model are needed. A session's
 * first turn draws every kind of item, a permission request included. Sessions and the events each one emitted are
 * kept in <OPENCODE_PLUS_HOME>/fake-backend.json, so a reloaded window finds them again.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFakeConversation, demoTurns } = require(path.join(__dirname, '..', 'ui', 'fake-conversation.js'));

const MODELS = [
  { id: 'fake/fake-small', invokeId: 'fake-small', providerId: 'fake', name: 'Fake Small', vendor: 'Test', contextWindow: 32000, maxOutputTokens: 4096, known: false },
  { id: 'fake/fake-large', invokeId: 'fake-large', providerId: 'fake', name: 'Fake Large', vendor: 'Test', contextWindow: 200000, maxOutputTokens: 8192, known: false },
];

function createOpenCode() {
  const file = path.join(process.env.OPENCODE_PLUS_HOME || '/tmp', 'fake-backend.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { sessions: {} }; } };
  const write = (db) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(db)); fs.renameSync(`${file}.tmp`, file); };
  const listeners = new Set();
  const changed = (sessionId) => { for (const fn of [...listeners]) { try { fn({ sessionId }); } catch (_) { /* the others still run */ } } };
  const live = new Map();

  function handle(saved) {
    const c = createFakeConversation({ turns: saved.events.length ? [] : demoTurns(), stepMs: 60 });
    let model = saved.model || MODELS[0].id;
    let asking = 0;
    Object.assign(c, {
      id: saved.id, cwd: saved.cwd, title: saved.title, status: 'idle', waitingTool: '', lastUserAt: saved.lastUserAt, lastReplyAt: saved.lastReplyAt,
      respondPermission: (rid, d) => c.respond(rid, d),
      history: async () => saved.events,
      getModel: () => model,
      setModel: (m) => { model = typeof m === 'string' ? m : m.id; const db = read(); if (db.sessions[saved.id]) { db.sessions[saved.id].model = model; write(db); } },
    });
    c.on((ev) => {
      const db = read();
      const s = db.sessions[saved.id];
      if (!s) return;
      s.events.push(ev);
      s.lastActiveAt = Date.now();
      if (ev.type === 'turnStart') c.status = 'working';
      if (ev.type === 'permission') { asking++; c.status = 'waiting'; c.waitingTool = ev.request.tool; }
      if (ev.type === 'permissionSettled' && --asking <= 0) { c.status = 'working'; c.waitingTool = ''; }
      if (ev.type === 'userMessage') { s.lastUserAt = c.lastUserAt = ev.at || Date.now(); if (!s.title) s.title = c.title = String(ev.text).slice(0, 60); }
      if (ev.type === 'turnEnd') { s.lastReplyAt = c.lastReplyAt = ev.at || Date.now(); c.status = 'idle'; }
      write(db);
      if (['turnStart', 'turnEnd', 'permission', 'permissionSettled', 'userMessage'].includes(ev.type)) changed(saved.id);
    });
    const dispose = c.dispose;
    c.dispose = () => { live.delete(saved.id); dispose.call(c); };
    live.set(saved.id, c);
    return c;
  }

  const row = (s) => {
    const c = live.get(s.id);
    const out = { id: s.id, title: s.title, cwd: s.cwd, lastActiveAt: s.lastActiveAt, status: c ? c.status : 'idle', lastUserAt: s.lastUserAt, lastReplyAt: s.lastReplyAt, open: !!c };
    if (c && c.status === 'waiting') out.waitingFor = { kind: 'permission', tool: c.waitingTool };
    return out;
  };

  return {
    /* Stands in for the OpenCode the extension is built for, so it does not say the work plan needs a newer one. */
    detect: () => ({ path: '/fake/opencode', version: { major: 2, minor: 0, patch: 0, text: '2.0.0-fake' }, line: 2 }),
    listSessions: async () => Object.values(read().sessions).map(row).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    onDidChangeSessions(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    async createSession(cwd, { model } = {}) {
      const db = read();
      const now = Date.now();
      const s = { id: `ses_${crypto.randomBytes(8).toString('hex')}`, title: '', cwd, lastActiveAt: now, lastUserAt: 0, lastReplyAt: 0, model: model || MODELS[0].id, events: [] };
      db.sessions[s.id] = s;
      write(db);
      changed(s.id);
      return handle(s);
    },
    async openSession(id) {
      if (live.has(id)) return live.get(id);
      const saved = read().sessions[id];
      if (!saved) throw new Error(`no session ${id}`);
      return handle(saved);
    },
    renameSession: () => Promise.reject(Object.assign(new Error('OpenCode has no way to rename a conversation over ACP.'), { code: 'unsupported' })),
    async deleteSession(id) { const c = live.get(id); if (c) c.dispose(); const db = read(); delete db.sessions[id]; write(db); changed(id); },
    listModels: () => MODELS,
    defaultModel: () => MODELS[0],
    bedrockStatus: () => ({ state: 'notListed', models: 0, opencodeMajor: 1, help: 'The fake backend has no Bedrock.' }),
    restart: async () => {},
    async dispose() { for (const c of [...live.values()]) c.dispose(); listeners.clear(); },
  };
}

module.exports = { createOpenCode, MODELS };
