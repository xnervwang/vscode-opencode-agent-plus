// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
// One folder per machine user, so every VS Code window on this machine sees the same conversations and plans.
const os = require('os');
const path = require('path');

function root() {
  return process.env.OPENCODE_PLUS_HOME || path.join(os.homedir(), '.opencode-plus');
}

module.exports = {
  root,
  sessionsDir: () => path.join(root(), 'sessions'),
  plansDir: () => path.join(root(), 'plans'),
};
