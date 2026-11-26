// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The pins in .github/upstream.json and the two workflows that read them. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PINS = JSON.parse(read('.github/upstream.json'));
const VSCODE = read('.github/workflows/vscode.yml');
const LATEST = read('.github/workflows/against-latest.yml');

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

test('run by hand, the vscode workflow can run each system more than once', () => {
  assert.match(VSCODE, /times:\n[\s\S]*?options: \['1', '2', '3', '5'\]/);
  assert.match(VSCODE, /round: \$\{\{ fromJSON\(/);
  assert.match(VSCODE, /name: vscode-\$\{\{ runner\.os \}\}\$\{\{ matrix\.round > 1 && format\('-\{0\}', matrix\.round\) \|\| '' \}\}/);
});

test('against-latest runs the vscode workflow once a day with the latest upstream', () => {
  assert.match(LATEST, /schedule:\n(\s+#.*\n)?\s+- cron: '\d+ \d+ \* \* \*'/);
  assert.match(LATEST, /uses: \.\/\.github\/workflows\/vscode\.yml\n\s+with:\n\s+upstream: latest/);
});

test('no unquoted workflow value holding an expression has a " #" in it, which YAML reads as the start of a comment', () => {
  for (const [name, text] of [['vscode.yml', VSCODE], ['against-latest.yml', LATEST]]) {
    const cut = text.split('\n').filter((l) => /^\s*-?\s*[\w-]+: [^'"\s].*\$\{\{.* #/.test(l));
    assert.deepStrictEqual(cut, [], name);
  }
});
