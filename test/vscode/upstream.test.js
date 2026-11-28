// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The pins in .github/upstream.json, the two workflows that read them, and when the window tests run. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PINS = JSON.parse(read('.github/upstream.json'));
const VSCODE = read('.github/workflows/vscode.yml');
const LATEST = read('.github/workflows/against-latest.yml');
const RELEASE = read('.github/workflows/release.yml');
const CI = read('.github/workflows/ci.yml');

test('upstream.json pins an Agent Plus commit and exact versions of the test runner', () => {
  assert.deepStrictEqual(Object.keys(PINS).sort(), ['agentPlus', 'playwrightCore', 'testElectron']);
  assert.match(PINS.agentPlus, /^[0-9a-f]{40}$/);
  for (const v of [PINS.testElectron, PINS.playwrightCore]) assert.match(v, /^\d+\.\d+\.\d+$/);
});

test('the vscode workflow builds the pinned Agent Plus and installs the pinned test runner, unless asked for the latest', () => {
  assert.match(VSCODE, /require\('\.\/\.github\/upstream\.json'\)\.agentPlus/);
  assert.match(VSCODE, /repository: xnervwang\/vscode-agent-plus\n\s+ref: \$\{\{ steps\.pick\.outputs\.agent-plus \}\}/);
  assert.match(VSCODE, /@vscode\/test-electron@\$\(node -p "require\('\.\/\.github\/upstream\.json'\)\.testElectron"\)/);
  assert.match(VSCODE, /playwright-core@\$\(node -p "require\('\.\/\.github\/upstream\.json'\)\.playwrightCore"\)/);
  assert.doesNotMatch(VSCODE, /@vscode\/test-electron@\d|playwright-core@\d/);
  assert.match(VSCODE, /OPENCODE_AGENT_PLUS_VSCODE_VERSION: \$\{\{ inputs\.upstream == 'latest' && 'stable' \|\| '' \}\}/);
  assert.match(VSCODE, /workflow_call:\n\s+inputs:\n\s+upstream:/);
});

test('the window tests run in full once a day and before each release, never on a push to main, and once per system', () => {
  assert.match(VSCODE, /schedule:\n(\s+#.*\n)?\s+- cron: '\d+ \d+ \* \* \*'/);
  assert.doesNotMatch(VSCODE, /^  push:/m, 'a push runs only ci.yml');
  assert.match(CI, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(VSCODE, /times:|matrix\.round/, 'no repeated rounds');
  assert.match(VSCODE, /name: vscode-\$\{\{ runner\.os \}\}\n/);
  assert.match(RELEASE, /  vscode:\n\s+uses: \.\/\.github\/workflows\/vscode\.yml\n\s+with:\n\s+upstream: pinned/);
  assert.match(RELEASE, /  publish:\n\s+needs: vscode\n/, 'nothing is published unless the window tests pass');
});

test('against-latest runs the vscode workflow once a week with the latest upstream', () => {
  assert.match(LATEST, /schedule:\n(\s+#.*\n)?\s+- cron: '\d+ \d+ \* \* \d'/);
  assert.match(LATEST, /uses: \.\/\.github\/workflows\/vscode\.yml\n\s+with:\n\s+upstream: latest/);
});

/* YAML reads " #" in an unquoted value as the start of a comment. */
test('no unquoted workflow value holding an expression has a " #" in it', () => {
  for (const [name, text] of [['vscode.yml', VSCODE], ['against-latest.yml', LATEST], ['release.yml', RELEASE]]) {
    const cut = text.split('\n').filter((l) => /^\s*-?\s*[\w-]+: [^'"\s].*\$\{\{.* #/.test(l));
    assert.deepStrictEqual(cut, [], name);
  }
});
