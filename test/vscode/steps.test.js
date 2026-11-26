// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Checks the window test's step table (lib/steps.js) against run.js and the vscode workflow. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { NEEDS, BASE, RUNS, chosen, outOfStep } = require('./lib/steps');

const RUN_JS = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'vscode.yml'), 'utf8');

test('run.js starts each step of the table once and in the table\'s order, and each step of the other runs once', () => {
  const started = [...RUN_JS.matchAll(/\bstep\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(started.filter((x) => x in NEEDS), Object.keys(NEEDS));
  assert.deepStrictEqual(started.filter((x) => !(x in NEEDS)), []);
  for (const run of RUNS) assert.match(RUN_JS, new RegExp(`RUN = [^\\n]*'${run}'`));
});

test('a step needs only steps that come before it', () => {
  assert.deepStrictEqual(outOfStep(), []);
  for (const x of BASE) assert.ok(x in NEEDS, x);
});

test('a pattern picks the steps it matches, those they rely on and the base, in their order', () => {
  assert.strictEqual(chosen(''), null);
  assert.deepStrictEqual([...chosen('^fork$')], ['new-conversation', 'fake-chat', 'opencode', 'replies', 'fork']);
  assert.deepStrictEqual([...chosen('tab-switch')], ['new-conversation', 'split', 'tab-switch']);
  assert.deepStrictEqual([...chosen('^gap-')], ['new-conversation', 'gap-page', 'gap-host']);
  assert.deepStrictEqual([...chosen('^reload$')], ['new-conversation', 'fake-chat', 'opencode', 'reload']);
});

test('a run with an option of its own is a single step, and a pattern naming another run\'s steps picks nothing in it', () => {
  assert.deepStrictEqual([...chosen('restricted', 'restricted')], ['restricted']);
  assert.deepStrictEqual([...chosen('restricted')], []);
  assert.deepStrictEqual([...chosen('input', 'restricted')], []);
  assert.strictEqual(chosen('', 'restricted'), null);
});

test('a pattern that matches no step, or is not a regular expression, is refused', () => {
  assert.throws(() => chosen('no-such-step'), /matches none of the steps/);
  assert.throws(() => chosen('('), /is not a regular expression/);
});

test('run by hand, the vscode workflow takes the system and the steps, and passes the steps to run.js', () => {
  assert.match(WORKFLOW, /workflow_dispatch:\n\s+inputs:\n\s+os:[\s\S]*?options: \[all, ubuntu-latest, macos-latest, windows-latest\][\s\S]*?steps:\n[\s\S]*?type: string/);
  assert.match(WORKFLOW, /os: \$\{\{ fromJSON\(inputs\.os && inputs\.os != 'all' && format\('\["\{0\}"\]', inputs\.os\) \|\| '\["ubuntu-latest", "macos-latest", "windows-latest"\]'\) \}\}/);
  assert.match(WORKFLOW, /OPENCODE_AGENT_PLUS_UI_STEPS: \$\{\{ inputs\.steps \}\}/);
});
