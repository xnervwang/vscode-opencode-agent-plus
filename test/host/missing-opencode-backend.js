// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * OPENCODE_AGENT_PLUS_TEST_BACKEND for extension-download.test.js: test/vscode/fake-backend.js behind the real
 * findOpenCode, which looks in an empty PATH and an empty home and so finds only an OpenCode downloaded under
 * OPENCODE_AGENT_PLUS_HOME. Until there is one, everything that would start OpenCode fails with its notFound error.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../vscode/fake-backend');
const server = require('../../src/opencode/server');

const STARTS = new Set(['listSessions', 'createSession', 'openSession', 'session', 'listModels', 'defaultModel', 'mcpList', 'dataPaths']);

function createOpenCode(opts) {
  const inner = fake.createOpenCode(opts);
  const home = process.env.OPENCODE_AGENT_PLUS_HOME;
  const find = () => server.findOpenCode({ env: { PATH: '' }, home: path.join(home, 'empty-home'),
    isExecutable: (p) => p.startsWith(home) && fs.existsSync(p), readVersion: () => ({ major: 2, minor: 4, patch: 1, text: '2.4.1' }) });
  return new Proxy(inner, {
    get(target, key) {
      if (key === 'detect') return () => { const f = find(); return { path: f.path, version: f.version, line: 2 }; };
      if (key === 'canRename') return () => { try { find(); return true; } catch (_) { return false; } };
      if (STARTS.has(key) && typeof target[key] === 'function') return (...args) => { find(); return target[key](...args); };
      return target[key];
    },
  });
}

module.exports = { createOpenCode };
