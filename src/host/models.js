// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The models of the providers OpenCode has connected, and the picker for them. A model is named <provider>/<model> in
 * opencodePlus.model, as OpenCode names it (OpenCode's ModelInfo.id already has that form); the model part alone also
 * matches. The list comes from the backend each time: OpenCode keeps it, and learns a model's context window once the
 * model has been used.
 */
const brand = require('../brand');

const SECTION = brand.prefix;
const fullId = (m) => (String(m.id).includes('/') || !m.providerId ? m.id : `${m.providerId}/${m.id}`);
const matches = (m, name) => !!name && (fullId(m) === name || m.id === name || m.invokeId === name);

/*
 * deps:
 *   vscode
 *   listModels()      Promise<ModelInfo[]>
 *   defaultModel()    optional: Promise of a ModelInfo or a model name, or null
 */
function createModels({ vscode, listModels, defaultModel }) {
  let last = [];

  function list() {
    const p = Promise.resolve().then(() => listModels());
    p.then((l) => { if (Array.isArray(l)) last = l; }, () => {});
    return p;
  }

  const setting = () => String(vscode.workspace.getConfiguration(SECTION).get('model') || '').trim();

  async function pick(placeHolder) {
    const l = await list();
    if (!l.length) {
      vscode.window.showWarningMessage('OpenCode has not listed any models yet. Open a conversation once, or connect a provider in OpenCode (opencode auth login), then try again.');
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
