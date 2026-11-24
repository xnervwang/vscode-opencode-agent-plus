// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plan bar above each chat page's input box (media/plan-bar.js, Agent Plus's fragment, drawn by media/chat.js): the
 * summary of the conversation a page shows, from Agent Plus's planSummary() (Plan bar in its docs/protocol.md), and
 * where the bar's two clicks go: agentPlus.showWorkPlanOf for the bar, agentPlus.answerQuestionOf for its red part.
 *
 * A page follows its own conversation's summary while it is open (follow()); the summaries are asked for, and Agent
 * Plus is listened to, only while some page follows one. Nothing is asked while `on()` is false, nor with an Agent
 * Plus that lacks planSummary: the summary is then null and the page draws no bar. No editor API here.
 */
const SOURCE = 'opencode-plus';

/*
 * `on()` is true while the bar is switched on; `run(command, arg)` runs a command.
 */
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
    /* The bar was switched on or off. */
    settingChanged() {
      hook();
      for (const id of followers.keys()) tell(id);
    },
    summaryOf,
    /* A page showing `sessionId` hears of its summary from now on; dispose() when it goes. */
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
    /* A click on the bar: `part` is 'answer' for its red part, anything else for the bar. */
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
