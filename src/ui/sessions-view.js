// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations view in the activity bar (opencodePlus.sessions): one row per saved conversation, most recently
 * active first, with its title, how long ago it was active and a status icon. Everything shown comes from the injected
 * listSessions(); the list is redrawn when the injected onDidChange fires and when the view becomes visible again,
 * which also keeps the "5m" ages roughly current without a timer.
 *
 * Conversations open in this window come first, in a group of their own ("Open in this window"), and the rest after
 * them in another; with only one kind there are no groups.
 */

const RENAME_COMMAND = 'opencodePlus.renameConversation';
const DELETE_COMMAND = 'opencodePlus.deleteConversation';
const OPEN_COMMAND = 'opencodePlus.openConversation';
const CONTEXT_IDLE = 'opencodePlus.session';
const CONTEXT_BUSY = 'opencodePlus.session.busy';
const CONTEXT_GROUP = 'opencodePlus.group';
const GROUPS = Object.freeze({ open: 'Open in this window', other: 'Other conversations' });

const STATUS_WORDS = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle' };

function age(ms, now) {
  if (typeof ms !== 'number' || !isFinite(ms) || !ms) return '';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const mo = Math.floor(d / 30);
  const y = Math.floor(d / 365);
  return y > 0 ? `${y}y` : mo > 0 ? `${mo}mo` : d > 0 ? `${d}d` : h > 0 ? `${h}h` : m > 0 ? `${m}m` : 'now';
}

function lastActive(meta) {
  return meta.lastActiveAt || meta.lastReplyAt || meta.lastUserAt || meta.createdAt || 0;
}

function toOff(sub) {
  if (typeof sub === 'function') return sub;
  return () => sub && typeof sub.dispose === 'function' && sub.dispose();
}

class SessionsView {
  /**
   * @param {{
   *   listSessions: () => (object[] | Promise<object[]>),
   *   onDidChange?: (listener: () => void) => ({ dispose(): void } | Function),
   *   statusOf?: (meta: object) => ('working' | 'waiting' | 'idle'),
   *   rename: (id: string, title: string) => unknown,
   *   remove: (id: string) => unknown,
   *   idOf?: (arg: unknown) => string,
   *   titleOf?: (id: string) => string,
   *   isOpenHere?: (id: string) => boolean,
   *   vscode?: object,
   *   now?: () => number,
   * }} opts
   * `idOf` names the conversation of a command argument that is not a row or an id (a chat tab's URI, or nothing for
   * the tab in front); `titleOf` gives the title of one the list has not shown.
   */
  constructor(opts) {
    this.vscode = opts.vscode || require('vscode');
    this.listSessions = opts.listSessions;
    this.statusOf = opts.statusOf || ((meta) => meta.status || 'idle');
    this.renameSession = opts.rename;
    this.removeSession = opts.remove;
    this.idOf = typeof opts.idOf === 'function' ? opts.idOf : () => '';
    this.titleOf = typeof opts.titleOf === 'function' ? opts.titleOf : () => '';
    this.isOpenHere = typeof opts.isOpenHere === 'function' ? opts.isOpenHere : () => false;
    this.now = opts.now || Date.now;
    this.last = [];
    this.treeView = null;
    this.emitter = new this.vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.subs = [() => this.emitter.dispose()];
    if (typeof opts.onDidChange === 'function') this.subs.push(toOff(opts.onDidChange(() => this.refresh())));
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  async getChildren(element) {
    if (element) return element.group ? element.rows : [];
    let list;
    try {
      list = await this.listSessions();
      if (this.treeView) this.treeView.message = undefined;
    } catch (err) {
      if (this.treeView) this.treeView.message = `Couldn't list conversations: ${(err && err.message) || err}`;
      return [];
    }
    this.last = (Array.isArray(list) ? list : []).filter((m) => m && m.id)
      .sort((a, b) => lastActive(b) - lastActive(a));
    const here = (m) => { try { return this.isOpenHere(m.id) === true; } catch (_) { return false; } };
    const open = this.last.filter(here);
    const other = this.last.filter((m) => !here(m));
    if (!open.length || !other.length) return this.last;
    return [{ group: 'open', label: GROUPS.open, rows: open }, { group: 'other', label: GROUPS.other, rows: other }];
  }

  getTreeItem(meta) {
    const vscode = this.vscode;
    if (meta && meta.group) {
      const g = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.Expanded);
      g.id = `group:${meta.group}`;
      g.description = String(meta.rows.length);
      g.contextValue = CONTEXT_GROUP;
      return g;
    }
    const status = this.statusOf(meta) || 'idle';
    const title = meta.title || 'Untitled conversation';
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    const now = this.now();
    item.id = meta.id;
    item.description = age(lastActive(meta), now);
    item.iconPath = status === 'working'
      ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'))
      : status === 'waiting'
        ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.red'))
        : new vscode.ThemeIcon('comment-discussion');
    /* The extension host may run on another machine in another time zone (Remote-SSH), so the time names its zone. */
    const ago = item.description;
    const when = lastActive(meta)
      ? `${ago === 'now' ? 'just now' : `${ago} ago`} (${new Date(lastActive(meta)).toLocaleString(undefined, { timeZoneName: 'short' })})`
      : '';
    item.tooltip = [
      title,
      `${STATUS_WORDS[status] || status}${when ? ` · last active ${when}` : ''}`,
      meta.cwd ? `Folder: ${meta.cwd}` : '',
      meta.modelId ? `Model: ${meta.modelId}` : '',
      `ID: ${meta.id}`,
    ].filter(Boolean).join('\n');
    item.contextValue = status === 'idle' ? CONTEXT_IDLE : CONTEXT_BUSY;
    item.command = { command: OPEN_COMMAND, title: 'Open Conversation', arguments: [meta.id] };
    return item;
  }

