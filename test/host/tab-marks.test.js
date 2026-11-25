// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* A chat tab's state dot (its icon) and the envelope after its title while a reply is unread. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-vscode');

const { vscode, control } = fake.create();
fake.install(vscode);
const { ChatEditorProvider } = require('../../src/host/chat-editor');
const { createSessionManager } = require('../../src/host/session-manager');
const { uriOf } = require('../../src/host/agentplus-source');
const { tabIcons, DOTS } = require('../../src/host/logo');
const marks = require('../../src/shared/title-marks');
const envelope = require('../../src/shared/envelope');

const ROOT = path.join(__dirname, '..', '..');
const A = 'ses_tabmarks0000000000000a';

function setup(title = 'Saved title') {
  const convs = [];
  const manager = createSessionManager({
    info: async (id) => ({ id, title, cwd: '/w', status: 'idle' }),
    makeConversation: async () => {
      const listeners = new Set();
      const c = { on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, fire: (e) => listeners.forEach((f) => f(e)), send() {}, abort() {}, dispose() {} };
      convs.push(c);
      return c;
    },
  });
  let theme = 2;
  const look = new Set();
  const icons = { stopped: { light: 'stopped-l', dark: 'stopped-d' }, working: { light: 'working-l', dark: 'working-d' }, waiting: { light: 'waiting-l', dark: 'waiting-d' } };
  const env = { window: { get activeColorTheme() { return { kind: theme }; }, onDidChangeActiveColorTheme: (fn) => { look.add(fn); return { dispose: () => look.delete(fn) }; } } };
  const provider = new ChatEditorProvider({
    manager,
    show: () => ({ dispose() {} }),
    focus: () => {},
    label: (s) => marks.withMarks(s.title, { unseen: s.unseen, envelope: envelope.envelope(env) }),
    iconFor: (a) => icons[a === 'working' || a === 'waiting' ? a : 'stopped'],
    onDidChangeLook: (fn) => envelope.onEnvelopeChange(env, fn),
  });
  return { manager, provider, convs, icons, setTheme: (k) => { theme = k; for (const fn of [...look]) fn(); }, looks: () => look.size };
}

const open = (provider, uri, panel) => provider.resolveCustomEditor(provider.openCustomDocument(uri), panel);

test('the tab icon follows working, waiting and stopped; an unread reply puts an envelope after the title until seen', async () => {
  const s = setup();
  const panel = control.panel();
  await open(s.provider, uriOf(A), panel);
  assert.strictEqual(panel.title, 'Saved title');
  assert.strictEqual(panel.iconPath, s.icons.stopped);
  s.convs[0].fire({ type: 'turnStart', at: 1 });
  assert.strictEqual(panel.iconPath, s.icons.working);
  s.convs[0].fire({ type: 'permission', requestId: 'p1', request: { tool: 'bash' } });
  assert.strictEqual(panel.iconPath, s.icons.waiting);
  s.convs[0].fire({ type: 'permissionSettled', requestId: 'p1', decision: 'allowOnce' });
  assert.strictEqual(panel.iconPath, s.icons.working);
  s.convs[0].fire({ type: 'turnEnd', reason: 'endTurn', at: 5 });
  assert.strictEqual(panel.iconPath, s.icons.stopped);
  assert.strictEqual(panel.title, 'Saved title \u{1F4E9}', 'a dark theme draws the envelope with the arrow');
  s.setTheme(1);
  assert.strictEqual(panel.title, 'Saved title ✉︎', 'a light theme draws the plain envelope as text');
  panel.setActive(false);
  panel.setActive(true);
  assert.strictEqual(panel.title, 'Saved title', 'coming to the front takes the envelope away');
  panel.dispose();
  assert.strictEqual(s.looks(), 0, 'the theme listener goes with the tab');
});

test('a title that already carries an envelope or a crown shows without them, and one envelope while unread', async () => {
  const s = setup('Report \u{1F4E9} draft \u{1F451}');
  const panel = control.panel();
  await open(s.provider, uriOf(A), panel);
  assert.strictEqual(panel.title, 'Report draft');
  s.convs[0].fire({ type: 'turnEnd', reason: 'endTurn', at: 5 });
  assert.strictEqual(panel.title, 'Report draft \u{1F4E9}');
  s.convs[0].fire({ type: 'turnStart', at: 6 });
  s.convs[0].fire({ type: 'turnEnd', reason: 'aborted', at: 7 });
  assert.strictEqual(panel.title, 'Report draft \u{1F4E9}', 'a stopped turn leaves the earlier unread reply unread');
});

test('tab icons: the logo in each theme colour, a green or red dot for working and waiting, written once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-icons-'));
  try {
    const files = tabIcons(ROOT, dir);
    assert.deepStrictEqual(Object.keys(files), ['stopped', 'working', 'waiting']);
    const read = (f) => fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(read(files.stopped.dark), /circle cx="19"/);
    assert.match(read(files.working.dark), new RegExp(`fill="${DOTS.working}"`));
    assert.match(read(files.waiting.light), new RegExp(`fill="${DOTS.waiting}"`));
    /* The logo is in the theme's icon colour, whether it is drawn with fills or strokes. */
    assert.match(read(files.waiting.light), /(fill|stroke)="#424242"/);
    assert.match(read(files.waiting.dark), /(fill|stroke)="#c5c5c5"/);
    assert.doesNotMatch(read(files.working.dark), /currentColor/);
    for (const f of [files.stopped.light, files.working.dark]) assert.match(path.basename(f), /^tab-(stopped|working)-(light|dark)-[0-9a-f]{10}\.svg$/);
    const before = fs.statSync(files.working.dark).mtimeMs;
    const again = tabIcons(ROOT, dir);
    assert.deepStrictEqual(again, files);
    assert.strictEqual(fs.statSync(files.working.dark).mtimeMs, before);
    assert.strictEqual(tabIcons('/no/such/extension', dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
