// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * "Edit automatically", the second of the chat page's permission modes (Ask before edits, Edit automatically, Plan):
 * OpenCode's build mode, with each request to edit or write a file inside the conversation's folder allowed once by
 * the extension instead of the user. Commands, web fetches, paths outside the folder and anything else still ask. The
 * choice is kept per conversation in the workspace's state, so it survives closing and reopening the tab.
 *
 * guard() wraps a conversation (src/host/model-choice.js's facade): it hears each request first, answers the ones it
 * allows, and keeps those requests and their answers from the listeners added through the wrapper, so the page shows
 * the tool call but no request.
 */
const path = require('path');

const KEY = 'opencodeAgentPlus.autoEdit';
const KEPT = 500;
const EDIT_KINDS = new Set(['edit', 'write']);

/* `memo` a vscode Memento (workspaceState), or null to keep the choice for this window only. */
function createAutoEdit({ memo = null } = {}) {
  let ids = [];
  try { const v = memo ? memo.get(KEY, []) : []; ids = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { ids = []; }
  const on = new Set(ids);
  const listeners = new Set();
  const save = () => {
    if (!memo) return;
    const list = [...on].slice(-KEPT);
    Promise.resolve(memo.update(KEY, list)).catch(() => {});
  };
  return {
    get: (id) => on.has(id),
    set(id, value) {
      if (!id) return;
      const was = on.has(id);
      if (value) { on.delete(id); on.add(id); } else on.delete(id);
      if (was === !!value) return;
      save();
      for (const fn of [...listeners]) { try { fn(id); } catch (_) { /* the others still run */ } }
    },
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}

/* Whether `request` (contracts.js PermissionRequest) edits or writes a file inside `folder`. A relative path is taken as
   relative to the folder. */
function allowable(request, folder) {
  if (!request || !EDIT_KINDS.has(request.kind) || !folder) return false;
  const p = (request.diff && request.diff.path) || request.path;
  if (typeof p !== 'string' || !p) return false;
  const full = path.resolve(folder, p);
  const rel = path.relative(path.resolve(folder), full);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/*
 * Wraps `conv` in place. `enabled()` says whether the mode is on now, `folder()` gives the conversation's folder, and
 * `answer(requestId)` allows a request once (it may save edited files first). Returns a function that undoes nothing
 * but stops answering, for a conversation that is closed.
 */
function guard(conv, { enabled, folder, answer, log = () => {} }) {
  const taken = new Set();
  let stopped = false;
  const baseOn = conv.on.bind(conv);
  const offBase = baseOn((ev) => {
    if (stopped || !ev || ev.type !== 'permission' || !ev.requestId) return;
    let on = false;
    try { on = enabled() === true && allowable(ev.request, folder()); } catch (_) { on = false; }
    if (!on) return;
    taken.add(ev.requestId);
    log(`allowed once without asking (Edit automatically): ${(ev.request && ev.request.summary) || 'an edit'}`);
    Promise.resolve().then(() => answer(ev.requestId)).catch((e) => log(`allowing ${ev.requestId} failed: ${(e && e.message) || e}`));
  });
  conv.on = (fn) => baseOn((ev) => {
    if (ev && (ev.type === 'permission' || ev.type === 'permissionSettled') && taken.has(ev.requestId)) {
      if (ev.type === 'permissionSettled') setTimeout(() => taken.delete(ev.requestId), 0);
      return;
    }
    fn(ev);
  });
  return () => { stopped = true; if (typeof offBase === 'function') offBase(); };
}

module.exports = { createAutoEdit, allowable, guard, KEY, EDIT_KINDS };
