// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One VS Code window for test/vscode/run.js, under xvfb-run on Linux: started with its own user data and extensions
 * folders, driven through Playwright over the DevTools protocol to read and click what is drawn, and through helper/ to
 * call the vscode API. The DevTools port is 0, so two runs on one machine do not collide; Chromium writes the port it took to
 * DevToolsActivePort in the user data folder. On Linux and macOS the process started for the window (xvfb-run, when it
 * is used) leads a process group of its own, which close() ends as a whole; on Windows close() ends the window's
 * process tree.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HELPER = path.join(__dirname, '..', 'helper');
const FLAGS = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
  '--disable-workspace-trust', '--use-inmemory-secretstorage', ...(process.platform === 'linux' ? ['--password-store=basic'] : [])];
const WINDOWS = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(test, ms, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await test(); } catch (_) { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

/* `exe` VS Code's executable; `profile` { exts, user, folder, control }; `env` the window's environment; `trust` leaves
   Workspace Trust on, which the user settings then decide. */
async function open({ exe, profile, env, playwright, log, size = '1600x1000', trust = false }) {
  fs.mkdirSync(profile.control, { recursive: true });
  const portFile = path.join(profile.user, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const args = [profile.folder, ...FLAGS.filter((f) => !trust || f !== '--disable-workspace-trust'), `--extensions-dir=${profile.exts}`, `--user-data-dir=${profile.user}`,
    `--extensionDevelopmentPath=${HELPER}`, '--remote-debugging-port=0'];
  const [prog, argv] = process.platform === 'linux' && !env.DISPLAY
    ? ['xvfb-run', ['-a', `--server-args=-screen 0 ${size}x24`, exe, ...args]]
    : [exe, args];
  const proc = spawn(prog, argv, { env: { ...env, OPENCODE_AGENT_PLUS_UI_CONTROL: profile.control }, stdio: ['ignore', 'pipe', 'pipe'], detached: !WINDOWS });
  const out = fs.createWriteStream(log);
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  let exited = null;
  proc.on('exit', (code, signal) => { exited = code === null ? signal : code; });

  const port = await until(() => {
    if (exited !== null) throw new Error(`VS Code exited (${exited}) before it opened a DevTools port; see ${log}`);
    const text = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : '';
    return /^\d+/.test(text) ? Number(text.split('\n')[0]) : 0;
  }, 90000);
  if (!port) throw new Error(`VS Code wrote no DevToolsActivePort in 90 s; see ${log}`);
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const workbench = () => browser.contexts().flatMap((c) => c.pages()).find((p) => /workbench\.html/.test(p.url()));
  const page = await until(workbench, 60000);
  if (!page) throw new Error('no workbench page among the DevTools targets');
  await page.waitForSelector('.monaco-workbench', { timeout: 90000 });

  let next = 0;
  const hosts = () => fs.readdirSync(profile.control).filter((n) => /^host-\d+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(profile.control, n), 'utf8')));
  const hostUp = async (after = 0) => {
    const h = await until(() => hosts().filter((x) => x.at > after).sort((a, b) => b.at - a.at)[0], 120000);
    if (!h) throw new Error('the helper extension did not start in the extension host in 120 s');
    return h;
  };
  /* Runs `body` in the extension host as an async function of (vscode, require, arg) and returns its result. */
  const call = async (body, arg, ms = 60000) => {
    const id = `r${process.pid}-${++next}`;
    const tmp = path.join(profile.control, `.${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ body, arg }));
    fs.renameSync(tmp, path.join(profile.control, `${id}.req.json`));
    const res = path.join(profile.control, `${id}.res.json`);
    const got = await until(() => fs.existsSync(res), ms, 100);
    if (!got) throw new Error(`no answer from the extension host in ${ms / 1000} s to: ${body.slice(0, 120)}`);
    const r = JSON.parse(fs.readFileSync(res, 'utf8'));
    fs.rmSync(res, { force: true });
    if (!r.ok) throw new Error(`in the extension host: ${r.error}`);
    return r.value;
  };
  const reload = async () => {
    const before = Date.now();
    await call('setTimeout(() => vscode.commands.executeCommand("workbench.action.reloadWindow"), 200); return true;');
    await sleep(2000);
    await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
    return hostUp(before);
  };
  const stop = (signal) => {
    if (WINDOWS) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-proc.pid, signal); } catch (_) { /* gone */ } }
  };
  const close = async () => {
    try { await browser.close(); } catch (_) { /* gone */ }
    stop('SIGTERM');
    await until(() => exited !== null, 10000);
    if (exited === null) stop('SIGKILL');
    out.end();
  };
  return { browser, page, call, reload, hostUp, close, proc };
}

/* Finds the webview frame on screen whose page has `selector`. A hidden tab's page stays loaded, so the first frame
   with `selector` may be one the user cannot see. */
async function frameWith(page, selector, ms = 30000) {
  const shown = async (f) => {
    let top = f;
    while (top.parentFrame() && top.parentFrame().parentFrame()) top = top.parentFrame();
    const el = top.parentFrame() ? await top.frameElement() : null;
    return !el || await el.isVisible();
  };
  return until(async () => {
    for (const f of page.frames()) {
      try { if (await f.$(selector) && await shown(f)) return f; } catch (_) { /* detached */ }
    }
    return null;
  }, ms, 300);
}

/* The chat page's model picker in frame `f`, read from the page: its two actions and each group's model ids. The
   list is drawn whether or not the picker is open. */
function modelChoices(f) {
  return f.evaluate(() => ({
    actions: [...document.querySelectorAll('#modelMenu .model-action')].map((r) => [r.dataset.action, r.querySelector('.menu-name').textContent]),
    groups: [...document.querySelectorAll('#modelMenu .model-group')].map((g) => ({ label: g.dataset.label, ids: [...g.querySelectorAll('[data-model-id]')].map((r) => r.dataset.modelId) })),
  }));
}

/* Picks `id` in the model picker of frame `f`, or the action 'connect' or 'reload': opens the picker from the pill,
   unfolds the row the model shares with its other geographies if it is folded, and clicks it. */
async function pickModel(f, id) {
  if (await f.evaluate(() => document.getElementById('modelMenu').hidden)) await f.click('#model');
  const sel = id === 'connect' || id === 'reload' ? `#modelMenu [data-action="${id}"]` : `#modelMenu [data-model-id="${id}"]`;
  await f.waitForSelector(sel, { state: 'attached', timeout: 10000 });
  if (!(await f.isVisible(sel))) {
    const family = await f.evaluate((s) => { const box = document.querySelector(s).closest('.model-family'); return box ? box.dataset.key : ''; }, sel);
    if (family) await f.click(`#modelMenu .model-row[data-family="${family}"]`);
  }
  await f.click(sel);
}

module.exports = { open, until, sleep, frameWith, modelChoices, pickModel };
