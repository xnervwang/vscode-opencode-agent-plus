// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Stands in for `opencode acp`: replays a script recorded from the real thing (fixtures/*.jsonl). Each script line is
 * one request the client sent, with what OpenCode sent back meanwhile: notifications, requests of its own (played
 * when the client has answered them) and `waitFor` a client notification such as session/cancel. A request takes the
 * next recorded line for its method, or the last one again when they run out. `after` holds what OpenCode sent once
 * it had answered, before the client's next request (a turn it started on its own); each step's recorded `delayMs`
 * is scaled by opts.afterScale, 0 by default, so they follow at once.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

function loadScript(name) {
  const file = path.join(__dirname, 'fixtures', name);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function fakeAgent(script, opts = {}) {
  const byMethod = new Map();
  for (const e of script) {
    if (!byMethod.has(e.on)) byMethod.set(e.on, []);
    byMethod.get(e.on).push(e);
  }
  const used = new Map();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  const received = [];
  const answers = new Map();
  const notices = [];
  const noticeWaiters = [];
  let nextId = 1000;

  const write = (msg) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(msg)}\n`); };
  const tick = () => new Promise((r) => setImmediate(r));

  // A real child keeps the event loop alive until it exits; so does this, so a stuck test times out instead.
  const alive = setInterval(() => {}, 1 << 30);
  function exit(code, signal) {
    if (child.exitCode !== null) return;
    clearInterval(alive);
    child.exitCode = code;
    child.signalCode = signal || null;
    setImmediate(() => { child.stdout.end(); child.emit('exit', code, signal || null); });
  }
  child.kill = (signal) => { exit(null, signal || 'SIGTERM'); return true; };

  function waitNotice(method) {
    const i = notices.indexOf(method);
    if (i >= 0) { notices.splice(i, 1); return Promise.resolve(); }
    return new Promise((resolve) => noticeWaiters.push({ method, resolve }));
  }

  async function playStep(step) {
    if (step.notify) write({ jsonrpc: '2.0', method: step.notify, params: step.params });
    else if (step.waitFor) await waitNotice(step.waitFor);
    else if (step.request) {
      const id = nextId++;
      const answered = new Promise((resolve) => answers.set(id, resolve));
      write({ jsonrpc: '2.0', id, method: step.request, params: step.params });
      await answered;
    }
  }

  const scale = typeof opts.afterScale === 'number' ? opts.afterScale : 0;
  const playedAfter = [];

  async function play(msg) {
    const list = byMethod.get(msg.method);
    if (!list) { write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `"Method not found": ${msg.method}` } }); return; }
    const n = used.get(msg.method) || 0;
    used.set(msg.method, n + 1);
    const entry = list[Math.min(n, list.length - 1)];
    for (const step of entry.send || []) {
      await tick();
      await playStep(step);
    }
    await tick();
    if (entry.error) write({ jsonrpc: '2.0', id: msg.id, error: entry.error });
    else write({ jsonrpc: '2.0', id: msg.id, result: entry.reply === undefined ? null : entry.reply });
    let last = 0;
    for (const step of n < list.length ? entry.after || [] : []) {
      const wait = scale > 0 ? Math.max(0, ((step.delayMs || 0) - last) * scale) : 0;
      last = step.delayMs || last;
      if (wait) await new Promise((r) => setTimeout(r, wait)); else await tick();
      await playStep(step);
      playedAfter.push(step);
    }
  }

  let buf = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      received.push(msg);
      if (msg.method && msg.id !== undefined) play(msg).catch((e) => { if (opts.log) opts.log(e.stack); });
      else if (msg.method) {
        const w = noticeWaiters.findIndex((x) => x.method === msg.method);
        if (w >= 0) noticeWaiters.splice(w, 1)[0].resolve(); else notices.push(msg.method);
      } else if (answers.has(msg.id)) {
        answers.get(msg.id)(msg);
        answers.delete(msg.id);
      }
    }
  });
  child.stdin.on('finish', () => exit(0));

  return { child, received, playedAfter, methods: () => received.filter((m) => m.method).map((m) => m.method) };
}

/* A startAcp replacement for createOpenCode that hands out fake agents and keeps them for the test to inspect.
   `script` is a fixture's name, or its lines already loaded. */
function fakeStarter(script, extra = [], agentOpts = {}) {
  const agents = [];
  const start = (launchOpts) => {
    const a = fakeAgent([...(Array.isArray(script) ? script : loadScript(script)), ...extra], agentOpts);
    a.launch = launchOpts;
    agents.push(a);
    return { child: a.child, stderrTail: () => '', args: ['acp'] };
  };
  return { start, agents };
}

module.exports = { fakeAgent, fakeStarter, loadScript };
