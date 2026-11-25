// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node build/npm-check.js [--prefix <folder>]
 *
 * Installs OpenCode the way the install hint tells users to, `npm install -g @opencode/cli`, into a prefix of its own
 * (a temporary one, removed afterwards, unless --prefix names one), with the version download.js pins. Then the
 * extension's own code finds it in that prefix alone, reads its version, starts `opencode acp`, waits for the answer
 * to initialize, runs one subcommand, and stops it. On Windows npm installs opencode.cmd, which Node does not start
 * without a shell, so this is where findOpenCode's reading of npm's launcher is tried for real. CI runs it on each
 * system.
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const at = args.indexOf('--prefix');
const given = at >= 0 ? path.resolve(args[at + 1] || '') : '';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-npm-'));
for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
  process.env[name] = path.join(root, 'xdg', name.toLowerCase());
  fs.mkdirSync(process.env[name], { recursive: true });
}
process.env.OPENCODE_AGENT_PLUS_HOME = path.join(root, 'agent');
process.env.OPENCODE_DISABLE_AUTOUPDATE = '1';

const download = require('../src/opencode/download');
const server = require('../src/opencode/server');
const { createOpenCode } = require('../src/opencode');

const prefix = given || path.join(root, 'npm');
/* npm's global layout: the launchers in the prefix itself on Windows, in <prefix>/bin elsewhere. */
const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });

let oc = null;

function cleanUp() {
  /* On Windows a process that has just been stopped can hold its files for a moment. */
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`(could not remove ${root}: ${e.message})`); }
}

async function fail(text) {
  console.error(text);
  if (oc) await oc.dispose().catch(() => {});
  cleanUp();
  process.exit(1);
}
const watchdog = setTimeout(() => fail('Gave up after 15 minutes.'), 15 * 60 * 1000);

/* A failed check: the message alone is printed. */
function check(ok, text) {
  if (!ok) throw Object.assign(new Error(text), { check: true });
}

/* npm is npm.cmd on Windows, which needs a shell; there its JavaScript is run with this Node instead. */
function npm() {
  if (process.platform !== 'win32') return ['npm'];
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  check(fs.existsSync(cli), `npm is not beside ${process.execPath} (no ${cli}).`);
  return [process.execPath, cli];
}

(async () => {
  const pkg = `@opencode/cli@${download.VERSION}`;
  const [cmd, ...pre] = npm();
  console.log(`npm install -g ${pkg} into ${prefix}`);
  const started = Date.now();
  const installed = childProcess.spawnSync(cmd, [...pre, 'install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', '--loglevel=error', pkg],
    { stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000 });
  check(!installed.error && installed.status === 0, `npm install failed: ${installed.error ? installed.error.message : `exit ${installed.status}`}`);
  console.log(`  installed (${((Date.now() - started) / 1000).toFixed(1)} s): ${fs.readdirSync(binDir).filter((n) => /^opencode/i.test(n)).join(', ')}`);

  oc = createOpenCode({
    root: process.env.OPENCODE_AGENT_PLUS_HOME,
    /* Only this prefix: no installer folder of the machine's, no downloaded copy. */
    findOpenCode: (o) => server.findOpenCode({ ...o, env: { PATH: binDir }, home, downloaded: '' }),
    idleStopMs: 0,
    log: (line) => console.log(`  log: ${line}`),
  });
  const found = oc.detect();
  console.log(`findOpenCode: ${found.path}, version ${JSON.stringify(found.version)}`);
  check(path.resolve(found.path).startsWith(path.resolve(prefix) + path.sep), 'findOpenCode did not pick the OpenCode npm installed.');
  if (process.platform === 'win32') {
    check(fs.existsSync(path.join(prefix, 'opencode.cmd')), `npm left no opencode.cmd in ${prefix}.`);
    check(/\.exe$/i.test(found.path), 'On Windows findOpenCode should give the opencode.exe that opencode.cmd runs.');
  }
  check(found.version && found.version.text === download.VERSION, `--version did not report ${download.VERSION}.`);

  const t0 = Date.now();
  const info = await oc.start();
  console.log(`acp answered initialize (${((Date.now() - t0) / 1000).toFixed(1)} s): ${JSON.stringify(info.agent)}, `
    + `capabilities ${Object.keys(info.capabilities || {}).join(', ')}`);
  const paths = await oc.dataPaths();
  console.log(`debug paths: ${Object.keys(paths).join(', ')}`);
  check(!!paths.data, '`opencode debug paths` named no data folder.');
  await oc.dispose();
  oc = null;
  console.log('stopped');
  clearTimeout(watchdog);
  cleanUp();
})().catch((e) => fail(e && e.check ? e.message : (e && e.stack) || String(e)));
