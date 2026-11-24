// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createConnection, RpcError } = require('../../src/opencode/client');

function pipePair() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  const sent = [];
  let buf = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { sent.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  return { child, sent, say: (s) => child.stdout.write(s) };
}

const flush = () => new Promise((r) => setImmediate(r));

test('requests get their responses, split or joined however the lines arrive', async () => {
  const { child, sent, say } = pipePair();
  const conn = createConnection(child);
  const a = conn.request('initialize', { protocolVersion: 1 });
  const b = conn.request('session/new', { cwd: '/w' });
  await flush();
  assert.deepEqual(sent.map((m) => [m.id, m.method]), [[1, 'initialize'], [2, 'session/new']]);
  say('{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s');
  say('1"}}\n{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
  assert.deepEqual(await b, { sessionId: 's1' });
  assert.deepEqual(await a, { protocolVersion: 1 });
});

test('an error response rejects with its code; notifications reach the handler', async () => {
  const { child, say } = pipePair();
  const seen = [];
  const conn = createConnection(child, { onNotification: (m, p) => seen.push([m, p]) });
  const r = conn.request('session/set_model', {});
  await flush();
  say('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk"}}}\n');
  say('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n');
  await assert.rejects(r, (e) => e instanceof RpcError && e.code === -32601 && e.method === 'session/set_model');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'session/update');
});

test('a request from the agent is answered with what the handler resolves, however late', async () => {
  const { child, sent, say } = pipePair();
  let release;
  createConnection(child, { onRequest: (method) => new Promise((resolve) => { release = () => resolve({ outcome: { outcome: 'selected', optionId: method } }); }) });
  say('{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}\n');
  await flush();
  assert.equal(sent.length, 0, 'no answer until the user decides');
  release();
  await flush();
  await flush();
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'session/request_permission' } } });
});

test('an unhandled agent request gets method-not-found', async () => {
  const { child, sent, say } = pipePair();
  createConnection(child);
  say('{"jsonrpc":"2.0","id":3,"method":"fs/read_text_file","params":{}}\n');
  await flush();
  await flush();
  assert.equal(sent[0].error.code, -32601);
});

test('the process exiting fails what is pending and reports once', async () => {
  const { child } = pipePair();
  const exits = [];
  const conn = createConnection(child, { onExit: (i) => exits.push(i) });
  const r = conn.request('session/prompt', {}, { timeoutMs: 0 });
  child.emit('exit', 1, null);
  child.emit('exit', 1, null);
  await assert.rejects(r, /exited/);
  assert.equal(exits.length, 1);
  assert.equal(conn.closed, true);
  await assert.rejects(conn.request('initialize', {}), /not running/);
});

test('a request times out when asked to', async () => {
  const { child } = pipePair();
  const conn = createConnection(child);
  await assert.rejects(conn.request('session/list', {}, { timeoutMs: 20 }), /timed out/);
});
