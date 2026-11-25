// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The @ references the editor puts into a chat page's message box (Alt+K, Add to Conversation, Fix with OpenCode):
 * `@<path>` for a file and `@<path>#L<from>-<to>` for lines of it, the path relative to the workspace folder it is in,
 * or absolute outside them, always with forward slashes. The page sends a file as a link OpenCode reads itself and lines
 * as their text, which the extension reads when the message goes (rangeText), so the model sees them as they are then.
 */
const fs = require('fs');
const path = require('path');

const MAX_CHARS = 100000;
const MAX_DIAGNOSTICS = 5;

/* The path shown and typed for `file`: relative to the first of `folders` it is in, else absolute. */
function relOf(file, folders) {
  for (const root of Array.isArray(folders) ? folders : []) {
    if (!root) continue;
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return file.split(path.sep).join('/');
}

/*
 * { token, path, name, rel, startLine?, endLine? } for `file`, with 1-based lines `startLine`..`endLine` when given.
 * Null for a path that is not absolute.
 */
function refFor(file, { folders, startLine, endLine } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const rel = relOf(file, folders);
  const out = { path: file, name: path.basename(file), rel, token: `@${rel}` };
  const from = Math.floor(Number(startLine) || 0);
  if (from > 0) {
    const to = Math.max(from, Math.floor(Number(endLine) || from));
    out.startLine = from;
    out.endLine = to;
    out.token = `@${rel}#L${from}${to > from ? `-${to}` : ''}`;
  }
  return out;
}

/* 1-based lines of a selection; one that ends at the start of a line does not take that line (as selection.js). */
function linesOf(sel) {
  const start = sel.start.line + 1;
  const end = sel.end.line + 1 - (sel.end.character === 0 && sel.end.line > sel.start.line ? 1 : 0);
  return { startLine: start, endLine: Math.max(start, end) };
}

/*
 * The text of lines `startLine`..`endLine` of `file`: from `open` (the text of the file as the editor holds it, or
 * null) or else from disk; at most `maxChars` characters. Null when the file cannot be read or has no such lines.
 */
function rangeText(file, startLine, endLine, { open = null, maxChars = MAX_CHARS } = {}) {
  let text = typeof open === 'string' ? open : null;
  if (text === null) {
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  }
  const all = text.split(/\r?\n/);
  const from = Math.max(1, Math.floor(Number(startLine) || 1));
  const to = Math.max(from, Math.floor(Number(endLine) || from));
  if (from > all.length) return null;
  const out = all.slice(from - 1, to).join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

const SEVERITY = ['Error', 'Warning', 'Information', 'Hint'];

/*
 * The draft Fix with OpenCode puts in the message box for diagnostics of one file: where they are and what the editor
 * says, for the user to read before sending. `diagnostics` is [{ severity, message, line, source?, code? }], lines
 * 1-based.
 */
function fixDraft(ref, diagnostics) {
  const list = (Array.isArray(diagnostics) ? diagnostics : []).filter((d) => d && typeof d.message === 'string').slice(0, MAX_DIAGNOSTICS);
  const lines = list.map((d) => {
    const where = d.line > 0 ? `line ${d.line}` : 'the file';
    const from = [d.source, d.code !== undefined && d.code !== '' ? String(d.code) : ''].filter(Boolean).join(' ');
    return `- ${SEVERITY[d.severity] || 'Problem'} at ${where}${from ? ` (${from})` : ''}: ${d.message.replace(/\s+/g, ' ').trim()}`;
  });
  return `Fix ${list.length === 1 ? 'this problem' : 'these problems'} in ${ref.token}:\n${lines.join('\n')}`;
}

module.exports = { refFor, relOf, linesOf, rangeText, fixDraft, MAX_CHARS, MAX_DIAGNOSTICS };
