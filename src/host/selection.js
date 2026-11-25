// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the editor offers the chat page: the lines selected in a file, and the file open in the editor, which a message
 * takes along (opencodeAgentPlus.attachSelection, attachOpenFile) or the page's selection button adds. The chat tab is
 * an editor itself, so no text editor is active while the user is in it; the selection used is the last non-empty one
 * in a file editor that is still visible, and the file is the one in the file editor that was active last, if it is
 * still visible.
 * VS Code's listeners are added only while a chat panel listens.
 */
const path = require('path');

const MAX_CHARS = 100000;
const SETTLE_MS = 150;

function createSelectionTracker({ vscode, maxChars = MAX_CHARS, settleMs = SETTLE_MS }) {
  const listeners = new Set();
  let last = null;
  let lastFile = null;
  let hooks = [];
  let timer = null;

  const isFile = (ed) => !!ed && !!ed.document && !!ed.document.uri && ed.document.uri.scheme === 'file';
  const usable = (ed) => isFile(ed) && ed.selection && !ed.selection.isEmpty;
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
    if (isFile(ed) && ed === vscode.window.activeTextEditor) lastFile = ed;
    fire();
  }
  function hook() {
    const w = vscode.window;
    if (hooks.length || typeof w.onDidChangeTextEditorSelection !== 'function') return;
    last = (w.visibleTextEditors || []).find(usable) || null;
    lastFile = isFile(w.activeTextEditor) ? w.activeTextEditor : (w.visibleTextEditors || []).find(isFile) || null;
    hooks = [w.onDidChangeTextEditorSelection((e) => note(e.textEditor))];
    if (typeof w.onDidChangeVisibleTextEditors === 'function') {
      /* A file editor that has just appeared, for example one opened beside the chat tab, also counts as the one in
         front. */
      let shown = new Set(w.visibleTextEditors || []);
      hooks.push(w.onDidChangeVisibleTextEditors(() => {
        const now = w.visibleTextEditors || [];
        let moved = false;
        const fresh = now.filter((ed) => isFile(ed) && !shown.has(ed));
        shown = new Set(now);
        if (last && !visible(last)) { last = null; moved = true; }
        if (fresh.length) { lastFile = fresh[fresh.length - 1]; moved = true; }
        else if (lastFile && !visible(lastFile)) { lastFile = now.find(isFile) || null; moved = true; }
        if (moved) fire();
      }));
    }
    /* Moving into the chat tab leaves no text editor active; the file that was active last is kept. */
    if (typeof w.onDidChangeActiveTextEditor === 'function') {
      hooks.push(w.onDidChangeActiveTextEditor((ed) => { if (isFile(ed) && ed !== lastFile) { lastFile = ed; fire(); } }));
    }
  }
  function unhook() {
    for (const d of hooks) { try { d.dispose(); } catch (_) { /* gone */ } }
    hooks = [];
    last = null;
    lastFile = null;
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
    describe() {
      const ed = last && visible(last) && usable(last) ? last : null;
      if (!ed) return null;
      const { startLine, endLine } = lines(ed.selection);
      return { label: `${path.basename(ed.document.uri.fsPath)}:${startLine}${endLine > startLine ? `-${endLine}` : ''}` };
    },
    /* What the button sends: a contracts.js FileRef with the selected text, plus the label. */
    current() {
      const ed = last && visible(last) && usable(last) ? last : null;
      if (!ed) return null;
      const { startLine, endLine } = lines(ed.selection);
      let text = ed.document.getText(ed.selection);
      if (text.length > maxChars) text = text.slice(0, maxChars);
      const name = path.basename(ed.document.uri.fsPath);
      return { path: ed.document.uri.fsPath, name, startLine, endLine, text, label: `${name}:${startLine}${endLine > startLine ? `-${endLine}` : ''}` };
    },
    /*
     * What can go with a message automatically: { selection, file }, each null or { path, name, key,
     * label } (the selection also { startLine, endLine }). `key` tells one apart from the next.
     */
    context() {
      const ed = last && visible(last) && usable(last) ? last : null;
      let selection = null;
      if (ed) {
        const { startLine, endLine } = lines(ed.selection);
        const name = path.basename(ed.document.uri.fsPath);
        selection = { path: ed.document.uri.fsPath, name, startLine, endLine, label: `${name}:${startLine}${endLine > startLine ? `-${endLine}` : ''}`,
          key: `${ed.document.uri.fsPath}:${startLine}-${endLine}` };
      }
      const fe = lastFile && visible(lastFile) && isFile(lastFile) ? lastFile : null;
      const file = fe ? { path: fe.document.uri.fsPath, name: path.basename(fe.document.uri.fsPath), label: path.basename(fe.document.uri.fsPath), key: fe.document.uri.fsPath } : null;
      return { selection, file };
    },
    lastEditor() { return lastFile && visible(lastFile) ? lastFile : null; },
    onDidChange(fn) {
      listeners.add(fn);
      hook();
      return { dispose: () => { listeners.delete(fn); if (!listeners.size) unhook(); } };
    },
    dispose() { listeners.clear(); unhook(); },
  };
}

module.exports = { createSelectionTracker };
