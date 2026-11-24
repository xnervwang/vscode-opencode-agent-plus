// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * This extension's conversations as a source of Agent Plus (xnervwang.agent-plus, protocol 1; its docs/protocol.md).
 *
 *   tabs            a chat tab is a custom editor of opencodeplus-session:/<session id> (src/host/chat-editor.js), so the
 *                   session id is in the tab itself and sessionForTab never has to answer '' for one of ours
 *   conversations   the ones open in this window (src/host/session-manager.js); one not open here is not running
 *   focus           reported by the chat editor when its panel comes to the front (focus())
 *   answers         sent as a user message; a turn in progress queues it, so it counts as submitted
 *   plans           the plugin's files (src/workplan); 'brief' is listed while the token mode lets the plugin keep one
 */
const path = require('path');
const vscode = require('vscode');
const brand = require('../brand');

const PROTOCOL = 1;
const ID = 'opencode-plus';
const CORE_ID = 'xnervwang.agent-plus';
const VIEW_TYPE = `${brand.prefix}.chat`;
const SCHEME = 'opencodeplus-session';
const EXTENSION_ID = `${brand.publisher}.${brand.packageName}`;

/* The session id of a opencodeplus-session:/<id> URI, or ''. */
function sessionOfUri(uri) {
  if (!uri || uri.scheme !== SCHEME) return '';
  const id = String(uri.path || '').replace(/^\/+/, '').split('/')[0];
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id) ? id : '';
}

const uriOf = (sessionId) => vscode.Uri.from({ scheme: SCHEME, path: `/${sessionId}` });

const isChatTab = (tab) => !!tab && tab.input instanceof vscode.TabInputCustom && String(tab.input.viewType).endsWith(VIEW_TYPE);

/* The activity Agent Plus reads, and `state` for its builds that read only that. */
function stateOf(c) {
  if (c.activity === 'waiting') return 'prompt';
  if (c.activity === 'working') return 'working';
  return c.unseen ? 'unread' : 'idle';
}

function toConversation(s) {
  const out = {
    sessionId: s.sessionId,
    title: String(s.title || 'New conversation').slice(0, 200),
    cwd: s.cwd || '',
    state: stateOf(s),
    activity: s.activity === 'working' || s.activity === 'waiting' ? s.activity : 'stopped',
    unseen: !!s.unseen,
    running: s.running !== false,
    lastActiveAt: s.lastActiveAt || 0,
    hasPlan: false,
  };
  if (s.lastUserAt > 0) out.lastUserAt = s.lastUserAt;
  if (s.lastReplyAt > 0) out.lastReplyAt = s.lastReplyAt;
  if (out.activity === 'waiting') {
    const tool = s.waitingFor && typeof s.waitingFor.tool === 'string' ? s.waitingFor.tool.slice(0, 80) : '';
    out.waitingFor = s.waitingFor && s.waitingFor.kind === 'question' ? { kind: 'question' } : tool ? { kind: 'permission', tool } : { kind: 'permission' };
  }
  return out;
}

function emitter() {
  const listeners = new Set();
  return {
    event(listener, thisArgs, disposables) {
      const fn = (v) => listener.call(thisArgs, v);
      listeners.add(fn);
      const d = { dispose: () => { listeners.delete(fn); } };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    },
    fire(v) { for (const fn of [...listeners]) { try { fn(v); } catch (_) { /* the other listeners still run */ } } },
    dispose() { listeners.clear(); },
  };
}

/*
 * deps:
 *   manager            src/host/session-manager.js
 *   planDir()          the plans folder (src/workplan planDir)
 *   planPath(id)       optional: a conversation's plan file, or null (src/workplan planPath)
 *   brief()            optional: whether the conversations keep a brief in their plans now
 *   planNotice()       optional: null or the row Agent Plus shows above the plan (a missing Python, say)
 *   logo()             { light, dark } Uris, or null
 *   reveal(sessionId)  Promise<boolean>: bring its tab in this window to the front
 *   openHere(sessionId)  Promise<boolean>: open it in this window
 *   trusted()          whether the workspace is trusted
 *   hidden(sessionId)  optional: true for a session not to list (a subagent's, open in a tab restored from before)
 *   log(line)          optional
 */
