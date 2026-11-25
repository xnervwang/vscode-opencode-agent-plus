// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * OPENCODE_AGENT_PLUS_TEST_BACKEND for the window tests: createOpenCode's shape (src/opencode/index.js) with the scripted
 * conversation of test/ui/fake-conversation.js as each session, so no OpenCode and no model are needed. A session's
 * first turn draws every kind of item, a permission request included; a message "Say: <text>" is answered with <text>,
 * for a reply the test writes itself, and "Demo: <name>" plays the turn DEMOS names, for the pictures that compare the
 * page with Claude Code's. Sessions and the events each one emitted are kept in
 * <OPENCODE_AGENT_PLUS_HOME>/fake-backend.json, so a reloaded window finds them again.
 *
 * With OPENCODE_AGENT_PLUS_FAKE_DEMO=1 each session also offers what a real OpenCode 2 does: a mode and an effort to
 * pick, three slash commands, and images, workspace files and selections in a message.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFakeConversation, demoTurns, streamText } = require(path.join(__dirname, '..', 'ui', 'fake-conversation.js'));

const MODELS = [
  { id: 'fake/fake-small', invokeId: 'fake-small', providerId: 'fake', name: 'Fake Small', vendor: 'Test', contextWindow: 32000, maxOutputTokens: 4096, known: false },
  { id: 'fake/fake-large', invokeId: 'fake-large', providerId: 'fake', name: 'Fake Large', vendor: 'Test', contextWindow: 200000, maxOutputTokens: 8192, known: false },
];

