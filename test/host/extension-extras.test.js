// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Through extension.js with the window tests' fake backend: the reader's time zone written for the plugin, the info
 * box's rows, the chimes' setting shared by the pages, forking from Agent Plus's list, the MCP list in an output
 * channel, and a diff's title bar on a request already answered.
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
process.env.OPENCODE_AGENT_PLUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'na-ext3-'));
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = path.join(ROOT, 'test', 'vscode', 'fake-backend.js');
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const extension = require('../../extension');

const memo = new Map();
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(process.env.OPENCODE_AGENT_PLUS_HOME, 'storage')),
  globalState: { get: (k, d) => (memo.has(k) ? memo.get(k) : d), update: async (k, v) => { memo.set(k, v); } },
  extension: { packageJSON: { version: '0.0.1' } },
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('through extension.js: the time zone, the info box, the chimes, Fork from the list, the MCP list, and a diff whose request was answered', async () => {
  const api = extension.activate(context);
  const opened = [];
  control.state.handlers['vscode.openWith'] = (uri) => opened.push(uri.toString());
  await control.state.handlers['opencodeAgentPlus.newConversation']();
  const id = opened[0].slice('opencodeagentplus-session:/'.length).split('/')[0];
  const provider = control.state.editors['opencodeAgentPlus.chat'].provider;
  const panel = control.panel();
  await provider.resolveCustomEditor(provider.openCustomDocument(vscode.Uri.from({ scheme: 'opencodeagentplus-session', path: `/${id}` })), panel);
  assert.strictEqual(api.test.chats(), 1);

  /* The page's zone goes to the plans folder, where the plugin's time-zone hook reads it. */
  panel.fromPage({ type: 'ready', tz: 'America/Los_Angeles' });
  await settle();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(api.test.zoneFile(), 'utf8')), { timeZone: 'America/Los_Angeles' });
  assert.strictEqual(memo.get('opencodeAgentPlus.timeZone'), 'America/Los_Angeles');
  const caps = panel.webview.posted.filter((m) => m.type === 'caps').pop();
  assert.deepStrictEqual([caps.rewind, caps.info, caps.replyImages], [false, true, true], 'the fake backend cannot rewind');

  /* The info box. */
  const rows = await api.test.infoRows(id);
  assert.deepStrictEqual(rows.map((r) => r.label), ['Session', 'Folder', 'OpenCode', 'Session database', 'Token mode']);
  assert.strictEqual(rows[0].value, id);
  assert.match(rows[2].value, /^2\.0\.0-fake, acp process \d+$/);
  assert.match(rows[3].value, /fake-backend\.json$/);
  assert.strictEqual(rows[4].value, 'All features');

  /* The chimes are on until muted; the setting is kept, and every page is told. */
  assert.strictEqual(panel.webview.posted.filter((m) => m.type === 'sound').pop().on, true);
  panel.fromPage({ type: 'setSound', on: false });
  await settle();
  assert.strictEqual(api.test.sound(), false);
  assert.strictEqual(memo.get('opencodeAgentPlus.sound'), false);
  assert.strictEqual(panel.webview.posted.filter((m) => m.type === 'sound').pop().on, false);

  /* Fork from Agent Plus's list, the source's own action on the row: a new conversation opens in a tab of its own. */
  const folder = api.test.snapshot(id).cwd;
  const before = (await api.test.source.listSessions({ folders: [folder] })).sessions;
  assert.deepStrictEqual(before.map((r) => [r.sessionId, r.actions]), [[id, ['fork']]]);
  assert.deepStrictEqual(api.test.source.sessionActions.own, [{ id: 'fork', title: 'Fork Conversation' }]);
  assert.deepStrictEqual((await api.test.source.runSessionAction('fork', [id], {})).results, [{ sessionId: id, outcome: 'done' }]);
  assert.strictEqual(opened.length, 2);
  assert.notStrictEqual(opened[1], opened[0]);
  assert.strictEqual(control.state.context['opencodeAgentPlus.canFork'], true);
  const after = (await api.test.source.listSessions({ folders: [folder] })).sessions;
  assert.strictEqual(after.length, 2, 'the fork is listed beside it');

  /* The MCP list goes to an output channel of its own. */
  const text = await control.state.handlers['opencodeAgentPlus.showMcpServers']();
  assert.match(text, /No MCP servers configured/);
  assert.strictEqual(control.state.shownChannel, 'OpenCode Agent Plus: MCP Servers');
  assert.ok(control.state.log.some((l) => /opencode mcp add/.test(String(l))));

  const said = control.state.said.length;
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.diffAllowOnce'](vscode.Uri.from({ scheme: 'opencodeAgentPlus-diff', path: '/p9/after/a.js' })), false);
  assert.match(control.state.said[said].message, /already been answered/);
  extension.deactivate();
});
