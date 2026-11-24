// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Turns what OpenCode sends over ACP for one session into contracts.js AgentEvents. Pure: no I/O, the clock comes in.
 *
 * A live turn is one session/prompt: the caller says when it starts and passes the prompt's result to end it. While
 * replaying session/load, a user message (chunks sharing a messageId) starts the next turn instead.
 *
 * Text a plugin adds for the model only (a work-plan line, a turn-end note) arrives as a user chunk annotated with
 * `audience: ["assistant"]` (1.x); it becomes a userMessage with `synthetic: true` and never starts a turn. The work plan
 * plugin on 2.x wraps its turn-end reminder in a <system-update> block; 2.4.1 neither streams nor replays it over ACP,
 * and a user chunk that starts with one is taken the same way should a later OpenCode send it.
 *
 * usage_update carries the session's running cost; AgentEvent usage carries the cost of one call, so the difference
 * from the last one seen is sent.
 *
 * OpenCode 2.x reports a retry it has scheduled as a session_info_update whose _meta["opencode/retry"] holds the next
 * attempt, and clears it with null when that attempt starts; they become `retry` events, attempt 0 for the clearing.
 *
 * With the client capability session.compaction, 2.x reports compacting as compaction_update (in_progress, then
 * completed with the summary, failed or cancelled) and streams the summary in compaction_summary_chunk; these become
 * `compaction` events, the chunks kept only for a completed update that carries no summary. A replay holds the
 * completed update where the compaction happened; it ends the replayed turn before it.
 *
 * A user message's images and files come back in a replay as image and resource_link chunks of the same messageId; a
 * file whose text was sent along comes back as part of the text, the way OpenCode wrote it for the model: a line
 * `[<absolute path>:<first line>]` and the text after it. Such parts are taken off the replayed text and named as
 * selections again.
 */
const { fileURLToPath } = require('url');

const STOP = Object.freeze({
  end_turn: 'endTurn',
  max_tokens: 'maxTokens',
  max_turn_requests: 'maxTokens',
  refusal: 'refused',
  cancelled: 'aborted',
});

const DEFAULT_TITLE = /^(New session|Child session) - \d{4}-\d\d-\d\dT[\d:.]+Z$/;
const RETRY_META = 'opencode/retry';

function normalizeTitle(t) {
  const s = typeof t === 'string' ? t.trim() : '';
  return DEFAULT_TITLE.test(s) ? '' : s;
}

const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

/* ProviderError from an error message OpenCode or the model API gave. */
function toProviderError(message, code) {
  const m = String(message || 'OpenCode reported an error');
  const kind =
    /aborted|cancel/i.test(m) ? 'aborted'
      : /authenticat|credential|not authorized|unauthori[sz]ed|security token|expired token|sign in|login/i.test(m) ? 'auth'
        : /throttl|rate.?limit|too many requests|\b429\b/i.test(m) ? 'throttled'
          : /model access|don'?t have access to the model|not enabled|use case details|model identifier is invalid|model.*not.*(available|found|supported)/i.test(m) ? 'modelNotEnabled'
            : /context|too long|too many tokens|prompt is too long|input.*length/i.test(m) ? 'contextTooLong'
              : /access ?denied|forbidden|\b403\b|permission/i.test(m) ? 'permission'
                : /content filter|refus|safety/i.test(m) ? 'refused'
                  : /invalid|validation|bad request|\b400\b/i.test(m) || code === -32602 ? 'badRequest'
                    : 'unavailable';
  return { kind, message: m };
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content && c.content.type === 'text') out.push(String(c.content.text || ''));
    else if (c.type === 'diff') out.push(`Edited ${c.path || ''}`.trim());
    else if (c.type === 'terminal') out.push(`[terminal ${c.terminalId || ''}]`);
  }
  return out.join('\n');
}

function diffOf(content) {
  if (!Array.isArray(content)) return null;
  const d = content.find((c) => c && c.type === 'diff' && typeof c.path === 'string');
  if (!d) return null;
  return { path: d.path, before: typeof d.oldText === 'string' ? d.oldText : '', after: typeof d.newText === 'string' ? d.newText : '' };
}

const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 200);

function forModelOnly(content) {
  const a = content && content.annotations && content.annotations.audience;
  return Array.isArray(a) && a.length > 0 && !a.includes('user');
}