function createAgentPlusSource(deps) {
  const focused = emitter(), changed = emitter(), noticed = emitter();
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  /* The session of the latest focus report; cleared once a tab that is not ours comes to the front. */
  let front = '';
  const deliveries = new Map();

  const activeTab = () => {
    try { const g = vscode.window.tabGroups.activeTabGroup; return g ? g.activeTab : undefined; } catch (_) { return undefined; }
  };
  const trusted = () => { try { return deps.trusted ? deps.trusted() !== false : true; } catch (_) { return false; } };

  async function deliver(sessionId, text) {
    if (!trusted()) return { outcome: 'notReceived', reason: 'the workspace is not trusted' };
    if (!deps.manager.has(sessionId)) return { outcome: 'notReceived', reason: 'the conversation is not open in this window' };
    try {
      deps.manager.send(sessionId, String(text));
      return { outcome: 'submitted' };
    } catch (e) {
      return { outcome: 'notReceived', reason: String((e && e.message) || e).slice(0, 200) };
    }
  }

  const briefOn = () => { try { return deps.brief ? deps.brief() === true : false; } catch (_) { return false; } };

  const source = {
    protocol: PROTOCOL,
    get features() { return briefOn() ? ['shows', 'openHere', 'brief'] : ['shows', 'openHere']; },
    id: ID,
    label: brand.displayName,
    extensionId: EXTENSION_ID,
    get logo() { try { return deps.logo ? deps.logo() : null; } catch (_) { return null; } },
    planDir: () => deps.planDir(),
    planPath: (sessionId) => {
      if (deps.planPath) return deps.planPath(sessionId);
      return typeof sessionId === 'string' && sessionOfUri(uriOf(sessionId)) ? path.join(deps.planDir(), `${sessionId}.json`) : null;
    },
    planNotice: () => { try { return deps.planNotice ? deps.planNotice() || null : null; } catch (_) { return null; } },
    onDidChangePlanNotice: noticed.event,
    onDidFocus: focused.event,
    onDidChangeConversations: changed.event,

    /* The session id for a chat tab of ours, null for any other tab. */
    sessionForTab(tab) {
      if (!isChatTab(tab)) return null;
      return sessionOfUri(tab.input.uri);
    },

    isFocused(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return false;
      const tab = activeTab();
      if (tab && isChatTab(tab)) return sessionOfUri(tab.input.uri) === sessionId;
      if (tab) return false;
      return front === sessionId;
    },

    async listConversations() {
      const hidden = (id) => { try { return deps.hidden ? deps.hidden(id) === true : false; } catch (_) { return false; } };
      return deps.manager.list().filter((s) => !hidden(s.sessionId)).map(toConversation);
    },

    reveal(sessionId) {
      if (!deps.manager.has(sessionId)) return Promise.resolve(false);
      return Promise.resolve().then(() => deps.reveal(sessionId)).then((r) => r === true, () => false);
    },

    shows(sessionId) { return typeof sessionId === 'string' && !!deps.manager.panelOf(sessionId); },

    openHere(sessionId) {
      if (!trusted() || !sessionOfUri(uriOf(String(sessionId || '')))) return Promise.resolve(false);
      return Promise.resolve().then(() => deps.openHere(sessionId)).then((r) => r === true, () => false);
    },

    canDeliver(sessionId) { return trusted() && deps.manager.has(sessionId); },

    /* One delivery id is typed once, also while the first call runs; one that did not arrive can be retried. */
    deliverAnswer(sessionId, text, opts) {
      const id = opts && typeof opts.deliveryId === 'string' ? opts.deliveryId : '';
      if (!id) return deliver(sessionId, text);
      if (deliveries.has(id)) return deliveries.get(id);
      const p = deliver(sessionId, text);
      deliveries.set(id, p);
      p.then((r) => {
        if (!r || r.outcome === 'notReceived') deliveries.delete(id);
        else setTimeout(() => deliveries.delete(id), 120000).unref?.();
      });
      return p;
    },
  };

  return {
    source,
    /* A chat panel of ours came to the front with this conversation. */
    focus(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return;
      front = sessionId;
      focused.fire({ sessionId });
    },
    /* Called with the active tab whenever tabs change. */
    tabsChanged(tab) { if (tab && !isChatTab(tab)) front = ''; },
    refocus() {
      const tab = activeTab();
      const id = isChatTab(tab) ? sessionOfUri(tab.input.uri) : front;
      if (id) focused.fire({ sessionId: id });
    },
    changed() { changed.fire(); },
    noticeChanged() { noticed.fire(); },
    log,
    dispose() { focused.dispose(); changed.dispose(); noticed.dispose(); deliveries.clear(); },
  };
}

/*
 * Registers `source` with Agent Plus once. Resolves to { accepted, code, reason, registration }. Never throws: without
 * Agent Plus, or refused by it, the extension works as before, outside Agent Plus.
 */
async function register(source, { log = () => {} } = {}) {
  const ext = vscode.extensions.getExtension(CORE_ID);
  if (!ext) { log('Agent Plus is not installed or not enabled'); return { accepted: false, code: 'no-core', reason: 'Agent Plus is not installed', registration: null }; }
  let api;
  try { api = ext.isActive ? ext.exports : await ext.activate(); } catch (e) {
    log(`Agent Plus did not start: ${(e && e.message) || e}`);
    return { accepted: false, code: 'no-core', reason: 'Agent Plus did not start', registration: null };
  }
  const core = api && api.agentPlus;
  if (!core || typeof core.registerSource !== 'function') {
    log('Agent Plus has no agentPlus interface');
    return { accepted: false, code: 'no-core', reason: 'Agent Plus has no agentPlus interface', registration: null };
  }
  let r;
  try { r = core.registerSource(source); } catch (e) { r = { accepted: false, code: 'failed', reason: String((e && e.message) || e) }; }
  if (r && r.accepted === true && r.registration && typeof r.registration.dispose === 'function') {
    log(`registered with Agent Plus ${core.version || ''}`.trim());
    return { accepted: true, code: '', reason: '', registration: r.registration };
  }
  const code = (r && r.code) || 'failed', reason = (r && r.reason) || 'no reason given';
  log(`Agent Plus did not take the source (${code}): ${reason}`);
  return { accepted: false, code, reason, registration: null };
}

module.exports = { createAgentPlusSource, register, toConversation, stateOf, sessionOfUri, uriOf, isChatTab, PROTOCOL, ID, CORE_ID, VIEW_TYPE, SCHEME, EXTENSION_ID };
