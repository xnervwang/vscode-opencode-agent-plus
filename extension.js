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
 *   src/host/file-search.js       the workspace files the chat page's @ list offers
 *   src/host/selection.js         the editor selection the chat page can send along
 *   src/host/plan-bar.js          the plan bar above each chat page's input box, from Agent Plus's summary
 *   src/host/window-states.js     every window's open conversations, for Agent Plus's listAllConversations()
 *   src/host/reply-file.js        each conversation's latest reply beside its plan, for a steward to read
 *   src/host/rewind.js            rewinding a conversation to before one of the user's messages (OpenCode 2)
 *   src/host/reply-images.js      the local images a reply shows, read for the chat page
 *   src/host/conversation-links.js   the conversations a reply names, linked in the chat page
 *   src/host/recent-closed.js     the chat tabs closed in this workspace, for the Recently closed group
 *   src/host/find-conversation.js    finding a conversation by part of its title, id or folder
 *
 * OPENCODE_PLUS_TEST_BACKEND, an absolute path to a module shaped like src/opencode/index.js, stands in for OpenCode in
 * the window tests; OPENCODE_PLUS_TEST_CONTROL makes activate() return a few internals for them.
 */
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const brand = require('./src/brand');
const paths = require('./src/paths');
const { createLocks, windowToken } = require('./src/host/locks');
const { createSessionManager } = require('./src/host/session-manager');
const { createBackend } = require('./src/host/backend');
const { createModels } = require('./src/host/models');
const { withModelChoice } = require('./src/host/model-choice');
const { createSessionsList } = require('./src/host/sessions-list');
const { createProviderConfig } = require('./src/host/provider-config');
const { historyFor } = require('./src/host/history');
const { ChatEditorProvider } = require('./src/host/chat-editor');
const { logoFiles, tabIcons } = require('./src/host/logo');
const marks = require('./src/shared/title-marks');
const envelope = require('./src/shared/envelope');
const ap = require('./src/host/agentplus-source');
const { createWorkPlan } = require('./src/host/work-plan');
const { createFileSearch } = require('./src/host/file-search');
const { createSelectionTracker } = require('./src/host/selection');
const { createPlanBar } = require('./src/host/plan-bar');
const { createWindowStates } = require('./src/host/window-states');
const { createReplyFiles } = require('./src/host/reply-file');
const workplan = require('./src/workplan');
const rewinding = require('./src/host/rewind');
const { loadImage } = require('./src/host/reply-images');
const { createConversationLinks } = require('./src/host/conversation-links');
const { createRecentClosed } = require('./src/host/recent-closed');
const { findConversation } = require('./src/host/find-conversation');
const hookSettings = require('./src/shared/hook-settings');
const tokenMode = require('./src/shared/token-mode');

const CONTEXT_AGENT_PLUS = `${brand.prefix}.agentPlus`;
/* Set once the OpenCode found can rename conversations (2.x); the Rename entries show only then. */
const CONTEXT_RENAME = `${brand.prefix}.canRename`;
const ZONE_KEY = `${brand.prefix}.timeZone`;
/* Set once OpenCode has said it can fork a conversation; the Fork entries show only then. */
const CONTEXT_FORK = `${brand.prefix}.canFork`;
/* Whether the chat pages chime, as the footer's button last left it; on until muted, as in Claude Code Plus. */
const SOUND_KEY = `${brand.prefix}.sound`;
/* The name of this window in the locks it takes (src/host/locks.js windowToken). */
const WINDOW_KEY = `${brand.prefix}.window`;
const REWIND = 'Rewind';
const TAKE_OVER = 'Take over here';
const TAKE_ANYWAY = 'Take over anyway';
const BUSY_TEXT = 'Another VS Code window has this conversation open, or had it open before it lost its connection '
  + '(VS Code keeps such a window running for a while). Take it over to continue here: the other window stops its turn '
  + 'and closes the conversation.';
