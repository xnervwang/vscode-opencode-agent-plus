// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Loaded as a development extension into the window that test/vscode/run.js drives, which cannot reach the vscode API
 * from outside. run.js writes <id>.req.json into the folder OPENCODE_PLUS_UI_CONTROL names; this runs its body as an async
 * function of (vscode, require, arg) and writes <id>.res.json. Files rather than a socket, because the window is
 * reloaded during a run and a request left in the folder waits for the next extension host, which announces itself in
 * host-<pid>.json.
 */
const fs = require('fs');
const path = require('path');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function activate(context) {
  const vscode = require('vscode');
  const dir = process.env.OPENCODE_PLUS_UI_CONTROL;
  if (!dir) return;
  const write = (name, value) => {
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, path.join(dir, name));
  };
  const busy = new Set();
  const take = async (name) => {
    const id = name.slice(0, -'.req.json'.length);
    const taken = path.join(dir, `${id}.taken-${process.pid}`);
    try { fs.renameSync(path.join(dir, name), taken); } catch (_) { return; }
    let reply;
    try {
      const { body, arg } = JSON.parse(fs.readFileSync(taken, 'utf8'));
      reply = { ok: true, value: await new AsyncFunction('vscode', 'require', 'arg', body)(vscode, require, arg) };
    } catch (e) {
      reply = { ok: false, error: String((e && e.stack) || e) };
    }
    try { write(`${id}.res.json`, reply); } catch (e) { write(`${id}.res.json`, { ok: false, error: `the result could not be sent: ${e.message}` }); }
    fs.rmSync(taken, { force: true });
  };
  const timer = setInterval(() => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      if (!n.endsWith('.req.json') || busy.has(n)) continue;
      busy.add(n);
      take(n).finally(() => busy.delete(n));
    }
  }, 150);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  write(`host-${process.pid}.json`, { pid: process.pid, at: Date.now(), version: vscode.version });
}

module.exports = { activate, deactivate() {} };
