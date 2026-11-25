// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node build/download-check.js
 *
 * Downloads OpenCode into a temporary folder. CI runs this on six platforms of the archive table; the two musl builds are
 * not among them.
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-download-'));
for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
  process.env[name] = path.join(root, 'xdg', name.toLowerCase());
  fs.mkdirSync(process.env[name], { recursive: true });
}
process.env.OPENCODE_AGENT_PLUS_HOME = root;
process.env.OPENCODE_DISABLE_AUTOUPDATE = '1';

const download = require('../src/opencode/download');
const server = require('../src/opencode/server');

function fail(text) {
  console.error(text);
  process.exit(1);
}

(async () => {
  const a = download.asset();
  if (!a) fail(`No OpenCode ${download.VERSION} archive is listed for ${process.platform} ${process.arch}.`);
  console.log(`${process.platform} ${process.arch}: ${a.name}, ${a.size} bytes`);
  let shown = -1;
  const started = Date.now();
  const r = await download.download({
    root,
    onProgress: (n, total) => {
      const tenth = Math.floor((n * 10) / total);
      if (tenth !== shown) { shown = tenth; console.log(`  ${tenth * 10}%`); }
    },
    onStep: (step) => console.log(`  ${step}`),
  });
  console.log(`${r.said} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (!r.ok) fail('The download failed.');
  const found = server.findOpenCode({ env: { PATH: '' }, home: path.join(root, 'home'), downloaded: download.executable(root) });
  console.log(`findOpenCode: ${found.path}, version ${JSON.stringify(found.version)}`);
  if (path.resolve(found.path) !== path.resolve(download.executable(root))) fail('findOpenCode did not pick the downloaded copy.');
  const said = childProcess.execFileSync(found.path, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim();
  console.log(`--version: ${said}`);
  if (!said.includes(download.VERSION)) fail(`--version did not report ${download.VERSION}.`);
  /* Windows can keep opencode.exe locked for a moment after it exits, so removing the folder may need a few tries. */
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) {
    console.log(`note: the temporary folder was left in place: ${(e && e.message) || e}`);
  }
})().catch((e) => fail((e && e.stack) || String(e)));
