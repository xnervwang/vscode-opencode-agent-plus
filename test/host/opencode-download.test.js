// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* src/host/opencode-download.js with a fake download module, and the backend's error listener it hangs on. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createOpenCodeDownload, COMMAND, BUTTON } = require('../../src/host/opencode-download');
const { createBackend } = require('../../src/host/backend');

const notFound = () => Object.assign(new Error('OpenCode was not found.'), { name: 'OpenCodeError', code: 'notFound' });
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/* Drops the time src/shared/notice-time.js puts before a notification. */
const unstamp = (m) => (typeof m === 'string' ? m.replace(/^\[[^\]]+\] /, '') : m);

/* A fake vscode.window that records what is shown. `pick` is the button the offer resolves with; `cancel()` presses
   Cancel on the progress notification. */
function fakeVscode({ pick } = {}) {
  const state = { asked: [], errors: [], progress: [], reports: [] };
  const cancelled = new EventEmitter();
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      showInformationMessage: async (text, ...buttons) => { state.asked.push({ text: unstamp(text), buttons }); return pick; },
      showErrorMessage: async (text) => { state.errors.push(unstamp(text)); },
      withProgress: async (opts, task) => {
        state.progress.push(opts);
        const token = { isCancellationRequested: false,
          onCancellationRequested: (fn) => { cancelled.on('cancel', fn); return { dispose: () => cancelled.off('cancel', fn) }; } };
        return task({ report: (r) => state.reports.push(r) }, token);
      },
    },
  };
  return { vscode, state, cancel: () => cancelled.emit('cancel') };
}

/* A fake src/opencode/download.js whose download() resolves to `result`; with `hold` it waits for release() or a cancel. */
function fakeLib({ result = { ok: true, path: '/r/opencode/2.4.1/opencode', said: 'in place' }, available = true, hold = false } = {}) {
  const calls = [];
  let release = () => {};
  const lib = {
    VERSION: '2.4.1',
    available: () => available,
    asset: () => (available ? { name: 'opencode-linux-x64-baseline.tar.gz', size: 130647866 } : null),
    download: async (opts) => {
      calls.push(opts);
      opts.onProgress(13064787, 130647866);
      opts.onProgress(13064790, 130647866);
      opts.onProgress(65323933, 130647866);
      if (hold) await new Promise((r) => { release = r; opts.signal.addEventListener('abort', r); });
      if (opts.signal.aborted) return { ok: false, cancelled: true, said: 'The download of OpenCode 2.4.1 was cancelled.' };
      opts.onProgress(130647866, 130647866);
      opts.onStep('Unpacking');
      return result;
    },
  };
  return { lib, calls, release: () => release() };
}

test('the first notFound in a window offers the download once; other errors and later ones do not', async () => {
  const { vscode, state } = fakeVscode({ pick: undefined });
  const { lib, calls } = fakeLib();
  const told = [];
  const d = createOpenCodeDownload({ vscode, lib, tell: (t) => told.push(t) });
  assert.equal(COMMAND, 'opencodeAgentPlus.downloadOpenCode');
  assert.equal(await d.offer(Object.assign(new Error('x'), { code: 'configuredNotFound' })), false);
  assert.equal(await d.offer(new Error('something else')), false);
  assert.equal(d.offered, false);
  assert.equal(await d.offer(notFound()), false, 'dismissed');
  assert.equal(await d.offer(notFound()), false);
  assert.equal(state.asked.length, 1);
  assert.deepEqual(state.asked[0], { text: 'OpenCode was not found. Download OpenCode 2.4.1 from GitHub (125 MB)? If you install OpenCode yourself, that one is used instead.', buttons: [BUTTON] });
  assert.equal(BUTTON, 'Download OpenCode');
  assert.equal(calls.length, 0, 'nothing is fetched without the click');
  assert.equal(d.offered, true);
});

