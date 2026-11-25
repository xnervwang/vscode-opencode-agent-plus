// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* src/opencode/download.js with an injected fetch and unpack, so nothing goes to the network, and findOpenCode's order. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const dl = require('../../src/opencode/download');
const { findOpenCode, OpenCodeError, DOWNLOAD_HINT } = require('../../src/opencode/server');
const { createOpenCode } = require('../../src/opencode');
const { fakeStarter } = require('./fake-agent');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpRoot = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oap-dl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const LINUX = dl.asset('linux', 'x64', false);
/* A fetch that writes a small file and says what fetchFile would say of the bytes it wrote: by default the size and
   SHA-256 recorded for the linux x64 archive. */
const fakeFetch = (said = { sha256: LINUX.sha256, bytes: LINUX.size }, calls = []) => async (url, file, { onProgress } = {}) => {
  calls.push(url);
  fs.writeFileSync(file, 'archive bytes');
  if (onProgress) { onProgress(Math.floor(said.bytes / 2)); onProgress(said.bytes); }
  return said;
};
/* An unpack that puts an `opencode` (or `name`) into the folder. */
const fakeUnpack = (name = 'opencode', calls = []) => async (archive, dir, opts) => {
  calls.push({ archive, dir, opts });
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho 2.4.1\n', { mode: 0o644 });
  return true;
};
const leftovers = (root) => fs.readdirSync(dl.folder(root)).filter((n) => n.startsWith('.'));

test('the archive for each platform: baseline on x64, musl where Linux has no glibc, none elsewhere', () => {
  const names = {
    'darwin arm64': 'opencode-darwin-arm64.zip',
    'darwin x64': 'opencode-darwin-x64-baseline.zip',
    'linux x64': 'opencode-linux-x64-baseline.tar.gz',
    'linux arm64': 'opencode-linux-arm64.tar.gz',
    'win32 x64': 'opencode-windows-x64-baseline.zip',
    'win32 arm64': 'opencode-windows-arm64.zip',
  };
  for (const [k, name] of Object.entries(names)) {
    const [platform, arch] = k.split(' ');
    const a = dl.asset(platform, arch, false);
    assert.equal(a.name, name, k);
    assert.equal(a.url, `https://github.com/anomalyco/opencode/releases/download/v2.4.1/${name}`);
    assert.equal(a.kind, name.endsWith('.tar.gz') ? 'tar.gz' : 'zip');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.size > 100e6 && a.size < 140e6, `${k}: ${a.size}`);
    assert.equal(dl.available(platform, arch), true);
  }
  assert.equal(dl.asset('linux', 'x64', true).name, 'opencode-linux-x64-baseline-musl.tar.gz');
  assert.equal(dl.asset('linux', 'arm64', true).name, 'opencode-linux-arm64-musl.tar.gz');
  assert.equal(dl.asset('darwin', 'arm64', true).name, 'opencode-darwin-arm64.zip', 'musl is a Linux question only');
  assert.equal(dl.asset('win32', 'x64', true).name, 'opencode-windows-x64-baseline.zip');
  for (const [platform, arch] of [['win32', 'ia32'], ['linux', 'ia32'], ['linux', 'arm'], ['freebsd', 'x64'], ['darwin', 'ppc64']]) {
    assert.equal(dl.asset(platform, arch, false), null, `${platform} ${arch}`);
    assert.equal(dl.available(platform, arch), false);
  }
  assert.equal(LINUX.size, 130647866);
  assert.equal(LINUX.sha256, '9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47');
});

test('musl is told by the report Node gives: no glibcVersionRuntime in its header', () => {
  assert.equal(dl.isMusl({ getReport: () => ({ header: { glibcVersionRuntime: '2.26' } }) }), false);
  assert.equal(dl.isMusl({ getReport: () => ({ header: {} }) }), true);
  assert.equal(dl.isMusl({ getReport: () => { throw new Error('no report'); } }), false);
  assert.equal(dl.isMusl(undefined), false);
});

test('it lives in <root>/opencode/2.4.1, opencode.exe on Windows', () => {
  assert.equal(dl.home('/r'), path.join('/r', 'opencode', '2.4.1'));
  assert.equal(dl.executable('/r', 'linux'), path.join('/r', 'opencode', '2.4.1', 'opencode'));
  assert.equal(dl.executable('/r', 'win32'), path.join('/r', 'opencode', '2.4.1', 'opencode.exe'));
});

