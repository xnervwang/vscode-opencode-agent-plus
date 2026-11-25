// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * "Fix with OpenCode Agent Plus" among the quick fixes where the editor reports an error or a warning
 * (opencodeAgentPlus.showFixActions). Picking it runs COMMAND with the file and the diagnostics at that place, which
 * puts a draft naming them into the message box of the chat tab in front, without sending it.
 */
const COMMAND = 'opencodeAgentPlus.fixWithOpenCode';
const TITLE = 'Fix with OpenCode Agent Plus';

/* The diagnostics of `context` (a CodeActionContext) worth offering a fix for: errors and warnings. */
function worthFixing(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : []).filter((d) => d && typeof d.message === 'string' && (d.severity === 0 || d.severity === 1));
}

/* A plain copy of a vscode.Diagnostic for the command's arguments: { severity, message, line, endLine, source, code }. */
function plain(d) {
  const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
  return { severity: d.severity, message: d.message, line: d.range ? d.range.start.line + 1 : 0, endLine: d.range ? d.range.end.line + 1 : 0,
    source: typeof d.source === 'string' ? d.source : '', code: code === undefined || code === null ? '' : String(code) };
}

/* `enabled()` reads the setting each time, so turning it off hides the action at once. */
function createFixActions({ vscode, enabled }) {
  const kind = vscode.CodeActionKind && vscode.CodeActionKind.QuickFix;
  return {
    provideCodeActions(document, range, context) {
      if (!enabled() || !document || !document.uri || document.uri.scheme !== 'file') return [];
      const found = worthFixing(context && context.diagnostics);
      if (!found.length) return [];
      const action = new vscode.CodeAction(TITLE, kind);
      action.diagnostics = found;
      action.command = { command: COMMAND, title: TITLE, arguments: [document.uri, found.map(plain)] };
      return [action];
    },
  };
}

/* Registers the provider for files of every language and returns its disposable, or null where the API is missing. */
function registerFixActions({ vscode, enabled }) {
  if (!vscode.languages || typeof vscode.languages.registerCodeActionsProvider !== 'function' || typeof vscode.CodeAction !== 'function') return null;
  const provider = createFixActions({ vscode, enabled });
  const kinds = vscode.CodeActionKind && vscode.CodeActionKind.QuickFix ? [vscode.CodeActionKind.QuickFix] : undefined;
  return vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, provider, kinds ? { providedCodeActionKinds: kinds } : undefined);
}

module.exports = { createFixActions, registerFixActions, worthFixing, plain, COMMAND, TITLE };
