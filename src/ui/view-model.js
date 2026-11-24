// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Turns a conversation's AgentEvents (src/contracts.js), and the records of a saved session, into what the chat page
 * draws. Pure: no vscode, no clock. Events without a time of their own (text, reasoning, permission, retry) take the
 * `now` the caller passes.
 *
 * Items only ever get appended or replaced in place, and every change replaces just the objects it touches, so
 * changedItems() finds what to post to the page by identity. Item `i<n>` sits at index n-1.
 *
 * Besides AgentEvents the reducer takes two actions of the panel's own:
 *   { type: 'ui.model', model }   the model now in use (ModelInfo, or { id, contextWindow } when not in the list)
 *   { type: 'ui.queued', text }   a message sent while a turn runs; it leaves the queue when its userMessage arrives
 *
 * A subagent's progress is drawn on the tool card of the call that started it (`child` of that item), or on a card
 * of its own (kind 'subagent') when no such call is known; only its last CHILD_ENTRIES steps are kept. A question is
 * an item whose `fields` (formFields) the page draws as a form; formContent turns what the user filled in back into
 * the answer's content.
 */

const MAX_SHOWN = 20000;
const CHILD_ENTRIES = 60;
const CHILD_TEXT = 4000;
/* Such a turn starts when a background task finishes, or when a subagent running in the background asks for permission. */
const UNSOLICITED_NOTE = 'OpenCode went on without a message from you, for a background task (a subagent or a command).';
const REGION_PREFIX = /^(us|eu|apac|ap|ca|jp|au|us-gov|global)\./;

function initialState() {
  return {
    seq: 0,
    items: [],
    status: 'idle',
    turn: null,
    title: '',
    model: null,
    contextUsed: 0,
    costUsd: 0,
    costKnown: false,
    pending: {},
    diffs: {},
    diffOrder: [],
    queued: [],
    qseq: 0,
    retry: null,
    lastAt: 0,
    compaction: null,
    children: {},
  };
}

