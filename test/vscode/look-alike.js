// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node test/vscode/look-alike.js --local --vscode <executable> --agent-plus <.vsix> --out <dir> [--deps <folder>]
 *   [--fonts <fonts.conf>] [--vsix <.vsix>] [--official <folder>] [<state> ...]
 *
 * Puts the chat page through the states of STATES, in the dark and the light theme, with test/vscode/fake-backend.js
 * and its demo turns (OPENCODE_AGENT_PLUS_FAKE_DEMO), and saves for each a picture with Claude Code's panel in the
 * same state on the left and this page on the right. The pictures go to <out>/shots with a look.json, which
 * test/vscode/LOOK.md explains; test/vscode/LOOK-ALIKE.md says how to judge them. The left halves are the pictures in --official (by default
 * test/vscode/look-alike/), taken once in Claude Code Plus's demo window; official.json there says from which versions.
 * They picture Anthropic's panel, so the folder stays on the developer's machine and out of the repository.
 * Both halves are the editor area of a window of 1440 by 900 CSS pixels without its row of tabs, cut the same way.
 * The pictures are put together on a canvas in the window itself, so nothing beyond what run.js needs is installed.
 * It runs only when someone starts it, never in CI; given state names, it pictures only those.
 *
 * Under `node --test` this file does nothing but export STATES.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const ID = 'xnervwang.opencode-agent-plus';
/* The editor area's row of tabs, left out of both halves: it shows each extension's own icon. */
const TABS = 35;
/* The / and @ lists keep only the lower part, where the list and the message box are. */
const LOWER = 440;
const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern' };

/*
 * Each state has a `name` its pictures are named after, the `themes` the archive has pictures of it in, `lower` to
 * keep only the lower part, and `expect`, what both halves show. act() puts this page into the state; it runs in order, in one conversation.
 */
const STATES = [
  { name: 'slash', themes: ['dark'], lower: true,
    expect: 'The message box holds "/" and right above it a list of commands as wide as the box, the first row highlighted.' },
  { name: 'at', themes: ['dark'], lower: true,
    expect: 'The message box holds "@" and right above it a list of files as wide as the box, each with a file icon, the first row highlighted.' },
  { name: 'permission', themes: ['dark', 'light'],
    expect: 'A request for permission, framed in the focus colour, right above (or in place of) the message box: a bold question naming the tool, the call\'s detail, and numbered rows to allow once, to allow for the project, and to refuse, the first highlighted; a hint about the keys under them.' },
  { name: 'reply', themes: ['dark', 'light'],
    expect: 'Your messages as full-width boxes with a coloured bar down the left edge and a small grey time before the text; every row of a reply hangs on a thin line down the left with a dot and starts with its small grey time; on the last row of each reply the turn\'s figures (a duration, ctx, cost, model) follow that time.' },
  { name: 'conversation', themes: ['dark', 'light'],
    expect: 'A turn with a thinking row, rows of text, and tool rows: each tool row has its time on a line of its own, then the tool\'s name in bold and what it was called with in grey; one tool is opened to a framed box with an IN row and an OUT row in a monospaced font.' },
  { name: 'question', themes: ['dark', 'light'],
    expect: 'A question from the model, framed in the focus colour, right above (or in place of) the message box: the question, each choice a row with a round button, its label and a grey description, a box for typing your own answer, and a Submit button.' },
  { name: 'subagent', themes: ['dark', 'light'],
    expect: 'A subagent\'s call as a tool row, under it a framed box saying what the subagent was asked and how it ended, with a small dot; the reply after it.' },
  { name: 'error', themes: ['dark'],
    expect: 'A tool call that failed: a red dot on its row, and its framed box with the command after IN and the error after OUT.' },
  { name: 'running', themes: ['dark', 'light'],
    expect: 'A turn still running: the last tool row has no end time, a line with a spinning mark shows the turn is still working, the message box\'s placeholder offers to queue another message, and the button at the right end of its row is a filled square to stop.' },
];

