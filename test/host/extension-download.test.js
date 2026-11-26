// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* extension.js in a window with no OpenCode, with download.js's download() replaced so that nothing goes to the
   network. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const ROOT = path.join(__dirname, '..', '..');
const { vscode, control } = fake.create();
fake.install(vscode);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-ext-dl-'));
process.env.OPENCODE_AGENT_PLUS_HOME = HOME;
process.env.OPENCODE_AGENT_PLUS_TEST_BACKEND = path.join(__dirname, 'missing-opencode-backend.js');
process.env.OPENCODE_AGENT_PLUS_TEST_CONTROL = '1';
const dl = require('../../src/opencode/download');
const { DOWNLOAD_HINT } = require('../../src/opencode/server');
const extension = require('../../extension');

const fetched = [];
dl.download = async (opts) => {
  fetched.push(opts);
  opts.onProgress(1, 2);
  opts.onProgress(2, 2);
  fs.mkdirSync(dl.home(), { recursive: true });
  fs.writeFileSync(dl.executable(), '#!/bin/sh\n', { mode: 0o755 });
  return { ok: true, path: dl.executable(), said: `OpenCode 2.4.1 is in ${dl.home()}.` };
};
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await settle(20); } };
const context = {
  subscriptions: [],
  secrets: control.secrets,
  extensionPath: ROOT,
  extensionUri: vscode.Uri.file(ROOT),
  globalStorageUri: vscode.Uri.file(path.join(HOME, 'storage')),
  extension: { packageJSON: { version: '0.0.1' } },
};
const OFFER = 'OpenCode was not found. Download OpenCode 2.4.1 from GitHub (';

let api;
test('no OpenCode: the list says how to get one, with a button, and the download is offered once', async () => {
  control.state.answers.push([OFFER, undefined]);
  api = extension.activate(context);
  await api.test.registered;
  const source = api.test.source;
  assert.deepStrictEqual((await source.listSessions({ folders: [HOME] })).sessions, []);
  const notice = source.sessionsNotice();
  assert.match(notice.text, /^OpenCode was not found\. Install OpenCode 2 with/);
  assert.deepStrictEqual(notice.actions.map((a) => [a.label, a.command]), [['Download OpenCode', 'opencodeAgentPlus.downloadOpenCode'], ['Show Logs', 'opencodeAgentPlus.showLogs']]);
  await settle();
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.newConversation'](), false);
  await source.listSessions({ folders: [HOME] });
  await settle();
  const offers = control.state.said.filter((s) => s.message.startsWith(OFFER));
  assert.strictEqual(offers.length, 1);
  assert.deepStrictEqual(offers[0].buttons, ['Download OpenCode']);
  assert.ok(control.state.said.some((s) => s.kind === 'error' && s.message.startsWith('OpenCode was not found.') && s.message.endsWith(DOWNLOAD_HINT)));
  assert.strictEqual(api.test.downloadOffered(), true);
  assert.deepStrictEqual(fetched, [], 'dismissed: nothing fetched');
  assert.notStrictEqual(control.state.context['opencodeAgentPlus.canRename'], true, 'no Rename entries without OpenCode');
});

test('the command downloads OpenCode, and the list and a new conversation work without a reload', async () => {
  const source = api.test.source;
  let changed = 0;
  source.onDidChangeSessions(() => { changed++; });
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.downloadOpenCode'](), true);
  assert.strictEqual(fetched.length, 1);
  assert.strictEqual(fetched[0].userAgent, 'opencode-agent-plus');
  assert.ok(control.state.progress.some((p) => p.cancellable === true && /^Downloading OpenCode 2\.4\.1 from GitHub \(\d+ MB\)$/.test(p.title)), JSON.stringify(control.state.progress));
  assert.ok(await until(() => changed > 0), 'the list is told to read again');
  assert.deepStrictEqual((await source.listSessions({ folders: [HOME] })).sessions, []);
  assert.strictEqual(source.sessionsNotice(), null, 'no note left above the list');
  assert.ok(control.state.said.some((s) => s.message === 'OpenCode 2.4.1 is ready for new conversations.'));
  assert.ok(await until(() => control.state.context['opencodeAgentPlus.canRename'] === true), 'the Rename entries come back');
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.newConversation'](), true);
  assert.ok(control.state.commands.some((c) => c[0] === 'vscode.openWith'), 'its chat tab opens');
  assert.strictEqual(control.state.said.filter((s) => s.message.startsWith(OFFER)).length, 1, 'no second offer');
});

test('the download command shows in the Command Palette only in a trusted workspace', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.contributes.commands.find((c) => c.command === 'opencodeAgentPlus.downloadOpenCode'),
    { command: 'opencodeAgentPlus.downloadOpenCode', title: 'Download OpenCode 2.4.1', category: 'OpenCode Agent Plus' });
  assert.deepStrictEqual(pkg.contributes.menus.commandPalette.find((c) => c.command === 'opencodeAgentPlus.downloadOpenCode'),
    { command: 'opencodeAgentPlus.downloadOpenCode', when: 'isWorkspaceTrusted' });
  assert.strictEqual(pkg.contributes.commands.find((c) => c.command === 'opencodeAgentPlus.downloadOpenCode').title.endsWith(dl.VERSION), true);
});

test.after(() => {
  const d = extension.deactivate();
  return Promise.resolve(d).then(() => fs.rmSync(HOME, { recursive: true, force: true }));
});
