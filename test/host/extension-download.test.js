// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* A window with no OpenCode: the list says how to get one, the offer comes once, its button downloads (a stand-in for
   download.js's download(), so nothing goes to the network), and without a reload the list is drawn again and a new
   conversation starts. */
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

test('no OpenCode: the list says how to get one and the offer comes once', async () => {
  control.state.answers.push([OFFER, undefined]);
  const api = extension.activate(context);
  const tree = control.state.trees['opencodeAgentPlus.sessions'];
  assert.deepStrictEqual(await tree.opts.treeDataProvider.getChildren(), []);
  assert.match(tree.message, /^Couldn't list conversations: OpenCode was not found\. Install OpenCode 2 with/);
  assert.ok(tree.message.endsWith(DOWNLOAD_HINT), tree.message);
  await settle();
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.newConversation'](), false);
  await tree.opts.treeDataProvider.getChildren();
  await settle();
  const offers = control.state.said.filter((s) => s.message.startsWith(OFFER));
  assert.strictEqual(offers.length, 1, 'once in a window, however often OpenCode is missed');
  assert.deepStrictEqual(offers[0].buttons, ['Download OpenCode']);
  assert.ok(control.state.said.some((s) => s.kind === 'error' && s.message.startsWith('OpenCode was not found.') && s.message.endsWith(DOWNLOAD_HINT)));
  assert.strictEqual(api.test.downloadOffered(), true);
  assert.deepStrictEqual(fetched, [], 'dismissed: nothing fetched');
  assert.notStrictEqual(control.state.context['opencodeAgentPlus.canRename'], true, 'no Rename entries without OpenCode');
});

test('the command downloads it; the list is drawn again and a new conversation starts, without a reload', async () => {
  const tree = control.state.trees['opencodeAgentPlus.sessions'];
  let redrawn = 0;
  tree.opts.treeDataProvider.onDidChangeTreeData(() => { redrawn++; });
  assert.strictEqual(await control.state.handlers['opencodeAgentPlus.downloadOpenCode'](), true);
  assert.strictEqual(fetched.length, 1);
  assert.strictEqual(fetched[0].userAgent, 'opencode-agent-plus');
  assert.ok(control.state.progress.some((p) => p.cancellable === true && /^Downloading OpenCode 2\.4\.1 from GitHub \(\d+ MB\)$/.test(p.title)), JSON.stringify(control.state.progress));
  assert.ok(await until(() => redrawn > 0), 'the Conversations view is drawn again');
  assert.deepStrictEqual(await tree.opts.treeDataProvider.getChildren(), []);
  assert.strictEqual(tree.message, undefined, 'no error left in the list');
  assert.ok(control.state.said.some((s) => s.message === 'OpenCode 2.4.1 is ready. New conversations use it.'));
  assert.ok(await until(() => control.state.context['opencodeAgentPlus.canRename'] === true), 'Rename is learned again');
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
