// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node test/vscode/run.js --local --vscode <executable> --out <dir> [--agent-plus <.vsix>] [--backend fake|opencode]
 *   [--opencode <executable>] [--model <provider/model>] [--deps <folder with node_modules>] [--fonts <fonts.conf>]
 *
 * Packs this extension (build/pack-vsix.js), installs it and Agent Plus into a profile of its own, starts that VS Code
 * under xvfb-run and goes through the steps below, saving a screenshot of each to <out>/shots with a look.json that
 * test/vscode/LOOK.md explains. `fake` (the default) puts test/vscode/fake-backend.js behind the chat; `opencode` uses
 * the real backend with the OpenCode at --opencode and the user's AWS profile `self`, for a run against a real model.
 * With OpenCode 2 the page's mode and effort pickers are switched and the next turns checked against what OpenCode
 * recorded, a subagent's session stays out of the list while the turn OpenCode starts when it finishes shows in the page,
 * the model adds a row to the work plan with the plugin's tool, Agent Plus's Work plan view shows it,
 * and with the token mode switched to Interface the next message gets no plan; then a command picked from the / list
 * compacts the conversation, a pasted image (with Claude Haiku 4.5), a file picked with @ and an editor selection go with
 * a message, a subagent's progress shows on its card, and the question tool's form is answered in the page; the plan bar
 * shows the plan's row and opens the Work plan view, the conversation is renamed from its tab's menu, a delivery through
 * the source is refused while a request waits, and a reply in a tab not in front puts an envelope after its title. The
 * chat tab's icon is checked for its state dot. With OpenCode 1 the notice that the work plan needs OpenCode 2 is shown
 * once, the new controls show only what it offers, and its tab offers no Rename. The plugin writes what it does to
 * <out>/plugin.jsonl (OPENCODE_PLUS_PLAN_LOG).
 * Exits non-zero if a check fails. Needs playwright-core (found through --deps or NODE_PATH). --fonts gives VS Code a
 * fontconfig file of its own, for a machine with no CJK font, where Chinese text would be drawn as boxes.
 *
 * Under `node --test` this file does nothing: the default test patterns pick up every .js under test/.
 */
if (process.env.NODE_TEST_CONTEXT) return;

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const flag = (name, d = '') => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

const LOCAL = has('--local');
const EXE = flag('--vscode');
const OUT = path.resolve(flag('--out', path.join(os.tmpdir(), `opencode-plus-ui-${Date.now()}`)));
/* 1.4.0 or later: the plan bar needs Agent Plus's planSummary. */
const AGENT_PLUS = flag('--agent-plus', '');
const BACKEND = flag('--backend', 'fake');
const OPENCODE = flag('--opencode');
const MODEL = flag('--model', BACKEND === 'fake' ? 'fake/fake-small' : 'amazon-bedrock/us.xai.grok-4.7');
const DEPS = flag('--deps');
const FONTS = flag('--fonts');
const ID = 'xnervwang.opencode-plus';
const HAIKU = 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0';

