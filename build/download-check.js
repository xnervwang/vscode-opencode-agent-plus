// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node build/download-check.js
 *
 * Downloads OpenCode as the Download OpenCode command does, into a temporary folder, then has findOpenCode find it with
 * nothing on PATH and runs its --version, with OpenCode's own folders in that temporary folder too. CI runs it on each
 * platform the archive table covers; it exits 1 when any step fails.
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
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => fail((e && e.stack) || String(e)));