module.exports = { STATES, TABS, LOWER, THEMES };
if (require.main !== module || process.env.NODE_TEST_CONTEXT) return;

const args = process.argv.slice(2);
const flag = (name, d = '') => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const LOCAL = has('--local');
const EXE = flag('--vscode');
const AGENT_PLUS = flag('--agent-plus');
const OUT = path.resolve(flag('--out', path.join(os.tmpdir(), `opencode-agent-plus-look-alike-${Date.now()}`)));
const DEPS = flag('--deps');
const FONTS = flag('--fonts');
const VSIX = flag('--vsix');
const OFFICIAL = path.resolve(flag('--official', path.join(HERE, 'look-alike')));
const ONLY = args.filter((a) => STATES.some((s) => s.name === a));
const need = (name) => require(DEPS ? path.join(DEPS, 'node_modules', name) : name);
const { open, until, sleep, frameWith } = require('./lib/window');

function cleanEnv(home, extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  return { ...env, HOME: home, ...extra };
}

/* The pictures in order, each written to <shots>; the canvas lives in the workbench page. */
async function compose(page, left, right, labels) {
  return page.evaluate(async ([a, b, la, lb]) => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('a picture would not load')); i.src = src; });
    const [x, y] = await Promise.all([a ? load(a) : null, load(b)]);
    const gap = 16, head = 28;
    const w = (x ? x.width : y.width) + gap + y.width, h = Math.max(x ? x.height : 0, y.height) + head;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#7f7f7f';
    g.fillRect(0, 0, w, h);
    if (x) g.drawImage(x, 0, head);
    g.drawImage(y, (x ? x.width : y.width) + gap, head);
    g.fillStyle = '#000000';
    g.font = '15px sans-serif';
    g.fillText(la, 8, 19);
    g.fillText(lb, (x ? x.width : y.width) + gap + 8, 19);
    return { url: c.toDataURL('image/png'), width: w, height: h };
  }, [left, right, labels[0], labels[1]]);
}

