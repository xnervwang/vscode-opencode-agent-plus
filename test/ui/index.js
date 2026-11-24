// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Makes `node --test test/ui` work. Node 22 runs a directory argument as a module, which resolves to this file, so it
 * loads the test files beside it. Found by a glob or by default discovery it loads nothing, so no test runs twice.
 */
const fs = require('fs');
const path = require('path');

function realArg() {
  try {
    return fs.realpathSync(process.argv[1]);
  } catch (e) {
    return '';
  }
}

if (process.argv[1] && realArg() === __dirname) {
  for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
    require(path.join(__dirname, name));
  }
}
