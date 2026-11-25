// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The editor group a conversation opens in: a group holding only chat tabs (the active one first), else a group holding
 * any chat tab, else the first group, which is the main editor area. It never opens a new split, and the active group
 * alone does not decide, since that is often a split to the right.
 */
function chatColumn(vscode, isChatTab) {
  const groups = vscode.window.tabGroups.all.map((g) => {
    const chats = (g.tabs || []).filter((t) => isChatTab(t)).length;
    return { viewColumn: g.viewColumn, isActive: !!g.isActive, chats, other: (g.tabs || []).length - chats };
  });
  const pick = (test) => (groups.find((g) => g.isActive && test(g)) || groups.find(test) || {}).viewColumn;
  const found = pick((g) => g.chats > 0 && g.other === 0) || pick((g) => g.chats > 0);
  if (found) return found;
  const columns = groups.map((g) => g.viewColumn).filter((c) => typeof c === 'number');
  return columns.length ? Math.min(...columns) : vscode.ViewColumn.One;
}

module.exports = { chatColumn };
