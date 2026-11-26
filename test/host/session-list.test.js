// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Through extension.js with the window tests' fake backend: the source registered with Agent Plus carries the session
 * list's members, lists a conversation of the folder with its state, renames it, will not delete it while it is open,
 * deletes it once closed together with its plan files, writes seen back, and gives its Account & usage part.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const { vscode, control } = fake.create();
fake.install(vscode);
process.env.OPENCODE_AGENT_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext-list-'));
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

const memento = (m) => ({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } });
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'storage')),
  globalState: memento(new Map()),
  workspaceState: memento(new Map()),
  extension: { packageJSON: { version: '0.0.1' } },
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
};

test('through extension.js: the session list\'s rows and actions for a conversation of this window', async () => {
  control.state.config['opencodeAgentPlus.model'] = 'fake/fake-small';
  const api = extension.activate(context);
  await api.test.registered;
  const source = api.test.source;
  for (const k of ['listSessions', 'onDidChangeSessions', 'runSessionAction', 'describeDeletion', 'wantSessionDetail', 'importSessions', 'noteSeen', 'accountInfo', 'onDidChangeAccountInfo']) {
    assert.ok(source[k], `the source has ${k}`);
  }
  assert.deepStrictEqual(source.sessionActions.open, ['tab']);

  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  const id = opened[0].slice('opencodeagentplus-session:/'.length).split('/')[0];
  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscode.Uri.from({ scheme: 'opencodeagentplus-session', path: `/${id}` })), panel);
  panel.fromPage({ type: 'ready' });
  const folder = api.test.snapshot(id).cwd;

  const empty = (await source.listSessions({ folders: [folder], cursor: null, limit: 500 })).sessions.find((s) => s.sessionId === id);
  assert.ok(empty, 'the new conversation is listed');
  assert.strictEqual(empty.kind, 'empty', 'no message yet');
  assert.strictEqual((await source.listSessions({ folders: [path.join(folder, 'elsewhere-not-here')] })).sessions.length, 0, 'not for another folder');

  await api.test.send(id, 'Reply with only the word alpha.');
  await until(() => { const s = api.test.snapshot(id); return s && s.activity === 'stopped' && s.lastReplyAt; });
  const row = (await source.listSessions({ folders: [folder] })).sessions.find((s) => s.sessionId === id);
  assert.strictEqual(row.kind, 'user');
  assert.strictEqual(row.activity, 'stopped');
  assert.ok(row.lastReplyAt > 0 && row.lastActiveAt >= row.lastReplyAt);

  assert.deepStrictEqual((await source.runSessionAction('rename', [id], { title: 'Named by the list' })).results, [{ sessionId: id, outcome: 'done' }]);
  assert.strictEqual((await source.listSessions({ folders: [folder] })).sessions.find((s) => s.sessionId === id).title, 'Named by the list');

  await source.noteSeen([id], true);
  assert.strictEqual((await source.listSessions({ folders: [folder] })).sessions.find((s) => s.sessionId === id).viewedAt, row.lastReplyAt, 'seen is written back');

  const info = await source.accountInfo({ sessionId: id });
  assert.ok(info && info.conversation, 'the conversation in front has its figures');

  const refused = (await source.runSessionAction('delete', [id], {})).results[0];
  assert.strictEqual(refused.outcome, 'refused');
  assert.match(refused.reason, /open in this window/);

  const plans = path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, `${id}.json`), '{}');
  panel.dispose();
  await until(() => !api.test.snapshot(id));
  assert.deepStrictEqual((await source.runSessionAction('delete', [id], {})).results, [{ sessionId: id, outcome: 'done' }]);
  assert.ok(!(await source.listSessions({ folders: [folder] })).sessions.some((s) => s.sessionId === id), 'gone from the list');
  assert.ok(!fs.existsSync(path.join(plans, `${id}.json`)), 'and its plan file with it');

  const entry = JSON.parse(fs.readFileSync(path.join(plans, 'windows', `${process.pid}.json`), 'utf8'));
  assert.ok(Array.isArray(entry.sessions) && typeof entry.name === 'string', 'the window entry Agent Plus reads');
  extension.deactivate();
});
