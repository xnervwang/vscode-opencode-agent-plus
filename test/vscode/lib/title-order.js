// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * run.js --title-order: with Claude Code and Codex installed beside this extension, a text file's editor title bar has
 * their buttons and this extension's New Conversation button next to each other, in that order. VS Code sorts the
 * buttons (test/host/title-order.test.js says how); this run sees where they land. The window test's helper adds a
 * button with an order of 97, as GitLens's buttons have, which this extension's button has to come before. The run
 * needs both extensions from the Marketplace, or --claude-code and --codex naming their .vsix files, so CI does not
 * run it.
 */
const fs = require('fs');
const path = require('path');

const OURS = 'OpenCode Agent Plus: New Conversation';
const isClaude = (l) => /^Claude Code: Open\b/.test(l);
const isCodex = (l) => /^Open Codex Sidebar\b/.test(l) || /^Codex Plus: /.test(l);
const isOrdered = (l) => /^Stand-in: A Button With an Order\b/.test(l);

/* t: { page, call, check, shot, until, sleep, folder } */
async function run(t) {
  const { page, call, check, shot, until, sleep, folder } = t;
  const installed = await call('return ["anthropic.claude-code", "openai.chatgpt"].filter((id) => !!vscode.extensions.getExtension(id));');
  check(installed.length === 2, 'Claude Code and Codex are installed beside this extension', installed);
  await call('await vscode.commands.executeCommand("setContext", "opencodeAgentPlusTests.titleOrder", true); return true;');
  const file = path.join(folder, 'title-order.txt');
  fs.writeFileSync(file, 'An editor whose title bar has the buttons.\n');
  await call('await vscode.commands.executeCommand("workbench.action.closeAllEditors"); const d = await vscode.workspace.openTextDocument(arg); await vscode.window.showTextDocument(d, { preview: false }); return true;', file);
  /* The buttons of the active editor group's title bar, left to right, by the label VS Code gives each. */
  const labels = () => page.evaluate(() => {
    const bar = document.querySelector('.editor-group-container.active .title .editor-actions');
    return bar ? [...bar.querySelectorAll('.action-item .action-label')].map((a) => a.getAttribute('aria-label') || a.title || '').filter(Boolean) : [];
  });
  const shown = await until(async () => { const l = await labels(); return l.some((x) => x.startsWith(OURS)) && l.some(isClaude) && l.some(isCodex) && l.some(isOrdered) ? l : null; }, 30000);
  const list = shown || await labels();
  const claude = list.findIndex(isClaude), codex = list.findIndex(isCodex), ours = list.findIndex((x) => x.startsWith(OURS)), ordered = list.findIndex(isOrdered);
  check(claude >= 0 && codex === claude + 1 && ours === codex + 1 && ordered > ours,
    'in a text file\'s title bar the Claude Code, Codex and New OpenCode Conversation buttons are next to each other, in that order, before a button with an order', list);
  await sleep(300);
  await shot('title-order', { features: ['editor title buttons'],
    expect: 'The right end of a text file\'s tab row: the Claude Code button (the Claude mark), then the Codex button, then the OpenCode mark of this extension\'s New Conversation button, next to each other, then a compare-changes icon (the test\'s stand-in for a button with an order), then the split editor and "..." buttons.',
    part: '.editor-group-container.active .title .editor-actions' });
}

module.exports = { run };
