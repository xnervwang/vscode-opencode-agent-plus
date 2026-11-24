// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation registers the commands, the Conversations view, the chat editor and the listeners, and nothing more: the
 * agent backend (src/host/backend.js, OpenCode's server behind it) starts when the first conversation or the
 * Conversations view needs it, and a conversation's history is read when its tab opens.
 *
 *   src/host/chat-editor.js       a chat tab is the custom editor newAgent.chat of newagent-session:/<session id>
 *   src/host/session-manager.js   the conversations open in this window, one window each (src/host/locks.js)
 *   src/host/models.js            the connected models and the one a new conversation gets
 *   src/host/agentplus-source.js  the conversations as a source of Agent Plus
 *
 * NEW_AGENT_TEST_BACKEND, an absolute path to a module shaped like src/opencode/index.js, stands in for the agent in
 * the window tests; NEW_AGENT_TEST_CONTROL makes activate() return a few internals for them.
 */
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const brand = require('./src/brand');
const paths = require('./src/paths');
const { createLocks } = require('./src/host/locks');
const { createSessionManager } = require('./src/host/session-manager');
const { createBackend } = require('./src/host/backend');
const { createModels } = require('./src/host/models');
const { withModelChoice } = require('./src/host/model-choice');
const { createSessionsList } = require('./src/host/sessions-list');
const { historyFor } = require('./src/host/history');
const { ChatEditorProvider } = require('./src/host/chat-editor');
const { logoFiles } = require('./src/host/logo');
const ap = require('./src/host/agentplus-source');

const CONTEXT_AGENT_PLUS = `${brand.prefix}.agentPlus`;
let running = null;

function activate(context) {
  const channel = vscode.window.createOutputChannel(brand.displayName, { log: true });
  const log = (line) => channel.info(String(line));
  const subs = context.subscriptions;
  subs.push(channel);

  const folder = () => {
    const f = vscode.workspace.workspaceFolders;
    return f && f.length && f[0].uri.scheme === 'file' ? f[0].uri.fsPath : os.homedir();
  };
  const tell = (text) => { Promise.resolve(vscode.window.showInformationMessage(text)).catch(() => {}); };
  const fail = (what, e) => {
    const text = `${what}: ${(e && e.message) || e}`;
    log(text);
    Promise.resolve(vscode.window.showErrorMessage(text)).catch(() => {});
  };

  const backend = createBackend({ options: { log, storageDir: context.globalStorageUri.fsPath, extensionPath: context.extensionPath } });
  subs.push(backend);
  const models = createModels({ vscode, listModels: () => backend.listModels(), defaultModel: () => backend.defaultModel() });
  const locks = createLocks({ dir: path.join(paths.root(), 'locks') });

  let manager = null;
  manager = createSessionManager({
    locks,
    info: async (id) => (await backend.listSessions()).find((s) => s.id === id) || null,
    makeConversation: async ({ id }) => {
      /* The model list first, briefly: a restored reply's context share needs the model's window when it is drawn. */
      await Promise.race([models.list().catch(() => null), new Promise((r) => setTimeout(r, 3000).unref?.())]);
      const inner = await backend.session(id);
      const conv = withModelChoice(inner, { modelById: (name) => models.byName(name), modelForNew: () => models.forNew(), tell, log });
      try { conv.saved = historyFor(await conv.history()); } catch (e) { log(`history of ${id}: ${(e && e.message) || e}`); conv.saved = { records: [], events: [] }; }
      return conv;
    },
    isLooking: (id) => {
      const p = manager.panelOf(id);
      return !!p && p.active && p.visible && vscode.window.state.focused;
    },
    log,
  });
  subs.push(manager);

  function show(panel, entry) {
    const { ChatPanel } = require('./src/ui/chat-panel');
    const conv = entry.conversation;
    const shown = conv.shownModelId || String(vscode.workspace.getConfiguration(brand.prefix).get('model') || '');
    /* Until the model list is in, a stand-in named as the list will name it, so the page's selector matches it later. */
    const standIn = shown ? { id: shown.split('/').pop(), providerId: shown.includes('/') ? shown.split('/')[0] : '', name: shown, contextWindow: 0 } : undefined;
    const chat = new ChatPanel({
      panel,
      extensionUri: context.extensionUri,
      conversation: conv,
      listModels: () => models.list(),
      respond: (requestId, decision) => conv.respond(requestId, decision),
      history: conv.saved ? conv.saved.records : [],
      model: conv.model || (shown ? models.cached(shown) || standIn : undefined),
      modelInfo: (providerId, modelId) => models.cached(providerId ? `${providerId}/${modelId}` : modelId) || models.cached(modelId),
      vscode,
    });
    for (const ev of (conv.saved && conv.saved.events) || []) chat.dispatch(ev);
    if (!conv.model && shown && !models.cached(shown)) {
      models.byName(shown).then((m) => { if (m && !conv.model) chat.dispatch({ type: 'ui.model', model: m }); }, () => {});
    }
    return chat;
  }

  /* Its tab here to the front, or a new tab; false when another window has it open. */
  async function openSession(id) {
    const panel = manager.panelOf(id);
    if (panel) { panel.reveal(panel.viewColumn); return true; }
    if (locks.holder(id)) { tell('This conversation is open in another VS Code window.'); return false; }
    await vscode.commands.executeCommand('vscode.openWith', ap.uriOf(id), ap.VIEW_TYPE, { preview: false });
    return true;
  }

  async function newConversation() {
    let info;
    try { info = await backend.createSession(folder()); } catch (e) { fail('A new conversation could not be started', e); return false; }
    if (!info) { fail('A new conversation could not be started', 'the agent gave no session'); return false; }
    return openSession(info.id);
  }

  const chatTabs = (id) => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    .filter((t) => ap.isChatTab(t) && ap.sessionOfUri(t.input.uri) === id);

  let link = null;
  const editor = new ChatEditorProvider({
    manager,
    show,
    focus: (id) => { if (link) link.focus(id); },
    busy: () => tell('This conversation is open in another VS Code window. Close it there to continue it here.'),
    log,
  });
  subs.push(vscode.window.registerCustomEditorProvider(ap.VIEW_TYPE, editor, { supportsMultipleEditorsPerDocument: false }));

  /* The Conversations view, redrawn when a conversation here or the backend's list changes. */
  const listed = createSessionsList({
    backend,
    manager,
    holder: (id) => locks.holder(id),
    closeTabs: async (id) => { const tabs = chatTabs(id); if (tabs.length) await vscode.window.tabGroups.close(tabs); },
  });
  const listChanged = new vscode.EventEmitter();
  let soon = null;
  const nudge = () => { if (!soon) soon = setTimeout(() => { soon = null; listChanged.fire(); }, 200); };
  subs.push(listChanged, { dispose: () => clearTimeout(soon) }, manager.onDidChange(nudge), backend.onDidChangeSessions(nudge));
  const { SessionsView } = require('./src/ui/sessions-view');
  const sessionsView = new SessionsView({
    listSessions: () => listed.list().finally(() => backend.listen()),
    onDidChange: (fn) => listChanged.event(fn),
    statusOf: (meta) => listed.statusOf(meta),
    rename: (id, title) => listed.rename(id, title),
    remove: (id) => listed.remove(id),
    vscode,
  });
  subs.push(sessionsView.register(), sessionsView);

  subs.push(
    vscode.commands.registerCommand(`${brand.prefix}.newConversation`, () => newConversation()),
    vscode.commands.registerCommand(`${brand.prefix}.openConversation`, (arg) => {
      const id = typeof arg === 'string' ? arg : arg && arg.id;
      return id ? openSession(id) : false;
    }),
    vscode.commands.registerCommand(`${brand.prefix}.chooseModel`, () => models.pick().catch((e) => fail('The models could not be listed', e))),
    vscode.commands.registerCommand(`${brand.prefix}.testConnection`, async () => {
      try {
        const l = await models.list();
        const providers = [...new Set(l.map((m) => m.providerId).filter(Boolean))];
        if (!l.length) vscode.window.showWarningMessage('The agent is running, but no model provider is connected. Connect one in OpenCode (opencode auth login).');
        else vscode.window.showInformationMessage(`Connected: ${l.length} models from ${providers.join(', ') || 'one provider'}.`);
      } catch (e) { fail('The agent could not be reached', e); }
    }),
  );

  /* Agent Plus. Without it, or refused by it, everything above works the same. */
  let logo;
  link = ap.createAgentPlusSource({
    manager,
    planDir: () => paths.plansDir(),
    logo: () => {
      if (logo === undefined) {
        const files = logoFiles(context.extensionPath, context.globalStorageUri.fsPath);
        logo = files ? { light: vscode.Uri.file(files.light), dark: vscode.Uri.file(files.dark) } : null;
      }
      return logo;
    },
    reveal: async (id) => { const p = manager.panelOf(id); if (!p) return false; p.reveal(p.viewColumn); return true; },
    openHere: (id) => openSession(id),
    trusted: () => vscode.workspace.isTrusted,
    log,
  });
  subs.push(link, manager.onDidChange(() => link.changed()));
  const activeTab = () => { const g = vscode.window.tabGroups.activeTabGroup; return g ? g.activeTab : undefined; };
  subs.push(vscode.window.tabGroups.onDidChangeTabs(() => link.tabsChanged(activeTab())));
  const agentPlus = { accepted: false, code: 'pending', reason: '' };
  const registered = ap.register(link.source, { log }).then((r) => {
    Object.assign(agentPlus, { accepted: r.accepted, code: r.code, reason: r.reason });
    if (r.registration) {
      if (running) running.registration = r.registration; else r.registration.dispose();
      link.refocus();
    }
    return vscode.commands.executeCommand('setContext', CONTEXT_AGENT_PLUS, r.accepted);
  }).catch((e) => log(`Agent Plus registration failed: ${(e && e.message) || e}`));

  running = { manager, registration: null };
  log(`activated ${context.extension ? context.extension.packageJSON.version : ''}`.trim());
  if (process.env.NEW_AGENT_TEST_CONTROL) {
    return { test: { agentPlus, registered, conversations: () => manager.list(), source: link.source, locks: () => locks.held() } };
  }
  return undefined;
}

/* Running turns are stopped: a window going away should not leave a turn waiting for an answer nobody can give. */
function deactivate() {
  if (!running) return;
  const { manager, registration } = running;
  running = null;
  try { manager.disposeAll({ abort: true }); } catch (_) { /* the window is going anyway */ }
  try { if (registration) registration.dispose(); } catch (_) { /* Agent Plus is going too */ }
}

module.exports = { activate, deactivate };
