// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Where the editor title bar puts the New Conversation button: right after the Claude Code and Codex buttons. VS Code
 * sorts an editor title bar's buttons by group, the navigation group first, then within a group by the order after
 * "@" (none counts as 0), then by command title (MenuService.compareMenuItems in the workbench). The Claude Code and
 * Codex buttons give no order, so this one gives none either, and its title sorts after theirs.
 * test/vscode/lib/title-order.js checks the same in a window with both extensions installed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../../package.json');

const COMMAND = 'opencodeAgentPlus.newConversationInEditor';

/* The order of the workbench's compareMenuItems, for entries { group: 'name@order', title }. */
function compare(a, b) {
  const split = (g) => { const i = g.lastIndexOf('@'); return i > 0 ? [g.slice(0, i), Number(g.slice(i + 1)) || 0] : [g, 0]; };
  const [ag, ao] = split(a.group || '');
  const [bg, bo] = split(b.group || '');
  if (ag !== bg) {
    if (!ag) return 1;
    if (!bg) return -1;
    if (ag === 'navigation') return -1;
    if (bg === 'navigation') return 1;
    const c = ag.localeCompare(bg);
    if (c) return c;
  }
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.title.localeCompare(b.title);
}

function ours() {
  const entry = pkg.contributes.menus['editor/title'].find((m) => m.command === COMMAND);
  const command = pkg.contributes.commands.find((c) => c.command === COMMAND);
  return { group: entry.group, title: command.title };
}

/* The buttons beside it, as their extensions contribute them: Claude Code's, then Codex's own or Codex Plus's (which
   takes its place), and a GitLens one that gives an order. */
const CLAUDE = { group: 'navigation', title: 'Claude Code: Open' };
const CODEX = { group: 'navigation', title: 'Open Codex Sidebar' };
const CODEX_PLUS = { group: 'navigation', title: 'Codex Plus: New Codex Conversation in a Tab' };
const GITLENS = { group: 'navigation@97', title: 'Open Changes with Previous Revision' };

test('the button is in the navigation group with no order of its own', () => {
  assert.equal(ours().group, 'navigation');
});

test('it sorts right after the Claude Code and Codex buttons, before buttons that give an order', () => {
  for (const codex of [CODEX, CODEX_PLUS]) {
    const me = ours();
    const sorted = [GITLENS, me, codex, CLAUDE].sort(compare);
    assert.deepEqual(sorted.map((e) => e.title), [CLAUDE.title, codex.title, me.title, GITLENS.title], codex.title);
  }
});