const FORCE_TEXT = 'The other window did not let go of the conversation within 10 seconds. Take it over anyway? '
  + 'If that window is still running, both windows may change the conversation at the same time.';
let running = null;
/* Conversations whose tabs close for a takeover, which is not the user closing them. */
const quietClose = new Set();

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
  /* Whether the OpenCode found can rename conversations, for the Rename entries; known once the list or a conversation
     has started it. */
  let renameKnown = false;
  const noteRename = () => {
    noteFork();
    if (renameKnown) return;
    renameKnown = true;
    Promise.resolve().then(() => vscode.commands.executeCommand('setContext', CONTEXT_RENAME, backend.canRename())).catch(() => { renameKnown = false; });
  };
  /* Known once OpenCode has started and said what it offers; asked again until then. */
  let forkKnown = false;
  function noteFork() {
    if (forkKnown || !backend.canFork()) return;
    forkKnown = true;
    Promise.resolve(vscode.commands.executeCommand('setContext', CONTEXT_FORK, true)).catch(() => { forkKnown = false; });
  }
  /* Once a conversation has started OpenCode here its version is known; OpenCode 1 keeps no work plan, which is said
     once. */
  let versionKnown = false;
  const noteVersion = () => {
    noteRename();
    if (versionKnown) return;
    versionKnown = true;
    Promise.resolve().then(() => backend.detect()).then((found) => plan.checkVersion(found.version), () => { versionKnown = false; });
  };
  const models = createModels({ vscode, listModels: () => backend.listModels(), defaultModel: () => backend.defaultModel() });
  const locks = createLocks({ dir: path.join(paths.root(), 'locks'), window: windowToken(context.workspaceState, WINDOW_KEY), log });
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

  /* Each conversation's latest reply, beside its plan, for a steward to read. */
  const replies = createReplyFiles({ dir: () => workplan.planDir(), log });
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
      replies.track(id, conv, events);
      return conv;
    },
    isLooking: (id) => {
      const p = manager.panelOf(id);
      return !!p && p.active && p.visible && vscode.window.state.focused;
    },
    log,
  });
  subs.push(manager);

  /* The plan bar of each chat page, fed by Agent Plus once this extension is registered there. */
  const planBar = createPlanBar({
    on: () => vscode.workspace.getConfiguration(brand.prefix).get('planBar', true) !== false,
    run: (command, arg) => vscode.commands.executeCommand(command, arg),
    log,
  });
  subs.push(planBar, vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${brand.prefix}.planBar`)) planBar.settingChanged(); }));

  /* The reader's zone as the last chat page to load reported it; the plugin's time-zone hook reads it from the plans
     folder (client-time-zone.json). */
  const memo = context.globalState && typeof context.globalState.get === 'function' ? context.globalState : null;
  let timeZone = memo ? String(memo.get(ZONE_KEY, '') || '') : '';
  const writeZone = (zone) => {
    if (!zone || vscode.workspace.isTrusted === false) return;
    try { if (hookSettings.writeClientZone(workplan.planDir(), zone)) log(`the reader's time zone for the plugin: ${zone}`); } catch (e) { log(`writing the time zone failed: ${e.message}`); }
  };
  writeZone(timeZone);
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') subs.push(vscode.workspace.onDidGrantWorkspaceTrust(() => writeZone(timeZone)));

  /* The chat pages open in this window, and whether they chime. */
  const chats = new Set();
  let soundOn = memo ? memo.get(SOUND_KEY, true) !== false : true;
  const sound = {
    on: () => soundOn,
    set(on) {
      soundOn = on === true;
      if (memo) Promise.resolve(memo.update(SOUND_KEY, soundOn)).catch(() => {});
      for (const c of chats) c.postSound();
    },
  };

  /* The conversations a reply may name, as links in the chat pages; read only while a page is open. */
  const links = createConversationLinks({
    on: () => vscode.workspace.getConfiguration(brand.prefix).get('conversationLinks', true) !== false,
    active: () => chats.size > 0,
    own: () => backend.listSessions(),
    openCore: (target) => vscode.commands.executeCommand('agentPlus.openConversation', target),
    openOwn: async (id, handOff) => {
      const p = manager.panelOf(id);
      if (p) { p.reveal(p.viewColumn); return true; }
      if (handOff && locks.holder(id) && !locks.ownWindow(id)) return false;
      return openSession(id);
    },
    log,
  });
  subs.push(links, vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${brand.prefix}.conversationLinks`)) links.settingChanged(); }));

  /* Shared by the chat tabs; they list files only while @ is typed and follow the selection only while open. */
  const files = createFileSearch({ vscode });
  const selection = createSelectionTracker({ vscode });
  subs.push(selection);

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
      findFiles: (vscode.workspace.workspaceFolders || []).some((f) => f.uri.scheme === 'file') ? (query) => files.search(query) : undefined,
      selection,
      onTimeZone: (zone) => {
        if (zone === timeZone) return;
        timeZone = zone;
        if (memo) Promise.resolve(memo.update(ZONE_KEY, zone)).catch(() => {});
        writeZone(zone);
      },
      rewind: backend.canRewind() ? (target) => rewindTo(entry.id, chat, target) : undefined,
      info: () => infoRows(entry.id),
      sound,
      loadImage: (src) => loadImage(src),
      links,
      planBar: {
        summary: () => planBar.summaryOf(entry.id),
        onDidChange: (fn) => planBar.follow(entry.id, fn),
        open: (part) => planBar.open(entry.id, part),
      },
      vscode,
    });
    chats.add(chat);
    links.settingChanged();
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
    panel.onDidDispose(() => { off(); chats.delete(chat); links.settingChanged(); });
    return chat;
  }

  /*
   * Rewinds conversation `id` to before the user message `target` names (src/host/rewind.js): OpenCode puts the files
   * back and lists them, the user confirms, and the page is drawn again from what OpenCode then has. Cancelling puts the
   * files back as they were.
   */
  const rewindsRunning = new Set();
  async function rewindTo(id, chat, target) {
    const e = manager.get(id);
    if (!e || rewindsRunning.has(id)) return false;
    rewindsRunning.add(id);
    try {
      const mid = rewinding.messageOf(target, target.messageId ? [] : await backend.userMessages(id));
      if (!mid) throw new Error('This message could not be found in what OpenCode keeps of the conversation, so nothing was rewound.');
      const staged = await backend.rewindStage(id, mid);
      log(`rewind of ${id} to before ${mid} staged: ${staged.files.length} files, tracked ${staged.tracked}`);
      const ask = rewinding.confirmation(staged);
      const pick = await Promise.resolve(vscode.window.showWarningMessage(ask.message, { modal: true, detail: ask.detail }, REWIND)).catch(() => undefined);
      if (pick !== REWIND) {
        await backend.rewindClear(id);
        log(`rewind of ${id} cancelled; the files are as they were`);
        return false;
      }
      await backend.rewindCommit(id);
      const events = await e.conversation.reload();
      chat.replaceHistory(historyFor(events).events, target.text);
      log(`rewound ${id} to before ${mid}`);
      return true;
    } finally {
      rewindsRunning.delete(id);
    }
  }

  /* What the info box of conversation `id`'s page lists. */
  async function infoRows(id) {
    const e = manager.get(id);
    const info = backend.info();
    let db = '';
    try { db = (await backend.dataPaths()).db || 'not named by OpenCode'; } catch (err) { db = `unknown: ${(err && err.message) || err}`; }
    const version = info && info.version ? info.version.text || `${info.version.major}.${info.version.minor}.${info.version.patch}` : '';
    return [
      { label: 'Session', value: id },
      { label: 'Folder', value: e ? e.cwd : '' },
      { label: 'OpenCode', value: info ? `${version || 'version unknown'}, acp process ${info.pid}` : 'not running in this window' },
      { label: 'Session database', value: db },
      { label: 'Token mode', value: tokenMode.labelOf(tokenMode.modeNow(vscode)) || '' },
    ];
  }

  /*
   * Another window holds it: offers to take it over, asks that window to let go, and when it does not answer in time
   * offers to take it anyway. True once this window may open it.
   */
  async function takeOver(id) {
    if (locks.ownWindow(id)) return takeBack(id);
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
  /*
   * The extension host this window had before a reload still holds it, as over Remote-SSH when the old connection was
   * not closed: taken back without asking, and by force when that host does not answer, since no other window has it.
   */
  async function takeBack(id) {
    const r = await locks.requestTakeover(id);
    log(`taking back ${id} from this window's earlier extension host: ${r}`);
    if (r !== 'timeout') return true;
    const lock = locks.acquire(id, { force: true });
    if (!lock.ok) fail('The conversation could not be taken back', lock.error || 'the lock kept changing');
    return lock.ok;
  }
  /* The holder's side: the conversation stops here and its tabs go, also in a window whose client has gone. */
  locks.onTakeover((id) => {
    const e = manager.get(id);
    const panels = e ? [...e.panels] : [];
    quietClose.add(id);
    setTimeout(() => quietClose.delete(id), 3000);
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

  const activeTab = () => { const g = vscode.window.tabGroups.activeTabGroup; return g ? g.activeTab : undefined; };
  /* The conversation a command was run on: a row of the list, an id, a chat tab's URI, the chat page's own context
     menu (its argument names the webview), or the chat tab in front. */
  const conversationOf = (arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof vscode.Uri) return ap.sessionOfUri(arg);
    if (arg && typeof arg.id === 'string' && !arg.group) return arg.id;
    if (arg !== undefined && !(arg && arg.webview === ap.VIEW_TYPE)) return '';
    const tab = activeTab();
    return ap.isChatTab(tab) ? ap.sessionOfUri(tab.input.uri) : '';
  };
  const chatTabs = (id) => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    .filter((t) => ap.isChatTab(t) && ap.sessionOfUri(t.input.uri) === id);

  /* A chat tab the user closes goes to the top of Recently closed; one closed by a takeover or a delete does not. */
  const recent = createRecentClosed({ memo: context.workspaceState, log });
  subs.push(vscode.window.tabGroups.onDidChangeTabs((e) => {
    for (const t of (e && e.closed) || []) {
      if (!ap.isChatTab(t)) continue;
      const id = ap.sessionOfUri(t.input.uri);
      if (id && !quietClose.has(id) && !chatTabs(id).length) recent.add(id);
    }
  }));

  /* A chat tab says what its conversation is doing by the dot on its icon, and a reply not read yet by an envelope
     after its title. */
  let icons;
  const iconFor = (activity) => {
    if (icons === undefined) {
      const files = tabIcons(context.extensionPath, context.globalStorageUri.fsPath);
      icons = files ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { light: vscode.Uri.file(v.light), dark: vscode.Uri.file(v.dark) }])) : null;
    }
    if (!icons) return undefined;
    return icons[activity === 'working' || activity === 'waiting' ? activity : 'stopped'];
  };
  let link = null;
  const editor = new ChatEditorProvider({
    manager,
    show,
    focus: (id) => { if (link) link.focus(id); },
    busy: (id) => takeOver(id),
    ownWindow: (id) => locks.ownWindow(id),
    label: (s) => marks.withMarks(s.title, { unseen: s.unseen, envelope: envelope.envelope(vscode) }),
    iconFor,
    onDidChangeLook: (fn) => envelope.onEnvelopeChange(vscode, fn),
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
        noteRename();
        for (const r of rows) if (r.cwd) folders.set(r.id, r.cwd);
        return rows.filter((r) => inScope(r.cwd));
      }),
      /* Its plan and its scratch folder go with it: Agent Plus only reads the plans folder. */
      deleteSession: (id) => backend.deleteSession(id).then(() => {
        recent.remove(id);
        const gone = workplan.removePlan(id);
        if (gone.length) log(`deleted the plan files of ${id}: ${gone.join(', ')}`);
        try {
          if (workplan.removeScratch(id)) log(`deleted the scratch folder of ${id}`);
        } catch (e) { log(`could not delete the scratch folder of ${id}: ${e.message}`); }
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
  subs.push(listChanged.event(() => links.refresh()), recent.onDidChange(nudge));
  const { SessionsView } = require('./src/ui/sessions-view');
  const sessionsView = new SessionsView({
    listSessions: () => listed.list().catch((e) => { if (e && e.name === 'OpenCodeError') throw new Error(e.message); throw e; }).finally(() => backend.listen()),
    onDidChange: (fn) => listChanged.event(fn),
    statusOf: (meta) => listed.statusOf(meta),
    rename: (id, title) => listed.rename(id, marks.withoutMarks(title)),
    remove: (id) => listed.remove(id),
    /* From a chat tab's menus the argument is its URI; with none, the chat tab in front. */
    idOf: (arg) => {
      if (arg instanceof vscode.Uri) return ap.sessionOfUri(arg);
      if (arg !== undefined) return '';
      const tab = activeTab();
      return ap.isChatTab(tab) ? ap.sessionOfUri(tab.input.uri) : '';
    },
    titleOf: (id) => { const s = manager.snapshot(id); return s ? s.title : ''; },
    isOpenHere: (id) => manager.has(id),
    recent: () => recent.get(),
    vscode,
  });
  subs.push(sessionsView.register(), sessionsView);

  subs.push(
    vscode.commands.registerCommand(`${brand.prefix}.newConversation`, () => newConversation()),
    vscode.commands.registerCommand(`${brand.prefix}.openConversation`, (arg) => {
      const id = typeof arg === 'string' ? arg : arg && arg.id;
      return id ? openSession(id) : false;
    }),
    vscode.commands.registerCommand(`${brand.prefix}.forkConversation`, async (arg) => {
      const id = conversationOf(arg);
      if (!id) return false;
      let f;
      try { f = await backend.forkSession(id); } catch (e) { fail('The conversation could not be forked', e); return false; }
      folders.set(f.id, f.cwd);
      log(`forked ${id} as ${f.id}`);
      return openSession(f.id);
    }),
    vscode.commands.registerCommand(`${brand.prefix}.showMcpServers`, () => showMcp()),
    vscode.commands.registerCommand(`${brand.prefix}.findConversation`, () => findConversation({ vscode,
      list: () => backend.listSessions().finally(() => backend.listen()), open: (id) => openSession(id), openHere: (id) => manager.has(id) })),
    vscode.commands.registerCommand(`${brand.prefix}.clearRecentlyClosed`, () => { recent.clear(); return true; }),
    vscode.commands.registerCommand(`${brand.prefix}.diffAllowOnce`, (arg) => answerDiff(arg, 'allowOnce')),
    vscode.commands.registerCommand(`${brand.prefix}.diffAllowInProject`, (arg) => answerDiff(arg, 'allowSession')),
    vscode.commands.registerCommand(`${brand.prefix}.diffDeny`, (arg) => answerDiff(arg, 'deny')),
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

  /* `opencode mcp list` in an output channel of its own; servers are added and removed in OpenCode's configuration. */
  let mcpChannel = null;
  async function showMcp() {
    if (!mcpChannel) { mcpChannel = vscode.window.createOutputChannel(`${brand.displayName}: MCP Servers`); subs.push(mcpChannel); }
    let text;
    try { text = await backend.mcpList(); } catch (e) { text = `opencode mcp list failed: ${(e && e.message) || e}`; }
    mcpChannel.clear();
    mcpChannel.appendLine(`$ opencode mcp list (${new Date().toLocaleString()})`);
    mcpChannel.appendLine(text || '(no output)');
    mcpChannel.appendLine('');
    mcpChannel.appendLine('Add a server with `opencode mcp add` in a terminal, or in OpenCode\'s configuration file.');
    mcpChannel.show(true);
    return text;
  }

  /* The title bar of a permission request's diff answers that request, then closes the diff. */
  async function answerDiff(arg, decision) {
    const { answerFromDiff } = require('./src/ui/chat-panel');
    let uri = arg instanceof vscode.Uri ? arg : null;
    if (!uri) { const tab = activeTab(); const input = tab && tab.input; uri = input && (input.modified || input.uri) || null; }
    if (!uri || !answerFromDiff(uri, decision)) { tell('That permission request has already been answered.'); return false; }
    const key = uri.toString();
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.modified && t.input.modified.toString() === key);
    if (tabs.length) await Promise.resolve(vscode.window.tabGroups.close(tabs)).catch(() => {});
    return true;
  }

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
    allConversations: () => windows.readAll(),
    timeZone: () => timeZone,
    log,
  });
  subs.push(link, manager.onDidChange(() => link.changed()), plan.onDidChangeNotice(() => link.noticeChanged()));
  /* What this window has open, for the other windows' listAllConversations(); rewritten a moment after it changes. */
  const windows = createWindowStates({ dir: path.join(paths.root(), 'windows'), list: () => link.conversations(), log });
  let stateSoon = null;
  const stateChanged = () => { if (!stateSoon) stateSoon = setTimeout(() => { stateSoon = null; windows.write(); }, 250); };
  subs.push(manager.onDidChange(stateChanged), { dispose: () => { clearTimeout(stateSoon); windows.dispose(); } });
  /* The token mode decides whether the conversations keep a brief, which Agent Plus reads with their list. */
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('agentPlus.tokenMode')) link.changed(); }));
  subs.push(vscode.window.tabGroups.onDidChangeTabs(() => link.tabsChanged(activeTab())));
  const agentPlus = { accepted: false, code: 'pending', reason: '' };
  const registered = ap.register(link.source, { log }).then((r) => {
    Object.assign(agentPlus, { accepted: r.accepted, code: r.code, reason: r.reason });
    if (r.registration) {
      if (running) running.registration = r.registration; else r.registration.dispose();
      link.refocus();
      planBar.attach(r.core);
      links.attach(r.core);
    }
    return vscode.commands.executeCommand('setContext', CONTEXT_AGENT_PLUS, r.accepted);
  }).catch((e) => log(`Agent Plus registration failed: ${(e && e.message) || e}`));

  running = { manager, backend, registration: null };
  log(`activated ${context.extension ? context.extension.packageJSON.version : ''}`.trim());
  if (process.env.OPENCODE_PLUS_TEST_CONTROL) {
    return { test: { agentPlus, registered, conversations: () => manager.list(), sessions: () => listed.list(), isChild: (id) => backend.isChild(id),
      source: link.source, locks: () => locks.held(), settings: () => settings.options(), ready: settings.ready, windowFile: windows.file,
      send: (id, text) => manager.send(id, text), snapshot: (id) => manager.snapshot(id), replyFile: (id) => replies.fileOf(id),
      told: () => told.slice(), sound: () => soundOn, recent: () => recent.get(), links: () => links.list(), infoRows: (id) => infoRows(id), mcp: () => showMcp(), chats: () => chats.size,
      zoneFile: () => path.join(workplan.planDir(), 'client-time-zone.json'), plan: () => ({ values: plan.values(), python: plan.python, notice: plan.planNotice(), dir: workplan.planDir(), launch: plan.launch(settings.options()).env }) } };
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
