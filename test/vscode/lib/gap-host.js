// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Step 11 of test/vscode/run.js: the message box and the editor. Connect a provider opens OpenCode's sign-in in a
 * terminal (a stand-in program records what it was given) and the models are listed again once it closes; Ctrl+Enter
 * sends when the setting asks for it; the mode pill's Edit automatically lets an edit through without a request and is
 * kept when the tab is reopened; Fork from here (OpenCode 2) opens the history before a message in a new tab; the file
 * open in the editor and the selection go along with a message unless removed (where the page takes files); Cmd+Esc
 * moves between an editor and the message box, Alt+K and Add to Conversation (the editor's and the Explorer's menus) put
 * @ references in it; Fix with OpenCode Agent Plus in the quick fixes of a JSON error drafts a message after what the box
 * holds; on Linux a process carrying the conversation's OPENCODE_SESSION_ID shows as detached on the background pill;
 * a message with only an image is sent (where the page takes images); on OpenCode 2 the effort chosen comes back after a
 * model without it, and stays when OpenCode starts again, in the page and in what OpenCode records; and with no chat tab
 * open, Cmd+Esc starts a conversation.
 *
 * Keys are pressed on Linux and macOS; on Windows, where the Windows key belongs to the system, the commands are run instead.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { modelChoices, pickModel } = require('./window');

const ID = 'xnervwang.opencode-agent-plus';
const HAIKU = 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0';

