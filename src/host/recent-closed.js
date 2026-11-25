// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Remembers the chat tabs closed in this workspace, most recent first, for the Recently closed group at the top of the
 * Conversations view (src/ui/sessions-view.js). They are kept in the workspace's state, so they outlast a reload. A tab
 * VS Code closes because the window goes away is not recorded: the extension host has already stopped and gets no
 * event. The view filters the list: it leaves out tabs that are open again and conversations its own list no longer
 * has.
 */
const KEY = 'opencodeAgentPlus.recentlyClosed';
/* More than the view shows, so one that is open again does not push an older one out. */
const KEEP = 30;
const SHOWN = 10;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const valid = (e) => !!e && typeof e.id === 'string' && SESSION_ID.test(e.id) && Number.isFinite(e.at);

function record(list, id, now = Date.now()) {
  const old = Array.isArray(list) ? list.filter(valid) : [];
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return old.slice(0, KEEP);
  return [{ id, at: now }, ...old.filter((e) => e.id !== id)].slice(0, KEEP);
}

const without = (list, id) => (Array.isArray(list) ? list.filter((e) => valid(e) && e.id !== id) : []);

/*
 * `memo` is a vscode.Memento (the workspace's state); `log(line)` optional. remove(id) is for a deleted conversation.
 */
function createRecentClosed({ memo, now = Date.now, log = () => {} }) {
  let list = [];
  try { list = (memo && memo.get(KEY, [])) || []; } catch (_) { list = []; }
  list = Array.isArray(list) ? list.filter(valid) : [];
  const listeners = new Set();
  const save = (next) => {
    list = next;
    if (memo) Promise.resolve(memo.update(KEY, list)).catch((e) => log(`recently closed: saving failed: ${(e && e.message) || e}`));
    for (const fn of [...listeners]) { try { fn(); } catch (_) { /* the others still run */ } }
  };
  return {
    get: () => list.slice(),
    add(id) { save(record(list, id, now())); },
    remove(id) { if (list.some((e) => e.id === id)) save(without(list, id)); },
    clear() { if (list.length) save([]); },
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
}

module.exports = { createRecentClosed, record, KEY, KEEP, SHOWN };
