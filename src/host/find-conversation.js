// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The command Find Conversation: a quick pick of every conversation OpenCode keeps (subagents' left out), the most
 * recently active first, matched as the user types against the title, the session id and the folder; the one picked
 * opens. Typing part of a session id finds the conversation, which the Conversations view cannot do.
 */
const { age } = require('../ui/sessions-view');

const lastActive = (r) => r.lastActiveAt || r.lastReplyAt || r.lastUserAt || r.createdAt || 0;

/* `openHere(id)` says whether a conversation is open in this window. */
function pickItems(rows, { now = Date.now(), openHere = () => false } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string' && r.id)
    .sort((a, b) => lastActive(b) - lastActive(a))
    .map((r) => {
      let here = false;
      try { here = openHere(r.id) === true; } catch (_) { here = false; }
      const when = age(lastActive(r), now);
      return {
        label: r.title || 'Untitled conversation',
        description: [here ? 'open in this window' : '', when ? (when === 'now' ? 'active now' : `active ${when} ago`) : ''].filter(Boolean).join(' · '),
        detail: [r.id, r.cwd].filter(Boolean).join('  ·  '),
        id: r.id,
      };
    });
}

/* Resolves to the id opened, or '' when the pick was dismissed. */
async function findConversation({ vscode, list, open, openHere, now = Date.now }) {
  const qp = vscode.window.createQuickPick();
  qp.title = 'Find a conversation';
  qp.placeholder = 'Type part of a title, a session id or a folder';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.show();
  let rows = [];
  try { rows = await list(); } catch (e) {
    qp.busy = false;
    qp.items = [];
    qp.placeholder = `Couldn't list conversations: ${(e && e.message) || e}`;
  }
  qp.items = pickItems(rows, { now: now(), openHere });
  qp.busy = false;
  const picked = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    qp.onDidAccept(() => { const s = qp.selectedItems[0] || qp.activeItems[0]; finish(s ? s.id : ''); qp.hide(); });
    qp.onDidHide(() => finish(''));
  });
  qp.dispose();
  if (picked) await open(picked);
  return picked;
}

module.exports = { findConversation, pickItems };