/* ---------- formatting, shared with the tests ---------- */

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtCost(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return '';
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/* `us.xai.grok-4.7` -> `grok-4.7`, `qwen.qwen3-coder-30b-a3b-v1:0` -> `qwen3-coder-30b-a3b`. */
/* `amazon-bedrock/us.xai.grok-4.7` -> `grok-4.7`: OpenCode's provider part, a Bedrock region and a vendor prefix go;
   a vendor prefix is letters only, so the dot in `gpt-5.1` stays. */
function shortModel(id) {
  if (!id) return '';
  let s = String(id);
  s = s.slice(s.lastIndexOf('/') + 1).replace(REGION_PREFIX, '').replace(/^[a-z][a-z-]*\./, '');
  return s.replace(/-v\d+(:\d+)?$/, '').replace(/-\d+:\d+$/, '').replace(/:\d+$/, '');
}

function contextPct(used, window) {
  return window > 0 && typeof used === 'number' ? Math.round((used / window) * 100) : null;
}

/* A turn replayed from history may carry no time and no usage (OpenCode's replay has neither): a duration under a
   second and a context share with no usage are left out rather than shown as 0s and ctx 0%. */
function figuresText(f) {
  const parts = [f.durationMs >= 1000 ? fmtDuration(f.durationMs) : ''];
  if (f.contextUsed > 0 && f.contextPct != null) parts.push(`ctx ${f.contextPct}%`);
  else if (f.contextUsed > 0) parts.push(`ctx ${fmtTokens(f.contextUsed)}`);
  if (f.costUsd != null) parts.push(fmtCost(f.costUsd));
  if (f.model) parts.push(f.effort ? `${f.model} ${f.effort}` : f.model);
  return parts.filter(Boolean).join(' · ');
}

function clip(text, max = MAX_SHOWN) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

function oneLine(s, max = 200) {
  const line = String(s).split('\n').find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/* The words after a tool's name on its card: the command, path or pattern it was called with. */
function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return oneLine(input.command);
  /* OpenCode's question tool: the questions it asks. */
  if (Array.isArray(input.questions)) {
    const asked = input.questions.map((q) => q && (q.question || q.header)).filter((q) => typeof q === 'string' && q);
    if (asked.length) return oneLine(asked.join(' · '));
  }
  const where = input.path || input.file_path || input.cwd;
  if (typeof input.pattern === 'string') return oneLine(where ? `${input.pattern}  in ${where}` : input.pattern);
  if (typeof where === 'string') {
    if (name === 'read_file' && (input.offset || input.limit)) {
      const from = Number(input.offset) || 1;
      return input.limit ? `${where}:${from}-${from + Number(input.limit) - 1}` : `${where}:${from}-`;
    }
    return oneLine(where);
  }
  const first = Object.values(input).find((v) => typeof v === 'string');
  if (first) return oneLine(first);
  const json = JSON.stringify(input);
  return json === '{}' ? '' : oneLine(json);
}

function inputText(input) {
  try {
    return clip(JSON.stringify(input == null ? {} : input, null, 2));
  } catch (e) {
    return String(input);
  }
}

const ERROR_LABELS = {
  auth: "Couldn't sign in",
  permission: 'Access denied',
  modelNotEnabled: 'Model not enabled',
  throttled: 'Throttled',
  contextTooLong: 'Conversation too long for this model',
  badRequest: 'Request rejected',
  refused: 'Refused',
  unavailable: 'Model unavailable',
  aborted: 'Stopped',
};

function errorText(error) {
  if (!error) return 'The turn failed.';
  if (typeof error === 'string') return error;
  const label = ERROR_LABELS[error.kind];
  const msg = error.message || '';
  return label ? (msg ? `${label}: ${msg}` : label) : msg || 'The turn failed.';
}

const END_NOTICES = {
  aborted: ['info', 'Stopped.'],
  maxTokens: ['info', "The reply reached the model's output limit and was cut off."],
  refused: ['error', 'The model declined to answer.'],
  reasoningOnly: ['info', 'The model returned only reasoning, with no reply.'],
  toolUse: ['info', 'The turn ended while the model still wanted to call tools.'],
};

/* ---------- state helpers ---------- */

function timeOf(s, at, now) {
  if (typeof at === 'number' && isFinite(at)) return at;
  if (typeof now === 'number' && isFinite(now)) return now;
  return s.lastAt || 0;
}

function append(s, item) {
  const seq = s.seq + 1;
  const id = `i${seq}`;
  return { s: { ...s, seq, items: [...s.items, { id, ...item }] }, id };
}

function indexOf(id) {
  return Number(String(id).slice(1)) - 1;
}

function replace(s, id, patch) {
  const i = indexOf(id);
  const old = s.items[i];
  if (!old) return s;
  const items = s.items.slice();
  items[i] = { ...old, ...patch };
  return { ...s, items };
}

function statusOf(s) {
  if (Object.keys(s.pending).length) return 'waiting';
  return s.turn ? 'working' : 'idle';
}

function settle(s) {
  return { ...s, status: statusOf(s) };
}

function startTurn(s, id, at, effort) {
  const model = s.model;
  return settle({
    ...s,
    retry: null,
    lastAt: at,
    turn: {
      id: id || `t${s.seq + 1}`,
      startedAt: at,
      effort: typeof effort === 'string' ? effort : '',
      modelId: model ? model.id : '',
      contextWindow: model ? model.contextWindow || 0 : 0,
      tools: {},
      costUsd: 0,
      costKnown: false,
      contextUsed: null,
    },
  });
}

function ensureTurn(s, at) {
  return s.turn ? s : startTurn(s, null, at);
}

/* Text and reasoning deltas extend the last item when it is the same kind in the same turn. */
function addDelta(s, kind, delta, at) {
  if (!delta) return s;
  s = ensureTurn(s, at);
  const last = s.items[s.items.length - 1];
  if (last && last.kind === kind && last.turn === s.turn.id) return replace(s, last.id, { text: last.text + delta });
  return append(s, { kind, turn: s.turn.id, at, text: delta }).s;
}

function rememberDiff(s, requestId, diff) {
  const diffs = { ...s.diffs, [requestId]: diff };
  const diffOrder = [...s.diffOrder, requestId];
  while (diffOrder.length > 20) delete diffs[diffOrder.shift()];
  return { ...s, diffs, diffOrder };
}

function endTurn(s, ev, at) {
  const turn = s.turn;
  for (const toolItemId of Object.values(turn.tools)) {
    const item = s.items[indexOf(toolItemId)];
    if (item && item.state === 'running') s = replace(s, toolItemId, { state: 'aborted', doneAt: at });
  }
  for (const itemId of Object.values(s.pending)) s = replace(s, itemId, { decision: 'cancelled' });
  s = { ...s, pending: {} };
  if (ev.reason === 'error') {
    s = append(s, { kind: 'notice', turn: turn.id, at, level: 'error', text: errorText(ev.error) }).s;
  } else if (END_NOTICES[ev.reason]) {
    const [level, text] = END_NOTICES[ev.reason];
    s = append(s, { kind: 'notice', turn: turn.id, at, level, text }).s;
  }
  const used = turn.contextUsed != null ? turn.contextUsed : s.contextUsed;
  const figures = {
    durationMs: Math.max(0, at - turn.startedAt),
    contextUsed: used || 0,
    contextWindow: turn.contextWindow,
    contextPct: contextPct(used, turn.contextWindow),
    turnCostUsd: turn.costKnown ? turn.costUsd : null,
    costUsd: s.costKnown ? s.costUsd : null,
    model: shortModel(turn.modelId),
    modelId: turn.modelId,
    effort: turn.effort || '',
    reason: ev.reason || 'endTurn',
  };
  figures.text = figuresText(figures);
  s = append(s, { kind: 'figures', turn: turn.id, at, ...figures }).s;
  return settle({ ...s, turn: null, retry: null, lastAt: at });
}

function attachmentsOf(list) {
  return (Array.isArray(list) ? list : []).filter((a) => a && typeof a.kind === 'string')
    .map((a) => ({ kind: a.kind, name: String(a.name || a.kind) }));
}

function subagentOf(ev) {
  const a = ev && ev.subagent;
  return a && typeof a.childId === 'string' ? { childId: a.childId, title: String(a.title || '') } : null;
}

/* ---------- subagents ---------- */

function childStep(c, e) {
  let entries = c.entries.slice();
  const last = entries[entries.length - 1];
  if ((e.type === 'text' || e.type === 'reasoning') && e.delta) {
    const kind = e.type;
    if (last && last.kind === kind) entries[entries.length - 1] = { ...last, text: clip(last.text + e.delta, CHILD_TEXT) };
    else entries.push({ kind, text: clip(e.delta, CHILD_TEXT) });
  } else if (e.type === 'toolCall') {
    entries.push({ kind: 'tool', id: e.id, name: e.name || 'tool', summary: summarizeInput(e.name, e.input), state: 'running', result: '' });
  } else if (e.type === 'toolResult') {
    const i = entries.map((x) => x.kind === 'tool' && x.id === e.id).lastIndexOf(true);
    const patch = { state: e.isError ? 'error' : 'done', result: clip(e.content, CHILD_TEXT) };
    if (i >= 0) entries[i] = { ...entries[i], ...patch };
    else entries.push({ kind: 'tool', id: e.id, name: 'tool', summary: '', ...patch });
  } else {
    return c;
  }
  let dropped = c.dropped;
  if (entries.length > CHILD_ENTRIES) { dropped += entries.length - CHILD_ENTRIES; entries = entries.slice(-CHILD_ENTRIES); }
  const end = entries[entries.length - 1];
  const lastLine = end.kind === 'tool' ? `${end.name}${end.summary ? ` ${end.summary}` : ''}`
    : String(end.text).split('\n').filter((l) => l.trim()).pop() || '';
  return { ...c, entries, dropped, last: oneLine(lastLine, 160) };
}

function toolItemOf(s, toolId) {
  if (!toolId) return null;
  const id = s.turn && s.turn.tools[toolId];
  if (id) return id;
  const found = [...s.items].reverse().find((it) => it.kind === 'tool' && it.toolId === toolId);
  return found ? found.id : null;
}

/* What the page draws of a subagent. */
function childView(c) {
  return { childId: c.childId, title: c.title, status: c.status, error: c.error, entries: c.entries, dropped: c.dropped, last: c.last };
}

function onSubagent(s, ev, at) {
  const childId = typeof ev.childId === 'string' ? ev.childId : '';
  if (!childId) return s;
  const before = s.children[childId] || { childId, title: '', status: 'running', error: '', toolId: '', host: null, entries: [], dropped: 0, last: '' };
  let c = {
    ...before,
    title: typeof ev.title === 'string' && ev.title ? ev.title : before.title,
    status: ['running', 'done', 'stopped', 'failed'].includes(ev.status) ? ev.status : before.status,
    error: typeof ev.error === 'string' ? ev.error : before.error,
  };
  if (ev.event && typeof ev.event === 'object') c = childStep(c, ev.event);
  if (typeof ev.toolId === 'string' && ev.toolId) c.toolId = ev.toolId;
  let host = c.host;
  const hostItem = host ? s.items[indexOf(host)] : null;
  const toolHost = toolItemOf(s, c.toolId);
  /* Moves to the call that started it once known; a card of its own stays where it was drawn. */
  if (toolHost && toolHost !== host && (!hostItem || hostItem.kind === 'tool')) {
    if (hostItem) s = replace(s, host, { child: null });
    host = toolHost;
  }
  if (!host) {
    const r = append(s, { kind: 'subagent', turn: s.turn ? s.turn.id : null, at, ...childView(c) });
    s = r.s;
    host = r.id;
  } else {
    const item = s.items[indexOf(host)];
    s = replace(s, host, item && item.kind === 'tool' ? { child: childView(c) } : childView(c));
  }
  c.host = host;
  return { ...s, children: { ...s.children, [childId]: c }, lastAt: at };
}

/* ---------- forms ---------- */

function optionsOf(list) {
  return (Array.isArray(list) ? list : []).filter((o) => o && (typeof o.const === 'string' || typeof o.const === 'number'))
    .map((o) => ({ value: String(o.const), label: String(o.title || o.const), description: typeof o.description === 'string' ? o.description : '' }));
}

/*
 * The fields of a form from the JSON Schema object an agent asks with: text, choice (one of), multi (any of), boolean,
 * number and integer. A string property `<key>_custom` next to a choice or multi `<key>` is that field's own-answer
 * box (`otherKey`), the way OpenCode's question tool asks.
 */
function formFields(schema) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required : []);
  const fields = [];
  for (const [key, p] of Object.entries(props)) {
    if (!p || typeof p !== 'object') continue;
    const base = {
      key,
      title: String(p.title || key),
      description: typeof p.description === 'string' ? p.description : '',
      required: required.has(key),
    };
    if (p.default !== undefined) base.default = p.default;
    if (p.type === 'array') {
      const items = p.items || {};
      const options = items.anyOf || items.oneOf ? optionsOf(items.anyOf || items.oneOf) : optionsOf((items.enum || []).map((v) => ({ const: v })));
      fields.push({ ...base, type: 'multi', options, minItems: Number(p.minItems) || 0, maxItems: Number(p.maxItems) || 0 });
    } else if (p.type === 'boolean') {
      fields.push({ ...base, type: 'boolean' });
    } else if (p.type === 'number' || p.type === 'integer') {
      const f = { ...base, type: p.type };
      if (typeof p.minimum === 'number') f.minimum = p.minimum;
      if (typeof p.maximum === 'number') f.maximum = p.maximum;
      fields.push(f);
    } else if (Array.isArray(p.oneOf) || Array.isArray(p.anyOf) || Array.isArray(p.enum)) {
      const options = p.enum ? optionsOf(p.enum.map((v, i) => ({ const: v, title: Array.isArray(p.enumNames) ? p.enumNames[i] : v }))) : optionsOf(p.oneOf || p.anyOf);
      fields.push({ ...base, type: 'choice', options });
    } else {
      const f = { ...base, type: 'text' };
      if (typeof p.maxLength === 'number') f.maxLength = p.maxLength;
      if (typeof p.minLength === 'number') f.minLength = p.minLength;
      fields.push(f);
    }
  }
  for (const f of fields) {
    if (f.type !== 'text' || !f.key.endsWith('_custom')) continue;
    const owner = fields.find((g) => g.key === f.key.slice(0, -'_custom'.length) && (g.type === 'choice' || g.type === 'multi'));
    if (owner) { owner.otherKey = f.key; owner.otherLabel = f.description || 'Your own answer'; f.otherOf = owner.key; }
  }
  return fields.filter((f) => !f.otherOf);
}

