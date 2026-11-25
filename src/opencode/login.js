// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What runs when the user connects a model provider: OpenCode's own sign-in wizard, `opencode auth login`, in a
 * terminal. ACP's initialize answer offers it as the auth method opencode-login, whose `_meta["terminal-auth"]` names
 * the arguments when OpenCode sends them. The program is always the OpenCode this extension found, never the
 * `opencode` on PATH that the method names, and the environment is the one its other subcommands get (server.js
 * subcommandEnv); on 2.x `--standalone` keeps the wizard off the shared background service, as for every subcommand.
 */
const server = require('./server');

const DEFAULT_ARGS = Object.freeze(['auth', 'login']);
const METHOD_ID = 'opencode-login';

/* The arguments of the first terminal sign-in an auth method gives, else `auth login`. */
function terminalArgs(authMethods) {
  for (const m of Array.isArray(authMethods) ? authMethods : []) {
    const t = m && m._meta && m._meta['terminal-auth'];
    if (t && Array.isArray(t.args) && t.args.length && t.args.every((a) => typeof a === 'string' && a.length < 200)) return t.args.slice(0, 8);
  }
  return DEFAULT_ARGS.slice();
}

/*
 * { shellPath, shellArgs, env } for vscode.window.createTerminal. `found` is what findOpenCode() or detect() gave
 * ({ path, version }); `env` the extra environment OpenCode starts with; `authMethods` what initialize answered, if
 * known. The terminal adds `env` to its own environment.
 */
function loginLaunch({ found, env = {}, authMethods } = {}) {
  if (!found || typeof found.path !== 'string' || !found.path) throw new server.OpenCodeError('notFound', 'OpenCode was not found, so there is no sign-in to run.');
  return {
    shellPath: found.path,
    shellArgs: server.subcommandArgs(found.version, terminalArgs(authMethods)),
    env: { ...(env && typeof env === 'object' ? env : {}), OPENCODE_DISABLE_AUTOUPDATE: '1' },
  };
}

module.exports = { loginLaunch, terminalArgs, DEFAULT_ARGS, METHOD_ID };