test('with no archive for the machine there is no offer, and the command says so', async () => {
  const { vscode, state } = fakeVscode({ pick: BUTTON });
  const { lib, calls } = fakeLib({ available: false });
  const told = [];
  const d = createOpenCodeDownload({ vscode, lib, tell: (t) => told.push(t) });
  assert.equal(await d.offer(notFound()), false);
  assert.equal(state.asked.length, 0);
  assert.equal(await d.run(), false);
  assert.match(told[0], /^OpenCode 2\.4\.1 is not published for this machine \(.+\)\. Install OpenCode yourself\.$/);
  assert.equal(calls.length, 0);
});

test('the button downloads with the percentage shown, and done() gets the result', async () => {
  const { vscode, state } = fakeVscode({ pick: BUTTON });
  const { lib, calls } = fakeLib();
  const done = [];
  const d = createOpenCodeDownload({ vscode, lib, done: (r) => done.push(r), ask: (text, ...b) => vscode.window.showInformationMessage(text, ...b) });
  assert.equal(await d.offer(notFound()), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userAgent, 'opencode-agent-plus');
  assert.deepEqual(state.progress, [{ location: 15, cancellable: true, title: 'Downloading OpenCode 2.4.1 from GitHub (125 MB)' }]);
  assert.deepEqual(state.reports, [{ increment: 10, message: '10%' }, { increment: 40, message: '50%' }, { increment: 50, message: '100%' }, { message: 'Unpacking' }],
    'one report per new percent');
  assert.deepEqual(done, [{ ok: true, path: '/r/opencode/2.4.1/opencode', said: 'in place' }]);
});

test('one download at a time in a window: a second click gets the first one', async () => {
  const { vscode } = fakeVscode();
  const f = fakeLib({ hold: true });
  const done = [];
  const d = createOpenCodeDownload({ vscode, lib: f.lib, done: (r) => done.push(r) });
  const a = d.run();
  const b = d.run();
  await settle();
  assert.equal(f.calls.length, 1);
  f.release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(done.length, 1);
  const c = d.run();
  await settle();
  f.release();
  assert.equal(await c, true, 'a second download can start after the first ends');
  assert.equal(f.calls.length, 2);
});

test('Cancel aborts the download; nothing is used and the user is told', async () => {
  const { vscode, cancel, state } = fakeVscode();
  const f = fakeLib({ hold: true });
  const told = [];
  const done = [];
  const d = createOpenCodeDownload({ vscode, lib: f.lib, tell: (t) => told.push(t), done: (r) => done.push(r) });
  const going = d.run();
  await settle();
  cancel();
  assert.equal(await going, false);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.deepEqual(told, ['The download of OpenCode 2.4.1 was cancelled.']);
  assert.deepEqual(done, []);
  assert.deepEqual(state.errors, []);
});

test('a failed download shows an error and nothing is used', async () => {
  const { vscode, state } = fakeVscode();
  const { lib } = fakeLib({ result: { ok: false, said: 'opencode-linux-x64-baseline.tar.gz did not match its recorded size and SHA-256 and was deleted.' } });
  const done = [];
  const d = createOpenCodeDownload({ vscode, lib, done: (r) => done.push(r) });
  assert.equal(await d.run(), false);
  assert.deepEqual(state.errors, ['OpenCode Agent Plus: downloading OpenCode failed. opencode-linux-x64-baseline.tar.gz did not match its recorded size and SHA-256 and was deleted.']);
  assert.deepEqual(done, []);
});

test('the backend passes each error of a call to onError before its caller gets it', async () => {
  const heard = [];
  const backend = createBackend({ load: () => ({ createOpenCode: () => ({
    listSessions: async () => { throw notFound(); },
    detect: () => { throw notFound(); },
    createSession: async () => ({ id: 'ses_1' }),
  }) }), onError: (e) => { heard.push(e.code); throw new Error('a listener that throws changes nothing'); } });
  await assert.rejects(backend.listSessions(), (e) => e.code === 'notFound');
  await assert.rejects(backend.detect(), (e) => e.code === 'notFound');
  assert.deepEqual(await backend.createSession('/w'), { id: 'ses_1' });
  assert.deepEqual(heard, ['notFound', 'notFound']);
});
