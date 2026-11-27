// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node build/latest-check.js [--version <v>] [--resolve]
 *
 * Runs the code this extension uses to work with OpenCode against the newest OpenCode published, rather than the
 * version src/opencode/download.js pins: .github/workflows/opencode-check.yml runs it once a day on each system, so that
 * a release which breaks the extension is known before users update to it.
 *
 * The newest version is the `latest` tag of @opencode/cli on npm, the one the install hint's `npm install -g` gets:
 * GitHub marks the newest 1.x release as its latest while 2.x is the line in use. For that version the script downloads
 * this machine's archive from the GitHub release under the name download.js uses, checks its size and SHA-256 against
 * the release and unpacks it; then the extension's own code finds it, starts it and makes a conversation with it. None
 * of this asks a model anything. Forking needs a message in the conversation, so it is checked only as a stated
 * capability.
 *
 * --resolve prints only the version it would check. Each failed check is a line starting "FAIL ". The exit status is
 * 0 when every check passed, 1 when one failed, and 2 when the check could not run at all (npm or GitHub unreachable,
 * no such release).
 */
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const at = args.indexOf('--version');
const given = at >= 0 ? String(args[at + 1] || '').replace(/^v/, '') : '';
const RESOLVE = args.includes('--resolve');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-latest-'));
for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
  process.env[name] = path.join(root, 'xdg', name.toLowerCase());
  fs.mkdirSync(process.env[name], { recursive: true });
}
process.env.OPENCODE_AGENT_PLUS_HOME = path.join(root, 'agent');
process.env.OPENCODE_DISABLE_AUTOUPDATE = '1';

const download = require('../src/opencode/download');
const server = require('../src/opencode/server');
const { createOpenCode } = require('../src/opencode');

const REPO = 'anomalyco/opencode';
let failed = 0;
let oc = null;

