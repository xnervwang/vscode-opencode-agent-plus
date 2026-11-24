// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The parts of the VS Code API that src/host/ touches, enough to run it in Node: events, URIs, tab inputs, a tab model
 * the test drives, commands, settings, secrets, messages, quick picks (also one made with createQuickPick, which the
 * test answers through state.quickPick) and webview panels. install() makes
 * require('vscode') return it.
 */
const Module = require('module');
const path = require('path');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
  }
  fire(e) { for (const fn of [...this.listeners]) fn(e); }
  dispose() { this.listeners.clear(); }
}

class Uri {
  constructor({ scheme = 'file', authority = '', path: p = '', query = '', fragment = '' }) {
    Object.assign(this, { scheme, authority, path: p, query, fragment });
  }
  static from(parts) { return new Uri(parts); }
  static file(p) { return new Uri({ scheme: 'file', path: p }); }
  static joinPath(base, ...parts) { return new Uri({ ...base, path: path.posix.join(base.path, ...parts) }); }
  get fsPath() { return this.path; }
  with(change) { return new Uri({ ...this, ...change }); }
  toString() { return `${this.scheme}:${this.authority ? '//' + this.authority : ''}${this.path}`; }
}

class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }

/* A webview panel the test can make active, hide or close. */
function panel({ viewColumn = 1, active = true } = {}) {
  const viewState = new EventEmitter(), disposed = new EventEmitter();
  const p = {
    title: '', viewColumn, active, visible: true, revealed: 0,
    webview: { options: {}, html: '', posted: [], cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
      postMessage: async (m) => { p.webview.posted.push(m); return true; },
      onDidReceiveMessage: (fn) => { p.heard.add(fn); return { dispose: () => p.heard.delete(fn) }; } },
    heard: new Set(),
    /* A message from the page. */
    fromPage(m) { for (const fn of [...p.heard]) fn(m); },
    onDidChangeViewState: viewState.event,
    onDidDispose: disposed.event,
    reveal(col) { p.revealed++; if (col) p.viewColumn = col; },
    setActive(on) { p.active = on; p.visible = p.visible || on; viewState.fire({ webviewPanel: p }); },
    dispose() { disposed.fire(); },
  };
  return p;
}

