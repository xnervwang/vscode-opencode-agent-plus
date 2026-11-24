// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Restricted Mode run of test/vscode/run.js (--restricted). The window has Workspace Trust turned on and its folder
 * not trusted; the folder's .vscode/settings.json points opencodePlus.opencode.path at a program of its own, which
 * writes a file if it is ever run, and sets the other three settings that pick what runs. Until trust is granted no
 * OpenCode process may start, that program may not run, nothing may be written to the extension's folder, and the
 * Conversations view, a chat tab and a command say to trust the workspace. The view's button and the tab's each open
 * the Workspace Trust editor, where the folder is then trusted; without a reload the extension starts, the chat tab is
 * handed over, and a new conversation runs on the OpenCode of the user settings, not the folder's.
 */
const fs = require('fs');
const path = require('path');

const TEXT = 'OpenCode Plus does nothing in Restricted Mode. It starts when you trust this workspace.';
const KEYS = ['opencode.path', 'opencode.askPermissions', 'bedrock.profile', 'bedrock.region'];
const PROBE = 'ses_restrictedprobe000000001';

/* Writes the folder's own settings and the program they name; returns what the run checks against. */
function prepareFolder(folder, root) {
  const marker = path.join(root, 'workspace-opencode-ran.txt');
  const program = path.join(folder, 'tools', 'opencode');
  fs.mkdirSync(path.dirname(program), { recursive: true });
  fs.writeFileSync(program, `#!/bin/sh\necho "$$ $0 $*" >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  const workspace = { 'opencodePlus.opencode.path': program, 'opencodePlus.opencode.askPermissions': false,
    'opencodePlus.bedrock.profile': 'workspace-profile', 'opencodePlus.bedrock.region': 'eu-west-3' };
  fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify(workspace, null, 2));
  return { marker, program, workspace };
}

/* The user settings of the run: Workspace Trust on, and no prompt at startup, so the folder opens in Restricted Mode. */
const TRUST_SETTINGS = { 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never' };

/*
 * The OpenCode processes this run's window started (and any run of the folder's program): those whose environment has
 * the run's control folder, which window.js gives VS Code, and whose program is an opencode. Linux only.
 */
function openCodeProcesses(control, program) {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let environ = '', argv = [];
    try { environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch (_) { continue; }
    if (!environ.split('\0').includes(`OPENCODE_PLUS_UI_CONTROL=${control}`)) continue;
    if (path.basename(argv[0] || '') !== 'opencode' && !argv.includes(program)) continue;
    const env = Object.fromEntries(environ.split('\0').filter((l) => /^AWS_(PROFILE|REGION)=/.test(l)).map((l) => l.split('=')));
    let exe = '';
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch (_) { /* gone */ }
    found.push({ pid: Number(pid), argv: argv.slice(0, 4), exe, env });
  }
  return found;
}

/* t: { page, call, ext, check, shot, until, sleep, frameWith, folder, control, home, real, opencode, prepared } */
async function run(t) {
  const { page, call, ext, check, shot, until, sleep, frameWith, real, prepared } = t;
  const userPath = real ? t.opencode : '';
  const procs = () => openCodeProcesses(t.control, prepared.program);
  const ran = () => fs.existsSync(prepared.marker);
  const textOf = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : ''; }, sel);
  const sidebar = '#workbench\\.parts\\.sidebar';

  // R1. The window is in Restricted Mode, and the extension is active there.
  const trusted = await call('return vscode.workspace.isTrusted;');
  const restricted = await ext('return api.test.restricted();');
  check(trusted === false && restricted === true, 'the folder opens in Restricted Mode, and OpenCode Plus is active but has not started', { trusted, restricted });

  // R2. The Conversations view says to trust the workspace, with the button, and offers nothing else.
  const icon = await page.waitForSelector('.activitybar .action-item [aria-label^="OpenCode Plus"]', { timeout: 30000 }).catch(() => null);
  if (icon) await icon.click();
  const view = await until(async () => {
    const text = await textOf(sidebar);
    const button = await page.evaluate(() => [...document.querySelectorAll('#workbench\\.parts\\.sidebar .welcome-view-content .monaco-button')].map((b) => b.textContent.trim()));
    return text.includes('does nothing in Restricted Mode') ? { button, empty: /No conversations yet/.test(text) } : null;
  }, 30000);
  const addButton = await page.$(`${sidebar} .action-label[aria-label^="New Conversation"]`);
  check(!!view && view.button.includes('Manage Workspace Trust') && !view.empty && !addButton,
    'the Conversations view says OpenCode Plus does nothing in Restricted Mode, with a Manage Workspace Trust button, and has no New Conversation button', { view, addButton: !!addButton });
  await page.mouse.move(900, 500);
  await shot('r01-view-restricted', { features: ['Restricted Mode view'],
    expect: `The side bar shows the OpenCode Plus Conversations view. In it, instead of a list, the text "${TEXT}" and under it a full-width "Manage Workspace Trust" button. The view title has no New Conversation (+) or Find button. VS Code itself marks the window as being in Restricted Mode (a "Restricted Mode" item at the left of the status bar).`,
    part: sidebar });

  // R3. A chat tab, as VS Code would restore one, shows the same text and button.
  await call('await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.parse("opencodeplus-session:/" + arg), "opencodePlus.chat", { preview: false }); return true;', PROBE);
  const tab = await frameWith(page, '#restricted', 30000);
  const tabText = tab ? await tab.evaluate(() => ({ text: document.getElementById('restricted').textContent, button: (document.getElementById('manage') || {}).textContent || '',
    chat: !!document.getElementById('input') })) : null;
  check(!!tabText && tabText.text === TEXT && tabText.button === 'Manage Workspace Trust' && !tabText.chat,
    'a chat tab shows the same text with a Manage Workspace Trust button, and no chat page', tabText);
  check(await ext('return api.test.waitingTabs();') === 1, 'the extension holds the tab until the workspace is trusted');
  await shot('r02-tab-restricted', { features: ['Restricted Mode chat tab'],
    expect: `An editor tab is open whose page shows only the text "${TEXT}" and under it a "Manage Workspace Trust" button in the theme's button colour. There is no message box, model picker or conversation.`,
    part: '#workbench\\.parts\\.editor' });

  // R4. A command says the same, and does nothing.
  const tabsBefore = await call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;');
  const answered = await call('return [await vscode.commands.executeCommand("opencodePlus.newConversation"), await vscode.commands.executeCommand("opencodePlus.testConnection")];');
  const toast = await until(() => page.evaluate((t) => [...document.querySelectorAll('.notification-toast')].some((e) => e.textContent.includes(t)), 'does nothing in Restricted Mode'), 10000);
  const tabsAfter = await call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;');
  check(JSON.stringify(answered) === '[false,false]' && !!toast && tabsAfter === tabsBefore,
    'New Conversation and Test OpenCode Connection only say to trust the workspace: no tab opens', { answered, toast, tabsBefore, tabsAfter });
  await shot('r03-command-restricted', { features: ['Restricted Mode command'],
    expect: `A notification at the bottom right says "${TEXT}" with a "Manage Workspace Trust" button. No new tab opened.`,
    part: '.notifications-toasts' });
  await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});

  // R5. The settings the extension reads ignore the folder's values.
  const seen = await call(`const c = vscode.workspace.getConfiguration("opencodePlus");
    return arg.map((k) => { const i = c.inspect(k) || {}; return { key: k, get: c.get(k), globalValue: i.globalValue, workspaceValue: i.workspaceValue, workspaceFolderValue: i.workspaceFolderValue }; });`, KEYS);
  const want = { 'opencode.path': userPath, 'opencode.askPermissions': true, 'bedrock.profile': real ? 'self' : '', 'bedrock.region': real ? 'us-east-1' : '' };
  console.log(`  note  settings as VS Code gives them to the extension in Restricted Mode: ${JSON.stringify(seen)}`);
  check(Array.isArray(seen) && seen.every((s) => s.get === want[s.key] && s.get !== prepared.workspace[`opencodePlus.${s.key}`]),
    "the four settings read as the user's values, not the folder's", seen);

  // R6. Nothing ran and nothing was written.
  await sleep(5000);
  const before = procs();
  check(before.length === 0, 'no OpenCode process has started', before);
  check(!ran(), "the folder's opencode program was never run", ran() ? fs.readFileSync(prepared.marker, 'utf8') : '');
  const written = fs.existsSync(t.home) ? fs.readdirSync(t.home) : [];
  check(written.length === 0, "nothing was written to the extension's folder (no plugin, plans, locks or window state)", written);

  // R7. Each button opens the Workspace Trust editor, with no prompt of VS Code's first; there the folder is trusted.
  const trustEditor = () => page.evaluate(() => ({ editor: !!document.querySelector('.workspace-trust-editor'),
    dialog: [...document.querySelectorAll('.monaco-dialog-box')].map((d) => d.textContent.trim().slice(0, 120)) }));
  const closeTrustEditor = () => call('await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => /Workspace Trust/.test(x.label))); return true;');
  const viewButton = page.locator(`${sidebar} .welcome-view-content .monaco-button`, { hasText: 'Manage Workspace Trust' }).first();
  await viewButton.click({ timeout: 10000 }).catch(() => {});
  const fromView = await until(async () => { const x = await trustEditor(); return x.editor || x.dialog.length ? x : null; }, 20000);
  check(!!fromView && fromView.editor && !fromView.dialog.length, "the view's Manage Workspace Trust button opens the Workspace Trust editor", fromView);
  if (fromView && fromView.dialog.length) await page.keyboard.press('Escape');
  await closeTrustEditor();
  await until(async () => !(await trustEditor()).editor, 10000);
  const tabNow = await frameWith(page, '#manage', 20000);
  if (tabNow) await tabNow.click('#manage').catch(() => {});
  const fromTab = await until(async () => { const x = await trustEditor(); return x.editor || x.dialog.length ? x : null; }, 20000);
  check(!!fromTab && fromTab.editor && !fromTab.dialog.length, "the chat tab's Manage Workspace Trust button opens the Workspace Trust editor", fromTab);
  await shot('r04-trust-editor', { features: ['Manage Workspace Trust'],
    expect: 'The Workspace Trust editor is open in a tab: it says the window is in Restricted Mode and offers a "Trust" button (with "Trust Parent" or similar beside it). No dialog covers it.',
    part: '#workbench\\.parts\\.editor' });
  const clicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.workspace-trust-editor .workspace-trust-buttons .monaco-button')];
    const b = all.find((x) => /^Trust/.test(x.textContent.trim()) && !/Parent/.test(x.textContent));
    if (!b) return all.map((x) => x.textContent.trim());
    b.click();
    return true;
  });
  const nowTrusted = await until(() => call('return vscode.workspace.isTrusted;'), 20000);
  check(clicked === true && nowTrusted === true, 'Trust in the Workspace Trust editor trusts the folder', { clicked, nowTrusted });

  // R8. Without a reload the extension starts: the view lists, the tab is handed over.
  const started = await until(() => ext('return !api.test.restricted() && typeof api.test.settings === "function";'), 30000);
  const host = await call('return process.pid;');
  check(!!started, 'OpenCode Plus starts once trusted, in the same extension host (no reload)', { started, host });
  const settings = await ext('return api.test.settings();');
  const env = (settings && settings.env) || {};
  check(!!settings && settings.binaryPath === userPath && settings.permissions === true && (env.AWS_PROFILE || '') === want['bedrock.profile'] && (env.AWS_REGION || '') === want['bedrock.region'],
    "once trusted it still starts OpenCode with the user's settings, not the folder's", settings);
  /* Trusted, restrictedConfigurations no longer applies: what still keeps the folder's values out is the machine scope. */
  const seenTrusted = await call(`const c = vscode.workspace.getConfiguration("opencodePlus");
    return arg.map((k) => { const i = c.inspect(k) || {}; return { key: k, get: c.get(k), globalValue: i.globalValue, workspaceValue: i.workspaceValue, workspaceFolderValue: i.workspaceFolderValue }; });`, KEYS);
  console.log(`  note  settings as VS Code gives them to the extension once trusted: ${JSON.stringify(seenTrusted)}`);
  check(Array.isArray(seenTrusted) && seenTrusted.every((x) => x.get === want[x.key] && x.workspaceValue === undefined && x.workspaceFolderValue === undefined),
    "once trusted the four settings still read as the user's values: VS Code gives no workspace value for them", seenTrusted);
  await call('await vscode.commands.executeCommand("workbench.view.extension.opencodePlus"); return true;');
  const listed = await until(async () => {
    const text = await textOf(sidebar);
    return !text.includes('does nothing in Restricted Mode') && /No conversations yet|Open in this window|Other conversations|Untitled/.test(text) ? text.slice(0, 200) : null;
  }, 60000);
  check(!!listed, 'the Conversations view drops the Restricted Mode text and shows the list', listed || await textOf(sidebar));
  const handed = await until(async () => {
    const still = await frameWith(page, '#restricted', 1000);
    const waiting = await ext('return api.test.waitingTabs();');
    return !still && waiting === 0;
  }, 60000);
  const probeTab = await call('const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.toString() === "opencodeplus-session:/" + arg); return t ? t.label : null;', PROBE);
  check(!!handed && !!probeTab, 'the chat tab that showed the Restricted Mode page is handed to the chat editor (it names no real conversation, so it says it could not be opened)', { handed, probeTab });
  await closeTrustEditor();
  await until(async () => !(await trustEditor()).editor, 10000);
  await page.mouse.move(900, 500);
  await shot('r05-trusted-tab', { features: ['chat tab after trust'],
    expect: 'The editor shows the chat tab that had the Restricted Mode page, now drawn by the chat editor: since the tab names a made-up conversation, it says "This conversation could not be opened:" followed by OpenCode\'s error. The Restricted Mode text and button are gone. VS Code no longer marks the window as Restricted Mode.',
    part: '#workbench\\.parts\\.editor' });
  await call('const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.toString() === "opencodeplus-session:/" + arg); await vscode.window.tabGroups.close(tabs); return true;', PROBE);

  // R9. A new conversation runs, on the user's OpenCode.
  await page.hover(`${sidebar} .pane-header`).catch(() => {});
  const add = await page.waitForSelector(`${sidebar} .action-label[aria-label^="New Conversation"]`, { timeout: 15000 }).catch(() => null);
  check(!!add, 'once trusted, the view title has the New Conversation button');
  if (add) await add.click(); else await call('return vscode.commands.executeCommand("opencodePlus.newConversation");');
  const chat = await frameWith(page, '#input', 60000);
  check(!!chat, 'a new conversation opens with the chat page');
  if (chat && real) {
    await chat.fill('#input', 'Reply with the single word READY and nothing else.');
    await chat.press('#input', 'Enter');
    const reply = await until(() => chat.evaluate(() => {
      const r = [...document.querySelectorAll('#log .msg.reply')].pop();
      return document.body.dataset.status === 'idle' && r && /READY/.test(r.textContent) ? r.textContent.trim().slice(0, 80) : null;
    }), 180000, 1000);
    check(!!reply, 'the model answers in the new conversation', reply || await chat.evaluate(() => document.getElementById('log').textContent.slice(-300)));
  }
  const info = await ext('return api.test.backendInfo();');
  const after = procs();
  const realPath = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };
  console.log(`  note  OpenCode once trusted: ${JSON.stringify(info && { path: info.path, version: info.version, pid: info.pid })}; processes of this run: ${JSON.stringify(after)}`);
  if (real) {
    const acp = after.find((x) => info && x.pid === info.pid);
    check(!!info && info.path === userPath && !!acp && realPath(acp.argv[0]) === realPath(userPath) && acp.argv.includes('acp'),
      "the OpenCode running is the one in the user settings, started as `opencode acp`", { info: info && { path: info.path, pid: info.pid }, acp });
    check(after.length > 0 && after.every((x) => realPath(x.argv[0]) === realPath(userPath) && x.env.AWS_PROFILE === 'self' && x.env.AWS_REGION === 'us-east-1'),
      "every OpenCode process of this run is the user's, with the user's AWS profile and Region", after);
  } else {
    check(after.length === 0, 'with the fake backend no OpenCode process runs', after);
  }
  check(!ran(), "the folder's opencode program was still never run", ran() ? fs.readFileSync(prepared.marker, 'utf8') : '');
  await shot('r06-trusted-conversation', { features: ['conversation after trust'],
    expect: real
      ? 'A chat tab with the message "Reply with the single word READY and nothing else." and the model\'s reply READY, a figures line under it; the Conversations view in the side bar lists the conversation. No Restricted Mode text anywhere.'
      : 'A chat tab with the chat page (model selector, empty message area, message box with Send); the Conversations view in the side bar lists the conversation. No Restricted Mode text anywhere.' });
}

module.exports = { run, prepareFolder, openCodeProcesses, TRUST_SETTINGS, TEXT };