/*
 * The answer's content from what the page filled in: values[key] is a string, an array of strings (multi) or a
 * boolean; values[otherKey] the own-answer text. Returns { content, errors }: errors say what to fix, in words.
 */
function formContent(fields, values) {
  const v = values && typeof values === 'object' ? values : {};
  const content = {};
  const errors = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    const raw = v[f.key];
    const other = f.otherKey && typeof v[f.otherKey] === 'string' ? v[f.otherKey].trim() : '';
    if (other) content[f.otherKey] = other;
    let answered = !!other;
    if (f.type === 'choice') {
      const pick = typeof raw === 'string' && f.options.some((o) => o.value === raw) ? raw : '';
      if (pick) { content[f.key] = pick; answered = true; }
    } else if (f.type === 'multi') {
      const picks = (Array.isArray(raw) ? raw : []).map(String).filter((x) => f.options.some((o) => o.value === x));
      if (picks.length) { content[f.key] = picks; answered = true; }
      const n = picks.length + (other ? 1 : 0);
      if (f.maxItems && n > f.maxItems) errors.push(`${f.title}: pick at most ${f.maxItems}.`);
      if (f.minItems && n && n < f.minItems) errors.push(`${f.title}: pick at least ${f.minItems}.`);
    } else if (f.type === 'boolean') {
      content[f.key] = raw === true || raw === 'true';
      answered = true;
    } else if (f.type === 'number' || f.type === 'integer') {
      const text = raw == null ? '' : String(raw).trim();
      if (text) {
        const n = Number(text);
        if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) errors.push(`${f.title}: enter ${f.type === 'integer' ? 'a whole number' : 'a number'}.`);
        else if (typeof f.minimum === 'number' && n < f.minimum) errors.push(`${f.title}: at least ${f.minimum}.`);
        else if (typeof f.maximum === 'number' && n > f.maximum) errors.push(`${f.title}: at most ${f.maximum}.`);
        else { content[f.key] = n; answered = true; }
      }
    } else {
      const text = typeof raw === 'string' ? raw : '';
      if (text.trim()) {
        if (f.maxLength && text.length > f.maxLength) errors.push(`${f.title}: at most ${f.maxLength} characters.`);
        else { content[f.key] = text; answered = true; }
      }
    }
    if (f.required && !answered && !errors.some((e) => e.startsWith(`${f.title}:`))) errors.push(`${f.title}: needs an answer.`);
  }
  return { content, errors };
}

