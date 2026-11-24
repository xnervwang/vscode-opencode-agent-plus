// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The times of a replayed conversation. ACP's session/load carries none, so a page drawn from it would date every
 * message at the moment it was opened; OpenCode's export (`opencode session export <id>` on 2.x, `opencode export <id>`
 * on 1.x) has them. Pure: the export comes in as parsed JSON.
 *
 * 2.x exports { info, messages: [{ id, type, time: { created, completed? }, content: [{ type: 'tool', id, time }] }] };
 * 1.x exports { info, messages: [{ info: { id, role, time }, parts: [{ id, type, callID?, time?, state: { time } }] }] }.
 * Replayed chunks name the message they belong to (2.x `msg_X`, `msg_X:reasoning:0`; 1.x a message or a part id) and
 * tool calls their call id, which is what the lookup is keyed by.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/* The message id a replayed chunk's messageId names: 2.x appends `:<kind>:<n>` to the message's own. */
const baseId = (mid) => (typeof mid === 'string' ? mid.split(':')[0] : '');

/*
 * { messages: Map<id, { created, done }>, calls: Map<call id, { created, done }>, users: [{ id, text, at }] } from an
 * export, or null when it is not one.
 */
function lookupOf(exported) {
  const list = exported && Array.isArray(exported.messages) ? exported.messages : null;
  if (!list) return null;
  const messages = new Map();
  const calls = new Map();
  const users = [];
  const span = (t) => ({ created: num(t && (t.created || t.start)), done: num(t && (t.completed || t.end)) });
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const info = m.info && typeof m.info === 'object' ? m.info : m;
    const id = typeof info.id === 'string' ? info.id : '';
    const role = info.role || info.type;
    const own = span(info.time);
    if (id) messages.set(id, own);
    const parts = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const t = span(p.time || (p.state && p.state.time));
      const at = { created: t.created || own.created, done: t.done || own.done };
      if (typeof p.id === 'string' && p.id && p.type !== 'tool') messages.set(p.id, at);
      if (p.type === 'tool') {
        const call = typeof p.callID === 'string' ? p.callID : typeof p.id === 'string' ? p.id : '';
        if (call) calls.set(call, at);
      }
    }
    if (role === 'user' && id) {
      const text = typeof info.text === 'string' ? info.text
        : parts.filter((p) => p && p.type === 'text' && !p.synthetic).map((p) => p.text || '').join('');
      users.push({ id, text, at: own.created });
    }
  }
  return { messages, calls, users };
}

/*
 * `events` (a replay's AgentEvents) with times from `lookup`; `metas[i]` says what update events[i] came from:
 * { mid, call }. A user message names its own id (messageId); a turn starts when its user message was written and ends
 * when the last reply it holds was completed; text and reasoning take their message's time, tool calls their own, and
 * none goes before the event ahead of it.
 * Events that cannot be placed keep the time of the one before (src/host/history.js). Returns a new array.
 */
function fillTimes(events, metas, lookup) {
  if (!lookup || !Array.isArray(events)) return Array.isArray(events) ? events.slice() : [];
  const out = events.map((e) => ({ ...e }));
  const msg = (mid) => lookup.messages.get(mid) || lookup.messages.get(baseId(mid)) || null;
  let start = -1;
  let lastDone = 0;
  /* The latest time placed so far: an event that cannot be placed takes it, rather than the moment of the replay. A replay
     comes in the order things happened, so no event goes before the one ahead of it: on 1.x a reply's chunks name their
     message, created before the reasoning parts that precede them. */
  let cur = 0;
  const place = (ev, at) => {
    if (at) { ev.at = Math.max(at, cur); cur = ev.at; } else if (cur && 'at' in ev) ev.at = cur;
  };
  for (let i = 0; i < out.length; i++) {
    const ev = out[i];
    const meta = (metas && metas[i]) || {};
    if (ev.type === 'turnStart') { start = i; lastDone = 0; place(ev, 0); continue; }
    if (ev.type === 'userMessage') {
      const t = msg(ev.messageId);
      place(ev, t && t.created);
      if (t && t.created && start >= 0 && out[start].type === 'turnStart') out[start].at = t.created;
      continue;
    }
    if (ev.type === 'text' || ev.type === 'reasoning') {
      const t = msg(meta.mid);
      if (t && t.done > lastDone) lastDone = t.done;
      place(ev, t && t.created);
      continue;
    }
    if (ev.type === 'toolCall' || ev.type === 'toolResult') {
      const t = lookup.calls.get(ev.id) || lookup.calls.get(meta.call);
      if (t && t.done > lastDone) lastDone = t.done;
      place(ev, t && (ev.type === 'toolCall' ? t.created : (t.done || t.created)));
      continue;
    }
    if (ev.type === 'turnEnd') {
      place(ev, lastDone);
      start = -1;
      lastDone = 0;
      continue;
    }
    place(ev, 0);
  }
  return out;
}

module.exports = { lookupOf, fillTimes, baseId };
