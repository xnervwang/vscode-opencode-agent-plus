// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Lists the models of the providers OpenCode has connected and shows the picker for them. A model is named <provider>/<model> in
 * opencodeAgentPlus.model, the form of OpenCode's ModelInfo.id; the model part alone also matches. The list comes from the backend each time: OpenCode keeps it, and learns a model's context window once the
 * model has been used.
 */
const brand = require('../brand');
const noticeTime = require('../shared/notice-time');

const SECTION = brand.prefix;
const fullId = (m) => (String(m.id).includes('/') || !m.providerId ? m.id : `${m.providerId}/${m.id}`);
const OPENCODE = 'opencode';
const providerOf = (m) => (m && m.providerId) || (String((m && m.id) || '').split('/')[0]) || '';
const MODES = ['auto', 'show', 'hide'];

function visibleModels(list, mode, current) {
  const l = Array.isArray(list) ? list : [];
  const m = MODES.includes(mode) ? mode : 'auto';
  if (m === 'show') return l;
  if (m === 'auto' && !l.some((x) => providerOf(x) !== OPENCODE)) return l;
  return l.filter((x) => providerOf(x) !== OPENCODE || (current && fullId(x) === current));
}

const groupOf = (m) => (providerOf(m) === OPENCODE ? "OpenCode's free models (opencode.ai)" : (m && (m.vendor || m.providerId)) || 'Other');
const matches = (m, name) => !!name && (fullId(m) === name || m.id === name || m.invokeId === name);

/*
 * deps:
 *   vscode
 *   listModels()      Promise<ModelInfo[]>
 *   defaultModel()    optional: Promise of a ModelInfo or a model name, or null
 */
function createModels({ vscode, listModels, defaultModel }) {
  let last = [], listed = false;

  function list() {
    const p = Promise.resolve().then(() => listModels());
    p.then((l) => { if (Array.isArray(l)) { last = l; listed = true; } }, () => {});
    return p;
  }

  const setting = () => String(vscode.workspace.getConfiguration(SECTION).get('model') || '').trim();
  const mode = () => String(vscode.workspace.getConfiguration(SECTION).get('openCodeModels') || 'auto');

  async function pick(placeHolder) {
    const l = visibleModels(await list(), mode(), setting());
    if (!l.length) {
      noticeTime.warning(vscode, 'OpenCode has not listed any models yet. Open a conversation once, or connect a provider in OpenCode (opencode auth login), then try again.');
      return null;
    }
    const groups = new Map();
    for (const m of l) {
      const g = groupOf(m);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    const items = [];
    for (const [g, models] of groups) {
      if (vscode.QuickPickItemKind) items.push({ label: g, kind: vscode.QuickPickItemKind.Separator });
      for (const m of models) {
        items.push({ label: m.name || m.id, description: fullId(m),
          detail: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : undefined, model: m });
      }
    }
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
    /* Uses the last list, without asking OpenCode again. */
    cached: (name) => last.find((m) => matches(m, name)) || null,
    /* Whether a list was read, and how many models it had, without asking OpenCode again. */
    state: () => ({ listed, count: last.length }),
    fullId,
  };
}

module.exports = { createModels, fullId, visibleModels, groupOf };
