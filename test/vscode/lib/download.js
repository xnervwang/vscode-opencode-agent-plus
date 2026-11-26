// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The run of test/vscode/run.js with --download: a window that has no OpenCode to find. PATH has no folder with an
 * opencode in it, the setting is empty, the installer folders in the home have no opencode, and OPENCODE_AGENT_PLUS_HOME is
 * a new empty folder. The steps D1 to D5 go from the offer to a reply from the real model through the downloaded
 * OpenCode, and the download really comes from GitHub.
 */
const fs = require('fs');
const path = require('path');
const server = require('../../../src/opencode/server');
const dl = require('../../../src/opencode/download');
const sessionList = require('./session-list');

const OFFER = `OpenCode was not found. Download OpenCode ${dl.VERSION} from GitHub`;
const READY = `OpenCode ${dl.VERSION} is ready for new conversations.`;
const XDG = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

/* Removes from `env`'s PATH every folder that holds an opencode; returns the new environment and the folders removed. */
function withoutOpenCode(env, platform = process.platform) {
  const names = platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = String(env[key] || '').split(path.delimiter).filter(Boolean);
  const dropped = dirs.filter((d) => names.some((n) => fs.existsSync(path.join(d, n))));
  return { env: { ...env, [key]: dirs.filter((d) => !dropped.includes(d)).join(path.delimiter) }, dropped };
}

/* The OpenCode processes of this run: those whose environment has the run's control folder and whose program is an
   opencode. Linux only. */
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
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-toast')].map((e) => e.textContent.trim()));
  const exe = dl.executable(t.home);

  // D1. Nothing to find.
  const homeDir = t.env.HOME || t.env.USERPROFILE || '';
  const found = server.candidates({ env: t.env, platform: process.platform, home: homeDir }).filter((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const setting = await call('return vscode.workspace.getConfiguration("opencodeAgentPlus").get("opencode.path");');
  const hostEnv = await call(`return { home: process.env.OPENCODE_AGENT_PLUS_HOME, xdg: ${JSON.stringify(XDG)}.map((k) => process.env[k]) };`);
  check(found.length === 0 && !setting && hostEnv.home === t.home && !fs.existsSync(dl.folder(t.home)),
    'nothing to find: the setting is empty, no PATH folder or installer folder holds an opencode, and OPENCODE_AGENT_PLUS_HOME has no download', { found, setting, hostEnv });
  check(XDG.every((k, i) => hostEnv.xdg[i] === t.xdgEnv[k]), 'the extension host, and so every opencode it runs (--version too), has this run\'s four XDG folders', hostEnv.xdg);

  // D2. Agent Plus's session list says OpenCode was not found, and the notification offers the download.
  const sl = await sessionList.missing({ page, call, ext, check, shot, until, sleep });
  const offer = await until(async () => (await toasts()).find((x) => x.includes(OFFER)) || null, 30000);
  const button = page.locator('.notifications-toasts .notification-toast', { hasText: OFFER }).locator('.monaco-button', { hasText: 'Download OpenCode' }).first();
  const hasButton = await button.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
  check(!!offer && hasButton, 'a notification offers to download OpenCode 2.4.1, with a Download OpenCode button', { offer, hasButton, toasts: await toasts() });
  await page.mouse.move(900, 500);
  await shot('d01-not-found', { features: ['OpenCode not found', 'download offer'],
    expect: `The side bar shows Agent Plus's session list with a note above it, starting with the OpenCode mark: "OpenCode was not found. Install OpenCode 2 with npm install -g @opencode/cli and reload the window, or download it with the button here." with Download OpenCode and Show Logs buttons. At the bottom right a notification says "${OFFER} (125 MB)? If you install OpenCode yourself, that one is used instead." with a "Download OpenCode" button. No conversation is open.` });

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

  // D4. The session list drops its note.
  if (sl) await sl.show();
  const listed = sl && sl.sl && await until(async () => !(await sl.notice()).some((n) => /OpenCode was not found/.test(n.text)), 120000);
  const host = await call('return process.pid;');
  check(!!listed, 'without a reload the session list drops its note that OpenCode was not found', sl && sl.sl && await sl.notice());
  await page.mouse.move(900, 500);
  await shot('d03-ready', { features: ['download finished', 'list after download'],
    expect: `Agent Plus's session list no longer has the note that OpenCode was not found. A notification says "${READY}". No error notification.` });

  // D5. A new conversation runs on the downloaded OpenCode and the real model answers.
  await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
  await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
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
    `the running OpenCode is the downloaded ${dl.VERSION}`, info && { path: info.path, version: info.version });
  check(procs.length > 0 && procs.every((x) => real(x.argv[0]) === real(exe) && XDG.every((k) => x.xdg[k] === t.xdgEnv[k])),
    'every OpenCode process of this run is the downloaded executable, with the same XDG folders', procs);
  await shot('d04-reply', { features: ['conversation on the downloaded OpenCode'],
    expect: 'A chat tab with the message "Reply with the single word READY and nothing else." and the model\'s reply READY, its time followed by figures that include the model name (Grok); Agent Plus\'s session list in the side bar lists the conversation. No error text or error notification.' });
}

module.exports = { run, withoutOpenCode, processes, OFFER, READY };
