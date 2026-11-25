// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Adds times and each turn's usage to a replayed conversation. ACP's session/load carries neither, so a page drawn from
 * it would date every message at the moment it was opened and leave the context and cost out of every turn's figures;
 * OpenCode's export (`opencode session export <id>` on 2.x, `opencode export <id>` on 1.x) has both. It does no I/O:
 * the caller passes the export in as parsed JSON.
 *
 * 2.x exports { info, messages: [{ id, type, time: { created, completed? }, content: [{ type: 'tool', id, time }] }] };
 * 1.x exports { info, messages: [{ info: { id, role, time }, parts: [{ id, type, callID?, time?, state: { time } }] }] }.
 * An assistant message carries `cost` (USD) and `tokens` { input, output, reasoning, cache: { read, write } } in both.
 * Replayed chunks name the message they belong to (2.x `msg_X`, `msg_X:reasoning:0`; 1.x a message or a part id) and
 * tool calls their call id, which is what the lookup is keyed by.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/* A replayed chunk's messageId without the `:<kind>:<n>` that 2.x appends to the message's own id. */
const baseId = (mid) => (typeof mid === 'string' ? mid.split(':')[0] : '');

/* The tokens a message used, counted as OpenCode reports them live (the sum it sends as usage_update's `used`). */
function usedOf(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  return num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(cache.read) + num(cache.write);
}

/*
 * { messages: Map<id, { created, done }>, calls: Map<call id, { created, done }>, users: [{ id, text, at }],
 *   assistants: Map<id, { order, cost, tokens }>, owners: Map<part id, message id>, after: Map<user id, [assistant id]> }
 * from an export, or null when it is not one. `after` lists the assistant messages between a user message and the next.
 */
function lookupOf(exported) {
  const list = exported && Array.isArray(exported.messages) ? exported.messages : null;
  if (!list) return null;
  const messages = new Map();
  const calls = new Map();
  const users = [];
  const assistants = new Map();
  const owners = new Map();
  const after = new Map();
  let lastUser = '';
  let order = 0;
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
      if (typeof p.id === 'string' && p.id && id) owners.set(p.id, id);
      if (p.type === 'tool') {
        const call = typeof p.callID === 'string' ? p.callID : typeof p.id === 'string' ? p.id : '';
        if (call) calls.set(call, at);
      }
    }
    if (role === 'assistant' && id) {
      const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost >= 0 ? info.cost : null;
      const tokens = info.tokens && typeof info.tokens === 'object' ? info.tokens : null;
      assistants.set(id, { order: order++, cost, tokens });
      if (lastUser) after.get(lastUser).push(id);
    }
    if (role === 'user' && id) {
      lastUser = id;
      after.set(id, []);
      const text = typeof info.text === 'string' ? info.text
        : parts.filter((p) => p && p.type === 'text' && !p.synthetic).map((p) => p.text || '').join('');
      users.push({ id, text, at: own.created });
    }
  }
  return { messages, calls, users, assistants, owners, after };
}

/*
 * `events` (a replay's AgentEvents) with times from `lookup`; `metas[i]` says what update events[i] came from:
 * { mid, call }. A user message names its own id (messageId); a turn starts when its user message was written and ends
 * when the last reply it holds was completed; text and reasoning take their message's time, tool calls their own, and
 * no event is dated earlier than the one before it.
 * Events that cannot be placed keep the time of the one before (src/host/history.js). Returns a new array.
 */
function fillTimes(events, metas, lookup) {
  if (!lookup || !Array.isArray(events)) return Array.isArray(events) ? events.slice() : [];
  const out = events.map((e) => ({ ...e }));
  const msg = (mid) => lookup.messages.get(mid) || lookup.messages.get(baseId(mid)) || null;
  let start = -1;
  let lastDone = 0;
  /* The latest time placed so far. It is a floor as well: on 1.x a reply's chunks name their message, which was created
     before the reasoning parts that come ahead of them. */
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

/*
 * `events` and `metas` (as for fillTimes) with a usage event put before each turn's turnEnd, from the assistant
 * messages of that turn in `lookup`: those its text and reasoning chunks refer to, and those after its user message
 * that no other turn refers to. The turn's cost is the sum of their costs and its context use that of the last one, as
 * OpenCode reports a live turn.
 * Returns new { events, metas } arrays and leaves a turn with none of them unchanged.
 */
function fillUsage(events, metas, lookup) {
  const list = Array.isArray(events) ? events : [];
  const ms = Array.isArray(metas) ? metas : [];
  if (!lookup || !lookup.assistants || !lookup.assistants.size) return { events: list.slice(), metas: ms.slice() };
  const ownerOf = (mid) => {
    if (typeof mid !== 'string' || !mid) return '';
    const id = lookup.owners.get(mid) || baseId(mid);
    return lookup.assistants.has(id) ? id : '';
  };
  /* The turns, each with its user message and the assistant messages its own chunks name. */
  const turns = [];
  let cur = null;
  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (!ev) continue;
    if (ev.type === 'turnStart') { cur = { user: '', named: new Set(), end: -1 }; turns.push(cur); continue; }
    if (!cur) continue;
    if (ev.type === 'userMessage' && typeof ev.messageId === 'string' && !cur.user) cur.user = ev.messageId;
    else if (ev.type === 'text' || ev.type === 'reasoning') { const id = ownerOf((ms[i] || {}).mid); if (id) cur.named.add(id); }
    else if (ev.type === 'turnEnd') { cur.end = i; cur = null; }
  }
  const named = new Set(turns.flatMap((t) => [...t.named]));
  const usage = new Map();
  for (const t of turns) {
    if (t.end < 0) continue;
    const ids = new Set(t.named);
    for (const id of (t.user && lookup.after.get(t.user)) || []) if (!named.has(id)) ids.add(id);
    const found = [...ids].map((id) => lookup.assistants.get(id)).filter(Boolean).sort((a, b) => a.order - b.order);
    const priced = found.filter((a) => a.cost !== null);
    const last = [...found].reverse().find((a) => usedOf(a.tokens) > 0);
    if (!priced.length && !last) continue;
    const ev = { type: 'usage', input: 0, output: 0 };
    if (last) {
      const tk = last.tokens;
      const cache = tk.cache && typeof tk.cache === 'object' ? tk.cache : {};
      Object.assign(ev, { input: num(tk.input), output: num(tk.output), cacheRead: num(cache.read), cacheWrite: num(cache.write), contextUsed: usedOf(tk) });
    }
    if (priced.length) ev.costUsd = priced.reduce((n, a) => n + a.cost, 0);
    usage.set(t.end, ev);
  }
  const outEvents = [];
  const outMetas = [];
  for (let i = 0; i < list.length; i++) {
    const u = usage.get(i);
    if (u) { outEvents.push(typeof list[i].at === 'number' ? { ...u, at: list[i].at } : u); outMetas.push({}); }
    outEvents.push(list[i]);
    outMetas.push(ms[i] || {});
  }
  return { events: outEvents, metas: outMetas };
}

module.exports = { lookupOf, fillTimes, fillUsage, usedOf, baseId };
