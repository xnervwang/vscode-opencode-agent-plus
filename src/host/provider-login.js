// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Connect a Model Provider: OpenCode's own sign-in wizard (src/opencode/login.js) in a terminal of this window, so over
 * Remote-SSH it runs on the remote machine, where OpenCode keeps its credentials. The wizard is OpenCode's; this only
 * opens it. When the terminal closes, `done()` runs, which starts OpenCode again and lists the models anew: a running
 * OpenCode does not see a provider added meanwhile (2.4.1, measured). One terminal at a time; asking again shows it.
 * The terminal is transient, so a window reload does not start the wizard again.
 */
const TERMINAL_NAME = 'OpenCode: Connect a Provider';

/*
 * deps:
 *   vscode
 *   launch()   Promise of { shellPath, shellArgs, env } (login.js loginLaunch)
 *   done({ exitCode })   after the terminal closes; its failure is logged
 *   fail(what, error), log(line)
 */
function createProviderLogin({ vscode, launch, done, fail, log = () => {} }) {
  let open = null;
  let starting = null;
  const subs = [];
  if (typeof vscode.window.onDidCloseTerminal === 'function') {
    subs.push(vscode.window.onDidCloseTerminal((t) => {
      if (!open || t !== open) return;
      open = null;
      const code = t.exitStatus ? t.exitStatus.code : undefined;
      log(`the provider sign-in terminal closed${code === undefined ? '' : ` with exit code ${code}`}`);
      Promise.resolve().then(() => done({ exitCode: code })).catch((e) => log(`after the provider sign-in: ${(e && e.message) || e}`));
    }));
  }

  async function start() {
    let l;
    try { l = await launch(); } catch (e) { fail('OpenCode\'s sign-in could not be started', e); return null; }
    const opts = { name: TERMINAL_NAME, shellPath: l.shellPath, shellArgs: l.shellArgs, env: l.env, isTransient: true };
    if (typeof vscode.ThemeIcon === 'function') opts.iconPath = new vscode.ThemeIcon('key');
    const t = vscode.window.createTerminal(opts);
    open = t;
    t.show(false);
    log(`provider sign-in: ${l.shellPath} ${l.shellArgs.join(' ')}`);
    return t;
  }

  return {
    TERMINAL_NAME,
    /* Opens the wizard's terminal, or shows the one already open; resolves with it, or null when it could not start. */
    run() {
      if (open) { open.show(false); return Promise.resolve(open); }
      if (!starting) starting = start().finally(() => { starting = null; });
      return starting;
    },
    get terminal() { return open; },
    dispose() { for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } },
  };
}

/* The providers of `after` that `before` did not have, by providerId, in the order `after` lists them. */
function addedProviders(before, after) {
  const had = new Set((Array.isArray(before) ? before : []).map((m) => m && m.providerId));
  const out = [];
  for (const m of Array.isArray(after) ? after : []) {
    const p = m && m.providerId;
    if (p && !had.has(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/* Whether every model of `list` is one of OpenCode's own free ones (provider opencode), and there is at least one. */
function onlyFreeModels(list) {
  const l = Array.isArray(list) ? list.filter(Boolean) : [];
  return l.length > 0 && l.every((m) => m.providerId === 'opencode' || String(m.id || '').startsWith('opencode/'));
}

module.exports = { createProviderLogin, addedProviders, onlyFreeModels, TERMINAL_NAME };