test('findOpenCode takes the user\'s own OpenCode first and the downloaded one only when there is no other', () => {
  const home = '/home/u';
  const env = { PATH: ['/usr/bin', '/opt/tools'].join(path.delimiter) };
  const downloaded = '/data/opencode/2.4.1/opencode';
  const version = (p) => ({ major: 2, minor: 4, patch: 1, text: p === downloaded ? '2.4.1' : '2.9.0' });
  const has = (set) => (p) => set.includes(p);
  const find = (set, more = {}) => findOpenCode({ env, home, platform: 'linux', arch: 'x64', downloaded, isExecutable: has(set), readVersion: version, ...more });
  assert.equal(find([downloaded, '/opt/tools/opencode']).path, '/opt/tools/opencode', 'PATH first');
  assert.equal(find([downloaded, '/home/u/.opencode/bin/opencode']).path, '/home/u/.opencode/bin/opencode', 'the installers\' places next');
  assert.equal(find([downloaded, '/home/u/x/opencode'], { configured: '~/x/opencode' }).path, '/home/u/x/opencode', 'the setting before all');
  const r = find([downloaded]);
  assert.equal(r.path, downloaded);
  assert.equal(r.version.text, '2.4.1');
  assert.throws(() => find([downloaded], { configured: '/nope/opencode' }),
    (e) => e instanceof OpenCodeError && e.code === 'configuredNotFound' && e.message.includes('/nope/opencode') && !e.message.includes(DOWNLOAD_HINT),
    'a configured path that is not there does not fall back to the download');
});

test('findOpenCode\'s notFound names the download command where there is an archive for the machine', () => {
  const opts = { env: { PATH: '' }, home: '/h', downloaded: '/d/opencode', isExecutable: () => false, readVersion: () => null };
  assert.throws(() => findOpenCode({ ...opts, platform: 'linux', arch: 'x64' }),
    (e) => e.code === 'notFound' && e.message.endsWith(DOWNLOAD_HINT) && /opencode\.ai\/install/.test(e.message));
  assert.match(DOWNLOAD_HINT, /^Or run "OpenCode Agent Plus: Download OpenCode 2\.4\.1" from the Command Palette to download it\.$/);
  assert.throws(() => findOpenCode({ ...opts, platform: 'win32', arch: 'ia32' }), (e) => e.code === 'notFound' && !e.message.includes(DOWNLOAD_HINT));
  /* By default the downloaded copy is looked for under OPENCODE_AGENT_PLUS_HOME. */
  const saved = process.env.OPENCODE_AGENT_PLUS_HOME;
  process.env.OPENCODE_AGENT_PLUS_HOME = '/agent-home';
  try {
    const seen = [];
    assert.throws(() => findOpenCode({ env: { PATH: '' }, home: '/h', platform: 'linux', isExecutable: (p) => { seen.push(p); return false; }, readVersion: () => null }));
    assert.equal(seen[seen.length - 1], path.join('/agent-home', 'opencode', '2.4.1', 'opencode'), 'and it is tried last');
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_AGENT_PLUS_HOME; else process.env.OPENCODE_AGENT_PLUS_HOME = saved;
  }
});

test('a download that matches is unpacked and moved into place, and the archive goes', async (t) => {
  const root = tmpRoot(t);
  const fetched = [];
  const unpacked = [];
  const progress = [];
  const steps = [];
  const r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch(undefined, fetched), unpack: fakeUnpack('opencode', unpacked),
    onProgress: (n, total) => progress.push([n, total]), onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true, r.said);
  assert.equal(r.path, dl.executable(root, 'linux'));
  assert.deepEqual(fetched, [LINUX.url]);
  assert.equal(unpacked[0].opts.kind, 'tar.gz');
  assert.ok(unpacked[0].archive.endsWith('.tar.gz'), unpacked[0].archive);
  assert.deepEqual(progress, [[Math.floor(LINUX.size / 2), LINUX.size], [LINUX.size, LINUX.size]]);
  assert.deepEqual(steps, ['Unpacking']);
  assert.deepEqual(fs.readdirSync(dl.folder(root)), ['2.4.1'], 'only the finished folder is left');
  assert.deepEqual(fs.readdirSync(dl.home(root)), ['opencode']);
  if (process.platform !== 'win32') fs.accessSync(r.path, fs.constants.X_OK);
  const again = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: () => { throw new Error('not fetched again'); } });
  assert.deepEqual([again.ok, again.already], [true, true]);
});

test('a download whose SHA-256 or size does not match is thrown away whole', async (t) => {
  const root = tmpRoot(t);
  let unpacked = 0;
  const unpack = async () => { unpacked++; return true; };
  let r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch({ sha256: sha(Buffer.from('other')), bytes: LINUX.size }), unpack });
  assert.equal(r.ok, false);
  assert.match(r.said, /^opencode-linux-x64-baseline\.tar\.gz did not match its recorded size and SHA-256, so it was thrown away\.$/);
  r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch({ sha256: LINUX.sha256, bytes: LINUX.size - 1 }), unpack });
  assert.equal(r.ok, false);
  assert.equal(unpacked, 0, 'nothing that failed the check is unpacked');
  assert.deepEqual(fs.readdirSync(dl.folder(root)), [], 'no archive, no folder');
});

