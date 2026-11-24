// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The permission requests answered "allow once" without asking the user: a write or an edit by OpenCode's write or
 * edit tool whose every target lies inside the one folder the extension names for that conversation (its folder for
 * images, src/workplan scratchDir). OpenCode's own rules cannot say this: they are fixed when its process starts and
 * shared by every conversation it runs, so the narrowest rule there would cover every conversation's folder.
 * Targets are compared by their real paths, so a symbolic link cannot lead a write out of the folder; a target with a
 * `.` or `..` segment, or not absolute, is asked about.
 */
const fs = require('fs');
const path = require('path');

const TOOLS = new Set(['write', 'edit']);

/* Every path the tool call names as a target, or null when it is not such a write or names none. */
function writeTargets(toolCall) {
  const tc = toolCall && typeof toolCall === 'object' ? toolCall : {};
  if (tc.kind !== 'edit' || !TOOLS.has(tc.name)) return null;
  const out = [];
  const add = (p) => { if (typeof p === 'string' && p) out.push(p); };
  if (Array.isArray(tc.locations)) for (const l of tc.locations) add(l && l.path);
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  add(raw.path); add(raw.filePath); add(raw.filepath);
  if (Array.isArray(tc.content)) for (const c of tc.content) if (c && c.type === 'diff') add(c.path);
  return out.length ? out : null;
}

/* The real path of `p`, which may not exist yet: its deepest existing folder resolved, the rest appended. */
function realOf(p) {
  let at = p;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(at), ...rest); } catch (_) {
      const up = path.dirname(at);
      if (up === at) return '';
      rest.unshift(path.basename(at));
      at = up;
    }
  }
}

function inside(file, folder) {
  if (!path.isAbsolute(file) || !path.isAbsolute(folder)) return false;
  if (file.split(/[\\/]+/).some((s) => s === '.' || s === '..')) return false;
  const f = realOf(file);
  const d = realOf(folder);
  if (!f || !d) return false;
  const rel = path.relative(d, f);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

/*
 * The reply to session/request_permission `params` without asking, or null to ask: `folderOf(sessionId)` gives the
 * conversation's folder (or null). A subagent asks with its parent's session id, so it gets the parent's folder.
 */
function answer(params, folderOf) {
  if (!params || typeof folderOf !== 'function') return null;
  let folder;
  try { folder = folderOf(params.sessionId); } catch (_) { return null; }
  if (typeof folder !== 'string' || !folder) return null;
  const targets = writeTargets(params.toolCall);
  if (!targets || !targets.every((t) => inside(t, folder))) return null;
  const once = Array.isArray(params.options) ? params.options.find((o) => o && o.kind === 'allow_once' && o.optionId) : null;
  return once ? { outcome: { outcome: 'selected', optionId: once.optionId } } : null;
}

module.exports = { answer, writeTargets, inside };
