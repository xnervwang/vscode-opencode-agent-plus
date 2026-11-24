// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * NEW_AGENT_TEST_BACKEND for the window tests: the shape src/host/backend.js expects, with task three's scripted
 * conversation (test/ui/fake-conversation.js) as each session. Its first turn draws every kind of item, a permission
 * request included. Sessions and the events each one emitted are kept in <NEW_AGENT_HOME>/fake-backend.json, so a
 * reloaded window finds them again.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFakeConversation, demoTurns } = require(path.join(__dirname, '..', 'ui', 'fake-conversation.js'));

const MODELS = [
  { id: 'fake-small', providerId: 'fake', name: 'Fake Small', vendor: 'Test', contextWindow: 32000, maxOutputTokens: 4096, known: true },
  { id: 'fake-large', providerId: 'fake', name: 'Fake Large', vendor: 'Test', contextWindow: 200000, maxOutputTokens: 8192, known: true },
];

function createBackend() {
  const file = path.join(process.env.NEW_AGENT_HOME || '/tmp', 'fake-backend.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { sessions: {} }; } };
  const write = (db) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(db)); fs.renameSync(`${file}.tmp`, file); };
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch (_) { /* the others still run */ } } };
  const live = new Map();

  const info = (s) => {
    const c = live.get(s.id);
    const waiting = c && c.events.length && c.events.filter((e) => e.type === 'permission').length > c.events.filter((e) => e.type === 'permissionSettled').length;
    return { ...s, status: c && c.busy ? (waiting ? 'waiting' : 'working') : 'idle', waitingFor: waiting ? { tool: 'edit_file' } : undefined };
  };

  return {
    listSessions: async () => Object.values(read().sessions).map(info),
    onDidChangeSessions(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    async createSession(cwd) {
      const db = read();
      const now = Date.now();
      const s = { id: `ses_${crypto.randomBytes(8).toString('hex')}`, title: '', cwd, createdAt: now, lastActiveAt: now, lastUserAt: 0, lastReplyAt: 0, events: [] };
      db.sessions[s.id] = s;
      write(db);
      changed();
      return { ...s, events: undefined };
    },
    async renameSession(id, title) { const db = read(); if (db.sessions[id]) { db.sessions[id].title = title; write(db); changed(); } },
    async deleteSession(id) { const db = read(); delete db.sessions[id]; write(db); changed(); },
    async session(id) {
      const saved = read().sessions[id];
      if (!saved) throw new Error(`no session ${id}`);
      const c = createFakeConversation({ turns: saved.events.length ? [] : demoTurns(), stepMs: 60 });
      live.set(id, c);
      c.respondPermission = (rid, d) => c.respond(rid, d);
      c.history = () => saved.events;
      c.on((ev) => {
        const db = read();
        const s = db.sessions[id];
        if (!s) return;
        s.events.push(ev);
        s.lastActiveAt = Date.now();
        if (ev.type === 'userMessage') { s.lastUserAt = ev.at || Date.now(); if (!s.title) s.title = String(ev.text).slice(0, 60); }
        if (ev.type === 'turnEnd') s.lastReplyAt = ev.at || Date.now();
        write(db);
        if (['turnStart', 'turnEnd', 'permission', 'permissionSettled', 'userMessage'].includes(ev.type)) changed();
      });
      const dispose = c.dispose;
      c.dispose = () => { live.delete(id); dispose.call(c); };
      return c;
    },
    listModels: async () => MODELS,
    defaultModel: async () => MODELS[0],
    dispose() { listeners.clear(); },
  };
}

module.exports = { createBackend, MODELS };