/* ---------- the reducer ---------- */

function reduce(s, ev, now) {
  if (!s) s = initialState();
  if (!ev || typeof ev.type !== 'string') return s;
  const at = timeOf(s, ev.at, now);
  switch (ev.type) {
    case 'turnStart':
      if (s.turn) s = endTurn(s, { reason: 'endTurn' }, at);
      /* The model the turn runs on, as <provider>/<model>; its context window comes with a later ui.model. */
      if (typeof ev.modelId === 'string' && ev.modelId && (!s.model || s.model.id !== ev.modelId)) {
        s = { ...s, model: { id: ev.modelId, name: ev.modelId, vendor: '', contextWindow: 0 } };
      }
      s = startTurn(s, ev.turnId, at, ev.effort);
      /* A turn the agent began itself has no user message to explain the reply that follows. */
      if (ev.unsolicited === true) s = append(s, { kind: 'notice', turn: s.turn.id, at, level: 'info', text: UNSOLICITED_NOTE }).s;
      return s;

    case 'userMessage': {
      /* Text a plugin added for the model to read, not something the user wrote. */
      if (ev.synthetic === true) return s;
      const text = String(ev.text || '');
      let queued = s.queued;
      const qi = queued.findIndex((q) => q.text.trim() === text.trim());
      if (qi >= 0) queued = [...queued.slice(0, qi), ...queued.slice(qi + 1)];
      const item = { kind: 'user', turn: s.turn ? s.turn.id : null, at, text };
      const shown = attachmentsOf(ev.attachments);
      if (shown.length) item.attachments = shown;
      const r = append({ ...s, queued, lastAt: at }, item);
      return r.s;
    }

    case 'text':
      return { ...addDelta(s, 'text', ev.delta, at), retry: null };

    case 'reasoning':
      return { ...addDelta(s, 'reasoning', ev.delta, at), retry: null };

    case 'toolCall': {
      s = ensureTurn(s, at);
      const r = append(s, {
        kind: 'tool', turn: s.turn.id, at, toolId: ev.id, name: ev.name || 'tool',
        summary: summarizeInput(ev.name, ev.input), input: inputText(ev.input),
        state: 'running', result: '', doneAt: null,
        ...(subagentOf(ev) ? { subagent: subagentOf(ev) } : {}),
      });
      return { ...r.s, retry: null, lastAt: at, turn: { ...r.s.turn, tools: { ...r.s.turn.tools, [ev.id]: r.id } } };
    }

    case 'toolResult': {
      const patch = {
        state: ev.isError ? 'error' : 'done', result: clip(ev.content), doneAt: at,
        display: ev.display && typeof ev.display === 'object' ? ev.display : null,
      };
      let itemId = s.turn && s.turn.tools[ev.id];
      if (!itemId) {
        const found = [...s.items].reverse().find((it) => it.kind === 'tool' && it.toolId === ev.id);
        itemId = found && found.id;
      }
      if (itemId) return { ...replace(s, itemId, patch), lastAt: at };
      return append(s, {
        kind: 'tool', turn: s.turn ? s.turn.id : null, at, toolId: ev.id, name: 'tool', summary: '', input: '', ...patch,
      }).s;
    }

    case 'permission': {
      s = ensureTurn(s, at);
      const req = ev.request || {};
      const { diff, ...rest } = req;
      const r = append(s, {
        kind: 'permission', turn: s.turn.id, at, requestId: ev.requestId,
        request: { ...rest, hasDiff: !!(diff && typeof diff === 'object') }, decision: null,
        ...(subagentOf(ev) ? { subagent: subagentOf(ev) } : {}),
      });
      s = { ...r.s, pending: { ...r.s.pending, [ev.requestId]: r.id } };
      if (diff && typeof diff === 'object') s = rememberDiff(s, ev.requestId, diff);
      return settle(s);
    }

    case 'question': {
      s = ensureTurn(s, at);
      const r = append(s, {
        kind: 'question', turn: s.turn.id, at, requestId: String(ev.requestId || ''), message: String(ev.message || ''),
        fields: formFields(ev.schema), decision: null,
        ...(subagentOf(ev) ? { subagent: subagentOf(ev) } : {}),
      });
      return settle({ ...r.s, pending: { ...r.s.pending, [ev.requestId]: r.id } });
    }

    case 'questionSettled': {
      const itemId = s.pending[ev.requestId] ||
        ([...s.items].reverse().find((it) => it.kind === 'question' && it.requestId === ev.requestId) || {}).id;
      if (!itemId) return s;
      const pending = { ...s.pending };
      delete pending[ev.requestId];
      return settle({ ...replace(s, itemId, { decision: ev.action === 'accept' ? 'answered' : 'dismissed' }), pending });
    }

    case 'compaction': {
      const status = ['running', 'completed', 'failed', 'cancelled'].includes(ev.status) ? ev.status : '';
      if (!status) return s;
      const open = s.compaction && s.items[indexOf(s.compaction)];
      const patch = { status, at, summary: typeof ev.summary === 'string' ? clip(ev.summary) : '', error: typeof ev.error === 'string' ? ev.error : '' };
      if (open && open.status === 'running') {
        s = replace(s, s.compaction, status === 'running' ? {} : patch);
      } else {
        const r = append(s, { kind: 'compaction', turn: s.turn ? s.turn.id : null, ...patch });
        s = { ...r.s, compaction: r.id };
      }
      return { ...s, compaction: status === 'running' ? s.compaction : null, lastAt: at };
    }

    case 'subagent':
      return onSubagent(s, ev, at);

    case 'permissionSettled': {
      const itemId = s.pending[ev.requestId] ||
        ([...s.items].reverse().find((it) => it.kind === 'permission' && it.requestId === ev.requestId) || {}).id;
      if (!itemId) return s;
      const pending = { ...s.pending };
      delete pending[ev.requestId];
      return settle({ ...replace(s, itemId, { decision: ev.decision }), pending });
    }

    case 'usage': {
      const cost = typeof ev.costUsd === 'number' && isFinite(ev.costUsd) ? ev.costUsd : null;
      const used = typeof ev.contextUsed === 'number' ? ev.contextUsed : s.contextUsed;
      /* The window the agent reports for the model this turn runs on, before the model list has learned it. */
      const win = typeof ev.contextWindow === 'number' && isFinite(ev.contextWindow) && ev.contextWindow > 0 ? ev.contextWindow : 0;
      s = { ...s, contextUsed: used, retry: null };
      if (win && s.model && !s.model.contextWindow && (!s.turn || !s.turn.modelId || s.turn.modelId === s.model.id)) s = { ...s, model: { ...s.model, contextWindow: win } };
      if (cost != null) s = { ...s, costUsd: s.costUsd + cost, costKnown: true };
      if (s.turn) {
        s = {
          ...s,
          turn: {
            ...s.turn,
            contextWindow: win || s.turn.contextWindow,
            contextUsed: used,
            costUsd: s.turn.costUsd + (cost || 0),
            costKnown: s.turn.costKnown || cost != null,
          },
        };
      }
      return s;
    }

    case 'retry':
      /* Attempt 0: the retry has started, so the countdown goes. */
      if (!(ev.attempt > 0)) return { ...s, retry: null };
      return {
        ...s,
        retry: {
          attempt: ev.attempt || 1,
          waitMs: typeof ev.waitMs === 'number' ? ev.waitMs : 0,
          error: errorText(ev.error),
          at,
        },
      };

    case 'turnEnd':
      /* Stopping drops the messages that waited for the turn. */
      if (ev.reason === 'aborted' && s.queued.length) s = { ...s, queued: [] };
      if (!s.turn) {
        if (ev.reason !== 'error') return s;
        return append(s, { kind: 'notice', turn: null, at, level: 'error', text: errorText(ev.error) }).s;
      }
      return endTurn(s, ev, at);

    case 'title':
      return { ...s, title: String(ev.title || '') };

    case 'ui.model': {
      const m = ev.model;
      if (!m || !m.id) return s;
      const model = { id: m.id, name: m.name || '', vendor: m.vendor || '', contextWindow: m.contextWindow || 0 };
      /* A running turn on this model takes the window, which OpenCode learns from the model's first call. */
      const turn = s.turn && (s.turn.modelId === m.id || !s.turn.modelId)
        ? { ...s.turn, modelId: m.id, contextWindow: model.contextWindow || s.turn.contextWindow } : s.turn;
      return { ...s, model, turn };
    }

    case 'ui.queued': {
      const text = String(ev.text || '');
      if (!text.trim()) return s;
      const qseq = s.qseq + 1;
      return { ...s, qseq, queued: [...s.queued, { id: `q${qseq}`, text, at }] };
    }

    default:
      return s;
  }
}

