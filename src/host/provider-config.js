// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The model provider as the settings describe it: newAgent.bedrock.region, .auth and .profile, and newAgent.model for
 * new conversations. An API key lives in VS Code's secret storage only. The provider is built on first use and built
 * again after any of these change; conversations hold `proxy`, which always calls the current one.
 *
 * NEW_AGENT_TEST_PROVIDER, an absolute path to a module exporting createProvider(config), replaces the providers for
 * the window tests.
 */
const brand = require('../brand');

const SECRET_KEY = `${brand.prefix}.bedrock.apiKey`;
const SECTION = brand.prefix;

function createProviderConfig({ vscode, secrets, log = () => {}, loadProviders, env = process.env }) {
  const load = loadProviders || (() => (env.NEW_AGENT_TEST_PROVIDER ? require(env.NEW_AGENT_TEST_PROVIDER) : require('../providers')));
  const listeners = new Set();
  let current = null;
  let models = null;
  let lastModels = [];
  const subs = [];

  const settings = () => {
    const c = vscode.workspace.getConfiguration(SECTION);
    return {
      region: String(c.get('bedrock.region') || 'us-east-1').trim() || 'us-east-1',
      auth: c.get('bedrock.auth') === 'apiKey' ? 'apiKey' : 'credentials',
      profile: String(c.get('bedrock.profile') || '').trim(),
      modelId: String(c.get('model') || '').trim(),
    };
  };

  const reset = (why) => {
    current = null;
    models = null;
    lastModels = [];
    log(`provider settings changed (${why}); the provider is built again on next use`);
    for (const fn of [...listeners]) { try { fn(); } catch (_) { /* the others still run */ } }
  };

  function provider() {
    if (current) return current;
    const s = settings();
    const auth = s.auth === 'apiKey'
      ? { mode: 'apiKey', getKey: async () => {
        const key = await secrets.get(SECRET_KEY);
        if (!key) throw new Error(`No Amazon Bedrock API key is set. Run "${brand.displayName}: Set Amazon Bedrock API Key".`);
        return key;
      } }
      : (s.profile ? { mode: 'credentials', profile: s.profile } : { mode: 'credentials' });
    const { createProvider } = load();
    current = createProvider({ providerId: 'bedrock', region: s.region, auth, logger: { log, info: log, warn: log, error: log, debug: () => {} } });
    return current;
  }

  /* The current provider's models, fetched once per provider. */
  function listModels(signal) {
    if (models) return models;
    const p = Promise.resolve().then(() => provider().listModels(signal));
    models = p;
    p.then((list) => { if (models === p && Array.isArray(list)) lastModels = list; }, () => { if (models === p) models = null; });
    return p;
  }

  const proxy = {
    get id() { return current ? current.id : 'bedrock'; },
    get label() { return current ? current.label : 'Amazon Bedrock'; },
    checkAuth: (signal) => provider().checkAuth(signal),
    listModels: (signal) => listModels(signal),
    stream: (req, signal) => provider().stream(req, signal),
  };

  const describe = (s) => `${s.region}, ${s.auth === 'apiKey' ? 'API key' : s.profile ? `profile ${s.profile}` : 'default credentials'}`;

  /* Asks the user for a model; saves it as newAgent.model. Resolves to the ModelInfo, or null when dismissed. */
  async function pickModel(placeHolder) {
    const list = await listModels();
    if (!list.length) { vscode.window.showWarningMessage('Amazon Bedrock lists no models this account can use.'); return null; }
    const items = list.map((m) => ({
      label: m.name || m.id,
      description: m.id,
      detail: [m.vendor, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : '', m.known === false ? 'limits not known' : ''].filter(Boolean).join(' · '),
      model: m,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Choose a model', placeHolder: placeHolder || 'Model for new conversations', matchOnDescription: true, ignoreFocusOut: true });
    if (!picked) return null;
    await vscode.workspace.getConfiguration(SECTION).update('model', picked.model.id, vscode.ConfigurationTarget.Global);
    return picked.model;
  }

  /* The model newAgent.model names, or the one the user picks when it is empty or not listed; null when dismissed. */
  async function modelForNew() {
    const { modelId } = settings();
    if (modelId) {
      const list = await listModels();
      const found = list.find((m) => m.id === modelId || m.invokeId === modelId);
      if (found) return found;
      return pickModel(`${modelId} is not among the models Amazon Bedrock lists here; choose another`);
    }
    return pickModel();
  }

  /* The ModelInfo for an id, from the list; null when it is not listed. */
  async function modelById(id) {
    if (!id) return null;
    const list = await listModels();
    return list.find((m) => m.id === id || m.invokeId === id) || null;
  }

  async function testConnection() {
    const s = settings();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing Amazon Bedrock (${describe(s)})` }, async () => {
      let auth;
      try { auth = await provider().checkAuth(); } catch (e) { auth = { ok: false, detail: String((e && e.message) || e) }; }
      if (!auth || !auth.ok) {
        vscode.window.showErrorMessage(`Amazon Bedrock (${describe(s)}): ${(auth && auth.detail) || 'sign-in failed'}`);
        return { ok: false, detail: (auth && auth.detail) || '' };
      }
      let list;
      try { list = await listModels(); } catch (e) {
        vscode.window.showErrorMessage(`Signed in to Amazon Bedrock (${describe(s)}), but listing models failed: ${(e && e.message) || e}`);
        return { ok: false, detail: String((e && e.message) || e) };
      }
      const missing = s.modelId && !list.some((m) => m.id === s.modelId || m.invokeId === s.modelId);
      const text = `Connected to Amazon Bedrock (${describe(s)}): ${list.length} models available${missing ? `, but not ${s.modelId}` : ''}.`;
      (missing ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(text);
      return { ok: true, detail: text, count: list.length };
    });
  }

  async function setApiKey() {
    const key = await vscode.window.showInputBox({
      title: 'Amazon Bedrock API key',
      prompt: 'Paste an Amazon Bedrock API key. It is kept in VS Code secret storage on this machine.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (String(v || '').trim() ? null : 'Enter a key.'),
    });
    if (!key || !key.trim()) return false;
    await secrets.store(SECRET_KEY, key.trim());
    if (settings().auth !== 'apiKey') {
      const use = 'Use the API key';
      const pick = await vscode.window.showInformationMessage('The Amazon Bedrock API key is saved. Sign-in still uses AWS credentials.', use);
      if (pick === use) await vscode.workspace.getConfiguration(SECTION).update('bedrock.auth', 'apiKey', vscode.ConfigurationTarget.Global);
    } else {
      vscode.window.showInformationMessage('The Amazon Bedrock API key is saved.');
    }
    return true;
  }

  async function clearApiKey() {
    await secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('The Amazon Bedrock API key is removed from this machine.');
  }

  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${SECTION}.bedrock`)) reset('settings');
  }));
  if (secrets && typeof secrets.onDidChange === 'function') {
    subs.push(secrets.onDidChange((e) => { if (e && e.key === SECRET_KEY) reset('API key'); }));
  }

  return {
    proxy,
    provider,
    settings,
    listModels,
    /* From the last list fetched, without fetching; null when it is not there. */
    cachedModel: (id) => lastModels.find((m) => m.id === id || m.invokeId === id) || null,
    pickModel,
    modelForNew,
    modelById,
    testConnection,
    setApiKey,
    clearApiKey,
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    dispose() { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } listeners.clear(); },
  };
}

module.exports = { createProviderConfig, SECRET_KEY };
