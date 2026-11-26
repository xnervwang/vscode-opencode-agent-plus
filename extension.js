// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation registers the commands, the Conversations view, the chat editor and the listeners. The agent (OpenCode,
 * through src/host/backend.js and src/opencode/) starts when the first conversation or the Conversations view needs it,
 * and a conversation's history is read when its tab opens. In Restricted Mode not even that: start() waits until the
 * workspace is trusted (src/host/trust-gate.js).
 *
 *   src/host/chat-editor.js       a chat tab is the custom editor opencodeAgentPlus.chat of opencodeagentplus-session:/<session id>
 *   src/host/chat-group.js        the editor group a conversation opens in
 *   src/host/session-manager.js   the conversations open in this window, one window each (src/host/locks.js)
 *   src/host/provider-config.js   the settings OpenCode starts with, the Bedrock API key
 *   src/host/models.js            the models OpenCode offers, and the picker
 *   src/host/agentplus-source.js  the conversations as a source of Agent Plus
 *   src/host/work-plan.js         copies the work plan plugin for OpenCode, finds Python for it, writes its settings
 *   src/host/file-search.js       the workspace files the chat page's @ list offers
 *   src/host/selection.js         the editor selection the chat page can send along
 *   src/host/plan-bar.js          the plan bar above each chat page's input box, from Agent Plus's summary
 *   src/host/window-states.js     every window's open conversations, for Agent Plus's listAllConversations()
 *   src/host/reply-file.js        each conversation's latest reply beside its plan, for a steward to read
 *   src/host/steward.js           which stewards look after each conversation, and the handoffs to them
 *   src/host/rewind.js            rewinding a conversation to before one of the user's messages (OpenCode 2)
 *   src/host/reply-images.js      reads the local image files a reply shows
 *   src/host/conversation-links.js   links to the conversations a reply names
 *   src/host/recent-closed.js     the chat tabs closed in this workspace, for the Recently closed group
 *   src/host/find-conversation.js    finding a conversation by part of its title, id or folder
 *   src/host/trust-gate.js        what the commands, the chat tabs and the view do before the workspace is trusted
 *   src/host/opencode-download.js    downloading OpenCode when none is found
 *   src/host/provider-login.js    OpenCode's sign-in wizard in a terminal, and the restart that follows it
 *   src/host/mentions.js          the @ references that editor commands put in a message box
 *   src/host/fix-actions.js       Fix with OpenCode Agent Plus among the editor's quick fixes
 *   src/host/auto-edit.js         the Edit automatically permission mode of each conversation
 *   src/host/detached.js          commands a conversation started that left OpenCode and are still running (Linux)
 *
 * OPENCODE_AGENT_PLUS_TEST_BACKEND, an absolute path to a module shaped like src/opencode/index.js, stands in for OpenCode in
 * the window tests; OPENCODE_AGENT_PLUS_TEST_CONTROL makes activate() return a few internals for them.
 */
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const brand = require('./src/brand');
const paths = require('./src/paths');
const { createLocks, windowToken } = require('./src/host/locks');
const { createSessionManager } = require('./src/host/session-manager');
const { chatColumn } = require('./src/host/chat-group');
const { createBackend } = require('./src/host/backend');
const { createModels, visibleModels } = require('./src/host/models');
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
const { createStewards } = require('./src/host/steward');
const workplan = require('./src/workplan');
const rewinding = require('./src/host/rewind');
const { loadImage } = require('./src/host/reply-images');
const { createConversationLinks } = require('./src/host/conversation-links');
const { createRecentClosed } = require('./src/host/recent-closed');
const { findConversation } = require('./src/host/find-conversation');
const hookSettings = require('./src/shared/hook-settings');
const tokenMode = require('./src/shared/token-mode');
const { createTrustGate } = require('./src/host/trust-gate');
const { createOpenCodeDownload } = require('./src/host/opencode-download');
const { createProviderLogin, addedProviders } = require('./src/host/provider-login');
/* src/opencode/ is loaded only once OpenCode is needed (Restricted Mode loads none of it). */
const loginLaunch = (o) => require('./src/opencode/login').loginLaunch(o);
const mentions = require('./src/host/mentions');
const { registerFixActions, COMMAND: FIX_COMMAND } = require('./src/host/fix-actions');
const autoEditing = require('./src/host/auto-edit');
const detaching = require('./src/host/detached');
const fs = require('fs');
const COMMANDS = require('./package.json').contributes.commands.map((c) => c.command);
const VIEW_ID = `${brand.prefix}.sessions`;