async function main() {
  if (!LOCAL) throw new Error('runs only with --local: it starts VS Code and installs extensions');
  if (!EXE || !fs.existsSync(EXE)) throw new Error('--vscode <executable> is needed');
  if (!AGENT_PLUS || !fs.existsSync(AGENT_PLUS)) throw new Error('--agent-plus <.vsix> is needed');
  const official = JSON.parse(fs.readFileSync(path.join(OFFICIAL, 'official.json'), 'utf8'));
  const playwright = need('playwright-core');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oap-look-alike-')));
  const shots = path.join(OUT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const p = { exts: path.join(root, 'exts'), user: path.join(root, 'user'), folder: path.join(root, 'ws'), control: path.join(root, 'ctl'),
    home: path.join(root, 'home'), agentHome: path.join(root, 'agent-home') };
  for (const d of Object.values(p)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(p.folder, 'README.md'), '# Demo project\n');
  fs.writeFileSync(path.join(p.folder, 'notes.txt'), 'Some notes.\n');
  fs.mkdirSync(path.join(p.folder, 'src'));
  fs.writeFileSync(path.join(p.folder, 'src', 'sum.js'), 'module.exports = (a, b) => a + b;\n');

  const vsix = VSIX ? path.resolve(VSIX) : path.join(root, 'opencode-agent-plus.vsix');
  if (!VSIX) {
    const pack = cp.spawnSync(process.execPath, [path.join(ROOT, 'build', 'pack-vsix.js'), ROOT, '--out', vsix], { encoding: 'utf8' });
    if (pack.status !== 0) throw new Error(`packing failed: ${pack.stderr}`);
  }
  const env = cleanEnv(p.home, { OPENCODE_AGENT_PLUS_HOME: p.agentHome, OPENCODE_AGENT_PLUS_TEST_CONTROL: '1', OPENCODE_AGENT_PLUS_FAKE_DEMO: '1',
    OPENCODE_AGENT_PLUS_TEST_BACKEND: path.join(HERE, 'fake-backend.js'), ...(FONTS ? { FONTCONFIG_FILE: path.resolve(FONTS) } : {}) });
  const cli = process.platform === 'darwin' ? path.resolve(EXE, '..', '..', 'Resources', 'app', 'bin', 'code') : path.join(path.dirname(EXE), 'bin', 'code');
  for (const ext of [AGENT_PLUS, vsix]) {
    const r = cp.spawnSync(cli, ['--install-extension', ext, `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`, '--force'], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`installing ${ext} failed: ${r.stdout}${r.stderr}`);
  }
  fs.mkdirSync(path.join(p.user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(p.user, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false,
    'workbench.colorTheme': THEMES.dark, 'chat.disableAIFeatures': true, 'git.enabled': false, 'window.dialogStyle': 'custom',
    'agentPlus.webviewRequestLimit': 'leave', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'window.menuStyle': 'custom',
    'opencodeAgentPlus.model': 'fake/fake-small',
  }, null, 2));

  const w = await open({ exe: EXE, profile: p, env, playwright, log: path.join(OUT, 'vscode.log') });
  const { page, call } = w;
  const steps = [];
  let previous = null;
  let failed = 0;
  try {
    await w.hostUp();
    const ext = (body) => call(`const e = vscode.extensions.getExtension(${JSON.stringify(ID)}); const api = e.isActive ? e.exports : await e.activate(); ${body}`);
    await until(() => ext('return !!(api && api.test);'), 60000);
    /* Agent Plus asks once, a few seconds after its first start, which token mode to use; the notice would cover the
       message box. */
    await until(() => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].some((n) => /token mode/i.test(n.textContent))), 20000);
    await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
    const editor = () => page.evaluate(() => { const b = document.getElementById('workbench.parts.editor').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
    const picture = (file) => (fs.existsSync(file) ? `data:image/${/\.png$/.test(file) ? 'png' : 'jpeg'};base64,${fs.readFileSync(file).toString('base64')}` : null);

    for (const theme of Object.keys(THEMES)) {
      const wanted = STATES.filter((s) => s.themes.includes(theme) && (!ONLY.length || ONLY.includes(s.name)));
      if (!wanted.length) continue;
      await call(`await vscode.workspace.getConfiguration().update("workbench.colorTheme", ${JSON.stringify(THEMES[theme])}, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand("workbench.action.closeSidebar"); await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("notifications.clearAll"); await vscode.commands.executeCommand("opencodeAgentPlus.newConversation"); return true;`);
      await sleep(1500);
      const chat = await frameWith(page, '#input', 30000);
      if (!chat) throw new Error('no chat page opened');
      await sleep(1000);
      const idle = () => until(() => chat.evaluate(() => document.body.dataset.status === 'idle'), 30000);
      const say = async (t) => { await chat.fill('#input', t); await chat.press('#input', 'Enter'); await sleep(400); };
      const toLastUser = () => chat.evaluate(() => { const u = [...document.querySelectorAll('#log .msg.user')].pop(); const l = document.getElementById('log');
        if (u) l.scrollTop += u.getBoundingClientRect().top - l.getBoundingClientRect().top - 8; });
      const toEnd = () => chat.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
      const acts = {
        slash: async () => { await chat.click('#input'); await chat.fill('#input', '/'); await chat.evaluate(() => document.getElementById('input').dispatchEvent(new Event('input'))); await sleep(800); },
        at: async () => { await chat.fill('#input', '@'); await chat.evaluate(() => { const i = document.getElementById('input'); i.setSelectionRange(1, 1); i.dispatchEvent(new Event('input')); }); await sleep(1500); },
        permission: async () => { await chat.press('#input', 'Escape'); await say('Hello there, please fix the failing test'); await until(() => chat.$('button[data-decision="allowOnce"]'), 30000); await sleep(1200); },
        reply: async () => { await chat.click('button[data-decision="allowOnce"]'); await idle(); await sleep(600); },
        conversation: async () => {
          await say('Demo: conversation'); await idle(); await sleep(600);
          await chat.click('#log .tool:not(.subagent) >> nth=-2 >> .tool-head'); await chat.click('#log details.reasoning >> nth=-1 >> summary');
          await sleep(300); await toLastUser(); await sleep(400);
        },
        question: async () => { await say('Demo: question'); await until(() => chat.$('#log .question:not(.settled)'), 20000); await sleep(800); },
        subagent: async () => {
          await chat.click('#log .question:not(.settled) label.q-option >> nth=0'); await chat.click('#log .question:not(.settled) .q-submit'); await idle();
          await say('Demo: subagent'); await idle(); await sleep(400); await toLastUser(); await sleep(400);
        },
        error: async () => { await say('Demo: error'); await idle(); await sleep(400); await toLastUser(); await sleep(400); },
        running: async () => { await say('Demo: running'); await sleep(2500); await toEnd(); await sleep(300); },
      };
      /* Every act runs in order, since each state builds on the one before; only the states asked for are pictured. */
      for (const s of STATES) {
        if (!s.themes.includes(theme)) { if (acts[s.name]) await acts[s.name]().catch(() => {}); continue; }
        let note = '';
        try { await acts[s.name](); } catch (e) { note = `the state could not be reached: ${e.message.split('\n')[0]}`; }
        if (!wanted.includes(s)) continue;
        await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
        await page.mouse.move(2, 450);
        await sleep(500);
        const area = await editor();
        const top = s.lower ? area.y + area.height - LOWER : area.y + TABS;
        const clip = { x: Math.round(area.x), y: Math.round(top), width: Math.round(area.width), height: Math.round(area.y + area.height - top) };
        const ours = path.join(shots, `${theme}-${s.name}.ours.png`);
        const full = path.join(shots, `${theme}-${s.name}.full.png`);
        await page.screenshot({ path: ours, clip, animations: 'disabled' });
        await page.screenshot({ path: full, animations: 'disabled' });
        const left = picture(path.join(OFFICIAL, theme, `${s.name}.jpg`));
        if (!left) note = note || `no archived picture ${theme}/${s.name}.jpg of Claude Code's panel`;
        const made = await compose(page, left, picture(ours), [`Claude Code ${official.claudeCode} with Claude Code Plus ${official.claudeCodePlus} (archived)`, 'OpenCode Agent Plus (this run)']);
        const image = path.join(shots, `${theme}-${s.name}.png`);
        fs.writeFileSync(image, Buffer.from(made.url.split(',')[1], 'base64'));
        steps.push({ name: `${theme}-${s.name}`, features: ['look alike Claude Code', s.name],
          expect: `${THEMES[theme]} theme. The left half is Claude Code's panel, the right half this extension's chat page, in the same state. Judge by LOOK-ALIKE.md how alike they look. Both halves should show: ${s.expect}`,
          unchanged: null, image: path.basename(image), full: path.basename(full), previous: previous ? path.basename(previous) : null,
          width: made.width, height: made.height, log: [], official: { file: `${theme}/${s.name}.jpg`, claudeCode: official.claudeCode, claudeCodePlus: official.claudeCodePlus },
          ...(note ? { note } : {}) });
        if (note) { failed++; console.log(`  FAIL  ${theme}-${s.name}: ${note}`); } else console.log(`  ok    ${theme}-${s.name}`);
        previous = full;
        fs.writeFileSync(path.join(shots, 'look.json'), JSON.stringify(steps, null, 2));
      }
      if (acts.running) await chat.click('#stop').catch(() => {});
    }
  } finally {
    await w.close();
  }
  for (const f of ['LOOK.md', 'LOOK-ALIKE.md']) fs.copyFileSync(path.join(HERE, f), path.join(shots, f));
  console.log(`look alike: ${steps.length - failed} pictured, ${failed} failed; pictures and look.json in ${shots}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
