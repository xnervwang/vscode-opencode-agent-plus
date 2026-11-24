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
 * `audience: ["assistant"]`; it becomes a userMessage with `synthetic: true` and never starts a turn.
 *
 * usage_update carries the session's running cost; AgentEvent usage carries the cost of one call, so the difference
 * from the last one seen is sent.
 */

const STOP = Object.freeze({
  end_turn: 'endTurn',
  max_tokens: 'maxTokens',
  max_turn_requests: 'maxTokens',
  refusal: 'refused',
  cancelled: 'aborted',
});

const DEFAULT_TITLE = /^(New session|Child session) - \d{4}-\d\d-\d\dT[\d:.]+Z$/;

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

function createMapper({ now = Date.now } = {}) {
  let turn = null;
  let replaying = false;
  let replayCount = 0;
  let pendingUser = '';
  let lastUserMessage = null;
  let lastCost = null;
  let lastUsed = 0;
  let contextWindow = 0;
  const tools = new Map();

  function begin(turnId, text, at, modelId) {
    const t = at || now();
    turn = { id: turnId, startedAt: t, agentOutput: false };
    const start = { type: 'turnStart', turnId, at: t };
    if (modelId) start.modelId = modelId;
    return [start, { type: 'userMessage', text: String(text || ''), at: t }];
  }

  function flushUser() {
    if (!pendingUser) return [];
    const ev = { type: 'userMessage', text: pendingUser, at: turn ? turn.startedAt : now() };
    pendingUser = '';
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
        if (forModelOnly(u.content)) {
          if (text) out.push(...flushUser(), { type: 'userMessage', text, synthetic: true, at: now() });
          return out;
        }
        if (!replaying) return out;
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
        if (cost !== undefined) ev.costUsd = cost;
        out.push(ev);
        return out;
      }
      case 'session_info_update': {
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
      out.push({
        type: 'usage',
        input: num(us.inputTokens),
        output: num(us.outputTokens),
        cacheRead: num(us.cachedReadTokens),
        cacheWrite: num(us.cachedWriteTokens),
        contextUsed: lastUsed,
      });
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
    update,
    permission,
    settled,
    end,
    replayStart() { replaying = true; replayCount = 0; turn = null; pendingUser = ''; lastUserMessage = null; },
    replayEnd() { const out = endReplayTurn(); replaying = false; return out; },
    get inTurn() { return !!turn; },
    get turnId() { return turn ? turn.id : null; },
    get contextWindow() { return contextWindow; },
    get contextUsed() { return lastUsed; },
    toolName(id) { const t = tools.get(id); return t ? t.name : ''; },
  };
}

module.exports = { createMapper, permissionRequest, toolNameOf, modelsFromConfig, toProviderError, normalizeTitle, contentText, STOP };
