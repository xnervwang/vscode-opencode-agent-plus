// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The run of test/vscode/run.js with --download: a window that has no OpenCode to find. PATH has no folder with an
 * opencode in it, the setting is empty, the installers' places in the home hold none, and OPENCODE_AGENT_PLUS_HOME is
 * a new empty folder. The Conversations view says OpenCode was not found and a notification offers the download; its
 * button really downloads OpenCode from GitHub, the progress shows, and without a reload the list is drawn again and a
 * new conversation gets a reply from the real model through the downloaded OpenCode.
 */
const fs = require('fs');
const path = require('path');
const server = require('../../../src/opencode/server');
const dl = require('../../../src/opencode/download');

const OFFER = `OpenCode was not found. Download OpenCode ${dl.VERSION} from GitHub`;
const READY = `OpenCode ${dl.VERSION} is ready. New conversations use it.`;
const XDG = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

/* `env` with every PATH folder that holds an opencode left out; returns the new environment and the folders dropped. */
function withoutOpenCode(env, platform = process.platform) {
  const names = platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = String(env[key] || '').split(path.delimiter).filter(Boolean);
  const dropped = dirs.filter((d) => names.some((n) => fs.existsSync(path.join(d, n))));
  return { env: { ...env, [key]: dirs.filter((d) => !dropped.includes(d)).join(path.delimiter) }, dropped };
}