/* A PNG of one colour, for the paste step. */
function solidPng(r, g, b, size = 32) {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const need = (name) => require(DEPS ? path.join(DEPS, 'node_modules', name) : name);
const { open, until, sleep, frameWith } = require('./lib/window');

/* VS Code's environment: none of the variables that would send the install to the VS Code running this script. */
function cleanEnv(home, extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  return { ...env, ...(home ? { HOME: home } : {}), ...extra };
}

function cliOf(exe) {
  const cli = path.join(path.dirname(exe), 'bin', 'code');
  if (!fs.existsSync(cli)) throw new Error(`no VS Code command line tool at ${cli}`);
  return (argv, env) => {
    const r = cp.spawnSync(cli, argv, { env, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
}

function writeSettings(user, extra) {
  fs.mkdirSync(path.join(user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false,
    'workbench.colorTheme': 'Default Dark Modern', 'chat.disableAIFeatures': true, 'git.enabled': false,
    'window.dialogStyle': 'custom', 'workbench.editor.wrapTabs': true, 'agentPlus.webviewRequestLimit': 'leave',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    ...extra,
  }, null, 2));
}

/* OpenCode processes still running with this run's state folder in their environment (a background service an OpenCode
   subcommand without --standalone would have left); they are stopped. Linux only, where /proc shows another process's
   environment. */
function stopLeftovers(stateDir) {
  if (process.platform !== 'linux' || !stateDir) return 'no leftover check on this platform';
  const left = [];
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let environ = '';
    try { environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch (_) { continue; }
    if (!environ.split('\0').includes(`XDG_STATE_HOME=${stateDir}`)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch (_) { /* gone */ }
    if (!/opencode/.test(cmd)) continue;
    left.push(`${pid} ${cmd.slice(0, 80)}`);
    try { process.kill(Number(pid), 'SIGTERM'); } catch (_) { /* gone */ }
  }
  return left.length ? `stopped OpenCode processes left by this run: ${left.join('; ')}` : 'no OpenCode process of this run was left running';
}

async function main() {
  if (!LOCAL && process.env.CI !== 'true') throw new Error('runs only where CI=true, or with --local: it starts VS Code and installs extensions');
  if (!EXE || !fs.existsSync(EXE)) throw new Error('--vscode <executable> is needed');
  if (!fs.existsSync(AGENT_PLUS)) throw new Error(`no Agent Plus .vsix at ${AGENT_PLUS}`);
  const playwright = need('playwright-core');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-ui-')));
  const shots = path.join(OUT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const p = { exts: path.join(root, 'exts'), user: path.join(root, 'user'), folder: path.join(root, 'ws'), control: path.join(root, 'ctl'),
    home: path.join(root, 'home'), agentHome: path.join(root, 'agent-home') };
  for (const d of Object.values(p)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(p.folder, 'README.md'), '# Demo project\n');
  fs.writeFileSync(path.join(p.folder, 'notes.txt'), 'Some notes.\n');
  fs.mkdirSync(path.join(p.folder, 'src'));
  fs.writeFileSync(path.join(p.folder, 'src', 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(p.folder, 'codeword.txt'), 'The code word is KIWI-93.\n');
  fs.writeFileSync(path.join(p.folder, 'colours.txt'), 'Colours of the week.\nThe colour of the day is MAGENTA.\nThat is all.\n');
  console.log(`temporary root ${root}; results in ${OUT}`);

  const vsix = path.join(root, 'opencode-plus.vsix');
  const pack = cp.spawnSync(process.execPath, [path.join(ROOT, 'build', 'pack-vsix.js'), ROOT, '--out', vsix], { encoding: 'utf8' });
  if (pack.status !== 0) throw new Error(`packing failed: ${pack.stderr}`);
  console.log(pack.stdout.trim());

  /*
   * The real backend signs in with the AWS profile `self` given through the extension's own settings, so that run keeps
   * the real home (the profile's credential_process reads it); OpenCode's data, config, state and cache folders all go
   * under <out>/xdg, away from the user's own OpenCode. The fake one gets a home of its own.
   */
  const real = BACKEND !== 'fake';
  const xdg = path.join(OUT, 'xdg');
  const xdgEnv = real ? { XDG_CONFIG_HOME: path.join(xdg, 'config'), XDG_DATA_HOME: path.join(xdg, 'data'), XDG_STATE_HOME: path.join(xdg, 'state'), XDG_CACHE_HOME: path.join(xdg, 'cache') } : {};
  for (const d of Object.values(xdgEnv)) fs.mkdirSync(d, { recursive: true });
  /* OpenCode's version line, read with this run's own folders. */
  let line = 0;
  if (real) {
    const v = cp.spawnSync(OPENCODE || 'opencode', ['--version'], { env: { ...process.env, ...xdgEnv }, encoding: 'utf8' });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${v.stdout || ''}`);
    line = m ? Number(m[1]) : 0;
    console.log(`OpenCode ${m ? m[0] : 'of unknown version'}`);
  }
  const planLog = path.join(OUT, 'plugin.jsonl');
  const env = cleanEnv(real ? '' : p.home, {
    OPENCODE_PLUS_HOME: p.agentHome, OPENCODE_PLUS_TEST_CONTROL: '1', ...xdgEnv, ...(FONTS ? { FONTCONFIG_FILE: path.resolve(FONTS) } : {}),
    ...(real ? { OPENCODE_PLUS_PLAN_LOG: planLog } : {}),
    ...(real ? {} : { OPENCODE_PLUS_TEST_BACKEND: path.join(HERE, 'fake-backend.js') }),
  });
  if (real) for (const k of Object.keys(env)) if (/^AWS_/.test(k)) delete env[k];
  const code = cliOf(EXE);
  for (const ext of [AGENT_PLUS, vsix]) {
    const r = code(['--install-extension', ext, `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`, '--force'], env);
    if (r.status !== 0) throw new Error(`installing ${ext} failed: ${r.out}`);
  }
  console.log(code(['--list-extensions', '--show-versions', `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`], env).out);
  writeSettings(p.user, { 'opencodePlus.model': MODEL, ...(OPENCODE ? { 'opencodePlus.opencode.path': OPENCODE } : {}),
    ...(real ? { 'opencodePlus.bedrock.profile': 'self', 'opencodePlus.bedrock.region': 'us-east-1' } : {}) });

  const steps = [];
  let failed = 0, passed = 0;
  const check = (cond, what, detail) => {
    if (cond) { passed++; console.log(`  ok    ${what}`); return true; }
    failed++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return false;
  };

  const w = await open({ exe: EXE, profile: p, env, playwright, log: path.join(OUT, 'vscode.log') });
  const { page, call } = w;
  let previous = null;
  /* A screenshot of the window and of one part of it, recorded in look.json. */
  const shot = async (name, { features, expect, unchanged = null, part = null, frame = null, note } = {}) => {
    await sleep(600);
    const full = path.join(shots, `${name}-full.png`);
    await page.screenshot({ path: full });
    let image = full;
    if (part) {
      const el = await page.$(part);
      if (el) { image = path.join(shots, `${name}.png`); await el.screenshot({ path: image }); }
    }
    /* The size of `image`, from its PNG header. */
    const head = fs.readFileSync(image);
    const size = { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    steps.push({ name, features: features || [name], expect, unchanged, image: path.basename(image), full: path.basename(full),
      previous: previous ? path.basename(previous) : null, width: size.width, height: size.height, log: [], ...(note ? { note } : {}) });
    previous = full;
    fs.writeFileSync(path.join(shots, 'look.json'), JSON.stringify(steps, null, 2));
    void frame;
  };
  const ext = (body, arg, ms) => call(`const e = vscode.extensions.getExtension(${JSON.stringify(ID)}); const api = e.isActive ? e.exports : await e.activate(); ${body}`, arg, ms);
  /* The chat tab of conversation `id` as VS Code's tab API has it: its label and whether it is in front. */
  const tabOf = (id) => call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.toString() === "opencodeplus-session:/" + arg);
    return t ? { label: t.label, active: t.isActive } : null;`, id);
  /* The image the tab strip draws as the icon of the tab whose label starts with `label`. */
  const iconOf = (label) => page.evaluate((t) => {
    for (const tab of document.querySelectorAll('.tabs-container .tab')) {
      const name = tab.querySelector('.label-name');
      if (!name || !name.textContent.startsWith(t)) continue;
      const icon = tab.querySelector('.monaco-icon-label-iconpath');
      return icon ? icon.style.backgroundImage : 'no icon element';
    }
    return 'no such tab';
  }, label);
  /* Opens the context menu of the tab whose label starts with `label` and returns its items; the menu stays open. */
  const tabMenu = async (label) => {
    await page.evaluate((t) => {
      for (const tab of document.querySelectorAll('.tabs-container .tab')) {
        const name = tab.querySelector('.label-name');
        tab.toggleAttribute('data-test-tab', !!name && name.textContent.startsWith(t));
      }
    }, label);
    await page.click('.tabs-container .tab[data-test-tab]', { button: 'right' });
    const first = page.locator('.monaco-menu .action-label').first();
    await first.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    return (await page.locator('.monaco-menu .action-label').allTextContents()).map((x) => x.trim()).filter(Boolean);
  };
  /* Renames the conversation of the tab whose label starts with `label` from that tab's context menu. */
  const renameFromTab = async (label, title, shotName) => {
    const items = await tabMenu(label);
    if (!items.includes('Rename Conversation')) { await page.keyboard.press('Escape'); return { items, renamed: false }; }
    if (shotName) await shot(shotName, { features: ['rename from the tab'], expect: 'The context menu of the chat tab is open; among its entries is "Rename Conversation".' });
    await page.locator('.monaco-menu .action-label', { hasText: 'Rename Conversation' }).first().click();
    await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 10000 });
    await page.fill('.quick-input-widget input', title);
    await page.keyboard.press('Enter');
    return { items, renamed: true };
  };

  try {
    await w.hostUp();
    await until(() => ext('return !!(api && api.test);'), 60000);

    // 1. The activity bar icon and the Conversations view.
    const icon = await page.waitForSelector('.activitybar .action-item a[aria-label^="OpenCode Plus"], .activitybar .action-item [aria-label^="OpenCode Plus"]', { timeout: 30000 }).catch(() => null);
    check(!!icon, 'the activity bar has the OpenCode Plus icon');
    if (icon) await icon.click();
    const viewOk = await until(() => page.evaluate(() => [...document.querySelectorAll('.pane-header')].some((h) => /Conversations/i.test(h.textContent))), 20000);
    check(viewOk, 'the Conversations view shows in the side bar');
    const pluginHome = path.join(p.agentHome, 'opencode-plugin', 'agent-work-plan');
    const plansDir = path.join(p.agentHome, 'plans');
    const inPlace = await until(() => ['index.js', 'hooks/plan_common.py', 'hooks/plan_agent.py', 'hooks/inject-work-plan.py'].every((f) => fs.existsSync(path.join(pluginHome, f)))
      && fs.existsSync(path.join(plansDir, 'config.json')), 20000);
    check(inPlace, "the work plan plugin, its scripts and config.json are in place in the extension's folder");
    await shot('01-activity-bar', { features: ['activity bar icon', 'Conversations view'],
      expect: 'The activity bar on the far left has the OpenCode Plus icon (a speech bubble with three dots) selected; the side bar shows the OpenCode Plus container with a Conversations view (its header may read "OpenCode Plus: Convers…"), empty or with a hint.',
      part: '#workbench\\.parts\\.sidebar' });

    // 2. A new conversation opens a chat tab.
    const before = Date.now();
    await page.click('.pane-header [aria-label="New Conversation"], .pane-header .codicon-add').catch(async () => { await call('return vscode.commands.executeCommand("opencodePlus.newConversation");'); });
    const tab = await until(() => call(`const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputCustom ? { viewType: t.input.viewType, uri: t.input.uri.toString(), label: t.label } : null;`), 30000);
    check(tab && tab.viewType === 'opencodePlus.chat' && /^opencodeplus-session:\/ses_/.test(tab.uri), 'a new conversation opens a opencodePlus.chat tab of opencodeplus-session:/<id>', tab);
    let chat = await frameWith(page, '#input', 30000);
    check(!!chat, 'the chat page loaded in the tab');
    await shot('02-new-conversation', { features: ['new conversation', 'chat editor tab'],
      expect: `An editor tab is open with the chat page: a header with a model selector showing ${real ? 'the Grok model' : 'Fake Small'}, an empty message area, and a message box at the bottom with a Send button.`,
      part: '#workbench\\.parts\\.editor' });

    let sessionId = tab ? tab.uri.replace(/^opencodeplus-session:\//, '') : '';
    const NEEDS_V2 = /The work plan needs OpenCode 2/;
    const toldV2 = async () => ((await ext('return api.test.told();')) || []).filter((t) => NEEDS_V2.test(t)).length;
    if (real && line === 1) {
      const n = await until(toldV2, 20000);
      const toast = await until(() => page.evaluate(() => [...document.querySelectorAll('.notification-toast, .notifications-toasts')].some((e) => /The work plan needs OpenCode 2/.test(e.textContent))), 10000);
      check(n === 1 && !!toast, 'on OpenCode 1 the notice "The work plan needs OpenCode 2" is shown once', { told: n, toast });
      await shot('02b-needs-opencode-2', { features: ['work plan notice on OpenCode 1'],
        expect: 'A notification at the bottom right says "The work plan needs OpenCode 2. This is OpenCode 1.19.6. Update OpenCode to keep a work plan in these conversations."' });
    }
    if (!real) {
      // 3. A message gets a reply; the permission request is answered from the page.
      if (chat) {
        await chat.fill('#input', 'Hello there, please fix the failing test');
        await chat.press('#input', 'Enter');
        const asked = await until(() => chat.$('button[data-decision="allowOnce"]'), 30000);
        check(!!asked, 'the reply streams in and stops at a permission request with Allow once');
        const waiting = await until(() => ext('return api.test.conversations().find((c) => c.activity === "waiting");'), 10000);
        check(!!waiting, 'the conversation is waiting for the user while the request is open', waiting);
        const waitIcon = await until(async () => { const t = await tabOf(sessionId); const i = t ? await iconOf(t.label) : ''; return /tab-waiting-dark-/.test(i) ? i : null; }, 10000);
        check(!!waitIcon, "while it waits, the chat tab's icon is the logo with a red dot", waitIcon || await iconOf((await tabOf(sessionId) || {}).label || ''));
        await shot('03-permission', { features: ['streamed reply', 'tool cards', 'permission request'],
          expect: 'The user message "Hello there, please fix the failing test", a reasoning block, a reply that starts "I\'ll look at the test first.", a read_file tool card with its result, and an edit_file card asking for permission with Allow once, Allow in this project, Deny and View diff buttons.',
          part: '#workbench\\.parts\\.editor' });
        if (asked) await asked.click();
        const done = await until(() => chat.evaluate(() => document.body.dataset.status === 'idle' && /subtracted instead of adding/.test(document.getElementById('log').textContent)), 30000);
        check(done, 'after Allow once the turn finishes with its last reply');
        const stopIcon = await until(async () => { const t = await tabOf(sessionId); const i = t ? await iconOf(t.label) : ''; return /tab-stopped-dark-/.test(i) ? i : null; }, 10000);
        check(!!stopIcon, "once the turn is over, the chat tab's icon is the plain logo", stopIcon);
        await shot('04-reply', { features: ['reply', 'reply figures'],
          expect: 'The edit_file card says it was allowed once, and the reply ends with "Fixed: sum subtracted instead of adding." and a code block; below the reply a line of figures such as a duration, ctx and the model name.',
          part: '#workbench\\.parts\\.editor' });

        // 4z. Rename from the chat tab's menu: the tab, the page and the list follow.
        const fakeLabel = (await tabOf(sessionId) || {}).label || '';
        const r = await renameFromTab(fakeLabel, 'Renamed in the fake run', '04z-tab-menu');
        const fakeRenamed = await until(async () => {
          const t = await tabOf(sessionId);
          const rows = (await ext('return api.test.sessions();')) || [];
          const pageTitle = await chat.evaluate(() => document.getElementById('title').textContent);
          return t && t.label === 'Renamed in the fake run' && pageTitle === 'Renamed in the fake run' && rows.some((x) => x.id === sessionId && x.title === 'Renamed in the fake run') ? { tab: t.label, pageTitle } : null;
        }, 15000);
        check(r.renamed && !!fakeRenamed, "Rename in the chat tab's menu renames the conversation: the tab, the page and the Conversations list follow", { r, fakeRenamed });
      }

    } else {
      // 3 (real model). A request that needs a tool: the tool call, the approval, the answer.
      const figures = () => chat.evaluate(() => document.querySelectorAll('#log .figures').length);
      const status = () => chat.evaluate(() => document.body.dataset.status);
      /* Sends `text` and waits for its turn to end, answering Allow once to every permission request on the way. */
      const turn = async (text, name, tick) => {
        const before = await figures();
        await chat.fill('#input', text);
        await chat.press('#input', 'Enter');
        return waitTurn(before, name, tick);
      };
      /* Waits for the turn begun after `before` figures lines to end, answering Allow once on the way; `tick` runs at
         each look. */
      const waitIcons = [];
      const waitTurn = async (before, name, tick) => {
        await until(async () => (await status()) !== 'idle' || (await figures()) > before, 60000, 200);
        let approved = 0;
        const end = Date.now() + 300000;
        while (Date.now() < end) {
          if (tick) await tick();
          /* An answered card keeps its buttons, hidden. */
          let button = null;
          for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { button = b; break; }
          if (button) {
            if (!approved) {
              const t = await tabOf(sessionId);
              if (t) waitIcons.push(await iconOf(t.label));
              await shot(`${name}-permission`, { features: ['tool call', 'permission request'],
                expect: 'The user message, a tool card for the call the model made, and a permission card with Allow once, Allow in this project and Deny buttons.',
                part: '#workbench\\.parts\\.editor' });
            }
            await button.click();
            approved++;
            await sleep(800);
            continue;
          }
          if ((await status()) === 'idle' && (await figures()) > before) break;
          await sleep(500);
        }
        return approved;
      };
      const menuItems = () => chat.evaluate(() => {
        const m = document.getElementById('menu');
        return m && !m.hidden ? [...m.querySelectorAll('.menu-item .menu-name')].map((e) => e.textContent) : [];
      });
      const lastReply = () => chat.evaluate(() => { const r = [...document.querySelectorAll('#log .msg.reply')].pop(); return r ? r.textContent : ''; });
      const lastUserChips = () => chat.evaluate(() => { const u = [...document.querySelectorAll('#log .msg.user')].pop(); return u ? [...u.querySelectorAll('.att')].map((e) => e.textContent) : []; });
      /* What OpenCode itself recorded for the session: its /api session.list, with a private server. */
      const recorded = () => {
        const r = cp.spawnSync(OPENCODE, ['api', 'session.list', '--param', 'limit=50', '--standalone'],
          { env: { ...process.env, ...xdgEnv, OPENCODE_DISABLE_AUTOUPDATE: '1' }, encoding: 'utf8', timeout: 60000 });
        try { return (JSON.parse(r.stdout).data || []).find((s) => s.id === sessionId) || null; } catch (_) { return null; }
      };
      if (chat) {
        let approved = await turn('列出工作目录下的文件', '03');
        const tools = await chat.evaluate(() => [...document.querySelectorAll('#log .tool')].map((e) => e.textContent.replace(/\s+/g, ' ').slice(0, 80)));
        check(tools.length > 0, 'the model called a tool for the request', tools);
        if (!approved) {
          console.log('  note  the first request asked for no approval (the model used a tool that needs none); asking for bash');
          approved = await turn('Now run `ls -la` with the bash tool and tell me what it shows.', '03b');
        }
        check(approved > 0, 'a permission request was shown and approved with Allow once');
        const answer = await chat.evaluate(() => document.getElementById('log').textContent);
        check(/README\.md|notes\.txt|sum\.js/.test(answer), 'the answer names files of the working folder');
        const idleIcon = await until(async () => { const t = await tabOf(sessionId); const i = t ? await iconOf(t.label) : ''; return /tab-stopped-dark-/.test(i) ? i : null; }, 10000);
        check(waitIcons.some((i) => /tab-waiting-dark-/.test(i)) && !!idleIcon, "the chat tab's icon has a red dot while the request waits, and is the plain logo once the turn is over", { waitIcons, idleIcon });
        await shot('04-answer', { features: ['answer', 'reply figures'],
          expect: 'The tool card shows its result and the permission card says allowed; the model answer lists the files of the folder (README.md, notes.txt, src); under it a figures line with a duration, ctx, maybe a cost, and the model name grok.',
          part: '#workbench\\.parts\\.editor' });

        if (line === 1) {
          // 3z. The second batch's controls on OpenCode 1: what it offers shows, and nothing reports an error.
          await chat.fill('#input', '/');
          await sleep(1500);
          const slash = await menuItems();
          console.log(`  note  OpenCode 1 lists ${slash.length} slash commands: ${JSON.stringify(slash.slice(0, 8))}`);
          await chat.press('#input', 'Escape');
          await chat.fill('#input', '@');
          const at = await until(async () => { const l = await menuItems(); return l.length ? l : null; }, 10000);
          await chat.press('#input', 'Escape');
          await chat.fill('#input', '');
          const page1 = await chat.evaluate(() => ({ placeholder: document.getElementById('input').placeholder, errors: [...document.querySelectorAll('#log .notice.level-error')].map((e) => e.textContent),
            questions: document.querySelectorAll('#log .question').length, compactions: document.querySelectorAll('#log .compaction').length }));
          const told1 = ((await ext('return api.test.told();')) || []).filter((t) => /error|fail/i.test(t));
          check(!!at && at.includes('notes.txt') && !page1.errors.length && !told1.length && !page1.questions && !page1.compactions,
            'on OpenCode 1 the @ list works, the other new controls show only what it offers, and nothing reports an error', { at, page: page1, told: told1, slash });
          await shot('04z-v1-controls', { features: ['new controls on OpenCode 1'],
            expect: 'The chat page as before, the message box empty; its placeholder may add hints such as "@ to add a file"; no error notice, no question form, no compaction line.',
            part: '#workbench\\.parts\\.editor' });
          const v1Items = await tabMenu((await tabOf(sessionId) || {}).label || '');
          await page.keyboard.press('Escape');
          const v1Bar = await chat.evaluate(() => { const b = document.querySelector('[data-agent-plus-plan-bar]'); return !!b && b.style.display !== 'none'; });
          check(v1Items.length > 0 && !v1Items.includes('Rename Conversation') && !v1Bar, "on OpenCode 1 the chat tab's menu has no Rename, and the page has no plan bar", { items: v1Items, bar: v1Bar });
        }

        if (line >= 2) {
          // 3e. Mode and effort, as OpenCode offers them: picked in the page, they take effect from the next turn. What
          // OpenCode itself recorded for the session says so (its /api session.list, with a private server).
          const pickers = () => chat.evaluate(() => ['mode', 'effort'].map((id) => {
            const s = document.getElementById(id);
            return { id, hidden: !s || s.hidden, value: s ? s.value : '', values: s ? [...s.options].map((o) => o.value) : [] };
          }));
          const shownPickers = await until(async () => { const o = await pickers(); return o.every((x) => !x.hidden && x.values.length > 1) ? o : null; }, 20000);
          check(!!shownPickers && shownPickers[0].values.includes('plan') && shownPickers[1].values.includes('low'), 'the mode and effort pickers show beside the model', shownPickers || await pickers());
          await chat.selectOption('#mode', 'plan');
          const planShown = await until(async () => (await pickers())[0].value === 'plan', 10000);
          await shot('04d-mode-plan', { features: ['mode picker', 'effort picker'],
            expect: 'The chat header has, right of the model picker, a mode picker now showing Plan and an effort picker; the rest of the page is unchanged.',
            part: '#workbench\\.parts\\.editor' });
          await turn('Use the write tool to create a file named plan-test.txt containing the word hi. Then tell me in one line whether you could.', '04d');
          const planFile = path.join(p.folder, 'plan-test.txt');
          const inPlan = recorded();
          check(planShown && !fs.existsSync(planFile) && !!inPlan && inPlan.agent === 'plan', 'with Plan picked, the next turn runs as the plan agent and writes no file',
            { planShown, file: fs.existsSync(planFile), agent: inPlan && inPlan.agent });
          await chat.selectOption('#mode', 'build');
          await until(async () => (await pickers())[0].value === 'build', 10000);
          await chat.selectOption('#effort', 'low');
          const lowShown = await until(async () => (await pickers())[1].value === 'low', 10000);
          await turn('Reply with only the word four.', '04e');
          const fig = await chat.evaluate(() => { const f = [...document.querySelectorAll('#log .figures')].pop(); return f ? f.textContent : ''; });
          const inLow = recorded();
          check(lowShown && / low$/.test(fig) && !!inLow && inLow.agent === 'build' && !!inLow.model && inLow.model.variant === 'low',
            'with Build and effort Low picked, the next turn runs with both, and its figures name the effort', { fig, agent: inLow && inLow.agent, model: inLow && inLow.model });
          await shot('04e-effort-low', { features: ['effort in reply figures'],
            expect: 'The Plan turn says the file could not be written; then "Reply with only the word four." and the reply "four", whose figures line ends with the model name followed by "low"; the pickers show Build and Low.',
            part: '#workbench\\.parts\\.editor' });

          // 3f. A subagent: its session stays out of the list, and the turn OpenCode starts when it finishes shows here.
          const notices = () => chat.evaluate(() => [...document.querySelectorAll('#log .notice')].map((e) => e.textContent));
          const activities = new Set();
          let clicked = 0, wentOn = false, runningShot = false;
          /* The subagent's request may come before the parent's turn is over, and its whole run with it, so this looks
             while that turn is awaited too. */
          const watch = async () => {
            const c = ((await ext('return api.test.conversations();')) || []).find((x) => x.sessionId === sessionId);
            /* Only once the parent's own turn is over: what counts is the turn OpenCode starts after it. */
            if (c && (await figures()) > beforeSub) activities.add(c.activity);
            if (!runningShot && await chat.$('#log .tool .child.state-running')) {
              runningShot = true;
              /* Once it has done something, so the box has a last line to show. */
              await until(() => chat.evaluate(() => { const l = document.querySelector('#log .tool .child.state-running .child-last'); return !!l && !!l.textContent; }), 5000);
              await shot('04f0-subagent-running', { features: ['subagent progress'],
                expect: 'Under the subagent tool card a "Subagent" box with the subagent\'s title, "Running…", and the last thing it did (such as a shell sleep command), maybe with "Its steps (n)"; a permission card for its shell command may be there too, marked "from subagent".',
                part: '#workbench\\.parts\\.editor' });
            }
          };
          const beforeSub = await figures();
          await turn('Use the subagent tool to start one subagent whose task is: use the shell tool to run the command sleep 8, then reply finished. After launching it, end your response at once without waiting.', '04f', watch);
          const end = Date.now() + 150000;
          while (Date.now() < end) {
            await watch();
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { await b.click(); clicked++; await sleep(500); }
            if ((await notices()).some((t) => /went on without a message from you/.test(t)) && (await status()) === 'idle') { wentOn = true; break; }
            await sleep(500);
          }
          check(wentOn && activities.has('working'), 'for the background subagent OpenCode went on without a message: the page says so, the conversation worked and went back to idle',
            { clicked, activities: [...activities], notices: await notices() });
          let kinds = {};
          try { kinds = JSON.parse(fs.readFileSync(path.join(p.agentHome, 'opencode-sessions.json'), 'utf8')).parents || {}; } catch (_) { /* none */ }
          const children = Object.keys(kinds).filter((k) => kinds[k] === sessionId);
          const rowsNow = ((await ext('return api.test.sessions();')) || []).map((r) => r.id);
          check(children.length > 0 && rowsNow.includes(sessionId) && !children.some((k) => rowsNow.includes(k)), "the subagent's session is known as a child and left out of the Conversations list",
            { children, rows: rowsNow });
          /* Its steps are drawn when the list is opened (a toggle event), so this looks again until they are there. */
          const card = await until(() => chat.evaluate(() => {
            const c = [...document.querySelectorAll('#log .tool .child')].pop();
            if (!c || !/Done/.test(c.querySelector('.child-state').textContent)) return null;
            const steps = c.querySelector('.child-steps');
            if (steps && !steps.open) { steps.open = true; return null; }
            const tools = [...c.querySelectorAll('.child-list .tool-name')].map((e) => e.textContent);
            return tools.length ? { title: c.querySelector('.child-title').textContent, state: c.querySelector('.child-state').textContent,
              steps: c.querySelector('.child-steps summary').textContent, tools } : null;
          }), 20000);
          const fromSub = await chat.evaluate(() => [...document.querySelectorAll('#log .permission .from-sub')].filter((e) => !e.hidden).map((e) => e.textContent));
          check(runningShot && !!card && card.tools.length > 0 && fromSub.length > 0,
            "the subagent's card showed it running and then done with its steps, and its request said it came from the subagent", { runningShot, card, fromSub });
          /* Opening the steps makes the log longer above its end, which then lies below the view: two pictures. */
          await chat.evaluate(() => {
            const c = [...document.querySelectorAll('#log .tool .child')].pop();
            const log = document.getElementById('log');
            if (c) log.scrollTop = c.closest('.tool').offsetTop - log.offsetTop;
          });
          await shot('04f-subagent', { features: ['subagent progress'],
            expect: 'Near the top, the subagent tool card with a "Subagent" box below it: the subagent\'s title, "Done", and "Its steps (n)" opened, listing its steps (a shell sleep command among them). Below it the rest of that turn: possibly a shell card and a permission card (allowed once) marked "from subagent …", and the short reply.',
            part: '#workbench\\.parts\\.editor' });
          await chat.evaluate(() => { const log = document.getElementById('log'); log.scrollTop = log.scrollHeight; });
          await shot('04f2-subagent-reply', { features: ['turn OpenCode started itself'],
            expect: 'The end of the conversation: the notice "OpenCode went on without a message from you, for a background task (a subagent or a command).", then the reply that the subagent has finished, with its figures line under it; the status line shows no work in progress.',
            part: '#workbench\\.parts\\.editor' });
        }

        if (line >= 2) {
          // 3c. The work plan: a row added with the plugin's tool, shown by Agent Plus's Work plan view.
          const planFile = path.join(plansDir, `${sessionId}.json`);
          const rows = () => {
            let plan = null;
            try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch (_) { return []; }
            const out = [];
            const walk = (ns) => { for (const n of ns || []) { out.push(n); walk(n.children); } };
            walk(plan && plan.nodes);
            return out;
          };
          await turn("Call the add_row tool once, with state doing and title 'list the files'. Do nothing else, then reply with only ok.", '04b');
          const row = await until(() => rows().find((n) => n.title === 'list the files'), 20000);
          const tools = await chat.evaluate(() => [...document.querySelectorAll('#log .tool')].map((e) => e.textContent.replace(/\s+/g, ' ').slice(0, 60)));
          check(!!row, "the model added a row to the conversation's work plan with the add_row tool", { rows: rows(), tools: tools.slice(-3) });
          await shot('04b-plan-row', { features: ['plan tool call'],
            expect: 'The chat shows the request to call add_row, an add_row tool card (its one-line result, "row 1 added: doing", may be folded), and the reply "ok".',
            part: '#workbench\\.parts\\.editor' });

          // 3c0. The plan bar: Agent Plus's summary of the plan right above the input box; a click opens its Work plan view.
          const barNow = () => chat.evaluate(() => {
            const b = document.querySelector('[data-agent-plus-plan-bar]');
            if (!b || b.style.display === 'none') return null;
            const r = b.getBoundingClientRect(), f = document.getElementById('composer').getBoundingClientRect();
            return { text: b.textContent, label: b.getAttribute('aria-label'), gap: Math.round(f.top - r.bottom), width: Math.round(r.width), box: Math.round(f.width) };
          });
          const bar = await until(barNow, 45000);
          check(!!bar && (/list the files/.test(bar.text) || /All rows done/.test(bar.text)) && bar.gap >= 0 && bar.gap <= 12 && Math.abs(bar.width - bar.box) <= 2,
            'once the plan has a row, the plan bar shows it right above the input box, as wide as it', bar);
          await shot('04b2-plan-bar', { features: ['plan bar'],
            expect: 'Right above the message box, as wide as it, a one-line bar: a list icon and "Plan", a short coloured track, "1 open", and the row "1 list the files" with its state icon (or a green check and "All rows done"), and an arrow at the right end.',
            part: '#workbench\\.parts\\.editor' });
          await call('await vscode.commands.executeCommand("workbench.view.explorer"); return true;').catch(() => {});
          await until(() => page.evaluate(() => !/Work plan/i.test(document.getElementById('workbench.parts.sidebar').textContent)), 5000);
          await chat.click('[data-agent-plus-plan-bar]');
          const barOpened = await until(() => page.evaluate(() => {
            const side = document.getElementById('workbench.parts.sidebar');
            return !!side && /Work plan/i.test(side.textContent) && side.textContent.includes('list the files');
          }), 20000);
          check(barOpened, "clicking the plan bar opens Agent Plus's Work plan view at this conversation");
          await call('await vscode.commands.executeCommand("agentPlus.workPlan.focus"); return true;').catch(() => {});
          const inView = await until(() => page.evaluate(() => {
            const side = document.getElementById('workbench.parts.sidebar');
            return !!side && /Work plan/i.test(side.textContent) && side.textContent.includes('list the files');
          }), 30000);
          check(inView, "Agent Plus's Work plan view shows that row for this conversation");
          await shot('04c-work-plan-view', { features: ['Agent Plus work plan'],
            expect: 'The side bar shows Agent Plus\'s Work plan view for this conversation, with the row "list the files" (doing, or done if the model has already closed it), while the chat tab stays in the editor.',
            part: '#workbench\\.parts\\.sidebar' });

          // 3d. Token mode Interface: the plugin stops adding the plan from the next message.
          const plugin = () => {
            try { return fs.readFileSync(planLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } }); } catch (_) { return []; }
          };
          const injected = path.join(plansDir, `${sessionId}.injected`);
          const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
          /* First a message the plan is injected into, which also leaves .injected beside the plan. */
          await turn('Reply with only the word two.', '07b');
          const shown = plugin().filter((l) => l.kind === 'prompt' && l.sessionID === sessionId).pop();
          check(!!shown && shown.chars > 0 && mtime(injected) > 0, 'with the plan open, the next message gets the plan injected', { last: shown, injected: mtime(injected) });
          await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", "interface", vscode.ConfigurationTarget.Global); return true;');
          const off = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(plansDir, 'config.json'), 'utf8')).enabled === false; } catch (_) { return false; } }, 10000);
          check(off, 'switching the token mode to Interface writes enabled: false for the plugin at once');
          const promptsBefore = plugin().filter((l) => l.kind === 'prompt' && l.sessionID === sessionId);
          const injectedBefore = mtime(injected);
          await turn('Reply with only the word three.', '08');
          await sleep(1500);
          const promptsAfter = plugin().filter((l) => l.kind === 'prompt' && l.sessionID === sessionId);
          const withdrawn = plugin().some((l) => l.kind === 'tools' && l.registered === false);
          const reply = await chat.evaluate(() => document.getElementById('log').textContent);
          check(promptsBefore.length > 0 && promptsAfter.length === promptsBefore.length && injectedBefore > 0 && mtime(injected) === injectedBefore && withdrawn && /three/i.test(reply),
            'in Interface the next message gets no work plan: no injection in the plugin log, .injected unchanged, the plan tools withdrawn, and the reply still comes',
            { promptsBefore: promptsBefore.length, promptsAfter: promptsAfter.length, injectedBefore, injectedAfter: mtime(injected), withdrawn });
          await shot('08-interface-mode', { features: ['token mode Interface'],
            expect: 'The chat shows "Reply with only the word three." and the reply "three", with no plan tool card in that turn.',
            part: '#workbench\\.parts\\.editor' });
          await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", undefined, vscode.ConfigurationTarget.Global); return true;').catch(() => {});

          // 3h. An image pasted into the box goes with the message; Claude Haiku 4.5 reads it.
          await chat.selectOption('#model', HAIKU);
          const onHaiku = await until(() => chat.evaluate((id) => document.getElementById('model').dataset.current === id, HAIKU), 15000);
          await chat.evaluate((b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'square.png', { type: 'image/png' }));
            const box = document.getElementById('input');
            box.focus();
            box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          }, solidPng(30, 80, 230).toString('base64'));
          const thumbs = await until(() => chat.evaluate(() => document.querySelectorAll('#attachments .att-image img').length), 10000);
          check(onHaiku && thumbs === 1, 'with Claude Haiku 4.5 picked, a pasted image shows as a thumbnail above the box', { onHaiku, thumbs });
          await shot('10-pasted-image', { features: ['pasted image'],
            expect: 'Above the empty message box a chip with a small blue square thumbnail, the name square.png and a × button; the model picker shows Claude Haiku 4.5.',
            part: '#workbench\\.parts\\.editor' });
          await turn('What colour is this image? Answer with one word and do not use any tool.', '10b');
          const colour = await lastReply();
          const imgChips = await lastUserChips();
          check(/blue/i.test(colour) && imgChips.includes('Image'), 'the model answers the colour of the pasted image, and the message shows it had one', { colour, imgChips });
          await chat.selectOption('#model', MODEL);
          await until(() => chat.evaluate((id) => document.getElementById('model').dataset.current === id, MODEL), 15000);

          // 3i. @ lists the workspace's files; the one picked goes with the message.
          await chat.fill('#input', 'What is the code word in @codew');
          const atList = await until(async () => { const l = await menuItems(); return l.includes('codeword.txt') ? l : null; }, 20000);
          check(!!atList, 'typing @ lists the workspace files that match', atList || await menuItems());
          await shot('11-at-menu', { features: ['@ file list'],
            expect: 'Above the message box, which holds "What is the code word in @codew", a list with codeword.txt (its path beside it) highlighted.',
            part: '#workbench\\.parts\\.editor' });
          await chat.press('#input', 'Enter');
          const withFile = await chat.inputValue('#input');
          await chat.type('#input', '? Answer with the code word only and do not use any tool.');
          const beforeFile = await figures();
          await chat.press('#input', 'Enter');
          await waitTurn(beforeFile, '11b');
          const word = await lastReply();
          const fileChips = await lastUserChips();
          check(withFile === 'What is the code word in @codeword.txt ' && /KIWI-93/.test(word) && fileChips.includes('codeword.txt'),
            'picking it puts @codeword.txt in the box, and the model answers from that file', { withFile, word, fileChips });

          // 3j. A selection in an editor: the page offers it, and it goes with the message.
          const colours = path.join(p.folder, 'colours.txt');
          await call(`const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(colours)}));
            const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
            ed.selection = new vscode.Selection(1, 0, 1, 33); return true;`);
          const selLabel = await until(() => chat.evaluate(() => { const b = document.getElementById('addSelection'); return b && !b.hidden ? b.textContent : ''; }), 15000);
          if (selLabel) await chat.click('#addSelection');
          const selChip = await until(() => chat.evaluate(() => [...document.querySelectorAll('#attachments .att-selection')].map((e) => e.textContent).join(' | ')), 10000);
          check(/colours\.txt:2/.test(selLabel || '') && /colours\.txt:2/.test(selChip || ''), 'with text selected in an editor the page offers it, and adding it shows it above the box', { selLabel, selChip });
          await shot('11c-selection', { features: ['selection button'],
            expect: 'The editor is split: colours.txt on the right with line 2 selected; in the chat, right of the message box, a button "+ colours.txt:2", and above the box a chip "Selection colours.txt:2" with a × button.',
            part: '#workbench\\.parts\\.editor' });
          await turn('What colour of the day does the attached selection name? One word, no tools.', '11d');
          const dayColour = await lastReply();
          check(/magenta/i.test(dayColour) && (await lastUserChips()).some((c) => /colours\.txt:2/.test(c)), 'the model answers from the selection sent with the message', { dayColour });
          await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === ${JSON.stringify(colours)});
            await vscode.window.tabGroups.close(tabs); return true;`).catch(() => {});

          // 3k. The question tool asks with a form in the page; the answer reaches the model.
          const beforeQuestion = await figures();
          await chat.fill('#input', 'Use the question tool to ask me whether I prefer red or blue (two options). Then reply with only the colour I chose.');
          await chat.press('#input', 'Enter');
          let form = null;
          const qEnd = Date.now() + 120000;
          while (!form && Date.now() < qEnd) {
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { await b.click(); await sleep(500); }
            form = await chat.$('#log .question:not(.settled) input[type="radio"]');
            if (!form) await sleep(500);
          }
          const qWaiting = ((await ext('return api.test.conversations();')) || []).find((x) => x.sessionId === sessionId);
          const listedQ = ((await ext('return api.test.source.listConversations();')) || []).find((x) => x.sessionId === sessionId);
          check(!!form && !!qWaiting && qWaiting.activity === 'waiting' && !!listedQ && !!listedQ.waitingFor && listedQ.waitingFor.kind === 'question',
            "the question tool's form shows in the page, and the conversation waits for an answer to a question", { form: !!form, activity: qWaiting && qWaiting.activity, waitingFor: listedQ && listedQ.waitingFor });
          await shot('12-question', { features: ['question form'],
            expect: 'A question card with a "Question" badge, the question about red or blue with two round choices (Red, Blue), an own-answer box, and Submit and Cancel buttons; the status line says it waits for an answer to a question.',
            part: '#workbench\\.parts\\.editor' });
          if (form) {
            await chat.evaluate(() => {
              const card = [...document.querySelectorAll('#log .question:not(.settled)')].pop();
              const blue = [...card.querySelectorAll('label.q-option')].find((l) => /blue/i.test(l.textContent));
              if (blue) blue.querySelector('input').click();
              card.querySelector('.q-submit').click();
            });
            await waitTurn(beforeQuestion, '12b');
          }
          const chosen = await lastReply();
          const settledQ = await chat.evaluate(() => { const c = [...document.querySelectorAll('#log .question')].pop(); return c ? c.querySelector('.perm-result').textContent : ''; });
          check(/blue/i.test(chosen) && /^Answered: .*Blue/i.test(settledQ), 'after Submit the model gets the answer: it replies with the colour chosen, and the card says what was answered', { chosen, settledQ });
          await shot('12b-answered', { features: ['question answered'],
            expect: 'Above it the question tool card (its result folded), then the question card, which now reads "Answered: … Blue": Blue\'s choice is checked and in bold, the other choice and the own-answer box are faded, and there are no buttons; below it the reply "Blue" (or "blue"), with a figures line.',
            part: '#workbench\\.parts\\.editor' });

          // 3l. Rename from the chat tab's menu: the tab, the page, the Conversations list, Agent Plus and OpenCode follow.
          const NEW_TITLE = 'Renamed by the window test';
          const r = await renameFromTab((await tabOf(sessionId) || {}).label || '', NEW_TITLE, '13-tab-menu');
          const renamed = await until(async () => {
            const t = await tabOf(sessionId);
            const pageTitle = await chat.evaluate(() => document.getElementById('title').textContent);
            const rows = (await ext('return api.test.sessions();')) || [];
            const apRows = (await ext('return api.test.source.listConversations();')) || [];
            const inOc = recorded();
            const out = { tab: t && t.label, pageTitle, list: (rows.find((x) => x.id === sessionId) || {}).title,
              agentPlus: (apRows.find((x) => x.sessionId === sessionId) || {}).title, opencode: inOc && inOc.title };
            return Object.values(out).every((v) => v === NEW_TITLE) ? out : null;
          }, 20000);
          check(r.renamed && !!renamed, "Rename in the chat tab's menu renames the conversation: the tab, the page, the Conversations list, Agent Plus's list and OpenCode's own record follow", { r, renamed });
          await call('await vscode.commands.executeCommand("agentPlus.conversations.focus"); return true;').catch(() => {});
          const apView = await until(() => page.evaluate((t) => { const e = document.getElementById('workbench.parts.panel'); return !!e && e.textContent.includes(t); }, NEW_TITLE), 30000);
          check(apView, "Agent Plus's Conversations view shows the new title");
          await shot('13b-renamed', { features: ['renamed conversation'],
            expect: `The chat tab and the page header read "${NEW_TITLE}"; the panel below shows Agent Plus's Conversations view with a row of that title.` });
          await call('await vscode.commands.executeCommand("workbench.action.closePanel"); return true;').catch(() => {});

          // 3m. While it waits for an approval, a delivery through the source is refused and says why; when the turn
          // ends, the latest reply is written beside the plan.
          let refused = null;
          const askText = 'Run the command `echo waiting-check` with the shell tool, then reply with only the word done.';
          const beforeAsk = await figures();
          await chat.fill('#input', askText);
          await chat.press('#input', 'Enter');
          await waitTurn(beforeAsk, '14', async () => {
            if (refused) return;
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) {
              if (await b.isVisible()) {
                refused = await ext('return api.test.source.deliverAnswer(arg, "a message from the steward", { deliveryId: "window-test-1" });', sessionId);
                return;
              }
            }
          });
          check(!!refused && refused.outcome === 'notReceived' && /^it is waiting for approval of \S+ in its window$/.test(refused.reason || ''),
            "while the conversation waits for an approval, the source's deliverAnswer refuses the message and names what it waits for", refused);
          const replyFile = path.join(plansDir, `${sessionId}.reply.json`);
          let latest = null;
          try { latest = JSON.parse(fs.readFileSync(replyFile, 'utf8')); } catch (_) { /* none */ }
          check(!!latest && latest.format === 1 && latest.said.length > 0 && latest.said[latest.said.length - 1].text === askText && /done/i.test(latest.reply)
            && !/a message from the steward/.test(JSON.stringify(latest)),
          'when the turn ends, the latest reply is written beside the plan: the message just sent and the reply to it, and not the refused one', { latest, shown: await lastReply() });

          // 3n. A reply in a tab not in front: an envelope after its title, gone once the tab comes to the front.
          await call('return vscode.commands.executeCommand("opencodePlus.newConversation");');
          const secondId = await until(async () => {
            const u = await call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.toString() : null;');
            return u && u !== `opencodeplus-session:/${sessionId}` ? u.replace(/^opencodeplus-session:\//, '') : null;
          }, 30000);
          const delivered = await ext('return api.test.source.deliverAnswer(arg, "Reply with only the word five.", { deliveryId: "window-test-2" });', sessionId);
          const unread = await until(async () => {
            const sn = await ext('return api.test.snapshot(arg);', sessionId);
            const t = await tabOf(sessionId);
            return sn && sn.activity === 'stopped' && sn.unseen && t && t.label.endsWith('\u{1F4E9}') ? { label: t.label, active: t.active } : null;
          }, 180000);
          const apUnseen = ((await ext('return api.test.source.listConversations();')) || []).find((x) => x.sessionId === sessionId);
          check(!!secondId && !!delivered && delivered.outcome === 'submitted' && !!unread && !unread.active && !!apUnseen && apUnseen.unseen === true,
            'a reply in a tab not in front puts an envelope after its title, and Agent Plus hears it is unseen', { secondId, delivered, unread, apUnseen });
          await shot('15-unread-envelope', { features: ['unread envelope', 'tab state dot'],
            expect: `Two chat tabs, each with the speech-bubble logo and no dot (neither conversation is working or waiting): the one in front is a new, empty conversation; the other reads "${NEW_TITLE} 📩", the envelope after its title.`,
            part: '#workbench\\.parts\\.editor' });
          const all = (await ext('return api.test.source.listAllConversations();')) || [];
          let windowFile = null;
          try { windowFile = JSON.parse(fs.readFileSync(await ext('return api.test.windowFile;'), 'utf8')); } catch (_) { /* none */ }
          check(all.some((c) => c.sessionId === sessionId) && all.some((c) => c.sessionId === secondId) && !!windowFile && windowFile.conversations.some((c) => c.sessionId === sessionId),
            "listAllConversations gives both conversations, and this window's file holds them for the other windows",
            { all: all.map((c) => c.sessionId), file: windowFile && windowFile.conversations.map((c) => c.sessionId) });
          await call('return vscode.commands.executeCommand("opencodePlus.openConversation", arg);', sessionId);
          const seen = await until(async () => { const t = await tabOf(sessionId); return t && t.active && t.label === NEW_TITLE ? t : null; }, 15000);
          check(!!seen, 'once that tab comes to the front, the envelope is gone', seen || await tabOf(sessionId));
          await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === "opencodeplus-session:/" + arg);
            await vscode.window.tabGroups.close(tabs); return true;`, secondId).catch(() => {});
          await sleep(1000);
          chat = await frameWith(page, '#input', 30000);
          await shot('15b-envelope-gone', { features: ['unread envelope'],
            expect: `One chat tab, "${NEW_TITLE}", in front with no envelope; its page ends with the reply "five".`,
            part: '#workbench\\.parts\\.editor' });

          /* Last of these: the first message after compacting gets the work plan's note about the plan again, which a
             model may answer instead of the message. */
          // 3g. Slash commands: / lists OpenCode's commands; /compact picked from the list and sent compacts.
          await chat.fill('#input', '/');
          const listedCmds = await until(async () => { const l = await menuItems(); return l.length ? l : null; }, 15000);
          check(!!listedCmds && listedCmds.includes('/compact'), 'typing / lists the slash commands OpenCode offers', listedCmds || []);
          const order = await chat.evaluate(() => {
            const r = (el) => (el ? el.getBoundingClientRect() : null);
            const bar = r(document.querySelector('[data-agent-plus-plan-bar]')), menu = r(document.getElementById('menu')), box = r(document.getElementById('composer'));
            return bar && menu && box ? { barBottom: Math.round(bar.bottom), menuTop: Math.round(menu.top), menuBottom: Math.round(menu.bottom), boxTop: Math.round(box.top) } : null;
          });
          check(!!order && order.barBottom <= order.menuTop && order.boxTop - order.menuBottom >= 0 && order.boxTop - order.menuBottom <= 12,
            'the / list sits right above the input box, and the plan bar above the list', order);
          await shot('09-slash-menu', { features: ['slash command list'],
            expect: 'Right above the message box, which holds "/", a list of commands such as /init, /review, /compact, each with a short description; the first is highlighted. The plan bar is above the list, not between the list and the box.',
            part: '#workbench\\.parts\\.editor' });
          await chat.type('#input', 'comp');
          const narrowed = await until(async () => { const l = await menuItems(); return l[0] === '/compact' ? l : null; }, 5000);
          await chat.press('#input', 'Enter');
          const typed = await chat.inputValue('#input');
          check(!!narrowed && typed === '/compact ', 'typing narrows the list, and Enter puts the command in the box', { narrowed, typed });
          const beforeCompact = await figures();
          await chat.press('#input', 'Enter');
          await waitTurn(beforeCompact, '09b');
          const compaction = await until(() => chat.evaluate(() => {
            const c = [...document.querySelectorAll('#log .compaction')].pop();
            return c && c.classList.contains('status-completed') ? { label: c.querySelector('.compaction-label').textContent, summary: !c.querySelector('.compaction-summary').hidden } : null;
          }), 60000);
          check(!!compaction && compaction.summary, 'after /compact the page shows the compaction line, with the summary to unfold', compaction);
          await chat.evaluate(() => {
            const d = [...document.querySelectorAll('#log .compaction-summary')].pop();
            const log = document.getElementById('log');
            if (d) { d.open = true; log.scrollTop = d.closest('.compaction').offsetTop - log.offsetTop; }
          });
          await shot('09b-compacted', { features: ['compaction divider'],
            expect: 'At the top, a horizontal line labelled "Conversation compacted" with a "Summary" below it, unfolded to show the summary OpenCode wrote (headings such as Objective); the figures line of the /compact turn follows the summary, possibly below the visible part.',
            part: '#workbench\\.parts\\.editor' });
        }
      }

    }

    // 4. Agent Plus took the source, and lists the conversation.
    const apState = await ext('await api.test.registered; return api.test.agentPlus;');
    check(apState && apState.accepted === true, 'Agent Plus accepted the source', apState);
    const listed = await ext('return api.test.source.listConversations();');
    check(Array.isArray(listed) && listed.some((c) => c.sessionId === sessionId && c.running === true), 'the conversation is in the list given to Agent Plus', listed);
    const apTab = await call(`const t = vscode.window.tabGroups.activeTabGroup.activeTab; const e = vscode.extensions.getExtension(${JSON.stringify(ID)}).exports; return e.test.source.sessionForTab(t);`);
    check(apTab === sessionId, 'sessionForTab names the conversation of the chat tab', apTab);
    await call('await vscode.commands.executeCommand("agentPlus.conversations.focus"); return true;').catch(() => {});
    const firstWords = real ? '列出工作目录' : 'Hello there';
    const titleNow = async () => ((await ext('return (api.test.conversations()[0] || {}).title || "";')) || firstWords).slice(0, 20);
    const inAp = await until(async () => page.evaluate((t) => { const e = document.getElementById('workbench.parts.panel'); return !!e && e.textContent.includes(t); }, await titleNow()), 30000);
    check(inAp, "the conversation shows in Agent Plus's Conversations view");
    await shot('05-agent-plus', { features: ['Agent Plus conversations'],
      expect: 'The panel at the bottom shows Agent Plus\'s Conversations view, which lists this conversation by its title (possibly cut short) with no activity dot, since it has stopped.',
      part: '#workbench\\.parts\\.panel' });
    await call('await vscode.commands.executeCommand("workbench.action.closePanel"); return true;').catch(() => {});

    // 5. The Conversations view lists it. (Clicking the icon of the container already shown would hide the side bar.)
    await call('await vscode.commands.executeCommand("workbench.view.extension.opencodePlus"); return true;');
    const inList = await until(async () => page.evaluate((t) => document.getElementById('workbench.parts.sidebar').textContent.includes(t), await titleNow()), 30000);
    check(inList, 'the Conversations view lists the conversation');
    await shot('06-sessions', { features: ['session list'],
      expect: real && line >= 2
        ? 'The OpenCode Plus Conversations view lists two rows with speech-bubble icons: the conversation by its title, and an "Untitled conversation", the empty one the envelope step opened and closed (OpenCode keeps a conversation from the moment it is made). A relative time such as "now" may be cut off by a long title.'
        : 'The OpenCode Plus Conversations view lists one row with the conversation title and a speech-bubble icon (a relative time such as "now" may be cut off by a long title).',
      part: '#workbench\\.parts\\.sidebar' });

    // 6. A reload brings the tab back with its history.
    await w.reload();
    await until(() => ext('return !!(api && api.test);'), 60000);
    const back = await until(() => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodePlus.chat").map((t) => t.input.uri.toString());`), 30000);
    check(Array.isArray(back) && back.includes(`opencodeplus-session:/${sessionId}`), 'after a reload the chat tab is back for the same conversation', back);
    const again = await frameWith(page, '#input', 30000);
    const history = again && await until(() => again.evaluate((re) => new RegExp(re).test(document.getElementById('log').textContent), real ? '列出工作目录下的文件' : 'subtracted instead of adding'), 30000);
    check(!!history, 'the restored tab shows the conversation so far');
    if (real && line === 1) {
      await sleep(3000);
      const again2 = await toldV2();
      check(again2 === 0, 'after the reload the notice is not shown again', { told: again2 });
    }
    await shot('07-after-reload', { features: ['reload', 'restored history'],
      expect: 'After the reload the chat tab is open again and shows the same conversation: the user message, the tool cards and the final reply.',
      part: '#workbench\\.parts\\.editor' });
  } catch (e) {
    check(false, 'the window steps ran to their end', (e && e.stack) || String(e));
    try { await shot('99-failure', { expect: 'The window as it was when the run failed.', note: String(e && e.message) }); } catch (_) { /* no window */ }
  } finally {
    await w.close();
    if (real) console.log(`  note  ${stopLeftovers(xdgEnv.XDG_STATE_HOME)}`);
  }
  console.log(`\nVS Code window: ${passed} passed, ${failed} failed; screenshots in ${shots}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error((e && e.stack) || e); process.exitCode = 1; });