  /* Creates the tree view and registers Rename and Delete. Returns one disposable for all of it. */
  register() {
    const vscode = this.vscode;
    this.treeView = vscode.window.createTreeView('opencodePlus.sessions', { treeDataProvider: this });
    const disposables = [
      this.treeView,
      this.treeView.onDidChangeVisibility((e) => {
        if (e.visible) this.refresh();
      }),
      vscode.commands.registerCommand(RENAME_COMMAND, (arg) => this.promptRename(arg)),
      vscode.commands.registerCommand(DELETE_COMMAND, (arg) => this.confirmDelete(arg)),
    ];
    return { dispose: () => disposables.forEach((d) => d && d.dispose && d.dispose()) };
  }

  find(arg) {
    let id = typeof arg === 'string' ? arg : arg && typeof arg.id === 'string' ? arg.id : '';
    let row = id && typeof arg === 'object' ? arg : null;
    if (!id) {
      try { id = String(this.idOf(arg) || ''); } catch (_) { id = ''; }
      row = null;
    }
    if (!id) return null;
    const known = this.last.find((m) => m.id === id);
    if (known) return known;
    if (row) return row;
    let title = '';
    try { title = String(this.titleOf(id) || ''); } catch (_) { title = ''; }
    return { id, title };
  }

  async promptRename(arg) {
    const meta = this.find(arg);
    if (!meta) return false;
    const title = await this.vscode.window.showInputBox({
      prompt: 'New title for the conversation',
      value: meta.title || '',
      validateInput: (v) => (v.trim() ? null : 'Enter a title.'),
    });
    if (title === undefined || !title.trim()) return false;
    try {
      await this.renameSession(meta.id, title.trim());
    } catch (err) {
      this.vscode.window.showErrorMessage(`Couldn't rename the conversation: ${(err && err.message) || err}`);
      return false;
    }
    this.refresh();
    return true;
  }

  async confirmDelete(arg) {
    const meta = this.find(arg);
    if (!meta) return false;
    const window = this.vscode.window;
    if ((this.statusOf(meta) || 'idle') !== 'idle') {
      window.showInformationMessage('Stop the conversation before deleting it.');
      return false;
    }
    const title = meta.title || 'Untitled conversation';
    const choice = await window.showWarningMessage(`Delete "${title}"?`,
      { modal: true, detail: 'The conversation is removed from disk and cannot be restored.' }, 'Delete');
    if (choice !== 'Delete') return false;
    try {
      await this.removeSession(meta.id);
    } catch (err) {
      window.showErrorMessage(`Couldn't delete the conversation: ${(err && err.message) || err}`);
      return false;
    }
    this.refresh();
    return true;
  }

  dispose() {
    for (const off of this.subs) off();
    this.subs = [];
  }
}

module.exports = {
  SessionsView,
  age,
  RENAME_COMMAND,
  DELETE_COMMAND,
  OPEN_COMMAND,
  CONTEXT_IDLE,
  CONTEXT_BUSY,
  CONTEXT_GROUP,
  GROUPS,
};
