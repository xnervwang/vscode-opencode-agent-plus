// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Connect a Model Provider: OpenCode's own sign-in wizard (src/opencode/login.js) in a terminal of this window, so over
 * Remote-SSH it runs on the remote machine, where OpenCode keeps its credentials. This module only opens it. When the
 * terminal closes, `done()` runs, which starts OpenCode again and lists the models anew: a running
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
      Promise.resolve().then(() => done({ exitCode: code })).catch((e) => log(`handling the end of the provider sign-in failed: ${(e && e.message) || e}`));
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
    /* Opens the wizard's terminal, or shows the one already open, and resolves with the terminal (null when it could not
       start). */
    run() {
      if (open) { open.show(false); return Promise.resolve(open); }
      if (!starting) starting = start().finally(() => { starting = null; });
      return starting;
    },
    get terminal() { return open; },
    dispose() { for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } },
  };
}

/* The providers that `after` has and `before` lacks (compared by providerId), in `after`'s order. */
function addedProviders(before, after) {
  const had = new Set((Array.isArray(before) ? before : []).map((m) => m && m.providerId));
  const out = [];
  for (const m of Array.isArray(after) ? after : []) {
    const p = m && m.providerId;
    if (p && !had.has(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

const names = (l) => (l.length < 3 ? l.join(' and ') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

/*
 * What to say once the sign-in terminal has closed and OpenCode lists its models again. `before` and `after` are
 * OpenCode's credentials around the sign-in (backend credentials(): [{ id, name, credentials }]), each null when
 * OpenCode could not say; `had` the models listed before it and `now` those listed after it. A sign-in that saves a
 * credential gives it a new id, so a provider with a new id was signed in: connected, when it had no credential and
 * no models before, and signed in again otherwise. Without both credential lists, only the models are compared, and
 * no change in them is not taken as a failed sign-in.
 */
function loginOutcome({ before, after, had, now }) {
  const count = Array.isArray(now) ? now.length : 0;
  const offers = count ? ` OpenCode offers ${count} model${count === 1 ? '' : 's'}.` : '';
  const added = addedProviders(had, now);
  if (Array.isArray(before) && Array.isArray(after)) {
    const old = new Map(before.map((i) => [i.id, new Set(i.credentials)]));
    const listed = new Set((Array.isArray(had) ? had : []).map((m) => m && m.providerId));
    const fresh = [];
    const again = [];
    for (const i of after) {
      const was = old.get(i.id);
      if (!i.credentials.some((c) => !was || !was.has(c))) continue;
      ((was && was.size) || listed.has(i.id) ? again : fresh).push(i.name);
    }
    const said = [];
    if (fresh.length) said.push(`Connected ${names(fresh)}.`);
    if (again.length) said.push(`Saved new credentials for ${names(again)}, ${again.length === 1 ? 'which was' : 'which were'} already connected.`);
    if (said.length) return `${said.join(' ')}${offers}`;
    if (added.length) return `OpenCode now offers models from ${names(added)}.`;
    return `The sign-in closed without saving credentials, so nothing changed.${offers}`;
  }
  if (added.length) return `OpenCode now offers models from ${names(added)}.`;
  return count ? `OpenCode restarted and offers ${count} model${count === 1 ? '' : 's'}.` : 'OpenCode restarted.';
}

/* Whether `list` is not empty and holds only OpenCode's own free models (provider opencode). */
function onlyFreeModels(list) {
  const l = Array.isArray(list) ? list.filter(Boolean) : [];
  return l.length > 0 && l.every((m) => m.providerId === 'opencode' || String(m.id || '').startsWith('opencode/'));
}

module.exports = { createProviderLogin, addedProviders, loginOutcome, onlyFreeModels, TERMINAL_NAME };
