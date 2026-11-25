// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Restricted Mode. Until the workspace is trusted the extension starts no OpenCode and no conversation, writes no file
 * and registers no Agent Plus source. It registers stand-ins that tell the user to trust the workspace: its commands, its
 * chat editor, and an empty Conversations view whose text is a viewsWelcome entry in package.json. Once trust is granted
 * they give way to the real ones without a reload, and a chat tab already open is handed to the real chat editor.
 *
 * The chat editor is registered here in every case, since VS Code takes one provider per view type; start() hands it
 * the real provider through useEditor().
 */
const crypto = require('crypto');
const brand = require('../brand');

const TRUST_COMMAND = 'workbench.trust.manage';
const MANAGE = 'Manage Workspace Trust';
const TEXT = `${brand.displayName} does nothing in Restricted Mode. It starts when you trust this workspace.`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* The button asks the extension to open Manage Workspace Trust: a command: link would make VS Code itself ask first,
   since in Restricted Mode it lets a webview's link run a command only in a trusted workspace. */
function page(nonce = crypto.randomBytes(16).toString('base64')) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 20px; }
button { font: inherit; padding: 4px 12px; border: none; border-radius: 2px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style></head>
<body><p id="restricted">${esc(TEXT)}</p>
<p><button id="manage" type="button">${esc(MANAGE)}</button></p>
<script nonce="${nonce}">const vscode = acquireVsCodeApi();
document.getElementById('manage').addEventListener('click', () => vscode.postMessage({ type: 'manageTrust' }));</script></body></html>`;
}

/*
 * deps:
 *   vscode
 *   viewType      opencodePlus.chat (the chat editor)
 *   viewId        the Conversations view
 *   commands      the ids of the commands package.json contributes
 *   log(line)     optional
 */
function createTrustGate({ vscode, viewType, viewId, commands, log = () => {} }) {
  const subs = [];
  let real = null;
  /* Chat tabs showing the Restricted Mode page: panel -> { document, off: [disposables] }. */
  const waiting = new Map();
  const provider = {
    openCustomDocument(uri, ctx, token) {
      return real ? real.openCustomDocument(uri, ctx, token) : { uri, dispose() {} };
    },
    resolveCustomEditor(document, panel, token) {
      if (real) return real.resolveCustomEditor(document, panel, token);
      panel.webview.options = { enableScripts: true };
      panel.webview.html = page();
      const off = [
        panel.webview.onDidReceiveMessage((m) => { if (m && m.type === 'manageTrust') Promise.resolve(vscode.commands.executeCommand(TRUST_COMMAND)).catch(() => {}); }),
        panel.onDidDispose(() => { waiting.delete(panel); for (const d of off) d.dispose(); }),
      ];
      waiting.set(panel, { document, off });
      return undefined;
    },
  };
  subs.push(vscode.window.registerCustomEditorProvider(viewType, provider, { supportsMultipleEditorsPerDocument: false }));

  const trusted = () => vscode.workspace.isTrusted !== false;
  const tell = () => {
    Promise.resolve(vscode.window.showInformationMessage(TEXT, MANAGE))
      .then((pick) => (pick === MANAGE ? vscode.commands.executeCommand(TRUST_COMMAND) : undefined))
      .catch(() => {});
    return false;
  };

  let started = false;
  return {
    provider,
    get started() { return started; },
    /* Runs `start` now in a trusted workspace, or once trust is granted. */
    whenTrusted(start) {
      if (trusted()) { started = true; start(); return; }
      log('Restricted Mode: nothing starts until this workspace is trusted');
      const stubs = commands.map((id) => vscode.commands.registerCommand(id, tell));
      stubs.push(vscode.window.registerTreeDataProvider(viewId, { getChildren: () => [], getTreeItem: (x) => x }));
      subs.push(...stubs);
      if (typeof vscode.workspace.onDidGrantWorkspaceTrust !== 'function') return;
      const grant = vscode.workspace.onDidGrantWorkspaceTrust(() => {
        if (started) return;
        started = true;
        grant.dispose();
        for (const d of stubs) { try { d.dispose(); } catch (_) { /* gone */ } }
        log('the workspace is trusted; starting');
        start();
      });
      subs.push(grant);
    },
    useEditor(editor) {
      real = editor;
      const tabs = [...waiting];
      waiting.clear();
      for (const [panel, { document, off }] of tabs) {
        for (const d of off) d.dispose();
        Promise.resolve().then(() => real.resolveCustomEditor(document, panel)).catch((e) => log(`opening a chat tab once trusted: ${(e && e.message) || e}`));
      }
    },
    waiting: () => waiting.size,
    dispose() { for (const d of subs.splice(0)) { try { d.dispose(); } catch (_) { /* gone */ } } },
  };
}

module.exports = { createTrustGate, TEXT, MANAGE, TRUST_COMMAND, page };