test('a failed unpack, or an archive without the executable, leaves nothing behind', async (t) => {
  const root = tmpRoot(t);
  let r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch(), unpack: async () => false });
  assert.deepEqual([r.ok, r.said], [false, 'Unpacking opencode-linux-x64-baseline.tar.gz failed.']);
  r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch(), unpack: fakeUnpack('something-else') });
  assert.deepEqual([r.ok, r.said], [false, 'opencode-linux-x64-baseline.tar.gz had no opencode in it.']);
  r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.deepEqual([r.ok, r.said], [false, 'ECONNRESET']);
  assert.deepEqual(fs.readdirSync(dl.folder(root)), []);
});

test('cancelling stops the download and removes the part already written', async (t) => {
  const root = tmpRoot(t);
  const stop = new AbortController();
  let partial = '';
  const fetch = (url, file, { signal }) => new Promise((resolve, reject) => {
    fs.writeFileSync(file, 'half');
    partial = file;
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    setTimeout(() => stop.abort(), 10);
  });
  const r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, signal: stop.signal, fetch, unpack: fakeUnpack() });
  assert.deepEqual([r.ok, r.cancelled], [false, true]);
  assert.equal(r.said, 'The download of OpenCode 2.4.1 was cancelled.');
  assert.ok(partial && !fs.existsSync(partial), 'the part written is gone');
  assert.deepEqual(fs.readdirSync(dl.folder(root)), []);
  /* Cancelled after the bytes arrived but before they were used: also nothing kept. */
  const late = new AbortController();
  const r2 = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, signal: late.signal,
    fetch: async (...a) => { const got = await fakeFetch()(...a); late.abort(); return got; }, unpack: fakeUnpack() });
  assert.equal(r2.cancelled, true);
  assert.deepEqual(fs.readdirSync(dl.folder(root)), []);
});

test('when another window put it in place first, its copy is kept and ours goes', async (t) => {
  const root = tmpRoot(t);
  const unpack = async (archive, dir) => {
    fs.writeFileSync(path.join(dir, 'opencode'), 'ours', { mode: 0o755 });
    fs.mkdirSync(dl.home(root), { recursive: true });
    fs.writeFileSync(dl.executable(root, 'linux'), 'theirs', { mode: 0o755 });
    return true;
  };
  const r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch(), unpack });
  assert.deepEqual([r.ok, r.already], [true, true]);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'theirs');
  assert.deepEqual(fs.readdirSync(dl.folder(root)), ['2.4.1']);
});

test('what a window closed halfway left is swept, but not what a running one is writing', async (t) => {
  const root = tmpRoot(t);
  const dir = dl.folder(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['.2.4.1.999001.aa.tar.gz', '.2.4.1.999001.aa.unpack', '.2.4.1.999002.bb.tar.gz', '.2.4.0.999001.cc.tar.gz', 'notes.txt']) {
    if (n.endsWith('.unpack')) fs.mkdirSync(path.join(dir, n)); else fs.writeFileSync(path.join(dir, n), 'x');
  }
  dl.sweep(dir, (pid) => pid === 999002);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.2.4.0.999001.cc.tar.gz', '.2.4.1.999002.bb.tar.gz', 'notes.txt']);
  const r = await dl.download({ root, platform: 'linux', arch: 'x64', musl: false, fetch: fakeFetch(), unpack: fakeUnpack(), isAlive: () => false });
  assert.equal(r.ok, true);
  assert.deepEqual(leftovers(root).sort(), ['.2.4.0.999001.cc.tar.gz'], 'the download sweeps first; another version is not its business');
});

test('no archive for the machine: nothing is fetched', async (t) => {
  const root = tmpRoot(t);
  const r = await dl.download({ root, platform: 'win32', arch: 'ia32', fetch: () => { throw new Error('fetched'); } });
  assert.deepEqual(r, { ok: false, said: 'OpenCode 2.4.1 is not published for win32 ia32.' });
  assert.equal(fs.existsSync(dl.folder(root)), false);
});

/* A stand-in for https.get: `routes` maps a URL to { status, location } or { status: 200, chunks }. */
function fakeGet(routes, seen = []) {
  return (url, options, cb) => {
    seen.push({ url, agent: options.headers['User-Agent'] });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (e) => { setImmediate(() => req.emit('error', e)); };
    const r = routes[url];
    setImmediate(() => {
      if (!r) { req.emit('error', new Error(`no route ${url}`)); return; }
      let i = 0;
      const res = new Readable({ read() {
        if (r.stall && i >= r.chunks.length - 1) return;
        this.push(i < (r.chunks || []).length ? Buffer.from(r.chunks[i++]) : null);
      } });
      res.statusCode = r.status;
      res.headers = r.location ? { location: r.location } : {};
      if (options.signal) options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; res.destroy(e); req.emit('error', e); });
      cb(res);
    });
    return req;
  };
}

