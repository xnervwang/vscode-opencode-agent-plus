// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plan bar above each chat page's input box, which media/chat.js draws with media/plan-bar.js (copied from Agent
 * Plus). It shows the summary Agent Plus's planSummary() gives for the page's conversation (Plan bar in its
 * docs/protocol.md).
 *
 * Agent Plus is asked for summaries, and listened to, only while some page follows one, the bar is switched on
 * (`on()`) and Agent Plus offers planSummary; otherwise the summary is null and the page draws no bar. No editor API
 * here.
 */
const SOURCE = 'opencode-plus';

/* `run(command, arg)` is vscode.commands.executeCommand, passed in so the tests need no editor. */
function createPlanBar({ on, run, log = () => {} }) {
  let core = null, sub = null, closed = false;
  /* sessionId -> the pages' listeners for its summary */
  const followers = new Map();
  const say = (e) => { try { log(`plan bar: ${(e && e.message) || e}`); } catch (_) { /* not logged */ } };
  const enabled = () => { try { return on() !== false; } catch (_) { return false; } };
  const usesCore = () => !!(core && Array.isArray(core.features) && core.features.includes('planSummary')
    && typeof core.planSummary === 'function' && typeof core.onDidChangePlanSummary === 'function');
  const summaryOf = (sessionId) => {
    if (closed || !enabled() || !usesCore()) return null;
    try { return core.planSummary(SOURCE, sessionId) || null; } catch (e) { say(e); return null; }
  };
  const tell = (sessionId) => {
    const fns = followers.get(sessionId);
    if (!fns || !fns.size) return;
    const summary = summaryOf(sessionId);
    for (const fn of [...fns]) { try { fn(summary); } catch (e) { say(e); } }
  };
  const unhook = () => { if (sub) { try { sub.dispose(); } catch (_) { /* gone */ } sub = null; } };
  const hook = () => {
    if (closed || !followers.size || !enabled() || !usesCore()) { unhook(); return; }
    if (sub) return;
    try {
      sub = core.onDidChangePlanSummary((e) => {
        if (closed || !e || e.sourceId !== SOURCE || typeof e.sessionId !== 'string') return;
        tell(e.sessionId);
      });
    } catch (e) { sub = null; say(e); }
  };

  return {
    /* The agentPlus interface once this extension is registered with it, or null; every page is sent its summary. */
    attach(next) {
      unhook();
      core = next || null;
      hook();
      for (const id of followers.keys()) tell(id);
    },
    settingChanged() {
      hook();
      for (const id of followers.keys()) tell(id);
    },
    summaryOf,
    /* Calls `fn` with the summary of `sessionId` each time it changes, until the returned object is disposed. */
    follow(sessionId, fn) {
      if (closed || typeof sessionId !== 'string' || !sessionId || typeof fn !== 'function') return { dispose() {} };
      if (!followers.has(sessionId)) followers.set(sessionId, new Set());
      followers.get(sessionId).add(fn);
      hook();
      return {
        dispose: () => {
          const fns = followers.get(sessionId);
          if (fns) { fns.delete(fn); if (!fns.size) followers.delete(sessionId); }
          if (!followers.size) unhook();
        },
      };
    },
    async open(sessionId, part) {
      if (closed || typeof sessionId !== 'string' || !sessionId || !usesCore()) return false;
      await run(part === 'answer' ? 'agentPlus.answerQuestionOf' : 'agentPlus.showWorkPlanOf', { sourceId: SOURCE, sessionId });
      return true;
    },
    following: () => [...followers.keys()],
    dispose() { closed = true; unhook(); followers.clear(); },
  };
}

module.exports = { createPlanBar, SOURCE };
