// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A backend session object (src/host/backend.js) that gets a model before its first message: the one it was last
 * used with, else the one src/host/models.js gives a new conversation. The chat page hears of the model through a
 * { type: 'ui.model', model } event, which src/ui/view-model.js reduces. Everything else passes through.
 */

/*
 * deps:
 *   modelById(name)    Promise of the connected model of that name, or null
 *   modelForNew()      Promise of the configured, default or picked model, or null when the user dismissed the picker
 *   tell(text)         says why a message was not sent
 *   log(line)          optional
 */
function withModelChoice(inner, deps) {
  const listeners = new Set();
  const emit = (ev) => { for (const fn of [...listeners]) { try { fn(ev); } catch (_) { /* the others still run */ } } };
  const raw = inner.on((ev) => emit(ev));
  const unsubscribe = typeof raw === 'function' ? raw : () => { if (raw && typeof raw.dispose === 'function') raw.dispose(); };
  let current = inner.model || null;
  let choosing = null;
  const savedId = () => {
    const v = (inner.loaded && inner.loaded.modelId) || inner.modelId || '';
    return typeof v === 'string' ? v : '';
  };

  function setModel(model) {
    current = model;
    inner.setModel(model);
    emit({ type: 'ui.model', model });
  }

  function ensureModel() {
    if (current) return Promise.resolve(current);
    if (!choosing) {
      choosing = (async () => {
        let m = null;
        if (savedId()) { try { m = await deps.modelById(savedId()); } catch (_) { m = null; } }
        if (!m) m = await deps.modelForNew();
        if (m && !current) setModel(m);
        return current;
      })().finally(() => { choosing = null; });
    }
    return choosing;
  }

  const facade = {
    get model() { return current; },
    get loaded() { return inner.loaded || null; },
    get sessionId() { return inner.sessionId; },
    /* The id of the model the page should show before one is chosen. */
    get shownModelId() { return current ? current.id : savedId(); },
    on(fn) {
      listeners.add(fn);
      const off = () => { listeners.delete(fn); };
      off.dispose = off;
      return off;
    },
    async send(text, images) {
      let m;
      try { m = await ensureModel(); } catch (e) {
        deps.tell(`The message was not sent: the models could not be listed (${(e && e.message) || e}).`);
        return undefined;
      }
      if (!m) { deps.tell('The message was not sent: choose a model first.'); return undefined; }
      return inner.send(text, images);
    },
    abort: () => inner.abort(),
    setModel,
    respond(requestId, decision) {
      if (typeof inner.respondPermission === 'function') return inner.respondPermission(requestId, decision);
      return typeof inner.respond === 'function' ? inner.respond(requestId, decision) : false;
    },
    history: () => (typeof inner.history === 'function' ? inner.history() : []),
    setTitle: (title) => (typeof inner.setTitle === 'function' ? inner.setTitle(title) : undefined),
    dispose() {
      unsubscribe();
      listeners.clear();
      if (typeof inner.dispose === 'function') inner.dispose();
    },
  };
  return facade;
}

module.exports = { withModelChoice };