/* A PNG of one colour, base64, for the image-only message. */
function bluePng(size = 32) {
  const zlib = require('zlib');
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [30, 80, 230]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const MAC = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';
const MOD = MAC ? 'Meta' : 'Control';

async function run(ctx) {
  const { page, call, ext, check, shot, until, sleep, frameWith, real, line, folder, out, chatUris, front, home } = ctx;
  const note = (text) => console.log(`  note  ${text}`);
  const conf = (key, value) => call(`await vscode.workspace.getConfiguration("opencodeAgentPlus").update(arg.key, arg.value, vscode.ConfigurationTarget.Global); return true;`, { key, value });
  const activeChat = () => call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.path.split("/")[1] : "";');
  const chatPage = () => frameWith(page, '#input', 20000);
  const userCount = (f) => f.evaluate(() => document.querySelectorAll('#log .msg.user').length);
  const idle = (f) => f.evaluate(() => document.body.dataset.status === 'idle');
  const inputOf = (f) => f.inputValue('#input');
  const told = async () => (await ext('return api.test.told();')) || [];
  /* Sends what the box holds with `key` and waits for the turn to end; in a run on a real model, requests are allowed. */
  const sendWith = async (f, key, ms = 180000) => {
    const n = await userCount(f);
    await f.press('#input', key);
    return until(async () => {
      if (real) for (const b of await f.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) await b.click().catch(() => {});
      return (await userCount(f)) > n && await idle(f) ? true : null;
    }, ms, 400);
  };
  const ask = (fakeText, realText) => (real ? realText : `Say: ${fakeText}`);
  /* Opens `file` beside the chat, or where it is already on screen (else in the active group); with `keep`, the focus
     stays where it is. */
  const openFile = (file, opts) => call(`const d = await vscode.workspace.openTextDocument(vscode.Uri.file(arg.file));
    const there = vscode.window.visibleTextEditors.find((x) => x.document.uri.toString() === vscode.Uri.file(arg.file).toString());
    const col = arg.beside ? vscode.ViewColumn.Beside : there ? there.viewColumn : vscode.ViewColumn.Active;
    const e = await vscode.window.showTextDocument(d, { viewColumn: col, preserveFocus: !!arg.keep, preview: false });
    if (arg.sel) e.selection = new vscode.Selection(arg.sel[0], arg.sel[1], arg.sel[2], arg.sel[3]);
    return e.document.uri.fsPath;`, { file, ...opts });
  const clearBox = async (f) => { await f.fill('#input', ''); };
  const closePanel = () => call('await vscode.commands.executeCommand("workbench.action.closePanel"); return true;').catch(() => {});

  const uris = await chatUris();
  if (!uris.length) { check(false, 'step 11 has a chat tab to start from', uris); return; }
  await front(uris[uris.length - 1]);
  let f = await chatPage();
  if (!f) { check(false, 'step 11 finds the chat page in front'); return; }

  // 11a. Connect a provider: the model list offers it, and it runs OpenCode's sign-in in a terminal.
  const record = path.join(out, 'login-stand-in.txt');
  fs.rmSync(record, { force: true });
  const program = path.join(out, WINDOWS ? 'opencode-stand-in.cmd' : 'opencode-stand-in');
  fs.writeFileSync(program, WINDOWS
    ? `@echo %*> "${record}"\r\n@echo AWS_PROFILE=%AWS_PROFILE%>> "${record}"\r\n@echo OPENCODE_DISABLE_AUTOUPDATE=%OPENCODE_DISABLE_AUTOUPDATE%>> "${record}"\r\n@ping -n 5 127.0.0.1 > nul\r\n`
    : `#!/bin/sh\n{ printf '%s\\n' "$*"; printf 'AWS_PROFILE=%s\\n' "$AWS_PROFILE"; printf 'OPENCODE_DISABLE_AUTOUPDATE=%s\\n' "$OPENCODE_DISABLE_AUTOUPDATE"; } > ${JSON.stringify(`${record}.tmp`)}\nmv ${JSON.stringify(`${record}.tmp`)} ${JSON.stringify(record)}\necho "Connect an integration (the window test's stand-in for OpenCode's sign-in)"\nsleep 4\n`,
  { mode: 0o755 });
  const plain = await ext('return api.test.loginLaunch();');
  /* The OpenCode the extension runs: a configured launcher script resolves to the program it starts. */
  const running = await ext('return api.test.backendInfo();');
  const configured = running && running.path ? running.path : real ? await call('return vscode.workspace.getConfiguration("opencodeAgentPlus").get("opencode.path");') : '/fake/opencode';
  const standalone = !real || line >= 2;
  check(!!plain && plain.shellPath === configured && plain.shellArgs.join(' ') === (standalone ? 'auth login --standalone' : 'auth login') && plain.env.OPENCODE_DISABLE_AUTOUPDATE === '1'
    && (!real || plain.env.AWS_PROFILE === 'self'),
  "the sign-in runs auth login with the OpenCode the extension found (not the one on PATH), adds --standalone on OpenCode 2 and uses the extension's environment", plain && { ...plain, env: Object.keys(plain.env) });
  await ext('return api.test.loginProgram(arg);', program);
  const offered = (await modelChoices(f)).actions;
  check(offered.some(([v, t]) => v === 'connect' && t === 'Connect a provider…'), 'the model list offers "Connect a provider…"', offered);
  /* OpenCode restarts only when no turn in this window is running, so the turns from earlier steps must end first. */
  const busy = async () => ((await ext('return api.test.conversations();')) || []).filter((c) => c.activity === 'working' || c.activity === 'waiting')
    .map((c) => ({ title: c.title, activity: c.activity, waitingFor: c.waitingFor }));
  const quiet = await until(async () => ((await busy()).length ? null : true), real ? 300000 : 30000);
  if (!quiet) note(`turns still running before the sign-in: ${JSON.stringify(await busy())}`);
  const refreshedBefore = (await ext('return api.test.logins();')).refreshed;
  /* The fake backend lists the credentials in this file: one before the sign-in, and one more saved while its terminal
     is open, as a second sign-in to a provider already connected saves. */
  const creds = path.join(home, 'fake-credentials.json');
  const credential = (...ids) => fs.writeFileSync(creds, JSON.stringify([{ id: 'fake', name: 'Fake', credentials: ids }]));
  if (!real) credential('cred_before');
  await pickModel(f, 'connect');
  const term = await until(() => call('const t = vscode.window.terminals.find((x) => x.name === "OpenCode: Connect a Provider"); return t ? { name: t.name, path: t.creationOptions.shellPath, args: t.creationOptions.shellArgs } : null;'), 20000);
  check(!!term && term.path === program && Array.isArray(term.args) && term.args.join(' ') === (standalone ? 'auth login --standalone' : 'auth login'),
    'picking it opens the terminal "OpenCode: Connect a Provider" running the sign-in', term);
  if (!real) credential('cred_before', 'cred_saved');
  const kept = await f.evaluate(() => document.getElementById('model').dataset.current || '');
  check(kept && kept !== 'connect', 'the model pill still shows the earlier model, not Connect a provider…', kept);
  /* The terminal's process starts through VS Code's pty host, whose node-pty needs glibc 2.28: on an older Linux it never
     starts, and the terminal is closed instead. Windows runs the stand-in through cmd, which is not checked here. */
  const pid = await call(`const t = vscode.window.terminals.find((x) => x.name === "OpenCode: Connect a Provider");
    return t ? (await Promise.race([t.processId, new Promise((r) => setTimeout(() => r(0), 15000))])) || 0 : 0;`, undefined, 30000).catch(() => 0);
  if (pid && !WINDOWS) {
    const got = await until(() => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : null), 20000);
    await shot('host-01-connect-terminal', { features: ['connect a provider'], settle: 300,
      expect: 'The terminal panel is open at the bottom with a terminal named "OpenCode: Connect a Provider" (a key icon); it shows the line "Connect an integration (the window test\'s stand-in for OpenCode\'s sign-in)". The chat tab is above it.' });
    const lines = (got || '').split('\n');
    check(!!got && lines[0] === (standalone ? 'auth login --standalone' : 'auth login') && lines.includes('OPENCODE_DISABLE_AUTOUPDATE=1') && (!real || lines.includes('AWS_PROFILE=self')),
      'the program got the arguments and the environment OpenCode starts with', lines);
  } else {
    if (!pid) note('the terminal\'s process did not start (VS Code\'s pty host needs glibc 2.28 on Linux), so the stand-in did not run; the terminal is closed instead');
    await sleep(1500);
    await call('const t = vscode.window.terminals.find((x) => x.name === "OpenCode: Connect a Provider"); if (t) t.dispose(); return true;');
  }
  const refreshed = await until(async () => { const l = await ext('return api.test.logins();'); return l.refreshed > refreshedBefore ? l : null; }, 120000);
  const outcome = real ? /^The sign-in closed without saving credentials, so nothing changed\./ : /^Saved new credentials for Fake, which was already connected\./;
  /* The notice follows the restart once OpenCode has listed the credentials again, which takes it a second or more. */
  const words = (refreshed && await until(async () => { const w = (await told()).slice(-3); return w.some((x) => outcome.test(x)) ? w : null; }, 30000))
    || (await told()).slice(-3);
  check(!!refreshed && words.some((w) => outcome.test(w)),
    real ? 'once the terminal closes, OpenCode restarts, and with no credential saved the notice says nothing changed rather than that the sign-in failed'
      : 'once the terminal closes, OpenCode restarts, and a credential saved for a provider already connected is reported as saved', { refreshed, words, busy: refreshed ? undefined : await busy() });
  if (!real) fs.rmSync(creds, { force: true });
  f = await chatPage();
  const listed = f ? await until(() => f.evaluate(() => { const n = document.querySelectorAll('#modelMenu [data-model-id]').length; return document.querySelector('#modelMenu [data-action="connect"]') && n > 1 ? n : null; }), 30000) : null;
  check(!!listed, 'the chat page lists the models again, still with "Connect a provider…"', listed);
  await ext('return api.test.loginProgram("");');
  await closePanel();

  // 11b. Ctrl+Enter sends when the setting asks for it; Enter then makes a new line.
  await conf('useCtrlEnterToSend', true);
  const hint = await until(() => f.evaluate(() => (/\+Enter to send, Enter for a new line/.test(document.getElementById('input').title) ? document.getElementById('input').title : null)), 10000);
  check(!!hint, 'with the setting on, the box says Ctrl+Enter (Cmd+Enter on macOS) sends', hint);
  const before11b = await userCount(f);
  await f.fill('#input', ask('Sent with Ctrl+Enter.', 'Reply with the single word OK and do not use any tool.'));
  await f.press('#input', 'Enter');
  await f.type('#input', 'Second line.');
  const typed = await inputOf(f);
  check(typed.includes('\nSecond line.') && (await userCount(f)) === before11b, 'Enter makes a new line and sends nothing', typed);
  const sent11b = await sendWith(f, `${MOD}+Enter`);
  check(!!sent11b && (await inputOf(f)) === '', `${MOD}+Enter sends the message`);
  await conf('useCtrlEnterToSend', undefined);

  // 11c. The permission modes; Edit automatically lets an edit in the folder through without a request.
  await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
  await until(async () => ((await activeChat()) && (await activeChat()) !== uris[uris.length - 1].replace(/^opencodeagentplus-session:\//, '') ? true : null), 20000);
  const autoId = await activeChat();
  f = await chatPage();
  const modes = f ? await until(() => f.evaluate(() => { const s = document.getElementById('mode'); return s && !s.hidden ? [...s.options].map((o) => o.textContent) : null; }), 20000) : null;
  check(!!modes && modes[0] === 'Ask before edits' && modes[1] === 'Edit automatically' && (!real || line < 2 || modes.includes('Plan')),
    'the mode pill offers Ask before edits, Edit automatically and, on OpenCode 2, Plan', modes);
  await f.selectOption('#mode', 'build:auto');
  const autoOn = await until(() => ext('return api.test.autoEdit(arg) || null;', autoId), 10000);
  const outlined = await f.evaluate(() => document.querySelector('.mode-pick').classList.contains('auto-edit'));
  check(!!autoOn && outlined, 'picking Edit automatically keeps it for this conversation, and the pill is outlined', { autoOn, outlined });
  await shot('host-02-edit-automatically', { features: ['edit automatically'], part: '#workbench\\.parts\\.editor',
    expect: 'An empty conversation; in the row under the message box, the mode pill near the right has a thin outline in the focus colour and reads "Edit automatically", which a chat as narrow as half the window cuts short with an ellipsis (such as "Edit aut…") rather than wrap the row.' });
  const target = path.join(folder, 'auto-edit.txt');
  fs.rmSync(target, { force: true });
  await f.fill('#input', real ? 'Use your write tool to create the file auto-edit.txt in the current folder, with the single word OTTER as its whole content. Do not run any command.'
    : 'Fix the failing test.');
  let asked = 0;
  const n11c = await userCount(f);
  await f.press('#input', 'Enter');
  const done11c = await until(async () => {
    for (const b of await f.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { asked++; await b.click().catch(() => {}); }
    return (await userCount(f)) > n11c && await idle(f) ? true : null;
  }, real ? 240000 : 60000, 300);
  const edited = real ? fs.existsSync(target) && /OTTER/.test(fs.readFileSync(target, 'utf8'))
    : await f.evaluate(() => document.querySelector('#log').textContent.includes('Edited sum.js'));
  const shownRequests = await f.evaluate(() => document.querySelectorAll('#log .permission').length);
  check(!!done11c && edited && asked === 0 && shownRequests === 0, 'with Edit automatically the edit went through and no request was shown', { done: !!done11c, edited, asked, shownRequests });
  await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.path === "/" + arg);
    await vscode.window.tabGroups.close(tabs); return true;`, autoId);
  await sleep(800);
  await call('return vscode.commands.executeCommand("opencodeAgentPlus.openConversation", arg);', autoId);
  f = await until(async () => ((await activeChat()) === autoId ? chatPage() : null), 20000);
  const reopened = f ? await until(() => f.evaluate(() => (document.getElementById('mode').value === 'build:auto' ? true : null)), 15000) : null;
  check(!!reopened, 'reopened, the tab is still on Edit automatically');

  // 11d. Fork from here (OpenCode 2) opens the history before a message in a new tab, with that message in its box.
  if (await ext('return api.test.canForkBefore();')) {
    const second = 'Reply with the single word SECOND and do not use any tool.';
    await f.fill('#input', second);
    await sendWith(f, 'Enter');
    await f.selectOption('#mode', 'build');
    await until(async () => (!(await ext('return api.test.autoEdit(arg);', autoId)) ? true : null), 10000);
    await f.hover('#log .msg.user >> nth=1');
    await sleep(400);
    const shown = await f.evaluate(() => { const b = document.querySelectorAll('#log .msg.user')[1].querySelector('button.fork'); return b && !b.hidden && getComputedStyle(b).visibility === 'visible'; });
    check(shown, 'hovering a message shows Fork from here beside Rewind');
    await shot('host-03-fork-button', { features: ['fork from here'], part: '#workbench\\.parts\\.editor',
      expect: 'The second user message has two small rounded buttons at its top right: "Fork from here" with a fork icon, then "Rewind to here".' });
    await f.evaluate(() => document.querySelectorAll('#log .msg.user')[1].querySelector('button.fork').click());
    const forkId = await until(async () => { const a = await activeChat(); return a && a !== autoId ? a : null; }, 60000);
    const g = forkId ? await chatPage() : null;
    const forkView = g ? await until(() => g.evaluate((t) => { const users = document.querySelectorAll('#log .msg.user').length; const box = document.getElementById('input').value;
      return users === 1 && box === t ? { users, box } : null; }, second), 30000) : null;
    const listed2 = forkId ? ((await ext('return api.test.sessions();')) || []).find((s) => s.id === forkId) : null;
    const child = forkId ? await ext('return api.test.isChild(arg);', forkId) : null;
    check(!!forkView && !!listed2 && child === false && /\(fork #\d+\)/.test(listed2.title || ''),
      'Fork from here opens a new tab with the messages before it and that message in the box; the copy is in the list', { forkId, forkView, listed: listed2 && listed2.title, child });
    if (g) await clearBox(g);
    await front(`opencodeagentplus-session:/${autoId}`);
    f = await chatPage();
  } else {
    const hidden = await f.evaluate(() => [...document.querySelectorAll('#log button.fork')].every((b) => b.hidden));
    check(hidden, 'without OpenCode 2 there is no Fork from here on a message');
    await f.selectOption('#mode', 'build');
  }

  // 11e. The file open in the editor and the selection go with a message unless removed (where the page takes files).
  const takesFiles = await f.evaluate(() => /@ for files/.test(document.getElementById('input').placeholder));
  const codeword = path.join(folder, 'codeword.txt');
  if (takesFiles) {
    await openFile(codeword, { beside: true, keep: true });
    /* What goes with the message is lit on the pill under the box; until codeword.txt has opened beside the chat, that
       is still the file shown before, so the check waits for it. */
    const pill = (kind) => f.evaluate((k) => { const c = document.querySelector(`#ctxPill.ctx-${k}.on`); return c && !c.hidden ? c.textContent : null; }, kind);
    const fileChip = await until(async () => { const t = await pill('file'); return t && /codeword\.txt/.test(t) ? t : null; }, 15000)
      || await f.evaluate(() => { const c = document.getElementById('ctxPill'); return c && !c.hidden ? `${c.className}: ${c.textContent}` : 'no pill'; });
    const notInBox = await f.evaluate(() => !document.querySelector('#attachments .att-chip'));
    check(!!fileChip && /codeword\.txt/.test(fileChip) && notInBox, 'the file open in the editor is lit on the pill under the box as going with the message, and is not among the attachments', { fileChip, notInBox });
    await shot('host-04-open-file', { features: ['open file goes along'], part: '#workbench\\.parts\\.editor',
      expect: 'The editor is split: codeword.txt on the right; in the chat on the left, in the row under the message box, a lit pill with a file icon, the name codeword.txt (in a chat this narrow cut short with an ellipsis, such as "codew…") and a small ×. Nothing about the file inside the box itself. The row of buttons stays on one line.' });
    await openFile(codeword, { beside: false, keep: true, sel: [0, 4, 0, 13] });
    const selChip = await until(async () => { const t = await pill('selection'); return t && /codeword\.txt:1/.test(t) ? t : null; }, 15000);
    check(!!selChip, 'a selection there takes the file\'s place', selChip);
    await f.click('#ctxDrop');
    const gone = await f.evaluate(() => { const c = document.getElementById('ctxPill'); return !c.classList.contains('on') && c.classList.contains('dropped'); });
    check(gone, 'the pill\'s × takes it out of this message, and the pill shows it struck through');
    await f.fill('#input', ask('Nothing attached.', 'Reply with the single word NOTHING and do not use any tool.'));
    await sendWith(f, 'Enter');
    const noChip = await f.evaluate(() => { const u = [...document.querySelectorAll('#log .msg.user')].pop(); return u ? u.querySelector('.user-att').textContent : 'none'; });
    const back = await until(() => f.evaluate(() => !!document.querySelector('#ctxPill.on') || null), 10000);
    check(!/codeword/.test(noChip) && !!back, 'that message was sent without the file, and the pill is lit again for the next one', { noChip, back: !!back });
    await openFile(codeword, { beside: false, keep: true, sel: [0, 0, 0, 0] });
    await until(() => f.evaluate(() => !!document.querySelector('#ctxPill.ctx-file.on') || null), 10000);
    if (real) {
      await f.fill('#input', 'What is the code word in the file attached to this message? Answer with the code word only and do not use any tool.');
      await sendWith(f, 'Enter');
      const reply = await f.evaluate(() => { const r = [...document.querySelectorAll('#log .msg.reply .md')].pop(); return r ? r.textContent : ''; });
      const chips = await f.evaluate(() => { const u = [...document.querySelectorAll('#log .msg.user')].pop(); return u ? u.querySelector('.user-att').textContent : ''; });
      check(/KIWI-93/.test(reply) && /codeword\.txt/.test(chips), 'the model reads the file sent with the message', { reply, chips });
    }
    await conf('attachOpenFile', false);
    const off = await until(() => f.evaluate(() => !document.querySelector('#ctxPill.on') || null), 10000);
    check(!!off, 'with attachOpenFile off, the file is not sent with the message');
    await conf('attachOpenFile', undefined);
  } else {
    note('this backend takes no files with a message, so the open file and the selection are not offered (the steps that send them run against a real OpenCode)');
  }

  // 11f. Cmd+Esc from an editor to the message box and back; Alt+K puts the file and selection in as an @ reference.
  const notes = path.join(folder, 'notes.txt');
  await clearBox(f);
  await openFile(notes, { beside: true, keep: false, sel: [0, 0, 0, 5] });
  const press = async (key, command) => {
    if (WINDOWS) await call('return vscode.commands.executeCommand(arg);', command);
    else await page.keyboard.press(key);
  };
  await sleep(500);
  await press('Meta+Escape', 'opencodeAgentPlus.focusInput');
  /* The chat page whose message box has the focus, among all those on screen. */
  const focusedBox = async () => {
    for (const fr of page.frames()) {
      try { if (await fr.evaluate(() => !!document.getElementById('input') && document.activeElement === document.getElementById('input') && document.hasFocus())) return fr; } catch (_) { /* detached */ }
    }
    return null;
  };
  const focused = await until(async () => ((await activeChat()) ? focusedBox() : null), 15000);
  check(!!focused, `${WINDOWS ? 'Focus the Message Box' : 'Meta+Esc in the editor'} moves to the message box of the chat tab in front`);
  const inFront = () => call('const e = vscode.window.activeTextEditor; const t = vscode.window.tabGroups.activeTabGroup.activeTab; return { editor: e ? e.document.uri.fsPath : "", tab: t ? t.label : "", text: !!t && t.input instanceof vscode.TabInputText };');
  const isBack = async () => { const a = await inFront(); return a.text && a.editor && path.relative(a.editor, notes) === '' ? a : null; };
  /* VS Code takes a moment to note that the text editor lost the focus; pressed before it has, the key focuses the box
     again. So if the first press did not take, the key is pressed once more; a person does not press twice that fast. */
  await sleep(400);
  await press('Meta+Escape', 'opencodeAgentPlus.blurInput');
  let backInEditor = await until(isBack, 5000);
  if (!backInEditor) {
    note('the first key press to go back came before VS Code noted the box had the focus; pressed again');
    await press('Meta+Escape', 'opencodeAgentPlus.blurInput');
    backInEditor = await until(isBack, 15000);
  }
  check(!!backInEditor, `${WINDOWS ? 'Back to the Editor' : 'Meta+Esc again'} goes back to the editor`, backInEditor || await inFront());
  await openFile(notes, { beside: false, keep: false, sel: [0, 0, 0, 5] });
  await sleep(400);
  await press('Alt+k', 'opencodeAgentPlus.insertAtMention');
  f = await chatPage();
  const mentioned = f ? await until(() => f.evaluate(() => (/@notes\.txt#L1 /.test(document.getElementById('input').value) ? document.getElementById('input').value : null)), 15000) : null;
  check(!!mentioned, `${WINDOWS ? 'Insert @-Mention Reference' : 'Alt+K'} puts @notes.txt#L1 in the message box of the chat tab in front`, mentioned || (f && await inputOf(f)));
  await shot('host-05-alt-k', { features: ['alt+k'], part: '#workbench\\.parts\\.editor',
    expect: 'The chat tab is in front on the left with the message box holding "@notes.txt#L1" (the caret may be in its blink-off phase); notes.txt is open on the right. Under the box a lit pill names the selection notes.txt:1, cut short with an ellipsis in a chat this narrow.' });

  // 11g. Add to Conversation from the editor's and the Explorer's context menus.
  await clearBox(f);
  await openFile(notes, { beside: false, keep: false });
  const editorArea = page.locator('.editor-group-container.active .monaco-editor .view-lines').first();
  await editorArea.click({ button: 'right' }).catch(() => {});
  const item = page.locator('.monaco-menu .action-label', { hasText: 'Add to Conversation' }).first();
  const inMenu = await item.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  if (inMenu) await shot('host-06-editor-menu', { features: ['add to conversation'], settle: 200,
    expect: 'The context menu of the notes.txt editor is open; among its entries is "Add to Conversation".' });
  if (inMenu) await item.click(); else await page.keyboard.press('Escape');
  f = await chatPage();
  const fromEditor = inMenu && f ? await until(() => f.evaluate(() => (/@notes\.txt\b/.test(document.getElementById('input').value) ? document.getElementById('input').value : null)), 15000) : null;
  check(!!fromEditor, 'the editor\'s Add to Conversation puts @notes.txt in the box of the chat tab in front', { inMenu, box: f && await inputOf(f) });
  await clearBox(f);
  await call('await vscode.commands.executeCommand("workbench.view.explorer"); return true;');
  const row = page.locator('.explorer-folders-view .monaco-list-row', { hasText: 'codeword.txt' }).first();
  const rowShown = await row.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
  if (rowShown) await row.click({ button: 'right' });
  const item2 = page.locator('.monaco-menu .action-label', { hasText: 'Add to Conversation' }).first();
  const inMenu2 = rowShown && await item2.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  if (inMenu2) await shot('host-07-explorer-menu', { features: ['add to conversation'], settle: 200,
    expect: 'The Explorer is open on the left with codeword.txt right-clicked; its context menu lists "Add to Conversation".' });
  if (inMenu2) await item2.click(); else await page.keyboard.press('Escape');
  f = await chatPage();
  const fromExplorer = inMenu2 && f ? await until(() => f.evaluate(() => (/@codeword\.txt\b/.test(document.getElementById('input').value) ? true : null)), 15000) : null;
  check(!!fromExplorer, 'the Explorer\'s Add to Conversation puts @codeword.txt in the box', { rowShown, inMenu2, box: f && await inputOf(f) });
  await clearBox(f);
  await call(`const u = (p) => vscode.Uri.file(p);
    await vscode.commands.executeCommand("opencodeAgentPlus.addToConversation", u(arg.a), [u(arg.a), u(arg.b)]);
    await vscode.commands.executeCommand("opencodeAgentPlus.addToConversation", u(arg.dir), [u(arg.dir)]); return true;`, { a: notes, b: codeword, dir: path.join(folder, 'src') });
  const both = await until(() => f.evaluate(() => { const v = document.getElementById('input').value; return /@notes\.txt\b/.test(v) && /@codeword\.txt\b/.test(v) ? v : null; }), 10000);
  const folderSaid = (await told()).some((w) => /A folder cannot be added/.test(w));
  check(!!both && folderSaid, 'several files picked in the Explorer go in together; a folder is refused with a message saying why', { both, folderSaid });
  await call('await vscode.commands.executeCommand("workbench.action.closeSidebar"); return true;').catch(() => {});
  await clearBox(f);

  // 11h. Fix with OpenCode Agent Plus among the quick fixes of a JSON error: a draft after the text already in the box.
  const broken = path.join(folder, 'broken.json');
  fs.writeFileSync(broken, '{\n  "a": 1\n  "b": 2\n}\n');
  await f.fill('#input', 'Keep this.');
  await openFile(broken, { beside: false, keep: false });
  const diags = await until(async () => { const d = await call('return vscode.languages.getDiagnostics(vscode.Uri.file(arg)).map((x) => ({ line: x.range.start.line, ch: x.range.start.character, message: x.message, severity: x.severity }));', broken); return d && d.length ? d : null; }, 45000);
  check(!!diags, 'VS Code\'s JSON service reports the missing comma', diags);
  if (diags) {
    const d0 = diags[0];
    const titles = await call(`const r = new vscode.Range(arg.line, arg.ch, arg.line, arg.ch + 1);
      const a = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", vscode.Uri.file(arg.file), r); return (a || []).map((x) => x.title);`, { file: broken, line: d0.line, ch: d0.ch });
    check(titles.includes('Fix with OpenCode Agent Plus'), 'the quick fixes there include Fix with OpenCode Agent Plus', titles);
    await call(`const e = vscode.window.activeTextEditor; const p = new vscode.Position(arg.line, arg.ch); e.selection = new vscode.Selection(p, p);
      await vscode.commands.executeCommand("editor.action.quickFix"); return true;`, { line: d0.line, ch: d0.ch });
    const entry = page.locator('.action-widget .monaco-list-row', { hasText: 'Fix with OpenCode Agent Plus' }).first();
    const inWidget = await entry.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
    if (inWidget) {
      await shot('host-08-quick-fix', { features: ['fix with opencode'], settle: 200,
        expect: 'broken.json is open with a red squiggle where a comma is missing; the quick fix menu is open next to it and lists "Fix with OpenCode Agent Plus".' });
      await entry.click();
    } else {
      await page.keyboard.press('Escape');
      await call(`const r = new vscode.Range(arg.line, arg.ch, arg.line, arg.ch + 1);
        const a = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", vscode.Uri.file(arg.file), r)).find((x) => x.title === "Fix with OpenCode Agent Plus");
        if (a) await vscode.commands.executeCommand(a.command.command, ...a.command.arguments); return !!a;`, { file: broken, line: d0.line, ch: d0.ch });
    }
    f = await chatPage();
    const draft = f ? await until(() => f.evaluate(() => { const v = document.getElementById('input').value; return /Fix this problem in @broken\.json#L\d/.test(v) ? v : null; }), 15000) : null;
    check(!!draft && draft.startsWith('Keep this.\n\n') && /- Error at line \d/.test(draft), 'picking it drafts the problem after the text already in the box of the chat tab in front', { inWidget, draft });
    if (draft) await shot('host-09-fix-draft', { features: ['fix with opencode'], part: '#workbench\\.parts\\.editor',
      expect: 'The chat tab is in front; its message box holds "Keep this.", a blank line, then "Fix this problem in @broken.json#L3:" and a line "- Error at line 3 (json …): …" describing the missing comma. Nothing was sent.' });
    await conf('showFixActions', false);
    const none = await call(`const r = new vscode.Range(arg.line, arg.ch, arg.line, arg.ch + 1);
      const a = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", vscode.Uri.file(arg.file), r); return (a || []).map((x) => x.title);`, { file: broken, line: d0.line, ch: d0.ch });
    check(!none.includes('Fix with OpenCode Agent Plus'), 'with showFixActions off it is not offered', none);
    await conf('showFixActions', undefined);
  }
  if (f) await clearBox(f);

  // 11i. A process with the conversation's OPENCODE_SESSION_ID outside OpenCode shows as detached (Linux).
  if (process.platform === 'linux') {
    await front(`opencodeagentplus-session:/${autoId}`);
    f = await chatPage();
    const child = spawn('sleep', ['287'], { detached: true, stdio: 'ignore', env: { ...process.env, OPENCODE_SESSION_ID: autoId } });
    child.unref();
    try {
      await ext('return api.test.rescanDetached();');
      const pill = await until(() => f.evaluate(() => { const b = document.getElementById('background'); return b && !b.hidden && /1 detached/.test(b.querySelector('summary').textContent) ? b.querySelector('summary').textContent : null; }), 15000);
      check(!!pill, 'the background pill counts the detached command', pill);
      if (pill) await f.click('#background > summary');
      const rows = pill ? await until(() => f.evaluate(() => [...document.querySelectorAll('#background .bg-detached')].map((r) => r.textContent)), 5000) : [];
      check((rows || []).some((r) => /sleep 287/.test(r) && r.includes(`pid ${child.pid}`)), 'its list shows the command line, the pid and when it started', rows);
      if (pill) await shot('host-10-detached', { features: ['detached commands'], part: '#workbench\\.parts\\.editor',
        expect: 'Above the message box, the background list is open: a row with a hollow green dot, "Detached", "sleep 287" in monospace and "pid <number> · since <time>". The pill under the box reads "1 detached".' });
    } finally {
      try { process.kill(child.pid, 'SIGTERM'); } catch (_) { /* gone */ }
    }
    await sleep(500);
    await ext('return api.test.rescanDetached();');
    const cleared = await until(() => f.evaluate(() => { const b = document.getElementById('background'); return b.hidden || !/detached/.test(b.querySelector('summary').textContent) ? true : null; }), 15000);
    check(!!cleared, 'once the command has ended, the pill no longer counts it');
  } else {
    note('detached commands are found through /proc, so only on Linux');
  }

  // 11k. On OpenCode 2, the effort chosen comes back after a model that lacks it, and stays when OpenCode starts again.
  await front(`opencodeagentplus-session:/${autoId}`);
  f = await chatPage();
  const effortShown = f ? await f.evaluate(() => { const e = document.getElementById('effort'); return !!e && !e.hidden && [...e.options].some((o) => o.value === 'low'); }) : false;
  if (real && line >= 2 && effortShown) {
    const model = await call('return vscode.workspace.getConfiguration("opencodeAgentPlus").get("model");');
    const exe = await call('return vscode.workspace.getConfiguration("opencodeAgentPlus").get("opencode.path");');
    const xdg = path.join(out, 'xdg');
    /* The effort OpenCode records for the session (its /api session.list, with a private server). */
    const recorded = () => {
      const r = require('child_process').spawnSync(exe, ['api', 'session.list', '--standalone'], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 << 20,
        env: { ...process.env, XDG_CONFIG_HOME: path.join(xdg, 'config'), XDG_DATA_HOME: path.join(xdg, 'data'), XDG_STATE_HOME: path.join(xdg, 'state'), XDG_CACHE_HOME: path.join(xdg, 'cache'), OPENCODE_DISABLE_AUTOUPDATE: '1' } });
      try { const row = JSON.parse(r.stdout).data.find((x) => x.id === autoId); return row && row.model ? row.model.variant : ''; } catch (_) { return ''; }
    };
    const effortNow = () => f.evaluate(() => document.getElementById('effort').value);
    const onModel = (id) => until(() => f.evaluate((m) => (document.getElementById('model').dataset.current === m ? true : null), id), 20000);
    await f.selectOption('#effort', 'low');
    await until(async () => ((await effortNow()) === 'low' ? true : null), 15000);
    await pickModel(f, HAIKU);
    await onModel(HAIKU);
    const onHaiku = await until(async () => ((await effortNow()) === 'default' ? 'default' : null), 15000) || await effortNow();
    await pickModel(f, model);
    await onModel(model);
    const back = await until(async () => ((await effortNow()) === 'low' ? 'low' : null), 15000) || await effortNow();
    const kept = await until(() => (recorded() === 'low' ? 'low' : null), 20000, 2000) || recorded();
    check(onHaiku === 'default' && back === 'low' && kept === 'low', 'the chosen effort comes back when the model offers it again, and OpenCode records it', { onHaiku, back, kept });
    await ext('return api.test.restartOpenCode();');
    await f.fill('#input', 'Reply with the single word AFTER and do not use any tool.');
    await sendWith(f, 'Enter');
    const afterRestart = { page: await effortNow(), recorded: recorded() };
    check(afterRestart.page === 'low' && afterRestart.recorded === 'low', 'after OpenCode restarts and a turn has run, both the page and OpenCode still have the effort at low', afterRestart);
  } else {
    note('keeping the effort across model changes needs OpenCode 2, so it is checked only against a real OpenCode 2');
  }

  // 11l. A message with only an image is sent, where the page takes images.
  const takesImages = f ? await f.evaluate(() => !document.getElementById('attach').hidden) : false;
  if (takesImages) {
    if (real) {
      await pickModel(f, HAIKU);
      await until(() => f.evaluate((m) => (document.getElementById('model').dataset.current === m ? true : null), HAIKU), 20000);
    }
    await clearBox(f);
    await f.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'square.png', { type: 'image/png' }));
      const box = document.getElementById('input');
      box.focus();
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, bluePng());
    const lit = await until(() => f.evaluate(() => (document.querySelectorAll('#attachments .att-image').length === 1 && !document.getElementById('send').classList.contains('empty') ? true : null)), 10000);
    check(!!lit, 'with an image and no text, the send button is lit');
    const went = await sendWith(f, 'Enter');
    const chips = await f.evaluate(() => { const u = [...document.querySelectorAll('#log .msg.user')].pop(); return u ? u.querySelector('.user-att').textContent : ''; });
    /* Only with a real OpenCode does the sent message show that it had an image. */
    check(!!went && (!real || /Image/.test(chips)), `Enter sends the image alone${real ? ', and the message shows it had one' : ''}`, { went: !!went, chips });
  } else {
    note('this backend takes no images, so the image-only message is not sent here');
  }

  // 11j. With no chat tab open, Cmd+Esc in an editor starts a conversation and focuses its box.
  await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat");
    await vscode.window.tabGroups.close(tabs); return true;`);
  await until(async () => ((await chatUris()).length === 0 ? true : null), 15000);
  await openFile(notes, { beside: false, keep: false });
  await sleep(500);
  await press('Meta+Escape', 'opencodeAgentPlus.focusInput');
  const started = await until(async () => ((await chatUris()).length === 1 && await focusedBox() ? true : null), 30000);
  check(!!started, 'with no chat tab open, it starts a conversation and focuses its message box');
  void ID;
}

module.exports = { run };
