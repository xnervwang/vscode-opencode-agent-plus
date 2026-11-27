// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Restricted Mode run of test/vscode/run.js (--restricted). The window has Workspace Trust turned on and its folder
 * not trusted; the folder's .vscode/settings.json points opencodeAgentPlus.opencode.path at a program of its own, which
 * writes a file if it is ever run, and sets the other three settings that pick what runs. Until trust is granted no
 * OpenCode process may start, that program may not run, nothing may be written to the extension's folder, Agent Plus's
 * session list says it is in Restricted Mode and has no OpenCode rows, and a chat tab and a command say to trust
 * the workspace. The buttons on the list's note and in the tab each open the Workspace Trust editor, where the folder is
 * then trusted; without a reload the extension starts, the list offers OpenCode, the chat tab is handed over, and a new
 * conversation started from the list runs on the OpenCode of the user settings, not the folder's.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sessionList = require('./session-list');

const TEXT = 'OpenCode Agent Plus does nothing in Restricted Mode. It starts when you trust this workspace.';
const KEYS = ['opencode.path', 'opencode.askPermissions', 'bedrock.profile', 'bedrock.region', 'opencode.environment'];
const PROBE = 'ses_restrictedprobe000000001';

/* Writes the folder's own settings and the program they name; returns the marker file, the program and those settings. */
function prepareFolder(folder, root) {
  const marker = path.join(root, 'workspace-opencode-ran.txt');
  /* On Windows an opencode.cmd, named like npm's launcher but running no opencode.exe. */
  const windows = process.platform === 'win32';
  const program = path.join(folder, 'tools', windows ? 'opencode.cmd' : 'opencode');
  fs.mkdirSync(path.dirname(program), { recursive: true });
  fs.writeFileSync(program, windows ? `@echo %~f0 %*>> "${marker}"\r\n@exit /b 1\r\n`
    : `#!/bin/sh\necho "$$ $0 $*" >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  const workspace = { 'opencodeAgentPlus.opencode.path': program, 'opencodeAgentPlus.opencode.askPermissions': false,
    'opencodeAgentPlus.bedrock.profile': 'workspace-profile', 'opencodeAgentPlus.bedrock.region': 'eu-west-3',
    'opencodeAgentPlus.opencode.environment': { SET_BY_THE_FOLDER: 'yes' } };
  fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify(workspace, null, 2));
  return { marker, program, workspace };
}

/* The user settings of the run: Workspace Trust on, and no prompt at startup, so the folder opens in Restricted Mode. */
const TRUST_SETTINGS = { 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never' };

/* Throws when the process table cannot be read, so that an empty one is never taken for "no process". */
function processTable() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`the process table could not be read: ${(r.error && r.error.message) || r.stderr}`);
    const rows = JSON.parse(r.stdout);
    return (Array.isArray(rows) ? rows : [rows]).map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name || '', command: x.CommandLine || '' }));
  }
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`the process table could not be read: ${(r.error && r.error.message) || r.stderr}`);
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3].split(' ')[0]), command: m[3] }));
}

function words(command) {
  const m = /^(?:"([^"]*)"|(\S*))\s*([\s\S]*)$/.exec(command);
  return [m[1] === undefined ? m[2] : m[1], ...m[3].split(/\s+/).filter(Boolean)];
}

/*
 * The OpenCode processes this run's window started (and any run of the folder's program). On Linux, those whose
 * environment has the run's control folder, which window.js gives VS Code, and whose program is an opencode. macOS and
 * Windows do not show another process's environment: there, the descendants of the window's process `windowPid` whose
 * program is an opencode or whose command line names the folder's program.
 */
function openCodeProcesses(control, program, windowPid) {
  if (process.platform !== 'linux') {
    const table = processTable();
    const tree = new Set([windowPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of table) if (!tree.has(x.pid) && tree.has(x.ppid)) { tree.add(x.pid); grew = true; }
    }
    return table.filter((x) => x.pid !== windowPid && tree.has(x.pid) && (/^opencode(\.exe|\.cmd)?$/i.test(x.name) || x.command.includes(program)))
      .map((x) => ({ pid: x.pid, argv: words(x.command).slice(0, 4), exe: '', env: null }));
  }
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let environ = '', argv = [];
    try { environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch (_) { continue; }
    if (!environ.split('\0').includes(`OPENCODE_AGENT_PLUS_UI_CONTROL=${control}`)) continue;
    if (path.basename(argv[0] || '') !== 'opencode' && !argv.includes(program)) continue;
    const env = Object.fromEntries(environ.split('\0').filter((l) => /^AWS_(PROFILE|REGION)=/.test(l)).map((l) => l.split('=')));
    let exe = '';
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch (_) { /* gone */ }
    found.push({ pid: Number(pid), argv: argv.slice(0, 4), exe, env });
  }
  return found;
}

/* t: { page, call, ext, check, shot, until, sleep, frameWith, folder, control, home, real, opencode, prepared, windowPid } */
async function run(t) {
  const { page, call, ext, check, shot, until, sleep, frameWith, real, prepared } = t;
  const userPath = real ? t.opencode : '';
  const procs = () => openCodeProcesses(t.control, prepared.program, t.windowPid);
  if (process.platform !== 'linux') console.log(`  note  ${process.platform} does not show another process's environment: the checks look for OpenCode processes only among the window's descendants`);
  const ran = () => fs.existsSync(prepared.marker);

  // R1. The window is in Restricted Mode, and the extension is active there.
  const trusted = await call('return vscode.workspace.isTrusted;');
  const restricted = await ext('return api.test.restricted();');
  check(trusted === false && restricted === true, 'the folder opens in Restricted Mode, and OpenCode Agent Plus is active but has not started', { trusted, restricted });

  // R2. Agent Plus's session list says it is in Restricted Mode, with the trust button, and has no OpenCode rows.
  const sl = await sessionList.restricted({ page, call, ext, check, shot, until, sleep });

  // R3. A chat tab, as VS Code would restore one, shows the same text and button.
  await call('await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.parse("opencodeagentplus-session:/" + arg), "opencodeAgentPlus.chat", { preview: false }); return true;', PROBE);
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
  const answered = await call('return [await vscode.commands.executeCommand("opencodeAgentPlus.newConversation"), await vscode.commands.executeCommand("opencodeAgentPlus.testConnection")];');
  const toast = await until(() => page.evaluate((t) => [...document.querySelectorAll('.notification-toast')].some((e) => e.textContent.includes(t)), 'does nothing in Restricted Mode'), 10000);
  const tabsAfter = await call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;');
  check(JSON.stringify(answered) === '[false,false]' && !!toast && tabsAfter === tabsBefore,
    'New Conversation and Test OpenCode Connection only say to trust the workspace: no tab opens', { answered, toast, tabsBefore, tabsAfter });
  /* The notification starts with its time (src/shared/notice-time.js). VS Code runs on this machine, so the hour and
     minute are this machine's; until a chat page reports the reader's time zone, the zone's name follows them. */
  const said = await page.evaluate((t) => { const e = [...document.querySelectorAll('.notification-toast')].find((x) => x.textContent.includes(t));
    const m = e && (e.querySelector('.notification-list-item-message') || e); return m ? m.innerText.trim() : ''; }, 'does nothing in Restricted Mode');
  const hm = (ms) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const stamp = /^\[(\d\d:\d\d)(?: [^\]]+)?\] /.exec(said);
  check(!!stamp && [Date.now(), Date.now() - 60000].map(hm).includes(stamp[1]) && said.slice(stamp[0].length) === TEXT,
    'and the notification starts with the current time in square brackets', said);
  await shot('r03-command-restricted', { features: ['Restricted Mode command'],
    expect: `A notification at the bottom right says "${TEXT}", with the time before it in square brackets such as [14:05] or [14:05 UTC], and a "Manage Workspace Trust" button. No new tab opened.`,
    part: '.notifications-toasts' });
  await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});

  // R5. The settings the extension reads ignore the folder's values.
  const seen = await call(`const c = vscode.workspace.getConfiguration("opencodeAgentPlus");
    return arg.map((k) => { const i = c.inspect(k) || {}; return { key: k, get: c.get(k), globalValue: i.globalValue, workspaceValue: i.workspaceValue, workspaceFolderValue: i.workspaceFolderValue }; });`, KEYS);
  const want = { 'opencode.path': userPath, 'opencode.askPermissions': true, 'bedrock.profile': real ? t.aws.profile : '', 'bedrock.region': real ? t.aws.region : '',
    'opencode.environment': {} };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log(`  note  settings as VS Code gives them to the extension in Restricted Mode: ${JSON.stringify(seen)}`);
  check(Array.isArray(seen) && seen.every((s) => same(s.get, want[s.key]) && !same(s.get, prepared.workspace[`opencodeAgentPlus.${s.key}`])),
    "the settings that decide how OpenCode is started read as the user's values, not the folder's", seen);

  // R6. Nothing ran and nothing was written.
  await sleep(5000);
  const before = procs();
  check(before.length === 0, 'no OpenCode process has started', before);
  if (process.platform === 'win32') console.log("  note  on Windows the folder's program is a .cmd that is not npm's launcher for an opencode.exe, which the extension never starts, so the next check passes even if the extension read the folder's path");
  check(!ran(), "the folder's opencode program was never run", ran() ? fs.readFileSync(prepared.marker, 'utf8') : '');
  const written = fs.existsSync(t.home) ? fs.readdirSync(t.home) : [];
  check(written.length === 0, "nothing was written to the extension's folder (no plugin, plans, locks or window state)", written);

  // R7. Each button opens the Workspace Trust editor without a VS Code prompt first; the folder is then trusted in it.
  const trustEditor = () => page.evaluate(() => ({ editor: !!document.querySelector('.workspace-trust-editor'),
    dialog: [...document.querySelectorAll('.monaco-dialog-box')].map((d) => d.textContent.trim().slice(0, 120)) }));
  const closeTrustEditor = () => call('await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => /Workspace Trust/.test(x.label))); return true;');
  if (sl) {
    await sl.show();
    await sl.sl.locator('.sl-note-btn', { hasText: 'Manage Workspace Trust' }).first().click({ timeout: 10000 }).catch(() => {});
  }
  const fromView = await until(async () => { const x = await trustEditor(); return x.editor || x.dialog.length ? x : null; }, 20000);
  check(!!fromView && fromView.editor && !fromView.dialog.length, "the session list's Manage Workspace Trust button opens the Workspace Trust editor", fromView);
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

  // R8. Without a reload the extension starts: the session list drops its note and offers OpenCode, and the chat tab is
  // handed to the chat editor.
  const started = await until(() => ext('return !api.test.restricted() && typeof api.test.settings === "function";'), 30000);
  const host = await call('return process.pid;');
  check(!!started, 'OpenCode Agent Plus starts once trusted, in the same extension host (no reload)', { started, host });
  const settings = await ext('return api.test.settings();');
  const env = (settings && settings.env) || {};
  check(!!settings && settings.binaryPath === userPath && settings.permissions === true && (env.AWS_PROFILE || '') === want['bedrock.profile'] && (env.AWS_REGION || '') === want['bedrock.region']
    && !('SET_BY_THE_FOLDER' in env),
    "once trusted it still starts OpenCode with the user's settings, not the folder's", settings);
  /* Once the folder is trusted, restrictedConfigurations no longer applies; the machine scope still keeps its values out. */
  const seenTrusted = await call(`const c = vscode.workspace.getConfiguration("opencodeAgentPlus");
    return arg.map((k) => { const i = c.inspect(k) || {}; return { key: k, get: c.get(k), globalValue: i.globalValue, workspaceValue: i.workspaceValue, workspaceFolderValue: i.workspaceFolderValue }; });`, KEYS);
  console.log(`  note  settings as VS Code gives them to the extension once trusted: ${JSON.stringify(seenTrusted)}`);
  check(Array.isArray(seenTrusted) && seenTrusted.every((x) => same(x.get, want[x.key]) && x.workspaceValue === undefined && x.workspaceFolderValue === undefined),
    "once trusted, those settings still read as the user's values: VS Code gives no workspace value for them", seenTrusted);
  const h = sessionList.create({ page, call, until, sleep });
  await h.show();
  const noteGone = h.sl && await until(async () => !(await h.notice()).some((n) => /Restricted Mode/.test(n.text)), 30000);
  /* With OpenCode Agent Plus the only agent, the New bar's agent button is titled after it. */
  const agents = h.sl && await until(() => h.sl.evaluate(() => { const b = document.querySelector('.sl-new-agent'); return b && /OpenCode/.test(b.title) && b.title; }), 30000);
  check(!!noteGone && !!agents, "the session list drops its Restricted Mode note, and its New bar starts OpenCode conversations now", { noteGone, agents });
  const handed = await until(async () => {
    const still = await frameWith(page, '#restricted', 1000);
    const waiting = await ext('return api.test.waitingTabs();');
    return !still && waiting === 0;
  }, 60000);
  const probeTab = await call('const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.path.split("/")[1] === arg); return t ? t.label : null;', PROBE);
  check(!!handed && !!probeTab, 'the chat tab that showed the Restricted Mode page is handed to the chat editor (it names no real conversation, so it says it could not be opened)', { handed, probeTab });
  await closeTrustEditor();
  await until(async () => !(await trustEditor()).editor, 10000);
  await page.mouse.move(900, 500);
  await shot('r05-trusted-tab', { features: ['chat tab after trust'],
    expect: 'The editor shows the chat tab that had the Restricted Mode page, now drawn by the chat editor: since the tab names a made-up conversation, it says "This conversation could not be opened:" followed by OpenCode\'s error. The Restricted Mode text and button are gone. VS Code no longer marks the window as Restricted Mode.',
    part: '#workbench\\.parts\\.editor' });
  await call('const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.path.split("/")[1] === arg); await vscode.window.tabGroups.close(tabs); return true;', PROBE);

  // R9. A new conversation, started from the session list's New bar, runs on the user's OpenCode.
  await h.show();
  const add = h.sl && h.sl.locator('.sl-new-half[data-where="tab"]').first();
  if (add) await add.click().catch(() => {}); else await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
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
    if (after.some((x) => !x.env)) console.log(`  note  ${process.platform} does not show another process's environment: the AWS profile and Region of these processes are not checked`);
    check(after.length > 0 && after.every((x) => realPath(x.argv[0]) === realPath(userPath) && (!x.env || (x.env.AWS_PROFILE === t.aws.profile && x.env.AWS_REGION === t.aws.region))),
      "every OpenCode process of this run is the user's, with the user's AWS profile and Region", after);
  } else {
    check(after.length === 0, 'with the fake backend no OpenCode process runs', after);
  }
  check(!ran(), "the folder's opencode program was still never run", ran() ? fs.readFileSync(prepared.marker, 'utf8') : '');
  await shot('r06-trusted-conversation', { features: ['conversation after trust'],
    expect: real
      ? 'A chat tab with the message "Reply with the single word READY and nothing else." and the model\'s reply READY, its time followed by figures; the Conversations view in the side bar lists the conversation. No Restricted Mode text anywhere.'
      : 'A chat tab showing the chat page (an empty area with the OpenCode mark and a hint, and the rounded message box with its row of buttons and a send arrow); the Conversations view in the side bar lists the conversation. No Restricted Mode text anywhere.' });
}

module.exports = { run, prepareFolder, openCodeProcesses, TRUST_SETTINGS, TEXT };