function reduceAll(events, state, now) {
  let s = state || initialState();
  for (const ev of events) s = reduce(s, ev, now);
  return s;
}

/* ---------- a saved session ---------- */

function partsText(parts) {
  if (!Array.isArray(parts)) return String(parts == null ? '' : parts);
  return parts.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n');
}

/*
 * Rebuilds the view from a session file's records (contracts.js SessionRecord), as if its events had just happened.
 * A user message with text starts a turn; a message holding only tool results continues the one before. Restored
 * turns end at their last message or usage record. `modelInfo(providerId, modelId)` may give the context window for
 * the ctx figures.
 */
function fromRecords(records, opts = {}) {
  const lookup = typeof opts.modelInfo === 'function' ? opts.modelInfo : () => null;
  const setModel = (s, providerId, modelId) => {
    if (!modelId) return s;
    const info = lookup(providerId, modelId) || { id: modelId, contextWindow: 0 };
    return reduce(s, { type: 'ui.model', model: info });
  };
  let s = initialState();
  let lastAt = 0;
  let n = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue;
    const at = typeof r.at === 'number' ? r.at : r.kind === 'meta' ? r.createdAt : lastAt;
    switch (r.kind) {
      case 'meta':
        s = setModel(s, r.providerId, r.modelId);
        if (r.title) s = reduce(s, { type: 'title', title: r.title });
        break;
      case 'model':
        s = setModel(s, r.providerId, r.modelId);
        break;
      case 'title':
        s = reduce(s, { type: 'title', title: r.title });
        break;
      case 'usage': {
        const used = (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
        s = reduce(s, { type: 'usage', input: r.input, output: r.output, contextUsed: used, costUsd: r.costUsd }, at);
        break;
      }
      case 'message': {
        const msg = r.message || {};
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (msg.role === 'user') {
          for (const b of blocks) {
            if (b.type === 'toolResult') {
              s = reduce(s, { type: 'toolResult', id: b.toolUseId, content: partsText(b.content), isError: !!b.isError, at });
            }
          }
          const words = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const images = blocks.filter((b) => b.type === 'image').length;
          if (words || images) {
            if (s.turn) s = reduce(s, { type: 'turnEnd', turnId: s.turn.id, reason: 'endTurn', at: lastAt });
            s = reduce(s, { type: 'turnStart', turnId: `h${++n}`, at });
            const note = images ? `[${images} image${images > 1 ? 's' : ''}]` : '';
            s = reduce(s, { type: 'userMessage', text: [words, note].filter(Boolean).join('\n'), at });
          }
        } else if (msg.role === 'assistant') {
          for (const b of blocks) {
            if (b.type === 'reasoning') s = reduce(s, { type: 'reasoning', delta: b.text || '' }, at);
            else if (b.type === 'text') s = reduce(s, { type: 'text', delta: b.text || '' }, at);
            else if (b.type === 'toolUse') s = reduce(s, { type: 'toolCall', id: b.id, name: b.name, input: b.input, at });
          }
        }
        break;
      }
      default:
        break;
    }
    if ((r.kind === 'message' || r.kind === 'usage') && at > lastAt) lastAt = at;
  }
  if (s.turn) s = reduce(s, { type: 'turnEnd', turnId: s.turn.id, reason: 'endTurn', at: lastAt });
  return s;
}