const PLUGIN_NOTE = /^\s*<system-update>/;

const KIND_TOOL = Object.freeze({ execute: 'bash', edit: 'edit', delete: 'delete', move: 'move', read: 'read', search: 'search', fetch: 'webfetch', think: 'think' });

/* 2.x names the tool; 1.x puts the name in the first title of a live call but a human title (`ls -la`) in replays. */
function toolNameOf(tc) {
  if (tc && typeof tc.name === 'string' && tc.name) return tc.name;
  const title = tc && typeof tc.title === 'string' ? tc.title : '';
  if (/^[A-Za-z_][\w.-]{0,40}$/.test(title)) return title;
  return (tc && KIND_TOOL[tc.kind]) || title || 'tool';
}

/* contracts.js PermissionRequest from session/request_permission's toolCall. `toolName` is what the tool call said. */
function permissionRequest(toolCall, toolName) {
  const tc = toolCall || {};
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  const loc = Array.isArray(tc.locations) && tc.locations[0] && tc.locations[0].path;
  const tool = toolName || toolNameOf(tc);
  const title = typeof tc.title === 'string' ? tc.title : '';
  switch (tc.kind) {
    case 'execute': {
      const command = typeof raw.command === 'string' ? raw.command : title;
      const out = { kind: 'command', tool, summary: `Run ${firstLine(command)}`, command };
      if (typeof raw.description === 'string' && raw.description) out.detail = raw.description;
      return out;
    }
    case 'edit':
    case 'delete':
    case 'move': {
      const diff = diffOf(tc.content);
      const p = (diff && diff.path) || raw.filepath || raw.filePath || loc || title;
      const write = tool === 'write' || (diff && diff.before === '');
      const out = { kind: write ? 'write' : 'edit', tool, summary: `${write ? 'Write' : 'Edit'} ${p}`, path: p };
      if (diff) out.diff = diff; else if (typeof raw.diff === 'string') out.detail = raw.diff;
      return out;
    }
    case 'read':
    case 'search': {
      const p = raw.filePath || raw.filepath || raw.path || loc || title;
      return { kind: 'read-outside', tool, summary: `${tc.kind === 'read' ? 'Read' : 'Search'} ${p}`, path: p };
    }
    default: {
      const out = { kind: 'other', tool, summary: title || tool };
      const detail = Object.keys(raw).length ? JSON.stringify(raw) : '';
      if (detail) out.detail = detail.slice(0, 2000);
      if (loc) out.path = loc;
      return out;
    }
  }
}

/* contracts.js ModelInfo[] from ACP's model config option. The catalog numbers are not in ACP: a context window is
 * filled in once a usage_update has reported it for that model, prices never are (OpenCode reports the cost). */
function modelsFromConfig(configOptions, contextWindows = {}) {
  const opt = Array.isArray(configOptions) ? configOptions.find((o) => o && (o.id === 'model' || o.category === 'model')) : null;
  if (!opt || !Array.isArray(opt.options)) return { models: [], current: '' };
  const flat = [];
  for (const o of opt.options) {
    if (o && Array.isArray(o.options)) flat.push(...o.options); else if (o) flat.push(o);
  }
  const models = flat.filter((o) => typeof o.value === 'string' && o.value).map((o) => {
    const value = o.value;
    const slash = value.indexOf('/');
    const providerId = slash > 0 ? value.slice(0, slash) : '';
    const invokeId = slash > 0 ? value.slice(slash + 1) : value;
    const label = String(o.name || value);
    const ls = label.indexOf('/');
    const vendor = ls > 0 ? label.slice(0, ls) : providerId;
    const name = ls > 0 ? label.slice(ls + 1) : label;
    const window = num(contextWindows[value]);
    return {
      id: value,
      invokeId,
      name,
      vendor,
      providerId,
      contextWindow: window,
      maxOutputTokens: 0,
      supports: { tools: true, parallelTools: true, images: true, documents: false, temperature: true, promptCache: false, reasoning: 'none' },
      known: false,
    };
  });
  return { models, current: typeof opt.currentValue === 'string' ? opt.currentValue : '' };
}

