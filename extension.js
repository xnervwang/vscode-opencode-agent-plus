// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation registers the commands, the Conversations view, the chat editor and the listeners, and nothing more: the
 * agent (OpenCode, through src/host/backend.js and src/opencode/) starts when the first conversation or the
 * Conversations view needs it, and a conversation's history is read when its tab opens.
 *
 *   src/host/chat-editor.js       a chat tab is the custom editor opencodePlus.chat of opencodeplus-session:/<session id>
 *   src/host/session-manager.js   the conversations open in this window, one window each (src/host/locks.js)
 *   src/host/provider-config.js   the settings OpenCode starts with, the Bedrock API key
 *   src/host/models.js            the models OpenCode offers, and the picker
 *   src/host/agentplus-source.js  the conversations as a source of Agent Plus
 *   src/host/work-plan.js         the work plan plugin OpenCode loads, its Python, and the token mode's switches for it
 *
 * OPENCODE_PLUS_TEST_BACKEND, an absolute path to a module shaped like src/opencode/index.js, stands in for OpenCode in
 * the window tests; OPENCODE_PLUS_TEST_CONTROL makes activate() return a few internals for them.
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
const { createProviderConfig } = require('./src/host/provider-config');
const { historyFor } = require('./src/host/history');
const { ChatEditorProvider } = require('./src/host/chat-editor');
const { logoFiles } = require('./src/host/logo');
const ap = require('./src/host/agentplus-source');
const { createWorkPlan } = require('./src/host/work-plan');
const workplan = require('./src/workplan');

const CONTEXT_AGENT_PLUS = `${brand.prefix}.agentPlus`;
const TAKE_OVER = 'Take over here';
const TAKE_ANYWAY = 'Take over anyway';
const BUSY_TEXT = 'Another VS Code window has this conversation open, or had it open before it lost its connection '
  + '(VS Code keeps such a window running for a while). Take it over to continue here: the other window stops its turn '
  + 'and closes the conversation.';
