// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Turns a conversation's history into what the chat page takes: session records (contracts.js SessionRecord) go to the page's
 * view model whole (src/ui/view-model.js fromRecords); AgentEvents are replayed into it one by one, and an event
 * without a time takes the previous event's, so a reply from history is not shown with the time it was replayed; bare
 * messages (contracts.js Message, optionally with `at`) are turned into message records.
 */
function historyFor(history) {
  const records = [], events = [];
  let at = 0;
  for (const x of Array.isArray(history) ? history : []) {
    if (!x || typeof x !== 'object') continue;
    if (typeof x.kind === 'string') records.push(x);
    else if (typeof x.type === 'string') {
      if (typeof x.at === 'number' && x.at > 0) at = x.at;
      events.push(at && typeof x.at !== 'number' ? { ...x, at } : x);
    }
    else if (x.role === 'user' || x.role === 'assistant') {
      const { at, ...message } = x;
      records.push({ kind: 'message', at: typeof at === 'number' ? at : 0, message });
    }
  }
  return { records, events };
}

module.exports = { historyFor };