const cleanUp = () => {
  /* On Windows a process that has just been stopped can hold its files for a moment. */
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`(could not remove ${root}: ${e.message})`); }
};
const fail = (text) => { failed++; console.log(`FAIL ${text}`); };
const ok = (text) => console.log(`ok   ${text}`);
const check = (cond, good, bad) => { if (cond) ok(good); else fail(bad || good); return !!cond; };
async function cannot(text) {
  console.log(`could not run: ${text}`);
  if (oc) await oc.dispose().catch(() => {});
  cleanUp();
  process.exit(2);
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'opencode-agent-plus-check', Accept: 'application/json', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`${url} answered ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`${url} did not answer in a minute`)));
  });
}

async function newest() {
  if (given) return given;
  const d = await getJson('https://registry.npmjs.org/@opencode%2Fcli');
  const v = d && d['dist-tags'] && d['dist-tags'].latest;
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) throw new Error('npm has no latest version of @opencode/cli');
  return v;
}

const watchdog = setTimeout(() => { fail('the check took more than 20 minutes'); cleanUp(); process.exit(1); }, 20 * 60 * 1000);

(async () => {
  let version;
  try { version = await newest(); } catch (e) { return cannot(e.message); }
  if (RESOLVE) { console.log(version); clearTimeout(watchdog); cleanUp(); return; }
  console.log(`OpenCode ${version}, ${given ? 'as asked' : 'the newest on npm'} (the extension pins ${download.VERSION}), on ${process.platform} ${process.arch}`);

  const auth = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  let release;
  try { release = await getJson(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, auth); } catch (e) { return cannot(e.message); }
  const want = download.asset();
  if (!want) return cannot(`download.js lists no archive for ${process.platform} ${process.arch}`);
  const a = (release.assets || []).find((x) => x.name === want.name);
  if (!check(!!a, `the release has ${want.name}`, `the release v${version} has no ${want.name}`)) return finish();
  const digest = typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : '';

  const archive = path.join(root, want.name);
  const t0 = Date.now();
  let got;
  try { got = await download.fetchFile(a.browser_download_url, archive, {}); } catch (e) { return cannot(`downloading ${want.name}: ${e.message}`); }
  console.log(`     downloaded ${got.bytes} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(got.bytes === a.size, `its size matches the release, ${a.size} bytes`, `${want.name} is ${got.bytes} bytes, the release says ${a.size}`);
  if (digest) check(got.sha256 === digest, 'its SHA-256 matches the release', `${want.name} has SHA-256 ${got.sha256}, the release gives ${digest}`);
  else console.log('     the release has no SHA-256 for it');

  const dir = path.join(root, 'unpacked');
  fs.mkdirSync(dir, { recursive: true });
  const unpacked = await download.extract(archive, dir, { kind: want.kind });
  const exe = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  if (!check(unpacked && fs.existsSync(exe), `it unpacks to ${path.basename(exe)} at its top`,
    `${want.name} did not unpack to ${path.basename(exe)} at its top, where download.js looks for it`)) return finish();
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);

  oc = createOpenCode({
    root: process.env.OPENCODE_AGENT_PLUS_HOME,
    findOpenCode: (o) => server.findOpenCode({ ...o, env: { PATH: '' }, home: path.join(root, 'home'), downloaded: exe }),
    idleStopMs: 0,
    log: (line) => console.log(`     log: ${line}`),
  });
  let found;
  try { found = oc.detect(); } catch (e) { fail(`findOpenCode failed: ${e.message}`); return finish(); }
  check(path.resolve(found.path) === path.resolve(exe), 'findOpenCode picks it', `findOpenCode picked ${found.path}`);
  check(!!found.version && found.version.text === version, `its --version says ${version}`, `its --version gave ${JSON.stringify(found.version)}`);

  let info;
  const t1 = Date.now();
  try { info = await oc.start(); } catch (e) { fail(`it did not start over ACP: ${e.message}`); return finish(); }
  const caps = info.capabilities || {};
  const session = caps.sessionCapabilities || {};
  console.log(`     ACP answered in ${((Date.now() - t1) / 1000).toFixed(1)} s: ${JSON.stringify(info.agent)}; session capabilities `
    + `${Object.keys(session).join(', ') || 'none'}; prompt capabilities ${Object.keys(caps.promptCapabilities || {}).join(', ') || 'none'}`);
  for (const c of ['list', 'fork', 'close']) check(!!session[c], `it says it can ${c} conversations`, `it does not say it can ${c} conversations: no sessionCapabilities.${c}`);

  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const made = [];
  try {
    const s = await oc.createSession(cwd);
    const id = s && (s.sessionId || s.id);
    if (check(typeof id === 'string' && !!id, 'a new conversation gets a session id', `creating a conversation gave ${JSON.stringify(s)}`)) {
      made.push(id);
      const listed = await oc.listSessions({ cwd });
      const ids = (Array.isArray(listed) ? listed : (listed && listed.sessions) || []).map((x) => x.sessionId || x.id);
      check(ids.includes(id), 'the folder\'s conversation list has it', `the folder's list did not have it: ${JSON.stringify(ids)}`);
      if (oc.canRename()) { await oc.renameSession(id, 'Daily check'); ok('it renames the conversation'); }
    }
  } catch (e) { fail(`a conversation round trip failed: ${e.message}`); }
  for (const id of made) {
    try { await oc.deleteSession(id); } catch (e) { fail(`deleting ${id} failed: ${e.message}`); }
  }
  try {
    const p = await oc.dataPaths();
    check(!!(p && p.data), '`opencode debug paths` names its data folder', '`opencode debug paths` printed no data folder');
  } catch (e) { fail(`\`opencode debug paths\` failed: ${e.message}`); }
  return finish();
})().catch((e) => { fail((e && e.stack) || String(e)); return finish(); });

async function finish() {
  if (oc) { await oc.dispose().catch(() => {}); oc = null; }
  clearTimeout(watchdog);
  cleanUp();
  console.log(failed ? `${failed} of the checks above failed.` : 'Every check passed.');
  process.exit(failed ? 1 : 0);
}
