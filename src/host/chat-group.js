// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The editor group a conversation opens in: one that already holds chat tabs, else the first group, the main editor
 * area. The active group alone does not decide, since that is often a split to the right, and no new split is opened.
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