test('fetchFile follows the redirect, hashes what it writes and reports each chunk', async (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, 'a.tar.gz');
  const seen = [];
  const get = fakeGet({
    'https://github.com/x/a.tar.gz': { status: 302, location: 'https://objects.example/a?sig=1' },
    'https://objects.example/a?sig=1': { status: 200, chunks: ['abc', 'def', 'gh'] },
  }, seen);
  const progress = [];
  const r = await dl.fetchFile('https://github.com/x/a.tar.gz', file, { get, userAgent: 'opencode-agent-plus', onProgress: (n) => progress.push(n) });
  assert.deepEqual(r, { sha256: sha(Buffer.from('abcdefgh')), bytes: 8 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdefgh');
  assert.deepEqual(progress, [3, 6, 8]);
  assert.deepEqual(seen.map((s) => s.url), ['https://github.com/x/a.tar.gz', 'https://objects.example/a?sig=1']);
  assert.ok(seen.every((s) => s.agent === 'opencode-agent-plus'));
  await assert.rejects(dl.fetchFile('https://github.com/x/b', file, { get: fakeGet({ 'https://github.com/x/b': { status: 404 } }) }), /answered 404/);
  const loop = fakeGet({ 'https://l/1': { status: 302, location: 'https://l/1' } });
  await assert.rejects(dl.fetchFile('https://l/1', file, { get: loop }), /answered 302/, 'redirects stop after five hops');
});

test('fetchFile stops when cancelled, with the file closed so it can be removed', async (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, 'a.tar.gz');
  const stop = new AbortController();
  const get = fakeGet({ 'https://g/a': { status: 200, chunks: ['abc', 'def', 'never'], stall: true } });
  const going = dl.fetchFile('https://g/a', file, { get, signal: stop.signal, onProgress: (n) => { if (n === 6) stop.abort(); } });
  await assert.rejects(going, (e) => e.name === 'AbortError');
  fs.rmSync(file);
  await assert.rejects(dl.fetchFile('https://g/a', file, { get, signal: stop.signal }), (e) => e.name === 'AbortError', 'already cancelled');
  assert.equal(fs.existsSync(file), false);
});

test('extract runs tar for tar.gz, ditto then unzip on macOS, and tar.exe on Windows', async () => {
  const ran = [];
  const run = (fail) => (bin, args, opts, cb) => { ran.push([path.basename(bin), ...args]); setImmediate(() => cb(fail.includes(path.basename(bin)) ? new Error('no') : null)); };
  assert.equal(await dl.extract('/a.tar.gz', '/d', { kind: 'tar.gz', platform: 'linux', run: run([]) }), true);
  assert.deepEqual(ran.pop(), ['tar', '-xzf', '/a.tar.gz', '-C', '/d']);
  assert.equal(await dl.extract('/a.zip', '/d', { kind: 'zip', platform: 'darwin', run: run(['ditto']) }), true);
  assert.deepEqual(ran.splice(0), [['ditto', '-x', '-k', '/a.zip', '/d'], ['unzip', '-q', '-o', '/a.zip', '-d', '/d']]);
  assert.equal(await dl.extract('C:\\a.zip', 'C:\\d', { kind: 'zip', platform: 'win32', run: run([]) }), true);
  assert.deepEqual(ran.splice(0).map((r) => r.slice(1)), [['-xf', 'C:\\a.zip', '-C', 'C:\\d']]);
  assert.equal(await dl.extract('/a.tar.gz', '/d', { kind: 'tar.gz', platform: 'linux', run: run(['tar']) }), false);
});

test('after notFound the same backend finds OpenCode on its next start, without being made again', async (t) => {
  const root = tmpRoot(t);
  let there = false;
  const starter = fakeStarter('v2-run.jsonl', []);
  const finds = [];
  const oc = createOpenCode({ root, idleStopMs: 0, startAcp: starter.start, findOpenCode: (o) => {
    finds.push(o);
    if (!there) throw new OpenCodeError('notFound', 'OpenCode was not found.');
    return { path: dl.executable(root, 'linux'), version: { major: 2, minor: 4, patch: 1, text: '2.4.1' } };
  } });
  t.after(() => oc.dispose());
  await assert.rejects(oc.createSession('/work/project'), (e) => e.code === 'notFound');
  await assert.rejects(oc.listSessions(), (e) => e.code === 'notFound');
  assert.equal(oc.canRename(), false);
  there = true;
  assert.equal(oc.canRename(), true);
  assert.equal(oc.detect().path, dl.executable(root, 'linux'));
  const s = await oc.createSession('/work/project');
  assert.ok(s.id);
  assert.equal(oc.info().path, dl.executable(root, 'linux'));
  assert.ok(finds.length >= 4, 'it looked each time');
});
