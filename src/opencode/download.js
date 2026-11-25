// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Downloads OpenCode where none is installed: the command-line archive OpenCode publishes on GitHub for one fixed
 * version, checked against the size and SHA-256 recorded here and unpacked into <root>/opencode/<VERSION>/, where
 * findOpenCode (server.js) looks after the user's own installations.
 *
 * Nothing is fetched unless the user asks for it (src/host/opencode-download.js). The archive and the folder it is
 * unpacked into have temporary names beside the destination and are renamed into place only once the executable is in
 * them, so two windows downloading at once, or a window closed halfway, leave no half installation that findOpenCode
 * could pick up.
 *
 * x64 gets the baseline builds, which do not need AVX2.
 */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const VERSION = '2.4.1';
const BASE = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/`;
/* By platform-arch, with -musl for a Linux without glibc: archive name, size in bytes, SHA-256. */
const ASSETS = Object.freeze({
  'darwin-arm64': ['opencode-darwin-arm64.zip', 115188658, '95a101eda95108478f1db43cff8fcbd4811f6c0e79af1e167301843c6a48d731'],
  'darwin-x64': ['opencode-darwin-x64-baseline.zip', 115360638, '3dd6612423b69f7f282866112d99b6d690c8e07f27375b227f6a6ee4e652f5b5'],
  'linux-x64': ['opencode-linux-x64-baseline.tar.gz', 130647866, '9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47'],
  'linux-x64-musl': ['opencode-linux-x64-baseline-musl.tar.gz', 130099009, '3d8d0ba66d33e1631ebe61b5539cd2ef971a724ff68eb286554093bf55ba5c9f'],
  'linux-arm64': ['opencode-linux-arm64.tar.gz', 128876799, 'cb28cf94541aeb62a4b2ea5997a99b5dd6bae595a772f36fbe279299f2032a4f'],
  'linux-arm64-musl': ['opencode-linux-arm64-musl.tar.gz', 127637580, '814d92dc6ce172a382090797df7072b7fe0f2840f2440838228196789c0e352f'],
  'win32-x64': ['opencode-windows-x64-baseline.zip', 132524449, '40c4f842398abcba3837d554a2b0ddd9a11c5fae667f198e0bb716d101a2aab4'],
  'win32-arm64': ['opencode-windows-arm64.zip', 125335322, '03ccc3d6a9b46ab082cbf7f5f86ff07c4bfcd7b802dbafe1614c257b1a96df8e'],
});
const UNPACK_MS = 5 * 60 * 1000;

let muslSeen = null;
/* Node's report names the glibc it runs on; under musl it names none. */
function isMusl(report = process.report) {
  if (report === process.report && muslSeen !== null) return muslSeen;
  let musl = false;
  try {
    const header = report && typeof report.getReport === 'function' ? report.getReport().header : null;
    musl = !!header && !header.glibcVersionRuntime;
  } catch (_) { musl = false; }
  if (report === process.report) muslSeen = musl;
  return musl;
}

/* The archive for this machine, { name, size, sha256, url, kind }, or null where none is published. `musl` is read
   from the running Node when not given, and only on Linux. */
function asset(platform = process.platform, arch = process.arch, musl) {
  const libc = platform === 'linux' && (musl === undefined ? isMusl() : musl) ? '-musl' : '';
  const a = ASSETS[`${platform}-${arch}${libc}`];
  if (!a) return null;
  return { name: a[0], size: a[1], sha256: a[2], url: BASE + a[0], kind: a[0].endsWith('.tar.gz') ? 'tar.gz' : 'zip' };
}

/* A download exists for this platform and processor; which libc the machine has does not change the answer. */
const available = (platform = process.platform, arch = process.arch) => !!asset(platform, arch, false);

const folder = (root = paths.root()) => path.join(root, 'opencode');
const home = (root = paths.root()) => path.join(folder(root), VERSION);
const exeName = (platform = process.platform) => (platform === 'win32' ? 'opencode.exe' : 'opencode');
const executable = (root = paths.root(), platform = process.platform) => path.join(home(root), exeName(platform));

function abortError() {
  const e = new Error('The download was cancelled.');
  e.name = 'AbortError';
  return e;
}

/*
 * Fetches `url` into `file`, following up to `hops` redirects, and resolves to { sha256, bytes }. The digest is taken
 * from the bytes as they arrive. `signal` cancels it, `onProgress(bytes)` is called after each chunk, and `get` stands in
 * for https.get.
 */
function fetchFile(url, file, { signal, onProgress, userAgent = 'opencode-agent-plus', get } = {}, hops = 5) {
  const getter = get || require('https').get;
  const { pipeline } = require('stream');
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    let piped = false;
    const req = getter(url, { headers: { 'User-Agent': userAgent }, signal }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        piped = true;
        resolve(fetchFile(new URL(res.headers.location, url).toString(), file, { signal, onProgress, userAgent, get }, hops - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); piped = true; reject(new Error(`${url} answered ${res.statusCode}`)); return; }
      piped = true;
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      res.on('data', (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
        if (onProgress) { try { onProgress(bytes); } catch (_) { /* not shown */ } }
      });
      /* Settles once the file is closed, so that the caller can delete it, also on Windows. */
      pipeline(res, fs.createWriteStream(file, { mode: 0o600 }), (err) => {
        if (err) reject(signal && signal.aborted ? abortError() : err);
        else resolve({ sha256: hash.digest('hex'), bytes });
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('the download stalled for two minutes')));
    req.on('error', (e) => { if (!piped) reject(signal && signal.aborted ? abortError() : e); });
  });
}

/*
 * Unpacks `archive` into the folder `dir`; resolves to whether it worked. tar.gz goes to tar; a zip to ditto (unzip
 * if that fails) on macOS and, on Windows, to python-runtime's unzip (tar.exe, else Expand-Archive).
 */
function extract(archive, dir, { kind, platform = process.platform, run = childProcess.execFile } = {}) {
  const go = (bin, args) => new Promise((resolve) => {
    try { run(bin, args, { timeout: UNPACK_MS, windowsHide: true }, (err) => resolve(!err)); } catch (_) { resolve(false); }
  });
  if (kind === 'tar.gz') return go('tar', ['-xzf', archive, '-C', dir]);
  if (platform === 'win32') return require('../shared/python-runtime').unzip(archive, dir, run);
  return go('ditto', ['-x', '-k', archive, dir]).then((ok) => ok || go('unzip', ['-q', '-o', archive, '-d', dir]));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/* Removes the archives and folders a download of VERSION left in `dir` when the process that made it is gone. */
function sweep(dir, isAlive = processAlive) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const own = new RegExp(`^\\.${VERSION.replace(/\./g, '\\.')}\\.(\\d+)\\.`);
  for (const n of names) {
    const m = own.exec(n);
    if (!m || Number(m[1]) === process.pid || isAlive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (_) { /* tried again next time */ }
  }
}

const runs = (p, platform) => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) { return false; }
};

/*
 * Fetches, checks and unpacks OpenCode VERSION. Resolves to { ok, said, path } when the executable is in place (or
 * already was: `already`), or { ok: false, said, cancelled } otherwise; `said` is for the user. Whatever it made is
 * removed when it does not succeed.
 *   onProgress(bytes, total)   while downloading; onStep(text) before unpacking
 *   signal                     an AbortSignal that cancels it
 *   fetch, unpack, isAlive     fetchFile, extract and the process check, replaceable in tests
 */
async function download({ root = paths.root(), platform = process.platform, arch = process.arch, musl, signal, onProgress, onStep,
  userAgent = 'opencode-agent-plus', fetch = fetchFile, unpack = extract, isAlive = processAlive } = {}) {
  const a = asset(platform, arch, musl);
  if (!a) return { ok: false, said: `OpenCode ${VERSION} is not published for ${platform} ${arch}.` };
  const target = home(root);
  const exe = executable(root, platform);
  if (runs(exe, platform)) return { ok: true, already: true, path: exe, said: `OpenCode ${VERSION} is already in ${target}.` };
  const dir = folder(root);
  const tmp = path.join(dir, `.${VERSION}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  const archive = `${tmp}.${a.kind}`;
  const part = `${tmp}.unpack`;
  const clean = () => {
    for (const p of [archive, part]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* swept next time */ } }
  };
  const stopped = () => !!(signal && signal.aborted);
  const cancelled = () => { clean(); return { ok: false, cancelled: true, said: `The download of OpenCode ${VERSION} was cancelled.` }; };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweep(dir, isAlive);
    const got = await fetch(a.url, archive, { signal, userAgent, onProgress: onProgress ? (n) => onProgress(n, a.size) : undefined });
    if (stopped()) return cancelled();
    if (!got || got.bytes !== a.size || got.sha256 !== a.sha256) {
      clean();
      return { ok: false, said: `${a.name} did not match its recorded size and SHA-256 and was deleted.` };
    }
    if (onStep) { try { onStep('Unpacking'); } catch (_) { /* not shown */ } }
    fs.mkdirSync(part, { recursive: true, mode: 0o700 });
    if (!(await unpack(archive, part, { kind: a.kind, platform }))) { clean(); return { ok: false, said: `Unpacking ${a.name} failed.` }; }
    if (stopped()) return cancelled();
    const inner = path.join(part, exeName(platform));
    if (!fs.existsSync(inner)) { clean(); return { ok: false, said: `${a.name} had no ${exeName(platform)} in it.` }; }
    if (platform !== 'win32' && !runs(inner, platform)) fs.chmodSync(inner, 0o755);
    try { fs.rmSync(archive, { force: true }); } catch (_) { /* swept next time */ }
    try {
      fs.renameSync(part, target);
    } catch (e) {
      /* Another window got there first. */
      if (runs(exe, platform)) { clean(); return { ok: true, already: true, path: exe, said: `OpenCode ${VERSION} is in ${target}.` }; }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(part, target);
    }
    return { ok: true, path: exe, said: `OpenCode ${VERSION} is in ${target}.` };
  } catch (e) {
    if (stopped() || (e && e.name === 'AbortError')) return cancelled();
    clean();
    return { ok: false, said: (e && e.message) || String(e) };
  }
}

module.exports = { VERSION, ASSETS, BASE, asset, available, isMusl, folder, home, executable, fetchFile, extract, sweep, download };