const FORCE_TEXT = 'The other window did not let go of the conversation within 10 seconds. Take it over anyway? '
  + 'If that window is still running, both windows may change the conversation at the same time.';
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
  /* What this window told the user, for the window tests. */
  const told = [];
  const tell = (text) => {
    told.push(String(text));
    if (told.length > 50) told.shift();
    Promise.resolve(vscode.window.showInformationMessage(text)).catch(() => {});
  };
  /* The same with buttons; resolves with the one chosen, or undefined. */
  const ask = (text, ...buttons) => {
    told.push(String(text));
    if (told.length > 50) told.shift();
    return Promise.resolve(vscode.window.showInformationMessage(text, ...buttons)).catch(() => undefined);
  };
  /* OpenCode's own errors (not installed, not found where the settings say) already say what to do. */
  const fail = (what, e) => {
    const own = e && (e.name === 'OpenCodeError' || e.code === 'notFound' || e.code === 'configuredNotFound');
    const text = own ? e.message : `${what}: ${(e && e.message) || e}`;
    log(text);
    Promise.resolve(vscode.window.showErrorMessage(text)).catch(() => {});
  };
  const named = () => String(vscode.workspace.getConfiguration(brand.prefix).get('model') || '').trim();

  /* The plugin and its scripts are copied before OpenCode can first start, which is on first use. */
  const plan = createWorkPlan({ vscode, extensionPath: context.extensionPath, storage: context.globalStorageUri.fsPath, memo: context.workspaceState, tell, log });
  subs.push(plan);
  plan.start().catch((e) => log(`work plan: ${(e && e.message) || e}`));

  let backend = null;
  const settings = createProviderConfig({ vscode, secrets: context.secrets, restart: (o) => backend.restart(plan.launch(o)), log });
  subs.push(settings);
  backend = createBackend({ options: () => ({ ...plan.launch(settings.options()), root: paths.root(), log }) });
  /* Once OpenCode has started here its version is known; OpenCode 1 keeps no work plan, which is said once. */
  let versionKnown = false;
  const noteVersion = () => {
    if (versionKnown) return;
    versionKnown = true;
    Promise.resolve().then(() => backend.detect()).then((found) => plan.checkVersion(found.version), () => { versionKnown = false; });
  };
  const models = createModels({ vscode, listModels: () => backend.listModels(), defaultModel: () => backend.defaultModel() });
  const locks = createLocks({ dir: path.join(paths.root(), 'locks'), log });
  subs.push(locks);
  /* Sessions this window just made, handed to the chat tab that opens them; folders of listed ones, for openSession. */
  const made = new Map();
  const folders = new Map();

  /* A turn refused for Bedrock credentials: OpenCode's way to fix it, at most once a minute. */
  let toldAuth = 0;
  const onAuth = (ev) => {
    if (!ev || ev.type !== 'turnEnd' || !ev.error || ev.error.kind !== 'auth' || Date.now() - toldAuth < 60000) return;
    toldAuth = Date.now();
    backend.bedrockStatus().then((status) => {
      if (status && status.state === 'authFailed') return settings.show(settings.describe({ status, models: [] }));
      return undefined;
    }).catch(() => {});
  };

  let manager = null;
  manager = createSessionManager({
    locks,
    makeConversation: async ({ id }) => {
      const inner = made.get(id) || await backend.session(id, folders.has(id) ? { cwd: folders.get(id) } : {});
      made.delete(id);
      noteVersion();
      let events = [];
      try { events = await inner.history(); } catch (e) { log(`history of ${id}: ${(e && e.message) || e}`); }
      /* The model list too: a restored reply's context share needs the model's window when it is drawn. */
      await models.list().catch(() => null);
      const conv = withModelChoice(inner, {
        needsChoice: !named() && !(Array.isArray(events) && events.length),
        choose: () => models.pick(),
        tell,
      });
      conv.saved = historyFor(events);
      conv.on(onAuth);
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
    /* The model as the list names it, or a stand-in of the same id until the list has it. */
    const infoOf = (name) => (name ? models.cached(name) || { id: name, providerId: name.includes('/') ? name.split('/')[0] : '', name, contextWindow: 0 } : undefined);
    const chat = new ChatPanel({
      panel,
      extensionUri: context.extensionUri,
      conversation: conv,
      listModels: () => models.list(),
      respond: (requestId, decision) => conv.respond(requestId, decision),
      history: conv.saved ? conv.saved.records : [],
      model: conv.model || infoOf(conv.modelName),
      modelInfo: (providerId, modelId) => models.cached(providerId ? `${providerId}/${modelId}` : modelId) || models.cached(modelId),
      vscode,
    });
    for (const ev of (conv.saved && conv.saved.events) || []) chat.dispatch(ev);
    /* The model a turn runs on (turnStart.modelId), and its context window once OpenCode has learned it, which is
       after the model's first call. */
    const follow = (name) => {
      const m = infoOf(name);
      const at = chat.state && chat.state.model;
      if (m && (!at || at.id !== m.id || (m.contextWindow && at.contextWindow !== m.contextWindow))) chat.dispatch({ type: 'ui.model', model: m });
    };
    const off = conv.on((ev) => {
      if (ev && ev.type === 'turnStart' && typeof ev.modelId === 'string' && ev.modelId) follow(ev.modelId);
      if (ev && ev.type === 'turnEnd') models.list().then(() => follow(conv.modelName), () => {});
    });
    panel.onDidDispose(() => off());
    return chat;
  }

  /*
   * Another window holds it: offers to take it over, asks that window to let go, and when it does not answer in time
   * offers to take it anyway. True once this window may open it.
   */
  async function takeOver(id) {
    const choice = await ask(BUSY_TEXT, TAKE_OVER);
    if (choice !== TAKE_OVER) return false;
    const r = await locks.requestTakeover(id);
    log(`taking over ${id}: ${r}`);
    if (r !== 'timeout') return true;
    const force = await Promise.resolve(vscode.window.showWarningMessage(FORCE_TEXT, { modal: true }, TAKE_ANYWAY)).catch(() => undefined);
    if (force !== TAKE_ANYWAY) return false;
    const lock = locks.acquire(id, { force: true });
    if (!lock.ok) fail('The conversation could not be taken over', lock.error || 'the lock kept changing');
    return lock.ok;
  }
  /* The holder's side: the conversation stops here and its tabs go, also in a window whose client has gone. */
  locks.onTakeover((id) => {
    const e = manager.get(id);
    const panels = e ? [...e.panels] : [];
    manager.close(id, { abort: true });
    for (const p of panels) { try { p.dispose(); } catch (_) { /* gone */ } }
    tell('This conversation was taken over by another VS Code window.');
  });

  /* Its tab here to the front, or a new tab; false when another window has it open and keeps it. */
  async function openSession(id) {
    const panel = manager.panelOf(id);
    if (panel) { panel.reveal(panel.viewColumn); return true; }
    if (locks.holder(id) && !(await takeOver(id))) return false;
    await vscode.commands.executeCommand('vscode.openWith', ap.uriOf(id), ap.VIEW_TYPE, { preview: false });
    return true;
  }

  async function newConversation() {
    let s;
    const model = named();
    try { s = await backend.createSession(folder(), model ? { model } : {}); } catch (e) { fail('A new conversation could not be started', e); return false; }
    if (!s || !s.id) { fail('A new conversation could not be started', 'OpenCode gave no session'); return false; }
    noteVersion();
    made.set(s.id, s);
    return openSession(s.id);
  }

  const chatTabs = (id) => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    .filter((t) => ap.isChatTab(t) && ap.sessionOfUri(t.input.uri) === id);

  let link = null;
  const editor = new ChatEditorProvider({
    manager,
    show,
    focus: (id) => { if (link) link.focus(id); },
    busy: (id) => takeOver(id),
    log,
  });
  subs.push(vscode.window.registerCustomEditorProvider(ap.VIEW_TYPE, editor, { supportsMultipleEditorsPerDocument: false }));

  /* The Conversations view: the sessions of this window's folders, redrawn when one here or OpenCode's list changes. */
  const inScope = (cwd) => {
    const f = (vscode.workspace.workspaceFolders || []).filter((x) => x.uri.scheme === 'file').map((x) => x.uri.fsPath);
    if (!f.length) return true;
    return f.some((root) => cwd === root || String(cwd).startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  };
  const listed = createSessionsList({
    backend: {
      ...backend,
      listSessions: () => backend.listSessions().then((rows) => {
        for (const r of rows) if (r.cwd) folders.set(r.id, r.cwd);
        return rows.filter((r) => inScope(r.cwd));
      }),
      /* Its plan goes with it: Agent Plus only reads the plans folder. */
      deleteSession: (id) => backend.deleteSession(id).then(() => {
        const gone = workplan.removePlan(id);
        if (gone.length) log(`deleted the plan files of ${id}: ${gone.join(', ')}`);
      }),
    },
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
    listSessions: () => listed.list().catch((e) => { if (e && e.name === 'OpenCodeError') throw new Error(e.message); throw e; }).finally(() => backend.listen()),
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
    vscode.commands.registerCommand(`${brand.prefix}.setBedrockApiKey`, () => settings.setApiKey()),
    vscode.commands.registerCommand(`${brand.prefix}.clearBedrockApiKey`, () => settings.clearApiKey()),
    vscode.commands.registerCommand(`${brand.prefix}.testConnection`, async () => {
      let found = null;
      try { found = await backend.detect(); } catch (e) { return settings.show(settings.describe({ error: e })); }
      plan.checkVersion(found.version);
      try {
        const [list, status] = await Promise.all([models.list(), backend.bedrockStatus()]);
        return settings.show(settings.describe({ status, models: list, found }));
      } catch (e) { return fail('OpenCode could not be asked', e); }
    }),
  );

  /* Agent Plus. Without it, or refused by it, everything above works the same. */
  let logo;
  link = ap.createAgentPlusSource({
    manager,
    planDir: () => workplan.planDir(),
    planPath: (id) => workplan.planPath(id),
    brief: () => plan.brief(),
    planNotice: () => plan.planNotice(),
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
    hidden: (id) => backend.isChild(id),
    log,
  });
  subs.push(link, manager.onDidChange(() => link.changed()), plan.onDidChangeNotice(() => link.noticeChanged()));
  /* The token mode decides whether the conversations keep a brief, which Agent Plus reads with their list. */
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('agentPlus.tokenMode')) link.changed(); }));
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

  running = { manager, backend, registration: null };
  log(`activated ${context.extension ? context.extension.packageJSON.version : ''}`.trim());
  if (process.env.OPENCODE_PLUS_TEST_CONTROL) {
    return { test: { agentPlus, registered, conversations: () => manager.list(), sessions: () => listed.list(), isChild: (id) => backend.isChild(id),
      source: link.source, locks: () => locks.held(), settings: () => settings.options(), ready: settings.ready,
      told: () => told.slice(), plan: () => ({ values: plan.values(), python: plan.python, notice: plan.planNotice(), dir: workplan.planDir(), launch: plan.launch(settings.options()).env }) } };
  }
  return undefined;
}

/* Running turns are stopped: a window going away should not leave a turn waiting for an answer nobody can give. VS Code
   waits for the promise, so OpenCode's process is gone with the window. */
function deactivate() {
  if (!running) return undefined;
  const { manager, backend, registration } = running;
  running = null;
  try { manager.disposeAll({ abort: true }); } catch (_) { /* the window is going anyway */ }
  try { if (registration) registration.dispose(); } catch (_) { /* Agent Plus is going too */ }
  return backend.dispose();
}

module.exports = { activate, deactivate };
