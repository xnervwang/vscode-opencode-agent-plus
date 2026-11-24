// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * JSON-RPC 2.0 over a child's stdio, one JSON object per line: the transport the Agent Client Protocol uses. Requests
 * the agent sends us (session/request_permission) go to `onRequest`, whose promise may stay pending for as long as
 * the user takes to answer.
 */

class RpcError extends Error {
  constructor(error, method) {
    const e = error && typeof error === 'object' ? error : { code: -32603, message: String(error) };
    super(typeof e.message === 'string' ? e.message : JSON.stringify(e));
    this.code = typeof e.code === 'number' ? e.code : -32603;
    this.data = e.data;
    this.method = method;
  }
}

const METHOD_NOT_FOUND = -32601;

/*
 * opts.onRequest(method, params) -> result or Promise of it; throw { code, message } to answer with an error.
 * opts.onNotification(method, params), opts.onExit({ code, signal, error }), opts.log(line).
 */
function createConnection(child, opts = {}) {
  const log = (line) => { try { if (opts.log) opts.log(line); } catch (_) { /* not logged */ } };
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let closed = false;

  function write(msg) {
    if (closed) return false;
    try { child.stdin.write(`${JSON.stringify(msg)}\n`); return true; } catch (e) { log(`acp write failed: ${e.message}`); return false; }
  }

  async function answer(msg) {
    let reply;
    try {
      if (typeof opts.onRequest !== 'function') throw { code: METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` };
      reply = { jsonrpc: '2.0', id: msg.id, result: (await opts.onRequest(msg.method, msg.params || {})) ?? null };
    } catch (e) {
      const code = e && typeof e.code === 'number' ? e.code : -32603;
      reply = { jsonrpc: '2.0', id: msg.id, error: { code, message: String((e && e.message) || e) } };
    }
    write(reply);
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { log(`acp sent a line that is not JSON: ${line.slice(0, 200)}`); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.method && msg.id !== undefined && msg.id !== null) { answer(msg); return; }
    if (msg.method) {
      try { if (opts.onNotification) opts.onNotification(msg.method, msg.params || {}); } catch (e) { log(`acp notification handler failed: ${(e && e.stack) || e}`); }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error, p.method)); else p.resolve(msg.result);
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });

  function shut(info) {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError({ code: -32000, message: info.message }, p.method));
    }
    pending.clear();
    try { if (opts.onExit) opts.onExit(info); } catch (_) { /* reported */ }
  }
  child.on('exit', (code, signal) => shut({ code, signal, message: `OpenCode exited (${signal || `code ${code}`})` }));
  child.on('error', (error) => shut({ code: null, signal: null, error, message: `OpenCode could not run: ${error.message}` }));
  if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', (e) => log(`acp stdin: ${e.message}`));

  return {
    /* timeoutMs 0 waits as long as it takes (session/prompt runs for the whole turn). */
    request(method, params, { timeoutMs = 60000 } = {}) {
      if (closed) return Promise.reject(new RpcError({ code: -32000, message: 'OpenCode is not running' }, method));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, method, timer: null };
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new RpcError({ code: -32001, message: `${method} timed out after ${Math.round(timeoutMs / 1000)}s` }, method));
          }, timeoutMs);
        }
        pending.set(id, entry);
        if (!write({ jsonrpc: '2.0', id, method, params })) {
          pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(new RpcError({ code: -32000, message: 'OpenCode is not running' }, method));
        }
      });
    },
    notify(method, params) { write({ jsonrpc: '2.0', method, params }); },
    get closed() { return closed; },
  };
}

module.exports = { createConnection, RpcError, METHOD_NOT_FOUND };