/* The OpenCode processes of this run: environment with the run's control folder, program an opencode. Linux only. */
function processes(control) {
  const found = [];
  if (process.platform !== 'linux') return found;
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let environ = [], argv = [];
    try { environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch (_) { continue; }
    if (!environ.includes(`OPENCODE_AGENT_PLUS_UI_CONTROL=${control}`) || path.basename(argv[0] || '') !== 'opencode') continue;
    const xdg = Object.fromEntries(environ.filter((l) => XDG.some((k) => l.startsWith(`${k}=`))).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    found.push({ pid: Number(pid), argv: argv.slice(0, 3), xdg });
  }
  return found;
}

/* t: { page, call, ext, check, shot, until, sleep, frameWith, control, home, env, xdgEnv } */
async function run(t) {
  const { page, call, ext, check, shot, until, sleep, frameWith } = t;
  const sidebar = '#workbench\\.parts\\.sidebar';
  const textOf = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : ''; }, sel);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-toast')].map((e) => e.textContent.trim()));
  const exe = dl.executable(t.home);

  // D1. Nothing to find: no setting, nothing on PATH or in the installers' places, an empty folder for the extension.
  const homeDir = t.env.HOME || t.env.USERPROFILE || '';
  const found = server.candidates({ env: t.env, platform: process.platform, home: homeDir }).filter((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const setting = await call('return vscode.workspace.getConfiguration("opencodeAgentPlus").get("opencode.path");');
  const hostEnv = await call(`return { home: process.env.OPENCODE_AGENT_PLUS_HOME, xdg: ${JSON.stringify(XDG)}.map((k) => process.env[k]) };`);
  check(found.length === 0 && !setting && hostEnv.home === t.home && !fs.existsSync(dl.folder(t.home)),
    'nothing to find: the setting is empty, no PATH folder or installer folder holds an opencode, and OPENCODE_AGENT_PLUS_HOME has no download', { found, setting, hostEnv });
  check(XDG.every((k, i) => hostEnv.xdg[i] === t.xdgEnv[k]), 'the extension host, and so every opencode it runs (--version too), has this run\'s four XDG folders', hostEnv.xdg);

  // D2. The Conversations view says OpenCode was not found, and the notification offers the download.
  const icon = await page.waitForSelector('.activitybar .action-item [aria-label^="OpenCode Agent Plus"]', { timeout: 30000 }).catch(() => null);
  if (icon) await icon.click();
  const message = await until(async () => {
    const text = await textOf(sidebar);
    return /Couldn't list conversations: OpenCode was not found\./.test(text) ? text : null;
  }, 60000);
  check(!!message && message.includes(server.DOWNLOAD_HINT), 'the Conversations view says OpenCode was not found and names the download command', message || await textOf(sidebar));
  const offer = await until(async () => (await toasts()).find((x) => x.includes(OFFER)) || null, 30000);
  const button = page.locator('.notifications-toasts .notification-toast', { hasText: OFFER }).locator('.monaco-button', { hasText: 'Download OpenCode' }).first();
  const hasButton = await button.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
  check(!!offer && hasButton, 'a notification offers to download OpenCode 2.4.1, with a Download OpenCode button', { offer, hasButton, toasts: await toasts() });
  await page.mouse.move(900, 500);
  await shot('d01-not-found', { features: ['OpenCode not found', 'download offer'],
    expect: `The side bar shows the OpenCode Agent Plus Conversations view with a message that begins "Couldn't list conversations: OpenCode was not found." and ends with "${server.DOWNLOAD_HINT}". At the bottom right a notification says "${OFFER} (125 MB)? An OpenCode you install yourself is used first." with a "Download OpenCode" button. No conversation is open.` });

  // D3. The button downloads it from GitHub, with the percentage in a notification that can be cancelled.
  const seen = [];
  let cancelButtons = -1;
  let progressShot = false;
  if (hasButton) await button.click();
  await page.mouse.move(900, 500);
  const start = Date.now();
  let toldNow = [];
  while (Date.now() - start < 600000) {
    const all = await toasts();
    const p = all.find((x) => x.includes(`Downloading OpenCode ${dl.VERSION} from GitHub`));
    if (p) {
      const m = /(\d+)%/.exec(p);
      if (m && !seen.includes(Number(m[1]))) seen.push(Number(m[1]));
      if (!progressShot && m) {
        progressShot = true;
        cancelButtons = await page.locator('.notifications-toasts .notification-toast', { hasText: 'Downloading OpenCode' }).locator('.monaco-button', { hasText: 'Cancel' }).count();
        await shot('d02-downloading', { features: ['download progress'],
          expect: `A notification at the bottom right reads "Downloading OpenCode ${dl.VERSION} from GitHub (125 MB)" followed by a percentage such as "37%", with a progress bar and a Cancel button. The offer's notification is gone.`,
          part: '.notifications-toasts', settle: 0 });
      }
    }
    toldNow = (await ext('return api.test.told();')) || [];
    if (toldNow.some((x) => x === READY || /was cancelled/.test(x)) || all.some((x) => /downloading OpenCode failed/.test(x))) break;
    await sleep(100);
  }
  console.log(`  note  percentages seen in the progress notification: ${seen.join(', ')}; Cancel buttons: ${cancelButtons}; took ${((Date.now() - start) / 1000).toFixed(1)} s`);
  check(seen.length > 0 && cancelButtons === 1, 'the download shows its percentage in a notification with a Cancel button', { seen, cancelButtons, toasts: await toasts() });
  const placed = (() => { try { fs.accessSync(exe, fs.constants.X_OK); return true; } catch (_) { return false; } })();
  const left = fs.existsSync(dl.folder(t.home)) ? fs.readdirSync(dl.folder(t.home)) : [];
  check(toldNow.includes(READY) && placed && JSON.stringify(left) === JSON.stringify([dl.VERSION]),
    `the download ends with "${READY}", the executable is in ${path.join('<OPENCODE_AGENT_PLUS_HOME>', 'opencode', dl.VERSION)} and nothing else is left beside it`, { told: toldNow.slice(-3), placed, left });
  const offers = toldNow.filter((x) => x.startsWith(OFFER)).length;
  check(offers === 1, 'the offer was made once in this window', { offers });

  // D4. Without a reload the list is drawn again.
  await call('await vscode.commands.executeCommand("workbench.view.extension.opencodeAgentPlus"); return true;');
  const listed = await until(async () => {
    const text = await textOf(sidebar);
    return !/Couldn't list conversations/.test(text) && /No conversations yet|Open in this window|Other conversations/.test(text) ? text.slice(0, 200) : null;
  }, 120000);
  const host = await call('return process.pid;');
  check(!!listed, 'without a reload the Conversations view drops the error and shows the list', listed || await textOf(sidebar));
  await page.mouse.move(900, 500);
  await shot('d03-ready', { features: ['download finished', 'list after download'],
    expect: `The Conversations view no longer shows the "Couldn't list conversations" message; it shows its empty-list text (such as "No conversations yet") or a list. A notification says "${READY}". No error notification.` });

  // D5. A new conversation runs on the downloaded OpenCode and the real model answers.
  await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
  await page.hover(`${sidebar} .pane-header`).catch(() => {});
  const add = await page.waitForSelector(`${sidebar} .action-label[aria-label^="New Conversation"]`, { timeout: 15000 }).catch(() => null);
  if (add) await add.click(); else await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
  await page.mouse.move(900, 500);
  const chat = await frameWith(page, '#input', 120000);
  check(!!chat, 'New Conversation opens the chat page');
  let reply = null;
  if (chat) {
    await chat.fill('#input', 'Reply with the single word READY and nothing else.');
    await chat.press('#input', 'Enter');
    reply = await until(() => chat.evaluate(() => {
      const r = [...document.querySelectorAll('#log .msg.reply')].pop();
      return document.body.dataset.status === 'idle' && r && /READY/.test(r.textContent) ? r.textContent.trim().slice(0, 80) : null;
    }), 240000, 1000);
    check(!!reply, 'the real model answers through the downloaded OpenCode', reply || await chat.evaluate(() => document.getElementById('log').textContent.slice(-300)));
  }
  const info = await ext('return api.test.backendInfo();');
  const procs = processes(t.control);
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };
  console.log(`  note  OpenCode in use: ${JSON.stringify(info && { path: info.path, version: info.version && info.version.text, pid: info.pid })}; processes of this run: ${JSON.stringify(procs)}; extension host ${host}`);
  check(!!info && real(info.path) === real(exe) && info.version && info.version.text === dl.VERSION,
    `the OpenCode running is the downloaded ${dl.VERSION}`, info && { path: info.path, version: info.version });
  check(procs.length > 0 && procs.every((x) => real(x.argv[0]) === real(exe) && XDG.every((k) => x.xdg[k] === t.xdgEnv[k])),
    'every OpenCode process of this run is the downloaded one, with this run\'s four XDG folders', procs);
  await shot('d04-reply', { features: ['conversation on the downloaded OpenCode'],
    expect: 'A chat tab with the message "Reply with the single word READY and nothing else." and the model\'s reply READY, a figures line under it naming the model (Grok); the Conversations view in the side bar lists the conversation. No error text or error notification.' });
}

module.exports = { run, withoutOpenCode, processes, OFFER, READY };
