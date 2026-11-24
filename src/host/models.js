// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The models of the providers the backend has connected, and which one a new conversation gets: newAgent.model, else
 * the backend's default, else the one the user picks from the list (saved to newAgent.model). A model is named
 * <providerId>/<id> in the setting, as OpenCode names it; a bare id also matches.
 */
const brand = require('../brand');

const SECTION = brand.prefix;
const fullId = (m) => (m.providerId ? `${m.providerId}/${m.id}` : m.id);
const matches = (m, name) => !!name && (fullId(m) === name || m.id === name || m.invokeId === name);

/*
 * deps:
 *   vscode
 *   listModels()      Promise<ModelInfo[]>
 *   defaultModel()    optional: Promise of a ModelInfo or a model name, or null
 */
function createModels({ vscode, listModels, defaultModel }) {
  let pending = null;
  let last = [];

  function list() {
    if (pending) return pending;
    const p = Promise.resolve().then(() => listModels());
    pending = p;
    p.then((l) => { if (Array.isArray(l)) last = l; }, () => {});
    /* Fetched again on the next call after a failure, and after a minute in any case: providers get connected. */
    const forget = () => { setTimeout(() => { if (pending === p) pending = null; }, 60000).unref?.(); };
    p.then(forget, () => { if (pending === p) pending = null; });
    return p;
  }

  const setting = () => String(vscode.workspace.getConfiguration(SECTION).get('model') || '').trim();

  async function pick(placeHolder) {
    const l = await list();
    if (!l.length) {
      vscode.window.showWarningMessage('No model provider is connected. Connect one in OpenCode (opencode auth login), then try again.');
      return null;
    }
    const items = l.map((m) => ({
      label: m.name || m.id,
      description: fullId(m),
      detail: [m.vendor || m.providerId, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : ''].filter(Boolean).join(' · '),
      model: m,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Choose a model', placeHolder: placeHolder || 'Model for new conversations', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
    if (!picked) return null;
    await vscode.workspace.getConfiguration(SECTION).update('model', fullId(picked.model), vscode.ConfigurationTarget.Global);
    return picked.model;
  }

  async function byName(name) {
    if (!name) return null;
    return (await list()).find((m) => matches(m, name)) || null;
  }

  async function forNew() {
    const named = setting();
    if (named) {
      const m = await byName(named);
      if (m) return m;
      return pick(`${named} is not among the connected models; choose another`);
    }
    if (typeof defaultModel === 'function') {
      let d = null;
      try { d = await defaultModel(); } catch (_) { d = null; }
      if (d && typeof d === 'object') return d;
      if (typeof d === 'string' && d) { const m = await byName(d); if (m) return m; }
    }
    return pick();
  }

  return {
    list,
    pick,
    byName,
    forNew,
    /* From the last list fetched, without fetching. */
    cached: (name) => last.find((m) => matches(m, name)) || null,
    fullId,
  };
}

module.exports = { createModels, fullId };