const CONTEXT_AGENT_PLUS = `${brand.prefix}.agentPlus`;
/* package.json shows the Rename entries when this is true: the OpenCode found can rename conversations (2.x). */
const CONTEXT_RENAME = `${brand.prefix}.canRename`;
const ZONE_KEY = `${brand.prefix}.timeZone`;
const CONTEXT_FORK = `${brand.prefix}.canFork`;
/* True while the Claude Code panel was in front after this extension's chat tab, so that Cmd+Esc and Alt+K in an
   editor go to that panel and not here (package.json keybindings). */
const CONTEXT_OTHER_CHAT = `${brand.prefix}.otherChatLast`;
const OTHER_CHAT = /claudeVSCodePanel/;
/* Whether the chat pages chime. The footer's button sets it, and it stays on until muted, as in Claude Code Plus. */
const SOUND_KEY = `${brand.prefix}.sound`;
/* The name of this window in the locks it takes (src/host/locks.js windowToken). */
const WINDOW_KEY = `${brand.prefix}.window`;
const REWIND = 'Rewind';
const TAKE_OVER = 'Take over here';
const TAKE_ANYWAY = 'Take over anyway';
const BUSY_TEXT = 'This conversation is open in another VS Code window, which may have lost its connection. '
  + 'Take it over to continue here. The other window stops any running turn and closes the conversation.';
const FORCE_TEXT = 'The other window did not release the conversation within 10 seconds. Take it over anyway? '
  + 'If that window is still running, both windows may change the conversation at the same time.';
let running = null;
/* Conversations whose tabs are closing for a takeover. The user did not close them, so Recently closed leaves them
   out. */
const quietClose = new Set();

function activate(context) {
  const channel = vscode.window.createOutputChannel(brand.displayName, { log: true });
  const log = (line) => channel.info(String(line));
  context.subscriptions.push(channel);
  const gate = createTrustGate({ vscode, viewType: ap.VIEW_TYPE, viewId: VIEW_ID, commands: COMMANDS, log });
  context.subscriptions.push(gate);
  /* The window tests' handle; its other members come with start(). */
  const api = process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL ? { test: { restricted: () => !gate.started, waitingTabs: () => gate.waiting() } } : undefined;
  gate.whenTrusted(() => {
    const test = start(context, log, gate, channel);
    if (api && test) Object.assign(api.test, test);
  });
  return api;
}