function create() {
  const tabsChanged = new EventEmitter();
  const configChanged = new EventEmitter();
  const secretsChanged = new EventEmitter();
  const groups = [{ viewColumn: 1, tabs: [], activeTab: null, isActive: true }];
  const state = { commands: [], handlers: {}, registered: [], said: [], answers: [], config: {}, configWrites: [], secrets: new Map(),
    picks: [], pickAnswer: null, inputs: [], inputAnswer: undefined, extensions: new Map(), context: {}, progress: [],
    editors: {}, trees: {}, log: [], closedTabs: [] };
  const say = (kind) => async (message, ...rest) => {
    const buttons = rest.filter((b) => typeof b === 'string');
    state.said.push({ kind, message, buttons });
    for (const [match, pick] of state.answers) if (String(message).includes(match)) return pick;
    return undefined;
  };
  const vscode = {
    EventEmitter, Uri, TabInputCustom, TabInputText, TabInputWebview, ThemeIcon, ThemeColor, TreeItem, RelativePattern,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    window: {
      state: { focused: true },
      tabGroups: {
        get all() { return groups; },
        get activeTabGroup() { return groups.find((g) => g.isActive) || groups[0]; },
        onDidChangeTabs: tabsChanged.event,
        close: async (tabs) => { state.closedTabs.push(...[].concat(tabs)); return true; },
      },
      createOutputChannel: (name) => ({ name, info: (l) => state.log.push(l), appendLine: (l) => state.log.push(l), clear() {}, show() { state.shownChannel = name; }, dispose() {} }),
      registerCustomEditorProvider: (viewType, provider, opts) => { state.editors[viewType] = { provider, opts }; return { dispose() {} }; },
      createTreeView: (id, opts) => {
        const shown = new EventEmitter();
        const view = { id, opts, message: undefined, onDidChangeVisibility: shown.event, dispose() {} };
        state.trees[id] = view;
        return view;
      },
      showInformationMessage: say('info'),
      showWarningMessage: say('warning'),
      showErrorMessage: say('error'),
      showQuickPick: async (items, opts) => { const list = await items; state.picks.push({ list, opts }); return state.pickAnswer ? state.pickAnswer(list) : undefined; },
      createQuickPick: () => {
        const accepted = new EventEmitter(), hidden = new EventEmitter();
        const qp = { items: [], selectedItems: [], activeItems: [], shown: false, disposed: false, onDidAccept: accepted.event, onDidHide: hidden.event,
          show() { qp.shown = true; }, hide() { if (qp.shown) { qp.shown = false; hidden.fire(); } }, dispose() { qp.disposed = true; },
          /* The user picks the item `fn` finds, or closes the pick when it finds none. */
          answer(fn) { const it = fn(qp.items); if (it) { qp.selectedItems = [it]; accepted.fire(); } else qp.hide(); } };
        state.quickPick = qp;
        return qp;
      },
      showInputBox: async (opts) => { state.inputs.push(opts); return typeof state.inputAnswer === 'function' ? state.inputAnswer(opts) : state.inputAnswer; },
      withProgress: async (opts, task) => { state.progress.push(opts); return task({ report() {} }, { isCancellationRequested: false }); },
    },
    commands: {
      executeCommand: async (cmd, ...args) => {
        state.commands.push([cmd, ...args]);
        if (cmd === 'setContext') state.context[args[0]] = args[1];
        if (state.handlers[cmd]) return state.handlers[cmd](...args);
        return undefined;
      },
      registerCommand: (id, fn) => { state.registered.push(id); state.handlers[id] = fn; return { dispose() {} }; },
    },
    extensions: { getExtension: (id) => state.extensions.get(id) },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      getConfiguration: (section) => ({
        get: (k, d) => { const full = section ? `${section}.${k}` : k; return full in state.config ? state.config[full] : d; },
        update: async (k, v, target) => {
          const full = section ? `${section}.${k}` : k;
          state.config[full] = v;
          state.configWrites.push([full, v, target]);
          configChanged.fire({ affectsConfiguration: (s) => full === s || full.startsWith(s + '.') });
        },
      }),
      onDidChangeConfiguration: configChanged.event,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }),
    },
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
  };
  const secrets = {
    get: async (k) => state.secrets.get(k),
    store: async (k, v) => { state.secrets.set(k, v); secretsChanged.fire({ key: k }); },
    delete: async (k) => { state.secrets.delete(k); secretsChanged.fire({ key: k }); },
    onDidChange: secretsChanged.event,
  };
  const control = {
    state,
    groups,
    secrets,
    panel,
    /* Puts these tabs in the one group, `active` the index of the one in front (-1 for none). */
    setTabs(list, active = 0) {
      groups[0].tabs = list.map((t) => ({ label: t.label || '', input: t.input, isActive: false, group: groups[0] }));
      groups[0].activeTab = groups[0].tabs[active] || undefined;
      if (groups[0].activeTab) groups[0].activeTab.isActive = true;
      tabsChanged.fire({ opened: [], closed: [], changed: [] });
    },
    /* Takes these tabs out of the group, as the user closing them. */
    closeTabs(list) {
      const gone = groups[0].tabs.filter((t) => list.includes(t));
      groups[0].tabs = groups[0].tabs.filter((t) => !list.includes(t));
      if (!groups[0].tabs.includes(groups[0].activeTab)) groups[0].activeTab = groups[0].tabs[0];
      tabsChanged.fire({ opened: [], closed: gone, changed: [] });
    },
    chatTab(sessionId) { return { label: 'chat', input: new TabInputCustom(Uri.from({ scheme: 'opencodeplus-session', path: `/${sessionId}` }), 'opencodePlus.chat') }; },
    fileTab(p) { return { label: path.basename(p), input: new TabInputText(Uri.file(p)) }; },
    setConfig(full, v) {
      state.config[full] = v;
      configChanged.fire({ affectsConfiguration: (s) => full === s || full.startsWith(s + '.') });
    },
  };
  return { vscode, control };
}

/* Makes require('vscode') return `vscode` from now on. */
function install(vscode) {
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : orig.call(this, request, ...rest); };
}

module.exports = { create, install, EventEmitter, Uri };