const DEMO = process.env.OPENCODE_AGENT_PLUS_FAKE_DEMO === '1';
const COMMANDS = [
  { name: 'compact', description: 'Summarize the conversation to make room in the context window' },
  { name: 'init', description: 'Write an AGENTS.md for this project' },
  { name: 'review', description: 'Review the changes in the working tree' },
];
const OPTION_VALUES = {
  mode: { name: 'Mode', values: [{ value: 'build', name: 'Build', description: 'Edits files and runs commands' }, { value: 'plan', name: 'Plan', description: 'Reads and plans, changes nothing' }] },
  effort: { name: 'Effort', values: [{ value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
};

/* The demo turns, by the name after "Demo: ". Each is a list of steps for fake-conversation.js. */
const DEMOS = {
  conversation: () => [
    ...streamText('Read the exporter before changing it.', 16, 'reasoning'),
    ...streamText("I'll add the CSV export first and mark the plan row as in progress.", 12),
    { type: 'toolCall', id: 'd-1', name: 'bash', input: { command: 'ls src && git log --oneline -3', description: 'List the source files and recent commits' } },
    { type: 'toolResult', id: 'd-1', content: 'sum.js\n3f2a1c0 Add sum\n9b8e7d6 First commit', isError: false },
    { type: 'toolCall', id: 'd-2', name: 'write', input: { path: 'src/export.js', content: 'module.exports = (rows) => rows.map((r) => r.join(",")).join("\\n");\n' } },
    { type: 'toolResult', id: 'd-2', content: 'Wrote src/export.js (1 line).', isError: false },
    { type: 'usage', input: 5200, output: 160, contextUsed: 5360, costUsd: 0.0182 },
    ...streamText('The exporter is written. Next I\'ll wire `export` into the CLI with the `--month` filter.\n\n- **src/export.js** joins each row with commas.\n- The tests come next.\n', 14),
  ],
  question: () => [
    { type: 'toolCall', id: 'dq-t', name: 'question', input: { questions: [{ question: 'Which config should I change?', header: 'Config' }] } },
    { type: 'question', requestId: 'dq-1', toolId: 'dq-t', message: 'Which config should I change?', schema: { type: 'object', required: ['config'], properties: {
      config: { type: 'string', title: 'Config', description: 'Which config should I change?', oneOf: [
        { const: 'staging', title: 'Staging', description: 'The staging config' }, { const: 'production', title: 'Production', description: 'The production config' }] },
      config_custom: { type: 'string', description: 'Other' } } } },
    { type: 'toolResult', id: 'dq-t', content: 'Config: Staging', isError: false },
    ...streamText("I'll change the staging config.", 10),
  ],
  subagent: () => [
    { type: 'toolCall', id: 'ds-1', name: 'task', input: { description: 'Look through the notes', prompt: 'Look through notes.txt for the retry delay.', subagent_type: 'general' } },
    { type: 'subagent', childId: 'ses_demo_child', title: 'Look through the notes', status: 'running', toolId: 'ds-1', event: { type: 'toolCall', id: 'dc-1', name: 'read', input: { path: 'notes.txt' } } },
    { type: 'subagent', childId: 'ses_demo_child', status: 'running', event: { type: 'toolResult', id: 'dc-1', content: 'Some notes.', isError: false } },
    { type: 'subagent', childId: 'ses_demo_child', status: 'running', event: { type: 'text', delta: 'The notes do not name a retry delay.' } },
    { wait: 400 },
    { type: 'subagent', childId: 'ses_demo_child', status: 'done' },
    { type: 'toolResult', id: 'ds-1', content: 'The notes do not name a retry delay.', isError: false },
    ...streamText('The helper looked: the notes do not name a retry delay.', 12),
  ],
  helper: () => [
    { type: 'toolCall', id: 'dh-1', name: 'task', input: { description: 'Look through the notes', prompt: 'Look through notes.txt for the retry delay.', subagent_type: 'general' } },
    { type: 'subagent', childId: 'ses_demo_helper', title: 'Look through the notes', status: 'running', toolId: 'dh-1', event: { type: 'toolCall', id: 'dh-c1', name: 'read', input: { path: 'notes.txt' } } },
    ...streamText('A helper is looking through the notes in the background.', 12),
  ],
  background: () => [
    { type: 'toolCall', id: 'db-1', name: 'bash', input: { command: 'sleep 600; echo done', description: 'Start the long job in the background' } },
    { type: 'toolResult', id: 'db-1', content: 'Started in the background (process 4242).', isError: false },
    { type: 'background', id: 'db-1', kind: 'shell', title: 'sleep 600; echo done', status: 'running', pid: 4242 },
    ...streamText('Started the long job in the background.', 12),
  ],
  error: () => [
    { type: 'toolCall', id: 'de-1', name: 'bash', input: { command: 'npm test', description: 'Run the test suite' } },
    { type: 'toolResult', id: 'de-1', content: 'Exit code 127\n/bin/bash: npm: command not found', isError: true },
    ...streamText('npm is not installed on this machine, so the tests did not run.', 12),
  ],
  running: () => [
    ...streamText('Build first, then run the tests.', 16, 'reasoning'),
    { type: 'toolCall', id: 'dr-1', name: 'bash', input: { command: 'npm run build', description: 'Build the project' } },
    { wait: 600000 },
  ],
  compact: () => [
    { type: 'compaction', status: 'running' },
    { wait: 300 },
    { type: 'compaction', status: 'completed', summary: 'The user asked for a CSV export; src/export.js is written and the CLI is next.' },
  ],
};

/* Windows refuses a read or a rename for a moment while another process, such as a virus scanner, has the file open. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
function retried(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (process.platform !== 'win32' || !BUSY.has(e && e.code) || i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function createOpenCode() {
  const file = path.join(process.env.OPENCODE_AGENT_PLUS_HOME || '/tmp', 'fake-backend.json');
  const read = () => { try { return JSON.parse(retried(() => fs.readFileSync(file, 'utf8'))); } catch (_) { return { sessions: {} }; } };
  const write = (db) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(db)); retried(() => fs.renameSync(`${file}.tmp`, file)); };
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
      reload: async () => (read().sessions[saved.id] || saved).events,
      checkBackground: () => {},
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
      if (ev.type === 'question') { asking++; c.status = 'waiting'; c.waitingTool = 'question'; }
      if ((ev.type === 'permissionSettled' || ev.type === 'questionSettled') && --asking <= 0) { c.status = 'working'; c.waitingTool = ''; }
      if (ev.type === 'userMessage') { s.lastUserAt = c.lastUserAt = ev.at || Date.now(); if (!s.title) s.title = c.title = String(ev.text).slice(0, 60); }
      if (ev.type === 'turnEnd') { s.lastReplyAt = c.lastReplyAt = ev.at || Date.now(); c.status = 'idle'; }
      if (ev.type === 'title') s.title = ev.title;
      write(db);
      if (['turnStart', 'turnEnd', 'permission', 'permissionSettled', 'userMessage'].includes(ev.type)) changed(saved.id);
    });
    if (DEMO) {
      const picked = { mode: 'build', effort: 'default' };
      Object.assign(c, {
        commands: () => COMMANDS,
        attachments: () => ({ images: true, files: true, selection: true }),
        options: () => Object.entries(OPTION_VALUES).map(([id, o]) => ({ id, name: o.name, value: picked[id], values: o.values })),
        setOption: (id, value) => { if (OPTION_VALUES[id]) picked[id] = value; },
      });
    }
    const send = c.send;
    let said = 0;
    c.send = (text, extra) => {
      const demo = /^Demo: (\w+)/.exec(String(text));
      if (demo && DEMOS[demo[1]]) c.script(DEMOS[demo[1]]());
      const m = /^Say: ([\s\S]+)$/.exec(String(text));
      if (!m) return send.call(c, text, extra);
      const turnId = `say-${++said}`;
      setTimeout(() => {
        c.emit({ type: 'turnStart', turnId });
        c.emit({ type: 'userMessage', text: String(text) });
        for (let i = 0; i < m[1].length; i += 24) c.emit({ type: 'text', delta: m[1].slice(i, i + 24) });
        c.emit({ type: 'turnEnd', turnId, reason: 'endTurn' });
      }, 60);
      return Promise.resolve();
    };
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
    /* Reports an OpenCode 2, so the extension does not say the work plan needs a newer one. */
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
    canRename: () => true,
    async renameSession(id, title) {
      const db = read();
      if (!db.sessions[id]) throw new Error(`no session ${id}`);
      db.sessions[id].title = String(title);
      write(db);
      const c = live.get(id);
      if (c) { c.title = String(title); c.emit({ type: 'title', title: String(title) }); }
      changed(id);
    },
    canFork: () => true,
    async forkSession(id) {
      const db = read();
      const from = db.sessions[id];
      if (!from) throw new Error(`no session ${id}`);
      const now = Date.now();
      const s = { ...from, id: `ses_${crypto.randomBytes(8).toString('hex')}`, title: from.title ? `${from.title} (fork)` : '', lastActiveAt: now, events: from.events.slice() };
      db.sessions[s.id] = s;
      write(db);
      changed(s.id);
      return { id: s.id, cwd: s.cwd };
    },
    canRewind: () => false,
    info: () => ({ path: '/fake/opencode', version: { major: 2, minor: 0, patch: 0, text: '2.0.0-fake' }, pid: process.pid, agent: { name: 'fake' } }),
    dataPaths: async () => ({ db: file }),
    mcpList: async () => 'No MCP servers configured (the fake backend has none)',
    async deleteSession(id) { const c = live.get(id); if (c) c.dispose(); const db = read(); delete db.sessions[id]; write(db); changed(id); },
    listModels: () => MODELS,
    defaultModel: () => MODELS[0],
    bedrockStatus: () => ({ state: 'notListed', models: 0, opencodeMajor: 1, help: 'The fake backend has no Bedrock.' }),
    restart: async () => {},
    async dispose() { for (const c of [...live.values()]) c.dispose(); listeners.clear(); },
  };
}

module.exports = { createOpenCode, MODELS };
