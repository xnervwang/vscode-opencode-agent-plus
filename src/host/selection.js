// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The selection in a file editor of this window, for the chat page's button that sends it along. The chat tab is an
 * editor itself, so no text editor is active while the user is in it; the last non-empty selection of a file editor
 * still visible is the one meant. VS Code's listeners are added only while a chat panel listens.
 */
const path = require('path');

const MAX_CHARS = 100000;
const SETTLE_MS = 150;

function createSelectionTracker({ vscode, maxChars = MAX_CHARS, settleMs = SETTLE_MS }) {
  const listeners = new Set();
  let last = null;
  let hooks = [];
  let timer = null;

  const usable = (ed) => !!ed && ed.document && ed.document.uri && ed.document.uri.scheme === 'file' && ed.selection && !ed.selection.isEmpty;
  const visible = (ed) => (vscode.window.visibleTextEditors || []).includes(ed);
  function fire() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const fn of [...listeners]) { try { fn(); } catch (_) { /* the others still run */ } }
    }, settleMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function note(ed) {
    if (usable(ed)) last = ed;
    else if (ed === last) last = null;
    fire();
  }
  function hook() {
    const w = vscode.window;
    if (hooks.length || typeof w.onDidChangeTextEditorSelection !== 'function') return;
    last = (w.visibleTextEditors || []).find(usable) || null;
    hooks = [w.onDidChangeTextEditorSelection((e) => note(e.textEditor))];
    if (typeof w.onDidChangeVisibleTextEditors === 'function') {
      hooks.push(w.onDidChangeVisibleTextEditors(() => { if (last && !visible(last)) { last = null; fire(); } }));
    }
  }
  function unhook() {
    for (const d of hooks) { try { d.dispose(); } catch (_) { /* gone */ } }
    hooks = [];
    last = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /* 1-based lines; a selection ending at the start of a line does not take that line. */
  function lines(sel) {
    const start = sel.start.line + 1;
    const end = sel.end.line + 1 - (sel.end.character === 0 && sel.end.line > sel.start.line ? 1 : 0);
    return { startLine: start, endLine: Math.max(start, end) };
  }

  return {
    /* { label } of the selection there is now, or null. */
    describe() {
      const ed = last && visible(last) && usable(last) ? last : null;
      if (!ed) return null;
      const { startLine, endLine } = lines(ed.selection);
      return { label: `${path.basename(ed.document.uri.fsPath)}:${startLine}${endLine > startLine ? `-${endLine}` : ''}` };
    },
    /* The selection with its text, as contracts.js FileRef plus its label; null when there is none. */
    current() {
      const ed = last && visible(last) && usable(last) ? last : null;
      if (!ed) return null;
      const { startLine, endLine } = lines(ed.selection);
      let text = ed.document.getText(ed.selection);
      if (text.length > maxChars) text = text.slice(0, maxChars);
      const name = path.basename(ed.document.uri.fsPath);
      return { path: ed.document.uri.fsPath, name, startLine, endLine, text, label: `${name}:${startLine}${endLine > startLine ? `-${endLine}` : ''}` };
    },
    onDidChange(fn) {
      listeners.add(fn);
      hook();
      return { dispose: () => { listeners.delete(fn); if (!listeners.size) unhook(); } };
    },
    dispose() { listeners.clear(); unhook(); },
  };
}

module.exports = { createSelectionTracker };
