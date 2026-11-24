// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Just enough of the vscode API for the chat panel and the sessions view, recording what they call. */
const path = require('path');

class Uri {
  constructor(scheme, p, query = '') {
    this.scheme = scheme;
    this.path = p;
    this.query = query;
  }
  static file(p) {
    return new Uri('file', p);
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.posix.join(base.path, ...parts), '');
  }
  static from({ scheme, path: p = '', query = '' }) {
    return new Uri(scheme, p, query);
  }
  static parse(s) {
    const m = /^([a-zA-Z][\w+.-]*):(.*)$/.exec(s);
    return m ? new Uri(m[1], m[2]) : new Uri('file', s);
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return { dispose: () => this.listeners.delete(fn) };
    };
  }
  fire(v) {
    for (const fn of [...this.listeners]) fn(v);
  }
  dispose() {
    this.listeners.clear();
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

function createFakeVscode(answers = {}) {
  const rec = {
    providers: new Map(),
    commands: [],
    registered: new Map(),
    clipboard: '',
    opened: [],
    errors: [],
    infos: [],
    warnings: [],
    inputs: [],
    treeViews: [],
  };
  const vscode = {
    rec,
    Uri,
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    workspace: {
      registerTextDocumentContentProvider(scheme, provider) {
        if (rec.providers.has(scheme)) throw new Error(`provider for ${scheme} already registered`);
        rec.providers.set(scheme, provider);
        return { dispose: () => rec.providers.delete(scheme) };
      },
    },
    commands: {
      executeCommand: async (...args) => {
        rec.commands.push(args);
      },
      registerCommand(id, fn) {
        rec.registered.set(id, fn);
        return { dispose: () => rec.registered.delete(id) };
      },
    },
    env: {
      clipboard: { writeText: async (t) => { rec.clipboard = t; } },
      openExternal: async (u) => {
        rec.opened.push(u.toString());
        return true;
      },
    },
    window: {
      showErrorMessage: async (m) => { rec.errors.push(m); },
      showInformationMessage: async (m) => { rec.infos.push(m); },
      showWarningMessage: async (m, ...rest) => {
        rec.warnings.push([m, ...rest]);
        return answers.warning;
      },
      showInputBox: async (o) => {
        rec.inputs.push(o);
        return answers.input;
      },
      createTreeView(id, options) {
        const visibility = new EventEmitter();
        const view = { id, options, message: undefined, onDidChangeVisibility: visibility.event, visibility, dispose() {} };
        rec.treeViews.push(view);
        return view;
      },
    },
  };
  return vscode;
}

function createFakePanel() {
  const receive = new EventEmitter();
  const viewState = new EventEmitter();
  const disposed = new EventEmitter();
  const panel = {
    posted: [],
    visible: true,
    webview: {
      options: null,
      html: '',
      cspSource: 'https://fake.webview',
      asWebviewUri: (u) => `https://fake.webview${u.path}`,
      postMessage: async (m) => {
        panel.posted.push(m);
        return true;
      },
      onDidReceiveMessage: receive.event,
    },
    onDidChangeViewState: viewState.event,
    onDidDispose: disposed.event,
    fromPage: (msg) => receive.fire(msg),
    hide() {
      panel.visible = false;
      viewState.fire({ webviewPanel: panel });
    },
    show() {
      panel.visible = true;
      viewState.fire({ webviewPanel: panel });
    },
    dispose: () => disposed.fire(),
  };
  return panel;
}

module.exports = { createFakeVscode, createFakePanel, Uri };