function start(context, log, gate, channel) {
  const subs = context.subscriptions;

  /* Edited files are saved before a message goes and before a request is allowed (opencodeAgentPlus.autosave):
     OpenCode reads and writes the files on disk, not what the editor holds. */
  const saveEdited = () => {
    if (vscode.workspace.getConfiguration(brand.prefix).get('autosave') === false) return Promise.resolve();
    return Promise.resolve().then(() => vscode.workspace.saveAll(false)).catch((e) => log(`saving edited files failed: ${(e && e.message) || e}`));
  };

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

  /* Copies the plugin and its scripts where OpenCode loads them, before anything can start OpenCode. */
  const plan = createWorkPlan({ vscode, extensionPath: context.extensionPath, storage: context.globalStorageUri.fsPath, memo: context.workspaceState, tell, log });
  subs.push(plan);
  plan.start().catch((e) => log(`work plan: ${(e && e.message) || e}`));

  let backend = null;
  const settings = createProviderConfig({ vscode, secrets: context.secrets, restart: (o) => backend.restart(plan.launch(o)), log });
  subs.push(settings);
  /* After a download the backend finds OpenCode on its next start; refound() then reads again what this window could
     not learn without it: whether Rename works, the version and the list. */
  const fetcher = createOpenCodeDownload({ vscode, ask, tell, log, done: (r) => refound(r) });
  backend = createBackend({ options: () => ({ ...plan.launch(settings.options()), root: paths.root(), log }), onError: (e) => { fetcher.offer(e); } });
  /* backend.canRename() is known once the conversation list or a conversation has started OpenCode; the Rename
     context key is set then. */
  let renameKnown = false;
  const noteRename = () => {
    noteFork();
    if (renameKnown) return;
    renameKnown = true;
    Promise.resolve().then(() => vscode.commands.executeCommand('setContext', CONTEXT_RENAME, backend.canRename())).catch(() => { renameKnown = false; });
  };
  /* backend.canFork() stays false until OpenCode has started and said what it offers, so each call asks again until it
     is true. */
  let forkKnown = false;
  function noteFork() {
    if (forkKnown || !backend.canFork()) return;
    forkKnown = true;
    Promise.resolve(vscode.commands.executeCommand('setContext', CONTEXT_FORK, true)).catch(() => { forkKnown = false; });
  }
  /* The version is known once a conversation has started OpenCode in this window. OpenCode 1 keeps no work plan, and
     plan.checkVersion() tells the user so once. */
  let versionKnown = false;
  const noteVersion = () => {
    noteRename();
    if (versionKnown) return;
    versionKnown = true;
    Promise.resolve().then(() => backend.detect()).then((found) => plan.checkVersion(found.version), () => { versionKnown = false; });
  };
  async function refound(r) {
    renameKnown = false;
    versionKnown = false;
    let found = null;
    try { found = await backend.detect(); } catch (e) { log(`looking for OpenCode after the download: ${(e && e.message) || e}`); }
    noteRename();
    nudge();
    if (found && path.resolve(found.path) !== path.resolve(r.path)) {
      tell(`The downloaded OpenCode is in ${r.path}, but the one at ${found.path} is still used because it is found first.`);
    } else {
      tell(`OpenCode${found && found.version ? ` ${found.version.text}` : ''} is ready for new conversations.`);
    }
  }
  const models = createModels({ vscode, listModels: () => backend.listModels(), defaultModel: () => backend.defaultModel() });
  const locks = createLocks({ dir: path.join(paths.root(), 'locks'), window: windowToken(context.workspaceState, WINDOW_KEY), log });
  subs.push(locks);
  /* `made` keeps a session this window has just created until its chat tab opens it. `folders` keeps the folder of each
     listed or forked session, so that opening it starts it there. */
  const made = new Map();
  const folders = new Map();

  let toldAuth = 0;
  const onAuth = (ev) => {
    if (!ev || ev.type !== 'turnEnd' || !ev.error || ev.error.kind !== 'auth' || Date.now() - toldAuth < 60000) return;
    toldAuth = Date.now();
    backend.bedrockStatus().then((status) => {
      if (status && status.state === 'authFailed') return settings.show(settings.describe({ status, models: [] }));
      return undefined;
    }).catch(() => {});
  };

  const replies = createReplyFiles({ dir: () => workplan.planDir(), log });
  const autoEdit = autoEditing.createAutoEdit({ memo: context.workspaceState });
  let manager = null;
  manager = createSessionManager({
    locks,
    makeConversation: async ({ id }) => {
      const inner = made.get(id) || await backend.session(id, folders.has(id) ? { cwd: folders.get(id) } : {});
      made.delete(id);
      noteVersion();
      let events = [];
      try { events = await inner.history(); } catch (e) { log(`history of ${id}: ${(e && e.message) || e}`); }
      /* Loads the model list too: drawing a restored reply's context share needs the model's context window. */
      await models.list().catch(() => null);
      const conv = withModelChoice(inner, {
        needsChoice: !named() && !(Array.isArray(events) && events.length),
        choose: () => models.pick(),
        tell,
      });
      autoEditing.guard(conv, { enabled: () => autoEdit.get(id), folder: () => conv.cwd || (folders.get(id) || ''),
        answer: (requestId) => saveEdited().then(() => conv.respond(requestId, 'allowOnce')), log });
      conv.saved = historyFor(events);
      conv.on(onAuth);
      replies.track(id, conv, events);
      stewards.track(id, conv, events);
      return conv;
    },
    isLooking: (id) => {
      const p = manager.panelOf(id);
      return !!p && p.active && p.visible && vscode.window.state.focused;
    },
    log,
  });
  subs.push(manager);

  /* Agent Plus feeds the plan bar on each chat page once this extension has registered with it. */
  const planBar = createPlanBar({
    on: () => vscode.workspace.getConfiguration(brand.prefix).get('planBar', true) !== false,
    run: (command, arg) => vscode.commands.executeCommand(command, arg),
    log,
  });
  subs.push(planBar, vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${brand.prefix}.planBar`)) planBar.settingChanged(); }));

  /* The user's time zone, as the last chat page to load reported it. The plugin's time-zone hook reads it from
     client-time-zone.json in the plans folder. */
  const memo = context.globalState && typeof context.globalState.get === 'function' ? context.globalState : null;
  let timeZone = memo ? String(memo.get(ZONE_KEY, '') || '') : '';
  const writeZone = (zone) => {
    if (!zone || vscode.workspace.isTrusted === false) return;
    try { if (hookSettings.writeClientZone(workplan.planDir(), zone)) log(`time zone written for the plugin: ${zone}`); } catch (e) { log(`writing the time zone failed: ${e.message}`); }
  };
  writeZone(timeZone);

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

  /* Focus view and the pinned prompt (opencodeAgentPlus.focusView, .pinPrompt) go to every chat page as they change. */
  const view = {
    focus: () => vscode.workspace.getConfiguration(brand.prefix).get('focusView', false) === true,
    pin: () => vscode.workspace.getConfiguration(brand.prefix).get('pinPrompt', true) !== false,
    setFocus: (on) => vscode.workspace.getConfiguration(brand.prefix).update('focusView', on === true, vscode.ConfigurationTarget.Global),
  };
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${brand.prefix}.focusView`) || e.affectsConfiguration(`${brand.prefix}.pinPrompt`)) for (const c of chats) c.postView();
  }));

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
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${brand.prefix}.openCodeModels`)) for (const c of chats) c.postModels();
  }));

  /* Shared by the chat tabs. A tab lists files only while @ is being typed, and follows the selection only while it is
     open. */
  const files = createFileSearch({ vscode });
  const selection = createSelectionTracker({ vscode });
  subs.push(selection);

  function show(panel, entry) {
    const { ChatPanel } = require('./src/ui/chat-panel');
    const conv = entry.conversation;
    const infoOf = (name) => (name ? models.cached(name) || { id: name, providerId: name.includes('/') ? name.split('/')[0] : '', name, contextWindow: 0 } : undefined);
    const chat = new ChatPanel({
      panel,
      extensionUri: context.extensionUri,
      conversation: conv,
      listModels: () => models.list(),
      visibleModels: (list, current) => visibleModels(list, String(vscode.workspace.getConfiguration(brand.prefix).get('openCodeModels') || 'auto'), current),
      respond: (requestId, decision) => (decision === 'deny' ? conv.respond(requestId, decision) : saveEdited().then(() => conv.respond(requestId, decision))),
      beforeSend: saveEdited,
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
      view,
      loadImage: (src) => loadImage(src),
      connectProvider: () => connectProvider(),
      composer: composerSettings,
      permissionMode: {
        get: () => autoEdit.get(entry.id),
        set: (on) => autoEdit.set(entry.id, on),
        onDidChange: (fn) => autoEdit.onDidChange((id) => { if (id === entry.id) fn(); }),
      },
      forkFrom: backend.canForkBefore() ? (target) => forkFromMessage(entry.id, target) : undefined,
      detached: detaching.supported() ? () => detaching.scan({ sessionId: entry.id, rootPid: (backend.info() || {}).pid || 0 }) : undefined,
      readRange: (file, from, to) => {
        const doc = (vscode.workspace.textDocuments || []).find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
        return mentions.rangeText(file, from, to, { open: doc ? doc.getText() : null });
      },
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
    /* The chat tab in front is the one the editor's commands add to. */
    const noteFront = () => { if (panel.active) { frontId = entry.id; otherChatLast(false); } };
    noteFront();
    const offFront = panel.onDidChangeViewState(noteFront);
    const draft = drafts.get(entry.id);
    if (draft) { drafts.delete(entry.id); chat.compose({ draft }); }
    for (const ev of (conv.saved && conv.saved.events) || []) chat.dispatch(ev);
    /* Shows the model a turn runs on (turnStart.modelId) and, after the model's first call, the context window
       OpenCode has learned for it. */
    const follow = (name) => {
      const m = infoOf(name);
      const at = chat.state && chat.state.model;
      if (m && (!at || at.id !== m.id || (m.contextWindow && at.contextWindow !== m.contextWindow))) chat.dispatch({ type: 'ui.model', model: m });
    };
    const off = conv.on((ev) => {
      if (ev && ev.type === 'turnStart' && typeof ev.modelId === 'string' && ev.modelId) follow(ev.modelId);
      if (ev && ev.type === 'turnEnd') models.list().then(() => follow(conv.modelName), () => {});
    });
    panel.onDidDispose(() => { off(); offFront.dispose(); chats.delete(chat); links.settingChanged(); });
    return chat;
  }

  /* The message box settings that every chat page uses. */
  const cfg = () => vscode.workspace.getConfiguration(brand.prefix);
  const composerSettings = () => ({ ctrlEnter: cfg().get('useCtrlEnterToSend') === true, attachFile: cfg().get('attachOpenFile') !== false,
    attachSelection: cfg().get('attachSelection') !== false });
  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (['useCtrlEnterToSend', 'attachOpenFile', 'attachSelection'].some((k) => e.affectsConfiguration(`${brand.prefix}.${k}`))) for (const c of chats) c.settingsChanged();
  }));

  /* The chat tab that was active last, and whether the Claude Code panel became active after it. */
  let frontId = '';
  let otherLast = null;
  function otherChatLast(on) {
    if (otherLast === on) return;
    otherLast = on;
    Promise.resolve(vscode.commands.executeCommand('setContext', CONTEXT_OTHER_CHAT, on)).catch(() => { otherLast = null; });
  }
  subs.push(vscode.window.tabGroups.onDidChangeTabs(() => {
    const t = activeTab();
    if (t && t.input instanceof vscode.TabInputWebview && OTHER_CHAT.test(String(t.input.viewType || ''))) otherChatLast(true);
  }));
  const frontChat = () => {
    const list = [...chats];
    return list.find((c) => c.conversation && c.conversation.id === frontId) || list[list.length - 1] || null;
  };
  /* Runs `fn` on the chat tab in front after bringing it forward and focusing it, or on a new conversation's tab when no
     chat tab is open. */
  async function toFrontChat(fn) {
    let chat = frontChat();
    if (!chat) {
      const id = await newConversationId();
      if (!id) return false;
      for (let i = 0; i < 150 && !chat; i++) {
        chat = [...chats].find((c) => c.conversation && c.conversation.id === id) || null;
        if (!chat) await new Promise((r) => setTimeout(r, 100));
      }
      if (!chat) return false;
    }
    chat.panel.reveal(chat.panel.viewColumn, false);
    fn(chat);
    return true;
  }
  const folderPaths = () => (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  /* The @ reference for a file, with the lines selected in `editor` when it shows that file. */
  const refOf = (file, editor) => {
    const sel = editor && editor.document && editor.document.uri.fsPath === file && editor.selection && !editor.selection.isEmpty ? mentions.linesOf(editor.selection) : {};
    return mentions.refFor(file, { folders: folderPaths(), ...sel });
  };

  const drafts = new Map();

  /*
   * Agent Plus's prefill: brings conversation `id` to the front in this window, opening its tab as openSession() does.
   */
  async function prefill(id, text, deadline) {
    const chatOf = () => [...chats].find((c) => c.conversation && c.conversation.id === id) || null;
    let chat = chatOf();
    if (!chat) {
      const opened = await openSession(id).catch(() => false);
      if (!opened) return { outcome: 'notReceived', reason: 'the conversation could not be opened in this window' };
      while (!(chat = chatOf()) && Date.now() < deadline - 200) await new Promise((r) => setTimeout(r, 100));
      if (!chat) return { outcome: 'notReceived', reason: 'the tab opened, but its chat page was not ready in time' };
    }
    chat.panel.reveal(chat.panel.viewColumn, false);
    const ok = await chat.prefill(text, Math.max(0, deadline - Date.now()));
    if (ok === true) return { outcome: 'drafted' };
    if (ok === false) return { outcome: 'notReceived', reason: 'the chat page did not take the text' };
    return { outcome: 'uncertain', reason: 'the chat page did not answer within the deadline' };
  }

  /* Fork from here: OpenCode copies the history before the user message `target` into a new conversation, which opens
     in a tab of its own with that message in its box. */
  async function forkFromMessage(id, target) {
    const mid = rewinding.messageOf(target, target.messageId ? [] : await backend.userMessages(id));
    if (!mid) throw new Error('Cannot fork here: OpenCode\'s copy of the conversation does not have this message.');
    const f = await backend.forkBefore(id, mid);
    if (f.cwd) folders.set(f.id, f.cwd);
    if (target.text) drafts.set(f.id, target.text);
    log(`forked ${id} before ${mid} as ${f.id}`);
    return openSession(f.id);
  }

  /*
   * Rewinds conversation `id` to before the user message `target` points to (src/host/rewind.js): OpenCode puts the files
   * back and lists them, the user confirms, and the page is redrawn from the history OpenCode then returns. Cancelling puts the
   * files back as they were.
   */
  const rewindsRunning = new Set();
  async function rewindTo(id, chat, target) {
    const e = manager.get(id);
    if (!e || rewindsRunning.has(id)) return false;
    rewindsRunning.add(id);
    try {
      const mid = rewinding.messageOf(target, target.messageId ? [] : await backend.userMessages(id));
      if (!mid) throw new Error('OpenCode\'s copy of the conversation does not have this message, so nothing was rewound.');
      const staged = await backend.rewindStage(id, mid);
      log(`rewind of ${id} to before ${mid} staged: ${staged.files.length} files, tracked ${staged.tracked}`);
      const ask = rewinding.confirmation(staged);
      const pick = await Promise.resolve(vscode.window.showWarningMessage(ask.message, { modal: true, detail: ask.detail }, REWIND)).catch(() => undefined);
      if (pick !== REWIND) {
        await backend.rewindClear(id);
        log(`rewind of ${id} cancelled; files restored`);
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

  /* Connect a Model Provider. OpenCode is restarted only when no turn in this window is running, since a restart would
     end the turn. */
  const idleHere = () => manager.list().every((s) => s.activity !== 'working' && s.activity !== 'waiting');
  const whenIdle = () => new Promise((resolve) => {
    if (idleHere()) { resolve(); return; }
    const d = manager.onDidChange(() => { if (idleHere()) { d.dispose(); resolve(); } });
  });
  let loginProgram = '';
  const logins = { opened: 0, refreshed: 0 };
  const login = createProviderLogin({
    vscode,
    launch: async () => {
      const found = await backend.detect();
      const info = backend.info();
      return loginLaunch({ found: loginProgram ? { ...found, path: loginProgram } : found, env: plan.launch(settings.options()).env, authMethods: info && info.authMethods });
    },
    done: async () => {
      const before = await models.list().catch(() => []);
      if (!idleHere()) {
        tell('OpenCode will restart for the new provider when the turns running in this window have ended.');
        await whenIdle();
      }
      await backend.restart(plan.launch(settings.options()));
      let list = [];
      try { list = await backend.refreshModels(); } catch (e) { log(`listing the models after the sign-in failed: ${(e && e.message) || e}`); }
      await models.list().catch(() => null);
      for (const c of chats) c.reloadModels();
      logins.refreshed++;
      const added = addedProviders(before, list);
      if (added.length) tell(`OpenCode now offers models from ${added.join(', ')}.`);
      else if (!manager.ids().length) tell('Open a conversation to see the updated model list.');
      else tell(`OpenCode offers ${list.length} model${list.length === 1 ? '' : 's'}; no provider was added.`);
    },
    fail,
    log,
  });
  subs.push(login);
  const connectProvider = () => { logins.opened++; return login.run(); };

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

  /* Brings the conversation's tab in this window to the front, or opens a new one. Returns false when another window
     has it open and does not let go. */
  async function openSession(id) {
    const panel = manager.panelOf(id);
    if (panel) { panel.reveal(panel.viewColumn); return true; }
    if (locks.holder(id) && !(await takeOver(id))) return false;
    await vscode.commands.executeCommand('vscode.openWith', ap.uriOf(id), ap.VIEW_TYPE,
      { preview: false, viewColumn: chatColumn(vscode, ap.isChatTab) });
    return true;
  }

  /* Starts a conversation and opens its tab; resolves with its id, or '' when that failed. */
  async function newConversationId() {
    let s;
    const model = named();
    try { s = await backend.createSession(folder(), model ? { model } : {}); } catch (e) { fail('A new conversation could not be started', e); return ''; }
    if (!s || !s.id) { fail('A new conversation could not be started', 'OpenCode returned no session'); return ''; }
    noteVersion();
    made.set(s.id, s);
    return (await openSession(s.id)) ? s.id : '';
  }
  const newConversation = () => newConversationId().then((id) => !!id);

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

  /* Closing a chat tab puts its conversation at the top of Recently closed, unless a takeover or a delete closed it. */
  const recent = createRecentClosed({ memo: context.workspaceState, log });
  subs.push(vscode.window.tabGroups.onDidChangeTabs((e) => {
    for (const t of (e && e.closed) || []) {
      if (!ap.isChatTab(t)) continue;
      const id = ap.sessionOfUri(t.input.uri);
      if (id && !quietClose.has(id) && !chatTabs(id).length) recent.add(id);
    }
  }));

  /* A dot on a chat tab's icon shows what its conversation is doing, and an envelope after its title marks a reply
     the user has not read yet. */
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
  gate.useEditor(editor);

  /* The Conversations view lists the sessions of this window's folders, and is redrawn when a conversation open here,
     OpenCode's session list or Recently closed changes. */
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
      /* Deleting a session also removes its plan files and scratch folder, since Agent Plus only reads the plans folder
         and nothing else clears them. */
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
    /* A chat tab's menus pass its URI. With no argument, this takes the chat tab in front. */
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
    /* The same command with the OpenCode mark, for the editor title bar, where the view's plus sign would read as "new file". */
    vscode.commands.registerCommand(`${brand.prefix}.newConversationInEditor`, () => newConversation()),
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
    vscode.commands.registerCommand(`${brand.prefix}.showLogs`, () => { channel.show(true); return true; }),
    vscode.commands.registerCommand(`${brand.prefix}.toggleFocusView`, () => Promise.resolve(view.setFocus(!view.focus())).then(() => view.focus())),
    vscode.commands.registerCommand(`${brand.prefix}.connectProvider`, () => connectProvider()),
    vscode.commands.registerCommand(`${brand.prefix}.focusInput`, () => toFrontChat((c) => c.focusInput())),
    /* Back from the chat tab to the file editor last in front. */
    vscode.commands.registerCommand(`${brand.prefix}.blurInput`, async () => {
      const ed = selection.lastEditor() || (vscode.window.visibleTextEditors || []).find((x) => x.document && x.document.uri.scheme === 'file');
      if (!ed) return false;
      await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
      return true;
    }),
    vscode.commands.registerCommand(`${brand.prefix}.insertAtMention`, () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !ed.document || ed.document.uri.scheme !== 'file') { tell('Open a file in the editor first.'); return false; }
      const ref = refOf(ed.document.uri.fsPath, ed);
      return ref ? toFrontChat((c) => c.compose({ refs: [ref] })) : false;
    }),
    /* Called from an editor's context menu with that editor's file and selection, or from the Explorer's with the
       files selected there. */
    vscode.commands.registerCommand(`${brand.prefix}.addToConversation`, (uri, uris) => {
      const ed = vscode.window.activeTextEditor;
      const list = Array.isArray(uris) && uris.length ? uris : uri instanceof vscode.Uri ? [uri] : ed ? [ed.document.uri] : [];
      const refs = [];
      let folders = 0;
      for (const u of list) {
        if (!u || u.scheme !== 'file') continue;
        try { if (fs.statSync(u.fsPath).isDirectory()) { folders++; continue; } } catch (_) { continue; }
        const r = refOf(u.fsPath, ed);
        if (r) refs.push(r);
      }
      if (!refs.length) { tell(folders ? 'A folder cannot be added to a conversation; add the files in it.' : 'There is no file to add.'); return false; }
      return toFrontChat((c) => c.compose({ refs }));
    }),
    vscode.commands.registerCommand(FIX_COMMAND, (uri, diagnostics) => {
      if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file') return false;
      const list = Array.isArray(diagnostics) ? diagnostics : [];
      const lines = list.map((d) => d.line).filter((n) => n > 0);
      const from = lines.length ? Math.min(...lines) : 0;
      const to = Math.max(from, ...list.map((d) => d.endLine || d.line || 0));
      const ref = mentions.refFor(uri.fsPath, { folders: folderPaths(), startLine: from, endLine: Math.min(to, from + 199) });
      if (!ref) return false;
      return toFrontChat((c) => c.compose({ refs: [ref], draft: mentions.fixDraft(ref, list) }));
    }),
    vscode.commands.registerCommand(`${brand.prefix}.findConversation`, () => findConversation({ vscode,
      list: () => backend.listSessions().finally(() => backend.listen()), open: (id) => openSession(id), openHere: (id) => manager.has(id) })),
    vscode.commands.registerCommand(`${brand.prefix}.clearRecentlyClosed`, () => { recent.clear(); return true; }),
    vscode.commands.registerCommand(`${brand.prefix}.diffAllowOnce`, (arg) => answerDiff(arg, 'allowOnce')),
    vscode.commands.registerCommand(`${brand.prefix}.diffAllowInProject`, (arg) => answerDiff(arg, 'allowSession')),
    vscode.commands.registerCommand(`${brand.prefix}.diffDeny`, (arg) => answerDiff(arg, 'deny')),
    vscode.commands.registerCommand(`${brand.prefix}.chooseModel`, () => models.pick().catch((e) => fail('The models could not be listed', e))),
    vscode.commands.registerCommand(fetcher.COMMAND, () => fetcher.run()),
    vscode.commands.registerCommand(`${brand.prefix}.setBedrockApiKey`, () => settings.setApiKey()),
    vscode.commands.registerCommand(`${brand.prefix}.clearBedrockApiKey`, () => settings.clearApiKey()),
    vscode.commands.registerCommand(`${brand.prefix}.testConnection`, async () => {
      let found = null;
      try { found = await backend.detect(); } catch (e) { return settings.show(settings.describe({ error: e })); }
      plan.checkVersion(found.version);
      try {
        const [list, status] = await Promise.all([models.list(), backend.bedrockStatus()]);
        return settings.show(settings.describe({ status, models: list, found }));
      } catch (e) { return fail('The connection test failed', e); }
    }),
  );

  const fixes = registerFixActions({ vscode, enabled: () => cfg().get('showFixActions') !== false && vscode.workspace.isTrusted !== false });
  if (fixes) subs.push(fixes);

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

  /* The Allow and Deny buttons in the title bar of a permission request's diff answer the request and close the
     diff. */
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

  /* Agent Plus. Everything above works the same when Agent Plus is not installed or turns down this registration. */
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
    prefill: (id, text, deadline) => prefill(id, text, deadline),
    trusted: () => vscode.workspace.isTrusted,
    hidden: (id) => backend.isChild(id),
    allConversations: () => windows.readAll(),
    timeZone: () => timeZone,
    log,
  });
  subs.push(link, manager.onDidChange(() => link.changed()), plan.onDidChangeNotice(() => link.noticeChanged()));
  const stewards = createStewards({
    dir: () => workplan.planDir(),
    ids: () => manager.ids(),
    title: (id) => { const s = manager.snapshot(id); return s ? marks.withoutMarks(s.title) : ''; },
    log,
  });
  subs.push(stewards, manager.onDidChange(() => stewards.opened()));
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
      stewards.attach(r.core);
    }
    return vscode.commands.executeCommand('setContext', CONTEXT_AGENT_PLUS, r.accepted);
  }).catch((e) => log(`Agent Plus registration failed: ${(e && e.message) || e}`));

  running = { manager, backend, registration: null };
  log(`activated ${context.extension ? context.extension.packageJSON.version : ''}`.trim());
  if (process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL) {
    return { agentPlus, registered, conversations: () => manager.list(), sessions: () => listed.list(), isChild: (id) => backend.isChild(id),
      source: link.source, locks: () => locks.held(), settings: () => settings.options(), ready: settings.ready, windowFile: windows.file,
      send: (id, text) => manager.send(id, text), snapshot: (id) => manager.snapshot(id), replyFile: (id) => replies.fileOf(id),
      stewardFile: (id) => stewards.fileOf(id), stewardsWatching: () => stewards.watching(),
      told: () => told.slice(), sound: () => soundOn, recent: () => recent.get(), links: () => links.list(), infoRows: (id) => infoRows(id), mcp: () => showMcp(), chats: () => chats.size,
      zoneFile: () => path.join(workplan.planDir(), 'client-time-zone.json'), plan: () => ({ values: plan.values(), python: plan.python, notice: plan.planNotice(), dir: workplan.planDir(), launch: plan.launch(settings.options()).env }),
      backendInfo: () => backend.info(), downloadOffered: () => fetcher.offered,
      /* For tests: the program the sign-in terminal runs in place of the OpenCode found ('' to run that one), and how many
         times the sign-in ran. */
      loginProgram: (p) => { loginProgram = String(p || ''); return true; }, logins: () => ({ ...logins }),
      autoEdit: (id) => autoEdit.get(id), rescanDetached: () => { for (const c of chats) c.lookForDetached(0); return chats.size; },
      canForkBefore: () => backend.canForkBefore(), restartOpenCode: () => backend.restart(plan.launch(settings.options())).then(() => true),
      loginLaunch: async () => loginLaunch({ found: await backend.detect(), env: plan.launch(settings.options()).env, authMethods: (backend.info() || {}).authMethods }) };
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