/* ---------- what the page gets ---------- */

function head(s) {
  const window = s.model ? s.model.contextWindow || 0 : 0;
  return {
    status: s.status,
    title: s.title,
    model: s.model ? { id: s.model.id, name: s.model.name, short: shortModel(s.model.id) } : null,
    contextUsed: s.contextUsed,
    contextWindow: window,
    contextPct: s.contextUsed > 0 ? contextPct(s.contextUsed, window) : null,
    contextText: s.contextUsed ? `${fmtTokens(s.contextUsed)}${window ? ` of ${fmtTokens(window)}` : ''} tokens` : '',
    costUsd: s.costKnown ? s.costUsd : null,
    costText: s.costKnown ? fmtCost(s.costUsd) : '',
    queued: s.queued,
    retry: s.retry,
    turnStartedAt: s.turn ? s.turn.startedAt : null,
    pending: Object.keys(s.pending).length,
    waitingFor: Object.keys(s.pending).some((k) => (s.items[indexOf(s.pending[k])] || {}).kind === 'question') ? 'question' : 'permission',
  };
}

function toView(s) {
  return { items: s.items, head: head(s) };
}

/* Items of `next` that are new or differ from `prev`, in display order. */
function changedItems(prev, next) {
  const before = prev ? prev.items : [];
  const out = [];
  for (let i = 0; i < next.items.length; i++) if (before[i] !== next.items[i]) out.push(next.items[i]);
  return out;
}

module.exports = {
  initialState,
  reduce,
  reduceAll,
  fromRecords,
  head,
  toView,
  changedItems,
  statusOf,
  fmtDuration,
  fmtCost,
  fmtTokens,
  shortModel,
  figuresText,
  summarizeInput,
  errorText,
  formFields,
  formContent,
};
