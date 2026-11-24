// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The files copied from Agent Plus (shared.json, build/sync-shared.js): a copy edited here would be overwritten by the
   next sync, so it fails here. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const sync = require(path.join(ROOT, 'build', 'sync-shared.js'));

test('every copy listed in shared.json is as recorded there and names its Agent Plus source', () => {
  const m = sync.readManifest(ROOT);
  assert.ok(m.files.length > 0);
  assert.deepStrictEqual(sync.checkCopies(ROOT), []);
  const unnamed = m.files.filter((f) => !sync.namesSource(fs.readFileSync(path.join(ROOT, f.path), 'utf8'), f.from)).map((f) => f.path);
  assert.deepStrictEqual(unnamed, []);
});

test('the plugin folder holds the shared hooks and the OpenCode plan_agent.py beside them', () => {
  const m = sync.readManifest(ROOT);
  const hooks = path.join(ROOT, 'opencode-plugin', 'agent-work-plan', 'hooks');
  for (const f of m.files.filter((x) => x.from.startsWith('shared/plugin/hooks/'))) {
    assert.strictEqual(path.dirname(path.join(ROOT, f.path)), hooks, f.path);
  }
  for (const name of ['plan_common.py', 'inject-work-plan.py', 'nudge-work-plan.py', 'plan-row.py', 'resume-work-plan.py', 'plan_agent.py']) {
    assert.ok(fs.existsSync(path.join(hooks, name)), name);
  }
  assert.match(fs.readFileSync(path.join(hooks, 'plan_agent.py'), 'utf8'), /SESSION_ID = r"ses_\[0-9A-Za-z\]\{8,64\}"/);
});
