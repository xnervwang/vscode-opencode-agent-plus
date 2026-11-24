// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A session object (src/host/backend.js) that asks the user for a model before the first message of a new
 * conversation when opencodePlus.model names none: OpenCode gives every new session a default model of its own, which may
 * not be one the user wants. The chat page hears of the choice through a { type: 'ui.model', model } event, which
 * src/ui/view-model.js reduces. Everything else passes through.
 */

/*
 * deps:
 *   needsChoice        whether the first message waits for the user to pick a model
 *   choose()           Promise of the picked ModelInfo, or null when the user dismissed the picker
 *   tell(text)         says why a message was not sent
 */
function withModelChoice(inner, deps) {
  const listeners = new Set();
  const emit = (ev) => { for (const fn of [...listeners]) { try { fn(ev); } catch (_) { /* the others still run */ } } };
  const raw = inner.on((ev) => emit(ev));
  const unsubscribe = typeof raw === 'function' ? raw : () => { if (raw && typeof raw.dispose === 'function') raw.dispose(); };
  let chosen = null;
  let pending = deps.needsChoice === true;
  let choosing = null;

  function setModel(model) {
    pending = false;
    chosen = model;
    const r = inner.setModel(model);
    emit({ type: 'ui.model', model });
    return r;
  }

  async function ensureModel() {
    if (!pending) return true;
    if (!choosing) {
      choosing = Promise.resolve().then(() => deps.choose()).then(async (m) => {
        if (m && pending) await setModel(m);
        return !pending;
      }).finally(() => { choosing = null; });
    }
    return choosing;
  }

  const pass = (name) => (...a) => (typeof inner[name] === 'function' ? inner[name](...a) : undefined);
  const facade = {
    get id() { return inner.id; },
    get cwd() { return inner.cwd; },
    get title() { return inner.title; },
    get status() { return inner.status; },
    get waitingTool() { return inner.waitingTool; },
    get lastUserAt() { return inner.lastUserAt; },
    get lastReplyAt() { return inner.lastReplyAt; },
    get model() { return chosen; },
    /* The name of the model the session uses, as <provider>/<model>; '' when not known. */
    get modelName() {
      if (chosen) return chosen.id;
      try { return typeof inner.getModel === 'function' ? String(inner.getModel() || '') : ''; } catch (_) { return ''; }
    },
    get needsChoice() { return pending; },
    on(fn) {
      listeners.add(fn);
      const off = () => { listeners.delete(fn); };
      off.dispose = off;
      return off;
    },
    async send(text, images) {
      let ok;
      try { ok = await ensureModel(); } catch (e) {
        deps.tell(`The message was not sent: the models could not be listed (${(e && e.message) || e}).`);
        return undefined;
      }
      if (!ok) { deps.tell('The message was not sent: choose a model first.'); return undefined; }
      return inner.send(text, images);
    },
    abort: pass('abort'),
    setModel,
    getModel: () => facade.modelName,
    options: () => (typeof inner.options === 'function' ? inner.options() : []),
    setOption(optionId, value) {
      if (typeof inner.setOption !== 'function') return Promise.reject(new Error('This agent has no settings for a conversation.'));
      return Promise.resolve().then(() => inner.setOption(optionId, value));
    },
    respond(requestId, decision) {
      if (typeof inner.respondPermission === 'function') return inner.respondPermission(requestId, decision);
      return typeof inner.respond === 'function' ? inner.respond(requestId, decision) : false;
    },
    respondPermission(requestId, decision) { return facade.respond(requestId, decision); },
    history: () => (typeof inner.history === 'function' ? inner.history() : []),
    dispose() {
      unsubscribe();
      listeners.clear();
      if (typeof inner.dispose === 'function') inner.dispose();
    },
  };
  return facade;
}

module.exports = { withModelChoice };
