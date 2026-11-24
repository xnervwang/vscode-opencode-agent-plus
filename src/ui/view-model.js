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
 */

const MAX_SHOWN = 20000;
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
function shortModel(id) {
  if (!id) return '';
  let s = String(id).replace(REGION_PREFIX, '');
  const dot = s.indexOf('.');
  if (dot > 0) s = s.slice(dot + 1);
  return s.replace(/-v\d+(:\d+)?$/, '').replace(/-\d+:\d+$/, '').replace(/:\d+$/, '');
}

function contextPct(used, window) {
  return window > 0 && typeof used === 'number' ? Math.round((used / window) * 100) : null;
}

function figuresText(f) {
  const parts = [fmtDuration(f.durationMs)];
  if (f.contextPct != null) parts.push(`ctx ${f.contextPct}%`);
  else if (f.contextUsed) parts.push(`ctx ${fmtTokens(f.contextUsed)}`);
  if (f.costUsd != null) parts.push(fmtCost(f.costUsd));
  if (f.model) parts.push(f.model);
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

function startTurn(s, id, at) {
  const model = s.model;
  return settle({
    ...s,
    retry: null,
    lastAt: at,
    turn: {
      id: id || `t${s.seq + 1}`,
      startedAt: at,
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
    reason: ev.reason || 'endTurn',
  };
  figures.text = figuresText(figures);
  s = append(s, { kind: 'figures', turn: turn.id, at, ...figures }).s;
  return settle({ ...s, turn: null, retry: null, lastAt: at });
}

/* ---------- the reducer ---------- */

function reduce(s, ev, now) {
  if (!s) s = initialState();
  if (!ev || typeof ev.type !== 'string') return s;
  const at = timeOf(s, ev.at, now);
  switch (ev.type) {
    case 'turnStart':
      if (s.turn) s = endTurn(s, { reason: 'endTurn' }, at);
      return startTurn(s, ev.turnId, at);

    case 'userMessage': {
      const text = String(ev.text || '');
      let queued = s.queued;
      const qi = queued.findIndex((q) => q.text.trim() === text.trim());
      if (qi >= 0) queued = [...queued.slice(0, qi), ...queued.slice(qi + 1)];
      const r = append({ ...s, queued, lastAt: at }, { kind: 'user', turn: s.turn ? s.turn.id : null, at, text });
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
      });
      s = { ...r.s, pending: { ...r.s.pending, [ev.requestId]: r.id } };
      if (diff && typeof diff === 'object') s = rememberDiff(s, ev.requestId, diff);
      return settle(s);
    }

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
      s = { ...s, contextUsed: used, retry: null };
      if (cost != null) s = { ...s, costUsd: s.costUsd + cost, costKnown: true };
      if (s.turn) {
        s = {
          ...s,
          turn: {
            ...s.turn,
            contextUsed: used,
            costUsd: s.turn.costUsd + (cost || 0),
            costKnown: s.turn.costKnown || cost != null,
          },
        };
      }
      return s;
    }

    case 'retry':
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
      return { ...s, model: { id: m.id, name: m.name || '', vendor: m.vendor || '', contextWindow: m.contextWindow || 0 } };
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
    contextPct: contextPct(s.contextUsed, window),
    contextText: s.contextUsed ? `${fmtTokens(s.contextUsed)}${window ? ` of ${fmtTokens(window)}` : ''} tokens` : '',
    costUsd: s.costKnown ? s.costUsd : null,
    costText: s.costKnown ? fmtCost(s.costUsd) : '',
    queued: s.queued,
    retry: s.retry,
    turnStartedAt: s.turn ? s.turn.startedAt : null,
    pending: Object.keys(s.pending).length,
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
};