const COMPACTION = Object.freeze({ in_progress: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' });

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/* The path a file:// URI names, or '' for any other URI. */
function pathOfUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return '';
  try { return fileURLToPath(uri.replace(/#.*$/, '')); } catch (_) { return ''; }
}

/* A user message's attachment as the chat page names it, from a replayed chunk. */
/* OpenCode's lines for a selection sent with its text (2.4.1, `Wh()`): "\n[<absolute path>:<line>]\n<text>". */
const SELECTION_PART = /\n\[((?:[A-Za-z]:)?[\\/][^\]\n]*?)(?::(\d+))?\]\n/g;

/* The replayed text without the selections OpenCode wrote into it, and the selections. */
function splitSelections(text) {
  const t = String(text || '');
  const found = [...t.matchAll(SELECTION_PART)];
  if (!found.length) return { text: t, shown: [] };
  const shown = found.map((m) => {
    const name = m[1].split(/[\\/]/).pop();
    return { kind: 'selection', name: m[2] ? `${name}:${m[2]}` : name, path: m[1] };
  });
  return { text: t.slice(0, found[0].index), shown };
}

function attachmentOf(content) {
  if (!content || typeof content !== 'object') return null;
  if (content.type === 'image') return { kind: 'image', name: 'image' };
  if (content.type === 'resource_link' && typeof content.uri === 'string') {
    const p = pathOfUri(content.uri);
    return { kind: 'file', name: String(content.name || (p ? p.split(/[\\/]/).pop() : content.uri)), path: p };
  }
  return null;
}

/* AgentEvent retry from the value of _meta["opencode/retry"]: { attempt, nextRetryAt, error: { message, status } }. */
function retryEvent(r, at) {
  if (!r || typeof r !== 'object') return { type: 'retry', attempt: 0, at };
  const e = r.error;
  const pe = toProviderError(typeof e === 'string' ? e : e && e.message);
  if (e && e.status === 429) pe.kind = 'throttled';
  const next = Date.parse(r.nextRetryAt || '');
  const waitMs = Number.isFinite(next) ? Math.max(0, next - at) : num(r.retryAfterMs);
  return { type: 'retry', attempt: num(r.attempt) || 1, waitMs, error: pe, at };
}

function createMapper({ now = Date.now } = {}) {
  let turn = null;
  let replaying = false;
  let replayCount = 0;
  let pendingUser = '';
  let pendingAttachments = [];
  let lastUserMessage = null;
  let noteMessage = null;
  let lastCost = null;
  let lastUsed = 0;
  let contextWindow = 0;
  const tools = new Map();
  const summaries = new Map();

  function turnStart(turnId, t, modelId, effort) {
    turn = { id: turnId, startedAt: t, agentOutput: false };
    const start = { type: 'turnStart', turnId, at: t };
    if (modelId) start.modelId = modelId;
    if (effort) start.effort = effort;
    return start;
  }

  /* `attachments`: what went with the text, [{ kind: 'image' | 'file' | 'selection', name, path? }]. */
  function begin(turnId, text, at, modelId, effort, attachments) {
    const t = at || now();
    const msg = { type: 'userMessage', text: String(text || ''), at: t };
    if (Array.isArray(attachments) && attachments.length) msg.attachments = attachments;
    return [turnStart(turnId, t, modelId, effort), msg];
  }

  /* A turn OpenCode began without a prompt (a subagent or a background shell it waited for finished): no user message. */
  function beginOwn(turnId, at, modelId, effort) {
    const start = turnStart(turnId, at || now(), modelId, effort);
    start.unsolicited = true;
    return [start];
  }

  function flushUser() {
    if (!pendingUser && !pendingAttachments.length) return [];
    const split = replaying ? splitSelections(pendingUser) : { text: pendingUser, shown: [] };
    const ev = { type: 'userMessage', text: split.text, at: turn ? turn.startedAt : now() };
    const shown = [...pendingAttachments, ...split.shown];
    if (shown.length) ev.attachments = shown;
    pendingUser = '';
    pendingAttachments = [];
    return [ev];
  }

  function agentOutput() {
    const out = flushUser();
    if (turn) turn.agentOutput = true;
    return out;
  }

  function toolCallEvent(id, t, fallbackInput) {
    t.called = true;
    const input = t.input && Object.keys(t.input).length ? t.input : (fallbackInput || t.input || {});
    return { type: 'toolCall', id, name: t.name, input, at: now() };
  }

  function onTool(u, out) {
    const id = u.toolCallId;
    if (typeof id !== 'string') return;
    let t = tools.get(id);
    if (!t) {
      t = { name: toolNameOf(u), input: {}, called: false, done: false, kind: u.kind };
      tools.set(id, t);
    }
    if (u.kind) t.kind = u.kind;
    if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) t.input = u.rawInput;
    const status = u.status || '';
    out.push(...agentOutput());
    if (!t.called && (status === 'in_progress' || status === 'completed' || status === 'failed')) out.push(toolCallEvent(id, t));
    if (t.done) return;
    if (status === 'completed') {
      t.done = true;
      const display = { title: typeof u.title === 'string' ? u.title : '', kind: t.kind || '' };
      /* A subagent tool names the session the subagent runs in. */
      const meta = u.rawOutput && u.rawOutput.metadata;
      if (meta && typeof meta.sessionID === 'string' && meta.sessionID) display.childId = meta.sessionID;
      const text = contentText(u.content) || (u.rawOutput && typeof u.rawOutput.output === 'string' ? u.rawOutput.output : '');
      out.push({ type: 'toolResult', id, content: text, isError: false, display, at: now() });
    } else if (status === 'failed') {
      t.done = true;
      const text = contentText(u.content) || (u.rawOutput && (u.rawOutput.error || u.rawOutput.output)) || 'The tool failed.';
      out.push({ type: 'toolResult', id, content: String(text), isError: true, at: now() });
    }
  }

  function endReplayTurn() {
    if (!turn) return [];
    const out = flushUser();
    out.push({ type: 'turnEnd', turnId: turn.id, reason: 'endTurn', at: now() });
    turn = null;
    return out;
  }

  /* One session/update payload. */
  function update(u) {
    const out = [];
    if (!u || typeof u !== 'object') return out;
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        const text = u.content && u.content.type === 'text' ? String(u.content.text || '') : '';
        const mid0 = typeof u.messageId === 'string' ? u.messageId : null;
        if (PLUGIN_NOTE.test(text) && mid0) noteMessage = mid0;
        if (forModelOnly(u.content) || PLUGIN_NOTE.test(text) || (mid0 && mid0 === noteMessage)) {
          if (text) out.push(...flushUser(), { type: 'userMessage', text, synthetic: true, at: now() });
          return out;
        }
        if (!replaying) return out;
        const attachment = attachmentOf(u.content);
        if (!text && !attachment) return out;
        const mid = typeof u.messageId === 'string' ? u.messageId : null;
        const next = mid ? mid !== lastUserMessage : !!(turn && turn.agentOutput);
        if (turn && next) out.push(...endReplayTurn());
        if (!turn) {
          replayCount += 1;
          const t = now();
          turn = { id: `replay-${replayCount}`, startedAt: t, agentOutput: false };
          out.push({ type: 'turnStart', turnId: turn.id, at: t });
        }
        lastUserMessage = mid;
        pendingUser += text;
        if (attachment) pendingAttachments.push(attachment);
        return out;
      }
      case 'compaction_update': {
        const status = COMPACTION[u.status];
        if (!status) return out;
        const cid = typeof u.compactionId === 'string' ? u.compactionId : '';
        if (replaying && status === 'completed') out.push(...endReplayTurn());
        else out.push(...flushUser());
        const ev = { type: 'compaction', status };
        if (cid) ev.id = cid;
        if (status === 'completed') {
          const summary = blocksText(u.summary) || summaries.get(cid) || '';
          if (summary) ev.summary = summary;
        }
        if (status === 'failed' && typeof u.error === 'string' && u.error) ev.error = u.error;
        if (status !== 'running') summaries.delete(cid);
        out.push(ev);
        return out;
      }
      case 'compaction_summary_chunk': {
        const cid = typeof u.compactionId === 'string' ? u.compactionId : '';
        const text = u.content && u.content.type === 'text' ? String(u.content.text || '') : '';
        if (text) summaries.set(cid, (summaries.get(cid) || '') + text);
        return out;
      }
      case 'agent_message_chunk':
        if (u.content && u.content.type === 'text' && u.content.text) out.push(...agentOutput(), { type: 'text', delta: String(u.content.text) });
        return out;
      case 'agent_thought_chunk':
        if (u.content && u.content.type === 'text' && u.content.text) out.push(...agentOutput(), { type: 'reasoning', delta: String(u.content.text) });
        return out;
      case 'tool_call':
      case 'tool_call_update':
        onTool(u, out);
        return out;
      case 'usage_update': {
        if (num(u.size)) contextWindow = u.size;
        if (num(u.used)) lastUsed = u.used;
        const amount = u.cost && typeof u.cost.amount === 'number' ? u.cost.amount : null;
        let cost;
        if (amount !== null) {
          cost = lastCost === null || amount < lastCost ? amount : amount - lastCost;
          lastCost = amount;
        }
        const ev = { type: 'usage', input: 0, output: 0, contextUsed: lastUsed };
        if (contextWindow) ev.contextWindow = contextWindow;
        if (cost !== undefined) ev.costUsd = cost;
        out.push(ev);
        return out;
      }
      case 'session_info_update': {
        const meta = u._meta && typeof u._meta === 'object' ? u._meta : null;
        if (meta && Object.prototype.hasOwnProperty.call(meta, RETRY_META)) out.push(retryEvent(meta[RETRY_META], now()));
        const title = normalizeTitle(u.title);
        if (title) out.push({ type: 'title', title });
        return out;
      }
      default:
        return out;
    }
  }

  /* A permission request; returns the events and the PermissionRequest built for it. */
  function permission(requestId, toolCall) {
    const out = [];
    const tc = toolCall || {};
    let t = typeof tc.toolCallId === 'string' ? tools.get(tc.toolCallId) : null;
    if (typeof tc.toolCallId === 'string' && !t) {
      t = { name: toolNameOf(tc), input: {}, called: false, done: false, kind: tc.kind };
      tools.set(tc.toolCallId, t);
    }
    if (t && !t.called) out.push(...agentOutput(), toolCallEvent(tc.toolCallId, t, tc.rawInput));
    const request = permissionRequest(tc, t ? t.name : '');
    out.push({ type: 'permission', requestId, request });
    return { events: out, request, tool: request.tool };
  }

  const settled = (requestId, decision) => [{ type: 'permissionSettled', requestId, decision }];

  /*
   * Ends the live turn with session/prompt's result, or with the error it failed with. Tools still open are left for
   * the UI to mark as stopped.
   */
  function end(result, error) {
    if (!turn) return [];
    const out = flushUser();
    const at = now();
    if (result && result.usage && typeof result.usage === 'object') {
      const us = result.usage;
      const ev = {
        type: 'usage',
        input: num(us.inputTokens),
        output: num(us.outputTokens),
        cacheRead: num(us.cachedReadTokens),
        cacheWrite: num(us.cachedWriteTokens),
        contextUsed: lastUsed,
      };
      if (contextWindow) ev.contextWindow = contextWindow;
      out.push(ev);
    }
    const ev = { type: 'turnEnd', turnId: turn.id, at };
    if (error) {
      const pe = toProviderError(error.message, error.code);
      if (pe.kind === 'aborted') ev.reason = 'aborted';
      else { ev.reason = 'error'; ev.error = pe; }
    } else {
      ev.reason = STOP[result && result.stopReason] || 'endTurn';
    }
    out.push(ev);
    turn = null;
    return out;
  }

  return {
    begin,
    beginOwn,
    update,
    permission,
    settled,
    end,
    replayStart() { replaying = true; replayCount = 0; turn = null; pendingUser = ''; pendingAttachments = []; lastUserMessage = null; noteMessage = null; },
    replayEnd() { const out = endReplayTurn(); replaying = false; return out; },
    get inTurn() { return !!turn; },
    get turnId() { return turn ? turn.id : null; },
    get contextWindow() { return contextWindow; },
    get contextUsed() { return lastUsed; },
    toolName(id) { const t = tools.get(id); return t ? t.name : ''; },
    /* The tool calls seen so far, newest last: [{ id, name, input }]. */
    toolCalls() { return [...tools].map(([id, t]) => ({ id, name: t.name, input: t.input })); },
  };
}

module.exports = { createMapper, permissionRequest, toolNameOf, modelsFromConfig, toProviderError, normalizeTitle, contentText, retryEvent, pathOfUri, STOP, RETRY_META };
