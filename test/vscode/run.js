// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node test/vscode/run.js --local --vscode <executable> --out <dir> [--agent-plus <.vsix>] [--backend fake|opencode]
 *   [--opencode <executable>] [--model <provider/model>] [--aws-profile <name>] [--aws-region <region>]
 *   [--deps <folder with node_modules>] [--fonts <fonts.conf>]
 *   [--vsix <.vsix>] [--restricted | --download | --steward | --title-order [--claude-code <id or .vsix>] [--codex <id or .vsix>]]
 * CI=true node test/vscode/run.js --out <dir> --agent-plus <.vsix> [--vsix <.vsix>] [--cache <folder>] [--restricted]
 *
 * Packs this extension (build/pack-vsix.js), or uses the .vsix given with --vsix, installs it and Agent Plus into a
 * profile of its own, starts that VS Code (under xvfb-run on Linux) and goes through the steps below, saving a
 * screenshot of each to <out>/shots with a look.json that test/vscode/LOOK.md explains. `fake` (the default) puts
 * test/vscode/fake-backend.js behind the chat; `opencode` uses the real backend with the OpenCode at --opencode and
 * the AWS profile given with --aws-profile (AWS_PROFILE when it is left out), for a run against a real model.
 * With OpenCode 2 the page's mode and effort pickers are switched and the next turns checked against what OpenCode
 * recorded, a subagent's session stays out of the list and the turn OpenCode starts after the subagent finishes shows in
 * the page, the model adds a row to the work plan with the plugin's tool and Agent Plus's Work plan view shows it,
 * and with the token mode switched to Interface the next message gets no plan; then a command picked from the / list
 * compacts the conversation, a pasted image (with Claude Haiku 4.5), a file picked with @ and an editor selection go with
 * a message, a subagent's progress shows on its card, and the question tool's form is answered in the page; the plan bar
 * shows the plan's row and opens the Work plan view, the conversation is renamed from its tab's menu, a delivery through
 * the source is refused while a request waits, and a reply in a tab not in front puts an envelope after its title. The
 * chat tab's icon is checked for its state dot. Then a permission request is answered from its diff's title bar, the
 * conversation is rewound (cancelled first, which puts the files back, then for real, in a workspace with an empty git
 * repository so OpenCode can restore files), a reply shows a local image, a shell command moved to the background shows
 * on the background pill until it ends, Esc stops a turn, the info box and the MCP list show, and a fork opens from the
 * tab's menu while the Conversations view splits into its two groups. After the reload a replayed message keeps the time
 * it was sent. The icons are shot in the activity bar in both themes, in the Extensions view, and on Agent Plus's rows
 * once a second source is registered (Agent Plus draws a source's logo only then). With OpenCode 1 the notice that the
 * work plan needs OpenCode 2 is shown once, the / and @ lists, question forms and compaction line show only what it
 * offers, and its tab offers Fork but not Rename. The plugin writes what it does to <out>/plugin.jsonl
 * (OPENCODE_AGENT_PLUS_PLAN_LOG).
 * After its own steps, the fake run also goes through the OpenCode 2 steps: with OPENCODE_AGENT_PLUS_FAKE_DEMO=1 the fake
 * backend answers the same prompts (fake-backend.js PROMPTS), and lib/gap-ci.js reads what it recorded where OpenCode's
 * own record is read. Its plan row is a plan file the test writes; the plugin's own steps (its tool, its injection) are
 * left to the real runs. Before the reload three chat tabs are open, one behind another and one in a split to the
 * right; after it each is back in its group with its own conversation.
 * --restricted runs test/vscode/lib/restricted.js instead: the folder untrusted, then trusted.
 * --steward runs test/vscode/lib/steward.js instead, with the real backend and OpenCode 2: a stand-in for Claude Code Plus's
 * source names two stewards for the conversation, the model hands messages to the one each turn calls for, and then the
 * stand-in names none.
 * --title-order runs test/vscode/lib/title-order.js instead, on the fake backend, with Claude Code and Codex installed;
 * it checks where their editor title buttons and this extension's land.
 * --download runs test/vscode/lib/download.js instead, with the real backend and no OpenCode to find (no --opencode, no
 * setting, PATH without a folder holding one): the notification's button downloads OpenCode from GitHub.
 * Exits non-zero if a check fails. Needs playwright-core (found through --deps or NODE_PATH). --fonts gives VS Code a
 * fontconfig file of its own, for a machine with no CJK font, where Chinese text would be drawn as boxes.
 * With CI=true and no --vscode, the version of VS Code in VSCODE_VERSION is downloaded with @vscode/test-electron
 * (found the same way) into --cache, by default a folder under RUNNER_TEMP or the system's temporary folder. The fake
 * and the Restricted Mode runs work on Linux, macOS and Windows; on the last two the window opens without xvfb-run.
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
const VSIX = flag('--vsix');
const CACHE = flag('--cache');
/* The same VS Code as the local runs use. */
const VSCODE_VERSION = '1.147.0';
const OUT = path.resolve(flag('--out', path.join(os.tmpdir(), `opencode-agent-plus-ui-${Date.now()}`)));
/* 1.4.0 or later: the plan bar needs Agent Plus's planSummary. Without --agent-plus, the newest package built in a
   vscode-agent-plus checkout beside this repository. */
function siblingAgentPlus() {
  const dir = path.join(ROOT, '..', 'vscode-agent-plus', 'build');
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^xnervwang\.agent-plus-[\d.]+\.vsix$/.test(f)) : [];
  const v = (f) => f.match(/([\d.]+)\.vsix$/)[1].split('.').map(Number);
  found.sort((a, b) => { const x = v(a), y = v(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  return found.length ? path.join(dir, found[found.length - 1]) : '';
}
const AGENT_PLUS = flag('--agent-plus') || siblingAgentPlus();
const DOWNLOAD = has('--download');
const BACKEND = DOWNLOAD ? 'opencode' : flag('--backend', 'fake');
const OPENCODE = flag('--opencode');
const MODEL = flag('--model', BACKEND === 'fake' ? 'fake/fake-small' : 'amazon-bedrock/us.xai.grok-4.7');
const AWS = { profile: flag('--aws-profile', process.env.AWS_PROFILE || ''), region: flag('--aws-region', process.env.AWS_REGION || 'us-east-1') };
const DEPS = flag('--deps');
const FONTS = flag('--fonts');
const RESTRICTED = has('--restricted');
const STEWARD_RUN = has('--steward');
const TITLE_ORDER = has('--title-order');
const ID = 'xnervwang.opencode-agent-plus';
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

/* An empty git repository, made without running git: OpenCode keeps file snapshots, and so can rewind files, only
   inside a git repository. */
function emptyGitRepo(dir) {
  const g = path.join(dir, '.git');
  for (const d of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'info']) fs.mkdirSync(path.join(g, d), { recursive: true });
  fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(g, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
  fs.writeFileSync(path.join(g, 'info', 'exclude'), '');
}

/* Converts a time the page shows (MM/DD HH:MM:SS, the page's local time) to epoch milliseconds, in the year of `near`. */
function pageTime(text, near) {
  const m = /(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)/.exec(String(text || ''));
  if (!m) return 0;
  return new Date(new Date(near).getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

const need = (name) => require(DEPS ? path.join(DEPS, 'node_modules', name) : name);
const { open, until, sleep, frameWith, pickModel } = require('./lib/window');
const restricted = require('./lib/restricted');
const downloading = require('./lib/download');
const stewarding = require('./lib/steward');
const titleOrder = require('./lib/title-order');
const gapCi = require('./lib/gap-ci');

/* VS Code's environment: none of the variables that would send the install to the VS Code running this script. A home
   given stands on Windows for the profile folders too, which Node's os.homedir() and the AppData lookups read there. */
function cleanEnv(home, extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  const homes = !home ? {} : process.platform === 'win32'
    ? { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') }
    : { HOME: home };
  return { ...env, ...homes, ...extra };
}

/* VS Code's command line tool for `exe`, where @vscode/test-electron's resolveCliPathFromVSCodeExecutablePath finds it;
   on Windows a .cmd, which only a shell runs. */
function cliOf(exe) {
  const windows = process.platform === 'win32';
  const cli = windows ? path.join(path.dirname(exe), 'bin', 'code.cmd')
    : process.platform === 'darwin' ? path.resolve(exe, '..', '..', 'Resources', 'app', 'bin', 'code') : path.join(path.dirname(exe), 'bin', 'code');
  if (!fs.existsSync(cli)) throw new Error(`no VS Code command line tool at ${cli}`);
  return (argv, env) => {
    const r = windows
      ? cp.spawnSync(`"${cli}"`, argv.map((a) => `"${a}"`), { env, encoding: 'utf8', maxBuffer: 64 << 20, shell: true, windowsHide: true })
      : cp.spawnSync(cli, argv, { env, encoding: 'utf8', maxBuffer: 64 << 20 });
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
    /* Draws context menus in the page on macOS too, as on Linux and Windows, so that a tab's menu can be read and
       clicked. */
    'window.menuStyle': 'custom',
    /* macOS runners give VS Code a 1024 by 677 window, where the chat page drops its outline column. Two steps of zoom
       out give the page about the 1440 by 900 it has on Linux. */
    ...(process.platform === 'darwin' && process.env.CI === 'true' ? { 'window.zoomLevel': -2 } : {}),
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
  if (!EXE && process.env.CI !== 'true') throw new Error('--vscode <executable> is needed: only a CI=true run downloads VS Code');
  if (EXE && !fs.existsSync(EXE)) throw new Error(`no VS Code at ${EXE}`);
  if (VSIX && !fs.existsSync(VSIX)) throw new Error(`no .vsix at ${VSIX}`);
  if (DOWNLOAD && (OPENCODE || RESTRICTED)) throw new Error('--download finds no OpenCode: it takes neither --opencode nor --restricted');
  if (BACKEND !== 'fake' && !DOWNLOAD && !AWS.profile) throw new Error('--backend opencode needs the AWS profile to sign in with: pass --aws-profile <name> or set AWS_PROFILE');
  if (TITLE_ORDER && (DOWNLOAD || RESTRICTED || STEWARD_RUN || BACKEND !== 'fake')) throw new Error('--title-order runs on the fake backend alone');
  if (STEWARD_RUN && (DOWNLOAD || RESTRICTED || BACKEND === 'fake')) throw new Error('--steward needs --backend opencode, and neither --download nor --restricted');
  if (!AGENT_PLUS || !fs.existsSync(AGENT_PLUS)) throw new Error(`no Agent Plus .vsix${AGENT_PLUS ? ` at ${AGENT_PLUS}` : ' beside this repository'}; pass --agent-plus <.vsix>`);
  const playwright = need('playwright-core');
  const exe = EXE || await need('@vscode/test-electron').downloadAndUnzipVSCode({ version: VSCODE_VERSION,
    cachePath: path.resolve(CACHE || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'opencode-agent-plus-vscode')) });

  /* Resolved, since macOS's temporary folder is a link and Windows's can come in its short 8.3 form. */
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'opencode-agent-plus-ui-')));
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
  const prepared = RESTRICTED ? restricted.prepareFolder(p.folder, root) : null;
  console.log(`temporary root ${root}; results in ${OUT}`);

  const vsix = VSIX ? path.resolve(VSIX) : path.join(root, 'opencode-agent-plus.vsix');
  if (VSIX) console.log(`this extension from ${vsix}`);
  else {
    const pack = cp.spawnSync(process.execPath, [path.join(ROOT, 'build', 'pack-vsix.js'), ROOT, '--out', vsix], { encoding: 'utf8' });
    if (pack.status !== 0) throw new Error(`packing failed: ${pack.stderr}`);
    console.log(pack.stdout.trim());
  }

  /*
   * The real backend signs in with the AWS profile of --aws-profile, given through the extension's own settings, so that
   * run keeps the real home (the profile's credential_process reads it); OpenCode's data, config, state and cache
   * folders all go under <out>/xdg, away from the user's own OpenCode. The fake one gets a home of its own.
   */
  const real = BACKEND !== 'fake';
  if (real) emptyGitRepo(p.folder);
  const xdg = path.join(OUT, 'xdg');
  const xdgEnv = real ? { XDG_CONFIG_HOME: path.join(xdg, 'config'), XDG_DATA_HOME: path.join(xdg, 'data'), XDG_STATE_HOME: path.join(xdg, 'state'), XDG_CACHE_HOME: path.join(xdg, 'cache') } : {};
  for (const d of Object.values(xdgEnv)) fs.mkdirSync(d, { recursive: true });
  /* Reads OpenCode's version line with this run's own folders (the fake backend reports OpenCode 2). */
  let line = 0;
  if (DOWNLOAD || !real) line = 2;
  else if (real) {
    const v = cp.spawnSync(OPENCODE || 'opencode', ['--version'], { env: { ...process.env, ...xdgEnv }, encoding: 'utf8' });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${v.stdout || ''}`);
    line = m ? Number(m[1]) : 0;
    console.log(`OpenCode ${m ? m[0] : 'of unknown version'}`);
    if (STEWARD_RUN && line < 2) throw new Error('--steward needs OpenCode 2: the handoff is a tool of the work plan plugin');
  }
  const planLog = path.join(OUT, 'plugin.jsonl');
  const env = cleanEnv(real ? '' : p.home, {
    OPENCODE_AGENT_PLUS_HOME: p.agentHome, OPENCODE_AGENT_PLUS_TEST_CONTROL: '1', ...xdgEnv, ...(FONTS ? { FONTCONFIG_FILE: path.resolve(FONTS) } : {}),
    ...(real ? { OPENCODE_AGENT_PLUS_PLAN_LOG: planLog } : {}),
    ...(real ? {} : { OPENCODE_AGENT_PLUS_TEST_BACKEND: path.join(HERE, 'fake-backend.js') }),
    /* What OpenCode 2 offers (modes, efforts, commands, attachments, rewinding), for the steps the fake run shares with
       the real ones; Restricted Mode's run keeps the plain fake. */
    ...(real || RESTRICTED ? {} : { OPENCODE_AGENT_PLUS_FAKE_DEMO: '1' }),
  });
  if (real) for (const k of Object.keys(env)) if (/^AWS_/.test(k)) delete env[k];
  if (!real && process.platform === 'win32') for (const k of ['APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[k], { recursive: true });
  if (DOWNLOAD) {
    const { env: bare, dropped } = downloading.withoutOpenCode(env);
    Object.assign(env, bare);
    if (dropped.length) console.log(`  note  left out of PATH, since they hold an opencode: ${dropped.join(', ')}`);
  }
  const code = cliOf(exe);
  const neighbours = TITLE_ORDER ? [flag('--claude-code', 'anthropic.claude-code'), flag('--codex', 'openai.chatgpt')] : [];
  for (const ext of [AGENT_PLUS, vsix, ...neighbours]) {
    const r = code(['--install-extension', ext, `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`, '--force'], env);
    if (r.status !== 0) throw new Error(`installing ${ext} failed: ${r.out}`);
  }
  console.log(code(['--list-extensions', '--show-versions', `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`], env).out);
  writeSettings(p.user, { 'opencodeAgentPlus.model': MODEL, ...(OPENCODE ? { 'opencodeAgentPlus.opencode.path': OPENCODE } : {}),
    ...(real ? { 'opencodeAgentPlus.bedrock.profile': AWS.profile, 'opencodeAgentPlus.bedrock.region': AWS.region } : {}), ...(RESTRICTED ? restricted.TRUST_SETTINGS : {}) });

  const steps = [];
  let failed = 0, passed = 0;
  const check = (cond, what, detail) => {
    if (cond) { passed++; console.log(`  ok    ${what}`); return true; }
    failed++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return false;
  };

  const w = await open({ exe, profile: p, env, playwright, log: path.join(OUT, 'vscode.log'), trust: RESTRICTED });
  const { page, call } = w;
  const drawn = await page.evaluate(() => ({ size: `${window.innerWidth} by ${window.innerHeight}`, version: (/Code\/([\d.]+)/.exec(navigator.userAgent) || [])[1] }))
    .catch(() => ({ size: 'of unknown size' }));
  console.log(`  note  VS Code ${drawn.version || 'of unknown version'} on ${process.platform}-${process.arch}, its window ${drawn.size}`);
  let previous = null;
  /* A screenshot of the window and of one part of it, recorded in look.json. `settle` is the wait before it, for a state
     that lasts only a moment. */
  const shot = async (name, { features, expect, unchanged = null, part = null, frame = null, note, settle = 600 } = {}) => {
    await sleep(settle);
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
  const tabOf = (id) => call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.toString() === "opencodeagentplus-session:/" + arg);
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

  /* ---------- steps the fake and the real runs share ---------- */

  /* The chat page's links to other conversations: [{ session, source, text, tip }]. */
  const convLinks = (f) => f.evaluate(() => [...document.querySelectorAll('#log a.conv-link')].map((a) => ({ session: a.dataset.session, source: a.dataset.source, text: a.textContent, tip: a.title })));
  const activeUri = () => call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.toString() : null;');
  const closeChat = (id) => call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === "opencodeagentplus-session:/" + arg);
    await vscode.window.tabGroups.close(tabs); return true;`, id).catch(() => false);
  /* Clicks the page's last link to conversation `id`; resolves to the id of the chat tab in front after the click. */
  const followLink = async (f, id) => {
    await f.evaluate((sid) => { const a = [...document.querySelectorAll('#log a.conv-link')].reverse().find((x) => x.dataset.session === sid);
      const l = document.getElementById('log');
      if (a) l.scrollTop += a.getBoundingClientRect().top - l.getBoundingClientRect().top - l.clientHeight / 2; }, id);
    await f.click(`#log a.conv-link[data-session="${id}"] >> nth=-1`);
    return until(async () => { const u = await activeUri(); return u === `opencodeagentplus-session:/${id}` ? id : null; }, 20000);
  };
  /* The outline beside the log, and the messages in the log. */
  const outlineOf = (f) => f.evaluate(() => {
    const o = document.getElementById('outline'), b = document.getElementById('navBtn');
    return { shown: !o.hidden && o.getBoundingClientRect().width > 50, button: !b.hidden, pressed: b.getAttribute('aria-pressed'),
      rows: [...o.querySelectorAll('.outline-row')].map((r) => ({ kind: r.classList.contains('outline-compaction') ? 'compaction' : 'user', text: r.textContent })),
      users: document.querySelectorAll('#log .msg.user').length, compactions: document.querySelectorAll('#log .compaction').length };
  });
  /* Scrolls the log to its end, clicks the outline's row `n` (0 first) and says how far the message it names is from the
     top of the log, and whether it flashed. */
  const jumpWith = async (f, n) => {
    await f.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
    await f.click(`#outline .outline-user >> nth=${n}`);
    await sleep(300);
    return f.evaluate((i) => {
      const u = document.querySelectorAll('#log .msg.user')[i], l = document.getElementById('log');
      return u ? { offset: Math.round(u.getBoundingClientRect().top - l.getBoundingClientRect().top), flash: u.classList.contains('flash'), canScroll: l.scrollHeight > l.clientHeight + 4 } : null;
    }, n);
  };
  /* Whether the page itself is scrolled (only its log should be), and by how much it is taller than its frame. */
  const pageScroll = (f) => f.evaluate(() => ({ scrolled: document.scrollingElement.scrollTop, top: Math.round(document.getElementById('top').getBoundingClientRect().top),
    over: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight }));
  /* Clears a hover label the pointer left behind (a tab's, or one from a button whose row went away) by hovering the
     activity bar, whose label goes when the pointer does; moving into a chat page alone does not clear it, as the
     workbench hears nothing in there. */
  const dropHover = async () => {
    await page.hover('.activitybar .action-item [aria-label^="OpenCode Agent Plus"]', { timeout: 3000 }).catch(() => {});
    await sleep(1200);
    await page.mouse.move(900, 500);
    await sleep(300);
  };
  /* The outline step. The rail's middle button opens the list of the user's messages, a click on a row scrolls to that
     message, and the button hides and shows the list again; the list is left closed. */
  const outlineStep = async (f, name, expect) => {
    await dropHover();
    if (!(await outlineOf(f)).shown) await f.click('#navBtn').catch(() => {});
    const o = await until(async () => { const x = await outlineOf(f); return x.shown && x.rows.filter((r) => r.kind === 'user').length === x.users && x.users > 0 ? x : null; }, 15000);
    const jump = o ? await jumpWith(f, 0) : null;
    const still = await pageScroll(f);
    if (still.over > 0) console.log(`  note  the chat page is ${still.over} px taller than its frame; only its log scrolls`);
    check(!!o && !!jump && jump.flash && (!jump.canScroll || Math.abs(jump.offset) <= 40) && still.scrolled === 0 && still.top === 0,
      'the list of your messages over the log has a row for each, and a click on the first scrolls the log to it, not the page', { outline: o || await outlineOf(f), jump, page: still });
    await shot(name, { features: ['conversation outline'], expect, part: '#workbench\\.parts\\.editor' });
    await f.click('#navBtn');
    const closed = await until(async () => { const x = await outlineOf(f); return !x.shown && x.button && x.pressed === 'false' ? x : null; }, 5000);
    await f.click('#navBtn');
    const back = await until(async () => { const x = await outlineOf(f); return x.shown && x.pressed === 'true' ? x : null; }, 5000);
    check(!!closed && !!back, "the rail's list button hides the list and shows it again", { closed, back });
    /* Typing in the list's filter box keeps only the rows whose message contains the typed words. */
    const word = await f.evaluate(() => { const u = [...document.querySelectorAll('#log .msg.user .bubble')].pop(); return u ? (u.textContent.match(/[A-Za-z]{4,}/g) || [u.textContent.trim()]).pop() : ''; });
    const filtered = async (q) => { await f.fill('#outline .outline-filter', q); await sleep(300);
      return f.evaluate(() => ({ rows: [...document.querySelectorAll('#outline .outline-row')].map((r) => r.title), none: !!document.querySelector('#outline .outline-none') })); };
    const hit = await filtered(word), miss = await filtered('zzqx no such words'), all = await filtered('');
    check(!!word && hit.rows.length >= 1 && hit.rows.every((t) => t.toLowerCase().includes(word.toLowerCase())) && !miss.rows.length && miss.none && all.rows.length === o.rows.length,
      'the filter box keeps the messages with the words typed, says when none match, and shows all again when emptied', { word, hit, miss, all: all.rows.length });
    await f.click('#navBtn');
    await until(async () => !(await outlineOf(f)).shown, 5000);
    /* The rail's other buttons: to the first message, to the end, and back to the message before. */
    const where = () => f.evaluate(() => { const l = document.getElementById('log'); return { top: l.scrollTop, end: l.scrollHeight - l.scrollTop - l.clientHeight }; });
    await f.click('#railTop'); await sleep(300);
    const atTop = await where();
    await f.click('#railBottom'); await sleep(300);
    const atEnd = await where();
    await f.click('#railPrev'); await sleep(300);
    const prev = await f.evaluate(() => { const l = document.getElementById('log').getBoundingClientRect().top;
      const u = [...document.querySelectorAll('#log .msg.user')].find((m) => m.classList.contains('flash'));
      return u ? Math.round(u.getBoundingClientRect().top - l) : null; });
    check(atTop.top === 0 && atEnd.end < 4 && prev !== null && Math.abs(prev) <= 40,
      "the rail's buttons scroll to the first message, to the end, and back to the message before, which flashes", { atTop, atEnd, prev });
    return o;
  };
  /* Which subagent items the page draws, and the state of the Subagents button. */
  const subagentView = (f) => f.evaluate(() => {
    const shown = (e) => !!e && getComputedStyle(e).display !== 'none' && !!e.getClientRects().length;
    const b = document.getElementById('subBtn');
    return { button: !b.hidden, text: b.textContent, pressed: b.getAttribute('aria-pressed'),
      cards: [...document.querySelectorAll('#log .tool.subagent')].map(shown),
      folded: [...document.querySelectorAll('#log .tool.sub-fold')].map((t) => ({ card: shown(t), child: shown(t.querySelector('.child')) })),
      hidden: [...document.querySelectorAll('#log .sub-hide')].map(shown),
      waiting: [...document.querySelectorAll('#log .permission:not(.settled), #log .question:not(.settled)')].filter((e) => e.querySelector('.from-sub:not([hidden])')).map(shown) };
  });
  /* Recently closed: its group lists `titles` (each the start of a title), and the button on its row empties it. */
  const recentStep = async (titles, name, expect) => {
    await call('await vscode.commands.executeCommand("workbench.view.extension.opencodeAgentPlus"); return true;');
    const group = await until(() => page.evaluate((want) => {
      const rows = [...document.querySelectorAll('#workbench\\.parts\\.sidebar .monaco-list-row')].map((r) => r.textContent.trim());
      const at = rows.findIndex((t) => /^Recently closed/.test(t));
      if (at < 0) return null;
      const after = rows.slice(at + 1, at + 1 + want.length);
      return want.every((w, i) => after[i] && after[i].startsWith(w)) ? { rows } : null;
    }, titles), 20000);
    const recent = (await ext('return api.test.recent();')) || [];
    check(!!group, 'the Conversations view has "Recently closed" at the top, listing the conversations whose tabs were closed, the latest first', { titles, group, recent,
      rows: await page.evaluate(() => [...document.querySelectorAll('#workbench\\.parts\\.sidebar .monaco-list-row')].map((r) => r.textContent.trim())) });
    const row = page.locator('#workbench\\.parts\\.sidebar .monaco-list-row', { hasText: 'Recently closed' }).first();
    await row.hover().catch(() => {});
    const button = row.locator('.action-label[aria-label^="Clear Recently Closed"]').first();
    const visible = await button.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    /* On the button itself, so the row's hover label does not cover it. */
    if (visible) await button.hover().catch(() => {});
    /* The whole window: a close-up is taken after it, when the pointer's hover has gone. */
    await shot(name, { features: ['recently closed'], expect });
    /* The row's buttons show while the pointer is on it, which a screenshot does not keep. */
    let clicked = false;
    if (visible) clicked = await row.hover().then(() => button.click({ timeout: 5000 })).then(() => true, () => false);
    if (!clicked) await call('return vscode.commands.executeCommand("opencodeAgentPlus.clearRecentlyClosed");');
    await dropHover();
    const cleared = await until(async () => {
      const r = (await ext('return api.test.recent();')) || [];
      const t = await page.evaluate(() => document.getElementById('workbench.parts.sidebar').textContent);
      return !r.length && !/Recently closed/.test(t);
    }, 10000);
    check(visible && clicked && cleared, "the group's Clear button empties Recently closed, and the group goes", { visible, clicked, cleared });
  };
  /* Find Conversation: typing part of `id` in its pick leaves only that conversation; Enter opens it. */
  const findStep = async (id, name, expect) => {
    await dropHover();
    await call(`vscode.commands.executeCommand("opencodeAgentPlus.findConversation"); return true;`);
    await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 15000 });
    const part = id.slice(5, 14);
    await page.fill('.quick-input-widget input', part);
    const rows = await until(async () => {
      const r = await page.evaluate(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((x) => x.textContent));
      return r.length === 1 && r[0].includes(id) ? r : null;
    }, 15000);
    await shot(name, { features: ['find by session id'], expect });
    await page.keyboard.press('Enter');
    const opened = await until(async () => ((await activeUri()) === `opencodeagentplus-session:/${id}` ? id : null), 20000);
    check(!!rows && !!opened, 'Find Conversation finds the conversation by part of its session id, and Enter opens it', { part, rows, opened,
      listed: await page.evaluate(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((x) => x.textContent)) });
    return opened;
  };

  if (DOWNLOAD) {
    try {
      await w.hostUp();
      await until(() => ext('return !!(api && api.test);'), 60000);
      await downloading.run({ page, call, ext, check, shot, until, sleep, frameWith, control: p.control, home: p.agentHome, env, xdgEnv });
    } catch (e) {
      check(false, 'the window steps ran to their end', (e && e.stack) || String(e));
      try { await shot('99-failure', { expect: 'The window as it was when the run failed.', note: String(e && e.message) }); } catch (_) { /* no window */ }
    } finally {
      await w.close();
      console.log(`  note  ${stopLeftovers(xdgEnv.XDG_STATE_HOME)}`);
    }
    console.log(`\nVS Code window: ${passed} passed, ${failed} failed; screenshots in ${shots}`);
    process.exitCode = failed ? 1 : 0;
    return;
  }

  if (RESTRICTED) {
    try {
      await w.hostUp();
      await until(() => ext('return !!(api && api.test);'), 60000);
      await restricted.run({ page, call, ext, check, shot, until, sleep, frameWith, control: p.control, home: p.agentHome, real, opencode: OPENCODE, prepared,
        windowPid: w.proc.pid, aws: AWS });
    } catch (e) {
      check(false, 'the window steps ran to their end', (e && e.stack) || String(e));
      try { await shot('99-failure', { expect: 'The window as it was when the run failed.', note: String(e && e.message) }); } catch (_) { /* no window */ }
    } finally {
      await w.close();
      if (real) console.log(`  note  ${stopLeftovers(xdgEnv.XDG_STATE_HOME)}`);
    }
    console.log(`\nVS Code window: ${passed} passed, ${failed} failed; screenshots in ${shots}`);
    process.exitCode = failed ? 1 : 0;
    return;
  }

  if (TITLE_ORDER) {
    try {
      await w.hostUp();
      await until(() => ext('return !!(api && api.test);'), 60000);
      await titleOrder.run({ page, call, check, shot, until, sleep, folder: p.folder });
    } catch (e) {
      check(false, 'the window steps ran to their end', (e && e.stack) || String(e));
      try { await shot('99-failure', { expect: 'The window as it was when the run failed.', note: String(e && e.message) }); } catch (_) { /* no window */ }
    } finally {
      await w.close();
    }
    console.log(`\nVS Code window: ${passed} passed, ${failed} failed; screenshots in ${shots}`);
    process.exitCode = failed ? 1 : 0;
    return;
  }

  if (STEWARD_RUN) {
    try {
      await w.hostUp();
      await until(() => ext('return !!(api && api.test);'), 60000);
      await stewarding.run({ page, call, ext, check, shot, until, sleep, frameWith, folder: p.folder, root, plans: path.join(p.agentHome, 'plans'), planLog });
    } catch (e) {
      check(false, 'the window steps ran to their end', (e && e.stack) || String(e));
      try { await shot('99-failure', { expect: 'The window as it was when the run failed.', note: String(e && e.message) }); } catch (_) { /* no window */ }
    } finally {
      await w.close();
      console.log(`  note  ${stopLeftovers(xdgEnv.XDG_STATE_HOME)}`);
    }
    console.log(`\nVS Code window: ${passed} passed, ${failed} failed; screenshots in ${shots}`);
    process.exitCode = failed ? 1 : 0;
    return;
  }

  /* When the real model's first message was sent, to compare with the time the page shows for it after the reload. */
  let firstSentAt = 0;
  try {
    await w.hostUp();
    await until(() => ext('return !!(api && api.test);'), 60000);

    // 1. The activity bar icon and the Conversations view.
    const icon = await page.waitForSelector('.activitybar .action-item a[aria-label^="OpenCode Agent Plus"], .activitybar .action-item [aria-label^="OpenCode Agent Plus"]', { timeout: 30000 }).catch(() => null);
    check(!!icon, 'the activity bar has the OpenCode Agent Plus icon');
    if (icon) await icon.click();
    const viewOk = await until(() => page.evaluate(() => [...document.querySelectorAll('.pane-header')].some((h) => /Conversations/i.test(h.textContent))), 20000);
    check(viewOk, 'the Conversations view shows in the side bar');
    const pluginHome = path.join(p.agentHome, 'opencode-plugin', 'agent-work-plan');
    const plansDir = path.join(p.agentHome, 'plans');
    const inPlace = await until(() => ['index.js', 'hooks/plan_common.py', 'hooks/plan_agent.py', 'hooks/inject-work-plan.py'].every((f) => fs.existsSync(path.join(pluginHome, f)))
      && fs.existsSync(path.join(plansDir, 'config.json')), 20000);
    check(inPlace, "the work plan plugin, its scripts and config.json are in place in the extension's folder");
    await shot('01-activity-bar', { features: ['activity bar icon', 'Conversations view'],
      expect: 'The activity bar on the far left has the OpenCode Agent Plus icon (the OpenCode mark: an upright rectangular frame whose lower inner half is filled in a fainter tone of the same colour) selected; the side bar shows the OpenCode Agent Plus container with a Conversations view (its header may read "OpenCode Agent Plus: Convers…"), empty or with a hint.',
      part: '#workbench\\.parts\\.sidebar' });
    /* VS Code puts a progress badge over a container's icon while one of its views loads; the close-ups wait it out. */
    const barQuiet = () => until(() => page.evaluate(() => {
      const seen = (e) => !!e && e.offsetParent !== null;
      return ![...document.querySelectorAll('.activitybar .badge.progress-badge')].some(seen)
        && ![...document.querySelectorAll('#workbench\\.parts\\.sidebar .monaco-progress-container.active')].some(seen);
    }), 30000);
    await barQuiet();
    await shot('01a-activity-bar-icon-dark', { features: ['activity bar icon'],
      expect: 'A close-up of the activity bar in the dark theme. Among the icons is the OpenCode Agent Plus one, the OpenCode mark: an upright rectangular frame whose lower inner half is filled in a fainter tone of the same colour, drawn in the same light grey as the other icons (brighter, as the selected one), about their size, sharp and centred in its slot, not cut off or blurred.',
      part: '#workbench\\.parts\\.activitybar' });

    // 1b. The extension's own icon in the Extensions view.
    await call('await vscode.commands.executeCommand("workbench.view.extensions"); await vscode.commands.executeCommand("workbench.extensions.search", "@installed OpenCode Agent Plus"); return true;');
    const extIcon = await until(() => page.evaluate(() => {
      for (const row of document.querySelectorAll('.extensions-viewlet .monaco-list-row')) {
        if (!/OpenCode Agent Plus/.test(row.textContent)) continue;
        const img = row.querySelector('img.icon');
        return img && img.complete && img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
      }
      return null;
    }), 30000);
    check(!!extIcon && extIcon.width === 256 && extIcon.height === 256, 'the Extensions view lists OpenCode Agent Plus with its 256 by 256 icon', extIcon);
    await page.mouse.move(800, 600);
    await shot('01b-extensions-view-icon', { features: ['extension icon'],
      expect: 'The Extensions view in the side bar, searched for "@installed OpenCode Agent Plus", lists OpenCode Agent Plus with its icon at the left of the row: a rounded indigo square with a white document outline holding three list rows (the first with a green tick), and a white circle at its left edge holding the OpenCode mark (an upright rectangular frame whose lower inner half is fainter). The icon is sharp, not stretched or cut off, and its rounded corners show the side bar behind them.',
      part: '#workbench\\.parts\\.sidebar' });
    await call('await vscode.commands.executeCommand("workbench.extensions.search", ""); await vscode.commands.executeCommand("workbench.view.extension.opencodeAgentPlus"); return true;');

    // 2. A new conversation opens a chat tab.
    const before = Date.now();
    await page.click('.pane-header [aria-label="New Conversation"], .pane-header .codicon-add').catch(async () => { await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");'); });
    const tab = await until(() => call(`const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputCustom ? { viewType: t.input.viewType, uri: t.input.uri.toString(), label: t.label } : null;`), 30000);
    check(tab && tab.viewType === 'opencodeAgentPlus.chat' && /^opencodeagentplus-session:\/ses_/.test(tab.uri), 'a new conversation opens a opencodeAgentPlus.chat tab of opencodeagentplus-session:/<id>', tab);
    let chat = await frameWith(page, '#input', 30000);
    check(!!chat, 'the chat page loaded in the tab');
    await shot('02-new-conversation', { features: ['new conversation', 'chat editor tab'],
      expect: `An editor tab is open with the chat page: a thin header with the conversation's title; in the middle of the empty page the OpenCode mark and a one-line hint; at the bottom a rounded, centred message box; in its row of buttons under the text, a model pill showing ${real ? 'the Grok model' : 'Fake Small'} and, at the right end, a square send button with an arrow.`,
      part: '#workbench\\.parts\\.editor' });

    let sessionId = tab ? tab.uri.replace(/^opencodeagentplus-session:\//, '') : '';
    const NEEDS_V2 = /The work plan needs OpenCode 2/;
    const toldV2 = async () => ((await ext('return api.test.told();')) || []).filter((t) => NEEDS_V2.test(t)).length;
    if (real && line === 1) {
      const n = await until(toldV2, 20000);
      const toast = await until(() => page.evaluate(() => [...document.querySelectorAll('.notification-toast, .notifications-toasts')].some((e) => /The work plan needs OpenCode 2/.test(e.textContent))), 10000);
      check(n === 1 && !!toast, 'on OpenCode 1 the notice "The work plan needs OpenCode 2" is shown once', { told: n, toast });
      await shot('02b-needs-opencode-2', { features: ['work plan notice on OpenCode 1'],
        expect: 'A notification at the bottom right says "The work plan needs OpenCode 2, and this is OpenCode 1.19.6. Update OpenCode to keep a work plan in these conversations."' });
    }
    if (!real) {
      // 3. A message gets a reply; the permission request is answered from the page.
      if (chat) {
        await chat.fill('#input', 'Hello there, please fix the failing test');
        firstSentAt = Date.now();
        await chat.press('#input', 'Enter');
        const asked = await until(() => chat.$('button[data-decision="allowOnce"]'), 30000);
        check(!!asked, 'the reply streams in and stops at a permission request with Allow once');
        const waiting = await until(() => ext('return api.test.conversations().find((c) => c.activity === "waiting");'), 10000);
        check(!!waiting, 'the conversation is waiting for the user while the request is open', waiting);
        const waitIcon = await until(async () => { const t = await tabOf(sessionId); const i = t ? await iconOf(t.label) : ''; return /tab-waiting-dark-/.test(i) ? i : null; }, 10000);
        check(!!waitIcon, "while it waits, the chat tab's icon is the logo with a red dot", waitIcon || await iconOf((await tabOf(sessionId) || {}).label || ''));
        await shot('03-permission', { features: ['streamed reply', 'tool rows', 'permission request'],
          expect: 'The user message "Hello there, please fix the failing test", a reasoning block, a reply that starts "I\'ll look at the test first.", each on the thin line down the left with a dot; a read_file tool row (green dot, "2 lines"), an edit_file row still running (blue dot); and, right above the message box, a framed permission box "Allow edit_file? Edit sum.js" with the numbered rows 1 Allow once (highlighted), 2 Allow in this project, 3 Deny and a View diff row.',
          part: '#workbench\\.parts\\.editor' });
        /* Answered from its diff's title bar rather than the page. */
        let fromTitle = false;
        if (asked) {
          /* Agent Plus asks for a token mode on its first start, and in a small window such as a macOS runner's that
             notification can cover the request's buttons. */
          await call('await vscode.commands.executeCommand("notifications.clearAll"); return true;').catch(() => {});
          await chat.click('#log .permission:not(.settled) button.diff');
          const allow = await page.waitForSelector('.editor-actions [aria-label="Allow Once"]', { timeout: 15000 }).catch(() => null);
          if (allow) {
            await shot('03b-diff-title-bar', { features: ['diff title bar answers'],
              expect: 'A diff editor "sum.js (proposed change)" is open, the old line on the left and the new one on the right; its title bar, at the right end of the tab row, has a check, a double check and a cross icon (Allow Once, Allow in This Project, Deny) before the usual editor actions.' });
            /* VS Code redraws the title bar as context keys change, so the button is looked up at the moment it is clicked. */
            await page.locator('.editor-actions [aria-label="Allow Once"]').first().click();
            /* The chat page was hidden behind the diff, so VS Code drew it again when the diff closed. */
            await until(() => call('return !vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => /proposed change/.test(t.label));'), 10000);
            chat = await frameWith(page, '#input', 30000);
            fromTitle = await until(() => chat.evaluate(() => /Allowed once/.test((document.querySelector('#log .permission .perm-result') || {}).textContent || '')), 15000);
          }
          const diffTab = await call('return vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => /proposed change/.test(t.label));');
          check(!!allow && !!fromTitle && !diffTab, "Allow Once in the diff's title bar answers the request, and the diff closes", { allow: !!allow, fromTitle, diffTab });
          if (!fromTitle) await asked.click().catch(() => {});
        }
        const done = await until(() => chat.evaluate(() => document.body.dataset.status === 'idle' && /subtracted instead of adding/.test(document.getElementById('log').textContent)), 30000);
        check(done, 'after Allow once the turn finishes with its last reply');
        const stopIcon = await until(async () => { const t = await tabOf(sessionId); const i = t ? await iconOf(t.label) : ''; return /tab-stopped-dark-/.test(i) ? i : null; }, 10000);
        check(!!stopIcon, "once the turn is over, the chat tab's icon is the plain logo", stopIcon);
        await shot('04-reply', { features: ['reply', 'reply figures'],
          expect: 'The conversation hangs on a thin line down the left with a dot on each row. The answered permission is one row for edit_file ending in "· Allowed once" and a small View diff button; the reply row reads "Fixed: sum subtracted instead of adding." with a code block, and its small grey time is followed by the turn\'s figures (a duration, ctx and the model name).',
          part: '#workbench\\.parts\\.editor' });

        // 4z. Rename from the chat tab's menu: the tab, the page and the list show the new title.
        const fakeLabel = (await tabOf(sessionId) || {}).label || '';
        const r = await renameFromTab(fakeLabel, 'Renamed in the fake run', '04z-tab-menu');
        const fakeRenamed = await until(async () => {
          const t = await tabOf(sessionId);
          const rows = (await ext('return api.test.sessions();')) || [];
          const pageTitle = await chat.evaluate(() => document.getElementById('title').textContent);
          return t && t.label === 'Renamed in the fake run' && pageTitle === 'Renamed in the fake run' && rows.some((x) => x.id === sessionId && x.title === 'Renamed in the fake run') ? { tab: t.label, pageTitle } : null;
        }, 15000);
        check(r.renamed && !!fakeRenamed, "Rename in the chat tab's menu renames the conversation: the tab, the page and the Conversations list follow", { r, fakeRenamed });

        // 4y. The info box, the mute button and the ring's outline.
        await chat.click('#infoBtn');
        const infoRows = await until(() => chat.evaluate(() => { const b = document.getElementById('infoBox'); return b && !b.hidden ? [...b.querySelectorAll('.info-row')].map((r) => r.textContent) : null; }), 10000);
        check(!!infoRows && infoRows.some((t) => t.includes(sessionId)) && infoRows.some((t) => /2\.0\.0-fake, acp process \d+/.test(t)), 'the info button opens a box with the session id, the agent and its process', infoRows);
        await shot('04y-info', { features: ['session info'],
          expect: 'Above the message box, opened from its "ℹ" button, a box with rows Session (an id starting ses_), Folder, OpenCode ("2.0.0-fake, acp process" and a number), Session database (a path) and Token mode (All features), and a "Copy all" button.',
          part: '#workbench\\.parts\\.editor' });
        await chat.press('#input', 'Escape');
        const infoClosed = await chat.evaluate(() => document.getElementById('infoBox').hidden);
        await chat.click('#sound');
        const muted = await until(async () => (await ext('return api.test.sound();')) === false && await chat.evaluate(() => document.getElementById('sound').classList.contains('muted')), 5000);
        await chat.click('#sound');
        const unmuted = await until(async () => (await ext('return api.test.sound();')) === true, 5000);
        check(infoClosed && muted && unmuted, 'Esc closes the box; the footer button mutes the chimes and turns them back on, kept by the extension', { infoClosed, muted, unmuted });
        await chat.evaluate(() => window.postMessage({ type: 'update', items: [], head: { status: 'idle', title: 'Renamed in the fake run', contextPct: 90, contextText: '28.8k of 32.0k tokens', queued: [], background: [] } }, '*'));
        const low = await until(() => chat.evaluate(() => document.getElementById('ring').classList.contains('low')), 5000);
        check(low, 'with 10% of the context left the ring is outlined');
        await shot('04y2-ring-low', { features: ['context ring outline'],
          expect: 'In the row of buttons under the message box, the context ring nine-tenths full, drawn in the warning colour with a thin circle of the same colour around it; further right a music-note button before the send button.',
          part: '#workbench\\.parts\\.editor' });

        // 4x. Fork from the chat tab's menu; with it closed, the Conversations view has its two groups.
        const forkItems = await tabMenu((await tabOf(sessionId) || {}).label || '');
        let forkId = '';
        if (forkItems.includes('Fork Conversation')) {
          /* A menu ignores a click that comes right after it opened. */
          await sleep(700);
          await page.locator('.monaco-menu .action-label', { hasText: 'Fork Conversation' }).first().click();
          forkId = await until(async () => {
            const u = await call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.toString() : null;');
            return u && u !== `opencodeagentplus-session:/${sessionId}` ? u.replace(/^opencodeagentplus-session:\//, '') : null;
          }, 20000);
        } else await page.keyboard.press('Escape');
        const forkPage = forkId && await frameWith(page, '#input', 20000);
        const forkShows = forkPage && await until(() => forkPage.evaluate(() => /subtracted instead of adding/.test(document.getElementById('log').textContent)), 15000);
        check(!!forkId && !!forkShows, "Fork Conversation in the chat tab's menu opens a copy of the conversation in a new tab", { items: forkItems, forkId, forkShows });
        if (forkId) {
          await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === "opencodeagentplus-session:/" + arg);
            await vscode.window.tabGroups.close(tabs); return true;`, forkId).catch(() => {});
          await sleep(800);
          chat = await frameWith(page, '#input', 20000);
        }
        await call('await vscode.commands.executeCommand("workbench.view.extension.opencodeAgentPlus"); return true;');
        const grouped = await until(() => page.evaluate(() => { const t = document.getElementById('workbench.parts.sidebar').textContent; return /Open in this window/.test(t) && /Other conversations/.test(t); }), 15000);
        check(grouped, 'the Conversations view has "Open in this window" with the open one and "Other conversations" with the fork');
        await shot('04x-groups', { features: ['open conversations first'],
          expect: 'The Conversations view has three groups: "Recently closed" with the fork ("Renamed in the fake run (fork)"), whose tab was just closed; "Open in this window" with "Renamed in the fake run"; and "Other conversations" with the fork again. Each group header shows a count.',
          part: '#workbench\\.parts\\.sidebar' });

        // 4w. Recently closed: the fork's tab was closed above; the button on its group's row empties it.
        await recentStep(['Renamed in the fake run (fork)'], '04w-recently-closed',
          'The Conversations view, the pointer on the clear-all button (lines with a cross) at the right end of the "Recently closed" row at the top, maybe with its label "Clear Recently Closed"; the group lists "Renamed in the fake run (fork)"; below it "Open in this window" with "Renamed in the fake run" and "Other conversations" with the fork; the view\'s title bar has a magnifier (Find Conversation) beside the plus.');

        // 4v. A reply naming the fork by its title and by its id links both, but not the page's own id; a click opens it.
        await chat.fill('#input', `Say: The copy is \u300CRenamed in the fake run (fork)\u300D, session ${forkId}; this one is ${sessionId}.`);
        await chat.press('#input', 'Enter');
        const linked = await until(async () => { const l = await convLinks(chat); return l.filter((x) => x.session === forkId).length >= 2 ? l : null; }, 20000);
        check(!!linked && linked.every((x) => x.session === forkId && x.source === 'opencode-plus') && linked.some((x) => /OpenCode Agent Plus conversation ses_/.test(x.tip)),
          "a reply naming another conversation by its title and by its id links both, not the page's own id, and a link's hover names the conversation", { linked: linked || await convLinks(chat) });
        await shot('04v-conversation-links', { features: ['links to other conversations'],
          expect: 'The last reply reads "The copy is 「Renamed in the fake run (fork)」, session ses_… ; this one is ses_…." where the fork\'s title inside the corner brackets and the first session id are links (link colour, dotted underline) and the second id, this conversation\'s own, is plain text. A column "YOUR MESSAGES" on the right lists the two messages.',
          part: '#workbench\\.parts\\.editor' });
        const went = await followLink(chat, forkId);
        check(!!went, 'a click on such a link opens that conversation in its own tab', { went, active: await activeUri() });
        await closeChat(forkId);
        await sleep(800);
        chat = await frameWith(page, '#input', 20000);

        // 4s. Find Conversation: typing part of the fork's id finds it; Enter opens it.
        if (await findStep(forkId, '04s-find-conversation',
          'A quick pick at the top titled "Find a conversation", its box holding a few letters and digits of a session id, and one row: "Renamed in the fake run (fork)" with "active … ago" and, below, the full ses_… id and the folder, the typed part highlighted.')) {
          await closeChat(forkId);
          await sleep(800);
          chat = await frameWith(page, '#input', 20000);
        }

        // 4u. The outline of the two messages.
        await outlineStep(chat, '04u-outline',
          'Over the top right of the conversation a framed list with a "Filter your messages" box lists the two user messages, each with its date and time ("Hello there, please fix the failing test", then "Say: The copy is …"); the log is scrolled to the first message, which has a thin focus-coloured outline; the middle of the five small buttons on the right edge, a list icon, shows as pressed.');

        // 4t. The subagent filter, on subagent items posted to the page the way the extension posts them.
        const quiet = await subagentView(chat);
        const SUB = { childId: 'ses_childfake00000000000000', title: 'Look around' };
        await chat.evaluate((sub) => {
          const now = Date.now();
          window.postMessage({ type: 'update', now, items: [
            { id: 'zz1', kind: 'tool', name: 'task', summary: 'Look around the repository', input: '{"description":"Look around"}', state: 'done', result: 'Found three files.', at: now, doneAt: now,
              child: { childId: sub.childId, title: sub.title, status: 'done', entries: [{ kind: 'tool', name: 'bash', summary: 'ls', state: 'done', result: 'a' }, { kind: 'text', text: 'Listed the files.' }], dropped: 0, last: 'Listed the files.' } },
            { id: 'zz2', kind: 'tool', name: 'bash', summary: 'ls -la', input: '{"command":"ls -la"}', state: 'done', result: 'README.md', at: now, doneAt: now, subagent: sub },
            { id: 'zz3', kind: 'permission', at: now, requestId: 'perm-sub-1', request: { tool: 'bash', summary: 'ls -la', command: 'ls -la', hasDiff: false }, decision: 'allowOnce', subagent: sub },
            { id: 'zz4', kind: 'permission', at: now, requestId: 'perm-sub-2', request: { tool: 'bash', summary: 'rm -rf build', command: 'rm -rf build', hasDiff: false }, decision: null, subagent: sub },
            { id: 'zz5', kind: 'subagent', at: now, childId: 'ses_childfake11111111111111', title: 'Second helper', status: 'running', entries: [], dropped: 0, last: 'Reading notes.txt' },
          ] }, '*');
        }, SUB);
        const subShown = await until(async () => { const v = await subagentView(chat); return v.button && v.text === 'Subagents' ? v : null; }, 5000);
        await chat.click('#subBtn');
        const subHidden = await until(async () => { const v = await subagentView(chat); return v.pressed === 'true' ? v : null; }, 5000);
        check(!quiet.button && !!subShown && subShown.folded.every((x) => x.card && x.child) && subShown.hidden.every(Boolean)
          && !!subHidden && subHidden.text === 'Subagents hidden (4)' && subHidden.folded.length === 1 && subHidden.folded.every((x) => x.card && !x.child)
          && subHidden.hidden.length === 3 && subHidden.hidden.every((x) => !x) && subHidden.waiting.length === 1 && subHidden.waiting.every(Boolean),
        "the Subagents button shows only once a subagent did something; pressed, it hides the subagents' boxes, calls and answered requests, folds the call that started each subagent, and leaves a subagent's request that still waits",
          { quiet, subShown, subHidden });
        await chat.evaluate(() => { const t = document.querySelector('#log [data-id="zz1"]'), l = document.getElementById('log'); if (t) l.scrollTop += t.getBoundingClientRect().top - l.getBoundingClientRect().top - 8; });
        await shot('04t-subagents-hidden', { features: ['subagent filter'],
          expect: 'In the row of buttons under the message box a pressed pill "Subagents hidden (4)". In the log, a task row "Look around the repository" with no Subagent box under it, then, right above the message box, the open permission box for "rm -rf build" tagged "#from subagent Look around" with its numbered Allow once, Allow in this project and Deny rows; no bash row, no answered permission row and no "Second helper" box.',
          part: '#workbench\\.parts\\.editor' });
        await chat.click('#subBtn');
        const subBack = await until(async () => { const v = await subagentView(chat); return v.pressed === 'false' && v.hidden.every(Boolean) && v.folded.every((x) => x.child) ? v : null; }, 5000);
        check(!!subBack, 'pressed again, everything the subagents did shows again', subBack || await subagentView(chat));
        /* Those items were posted to the page only, one of them a request still open; reloaded, the page draws the
           conversation as the extension has it. */
        await call('await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction"); return true;');
        chat = await until(async () => {
          const f = await gapCi.frameShowing(page, until, 'subtracted instead of adding', 5000);
          return f && await f.evaluate(() => !document.querySelector('#log [data-id^="zz"]')) ? f : null;
        }, 30000);
        check(!!chat, 'reloaded, the chat page shows the conversation again, without the items posted to it');
      }
    }

    if (real || line >= 2) {
      // 3 (real model, and the fake backend from here on). A request that needs a tool: the tool call, the approval, the
      // answer.
      const figures = () => chat.evaluate(() => document.querySelectorAll('#log .figures').length);
      const status = () => chat.evaluate(() => document.body.dataset.status);
      /* Sends `text` and waits for its turn to end, answering Allow once to every permission request on the way. */
      const turn = async (text, name, tick) => {
        const before = await figures();
        await chat.fill('#input', text);
        await chat.press('#input', 'Enter');
        return waitTurn(before, name, tick);
      };
      /* Waits until the turn that started after the page had `before` figures lines has ended, answering Allow once on
         the way; `tick` runs on each check. */
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
                expect: 'The user message, a tool row, and right above the message box the permission box: "Allow <tool>?", then the numbered rows 1 Allow once (highlighted), 2 Allow in this project and 3 Deny.',
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
      /* What OpenCode itself recorded for the session: its /api session.list, with a private server; what the fake
         backend recorded, with that one. */
      const recorded = () => {
        if (!real) return gapCi.fakeRecord(p.agentHome, sessionId);
        const r = cp.spawnSync(OPENCODE, ['api', 'session.list', '--param', 'limit=50', '--standalone'],
          { env: { ...process.env, ...xdgEnv, OPENCODE_DISABLE_AUTOUPDATE: '1' }, encoding: 'utf8', timeout: 60000 });
        try { return (JSON.parse(r.stdout).data || []).find((s) => s.id === sessionId) || null; } catch (_) { return null; }
      };
      if (chat) {
        if (!firstSentAt) firstSentAt = Date.now();
        let approved = await turn('列出工作目录下的文件', real ? '03' : '03c');
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
          expect: `The tool row is done (a green dot) and the answered permission row says allowed; the model answer lists the files of the folder (README.md, notes.txt, src), and its row's time is followed by the figures: a duration, the ctx percentage, a cost if there is one, and the model name ${real ? 'grok' : 'fake-small'}.`,
          part: '#workbench\\.parts\\.editor' });

        if (line === 1) {
          // 3z. On OpenCode 1 the / and @ lists, question forms and compaction line show only what it offers, and nothing
          // reports an error.
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
            'on OpenCode 1 the @ list works, the / list, question form and compaction line show only what it offers, and nothing reports an error', { at, page: page1, told: told1, slash });
          await shot('04z-v1-controls', { features: ['/ and @ lists, question form and compaction line on OpenCode 1'],
            expect: 'The chat page with the message box empty; its placeholder may add hints such as "@ to add a file"; no error notice, no question form, no compaction line.',
            part: '#workbench\\.parts\\.editor' });
          const v1Items = await tabMenu((await tabOf(sessionId) || {}).label || '');
          await page.keyboard.press('Escape');
          const v1Bar = await chat.evaluate(() => { const b = document.querySelector('[data-agent-plus-plan-bar]'); return !!b && b.style.display !== 'none'; });
          check(v1Items.length > 0 && !v1Items.includes('Rename Conversation') && !v1Bar, "on OpenCode 1 the chat tab's menu has no Rename, and the page has no plan bar", { items: v1Items, bar: v1Bar });
          const v1Rewind = await chat.evaluate(() => [...document.querySelectorAll('#log .msg.user button.rewind')].some((b) => !b.hidden));
          await chat.click('#infoBtn');
          const v1Info = await until(() => chat.evaluate(() => { const b = document.getElementById('infoBox'); return b && !b.hidden && b.querySelector('.info-row') ? b.textContent : null; }), 15000);
          await chat.press('#input', 'Escape');
          check(v1Items.includes('Fork Conversation') && !v1Rewind && /1\.19\.6, acp process \d+/.test(v1Info || ''),
            'on OpenCode 1 the tab offers Fork (its ACP has session/fork), the page offers no rewind, and the info box names 1.19.6', { items: v1Items, rewind: v1Rewind, info: v1Info });
          await shot('04z2-v1-info', { features: ['session info on OpenCode 1'],
            expect: 'The chat page of OpenCode 1.19.6 with no "Rewind to here" on the user messages; the info box may still be closing.',
            part: '#workbench\\.parts\\.editor' });
          // 3z3. On OpenCode 1 the outline, the Subagents button and Find Conversation behave as on OpenCode 2.
          await outlineStep(chat, '04z3-v1-outline',
            'The chat page of OpenCode 1.19.6 with the framed list of its user messages open over the top right, each with its date and time; the middle button of the rail on the right edge is pressed; no "Subagents" pill under the message box.');
          const v1Subs = await subagentView(chat);
          check(!v1Subs.button, 'with no subagent in the conversation there is no Subagents button', v1Subs);
          await findStep(sessionId, '04z4-v1-find',
            'A quick pick "Find a conversation" with a few characters of a session id typed and one row: this conversation\'s title, "open in this window", and below it its ses_… id and folder.');
          chat = await frameWith(page, '#input', 30000);
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
            expect: 'In the row of buttons under the message box: the model pill with its effort after it in grey, and near the right end the mode, now Plan; the rest of the page is unchanged.',
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
            expect: 'The Plan turn says the file could not be written; then "Reply with only the word four." and the reply "four", whose figures end with the model name and "low"; under the message box the effort shows Low and the mode Ask before edits.',
            part: '#workbench\\.parts\\.editor' });

          // 3f. A subagent: its session stays out of the list, and the turn OpenCode starts when it finishes shows here.
          const notices = () => chat.evaluate(() => [...document.querySelectorAll('#log .notice')].map((e) => e.textContent));
          const activities = new Set();
          let clicked = 0, wentOn = false, runningShot = false;
          /* The subagent's request may come before the parent's turn is over, and its whole run with it, so this looks
             while that turn is awaited too. */
          const watch = async () => {
            const c = ((await ext('return api.test.conversations();')) || []).find((x) => x.sessionId === sessionId);
            /* Recorded only after the parent's own turn is over: the turn that matters is the one OpenCode starts after it. */
            if (c && (await figures()) > beforeSub) activities.add(c.activity);
            if (!runningShot && await chat.$('#log .tool .child.state-running')) {
              runningShot = true;
              /* Once it has done something, so the box has a last line to show. */
              await until(() => chat.evaluate(() => { const l = document.querySelector('#log .tool .child.state-running .child-last'); return !!l && !!l.textContent; }), 5000);
              await shot('04f0-subagent-running', { features: ['subagent progress'],
                expect: 'Under the subagent\'s task row a box "Subagent:" with the subagent\'s title, "Running…", and the last thing it did (such as a shell sleep command), maybe with "Its steps (n)"; a permission box for its shell command may be there too, tagged "#from subagent".',
                part: '#workbench\\.parts\\.editor' });
            }
          };
          const beforeSub = await figures();
          await turn('Use the subagent tool to start one subagent whose task is: use the shell tool to run the command sleep 8, then reply finished. After launching it, end your response at once without waiting.', '04f', watch);
          const end = Date.now() + 150000;
          while (Date.now() < end) {
            await watch();
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { await b.click(); clicked++; await sleep(500); }
            if ((await notices()).some((t) => /started this turn on its own/.test(t)) && (await status()) === 'idle') { wentOn = true; break; }
            await sleep(500);
          }
          check(wentOn && activities.has('working'), 'for the background subagent OpenCode went on without a message: the page says so, the conversation worked and went back to idle',
            { clicked, activities: [...activities], notices: await notices() });
          let kinds = {};
          if (!real) kinds = gapCi.fakeParents(p.agentHome);
          else try { kinds = JSON.parse(fs.readFileSync(path.join(p.agentHome, 'opencode-sessions.json'), 'utf8')).parents || {}; } catch (_) { /* none */ }
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
            "the subagent's box showed it running and then done with its steps, and its request said it came from the subagent", { runningShot, card, fromSub });
          /* Opening the steps lengthens the log above its end and pushes the end below the view, so this takes two pictures. */
          await chat.evaluate(() => {
            const c = [...document.querySelectorAll('#log .tool .child')].pop();
            const log = document.getElementById('log');
            if (c) log.scrollTop = c.closest('.tool').offsetTop - log.offsetTop;
          });
          await shot('04f-subagent', { features: ['subagent progress'],
            expect: 'Near the top, the subagent\'s task row with a "Subagent:" box below it: the subagent\'s title, "Done", and "Its steps (n)" opened, listing its steps (a shell sleep command among them). Below it the short reply of that turn, then possibly the notice that OpenCode started a turn on its own and, in that turn, a shell row or an answered permission row (allowed once) tagged "#from subagent …".',
            part: '#workbench\\.parts\\.editor' });
          await chat.evaluate(() => { const log = document.getElementById('log'); log.scrollTop = log.scrollHeight; });
          await shot('04f2-subagent-reply', { features: ['turn OpenCode started itself'],
            expect: 'The end of the conversation: the notice "OpenCode started this turn on its own, for a background subagent or command.", then the reply that the subagent has finished, its time followed by the figures; no Working line above the message box.',
            part: '#workbench\\.parts\\.editor' });

          // 3f2. The subagent filter: only this conversation's own output, the subagent's progress folded away.
          const subOn = await subagentView(chat);
          await chat.click('#subBtn').catch(() => {});
          const subOff = await until(async () => { const v = await subagentView(chat); return v.pressed === 'true' ? v : null; }, 5000);
          check(subOn.button && subOn.folded.length + subOn.cards.length > 0 && !!subOff && /^Subagents hidden \(\d+\)$/.test(subOff.text)
            && subOff.folded.every((x) => x.card && !x.child) && subOff.cards.every((x) => !x) && subOff.hidden.every((x) => !x),
          "the Subagents button hides what the subagent did and folds the row of the call that started it, which stays", { subOn, subOff });
          await chat.evaluate(() => { const t = document.querySelector('#log .tool.sub-fold') || document.querySelector('#log .tool'), l = document.getElementById('log'); if (t) l.scrollTop += t.getBoundingClientRect().top - l.getBoundingClientRect().top - 8; });
          await shot('04f3-subagents-hidden', { features: ['subagent filter'],
            expect: 'Under the message box a pressed pill "Subagents hidden (n)". At the top of the log the subagent\'s task row stands alone, with no Subagent box under it; the subagent\'s shell row and its permission row are gone; the parent\'s own messages, replies and notice are there.',
            part: '#workbench\\.parts\\.editor' });
          await chat.click('#subBtn').catch(() => {});
          const subAgain = await until(async () => { const v = await subagentView(chat); return v.pressed === 'false' && v.folded.every((x) => x.child) && v.hidden.every(Boolean) ? v : null; }, 5000);
          check(!!subAgain, 'pressed again, what the subagent did shows again', subAgain || await subagentView(chat));
          await chat.evaluate(() => { const log = document.getElementById('log'); log.scrollTop = log.scrollHeight; });
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
          if (real) {
            await turn("Call the add_row tool once, with state doing and title 'list the files'. Do nothing else, then reply with only ok.", '04b');
            const row = await until(() => rows().find((n) => n.title === 'list the files'), 20000);
            const tools = await chat.evaluate(() => [...document.querySelectorAll('#log .tool')].map((e) => e.textContent.replace(/\s+/g, ' ').slice(0, 60)));
            check(!!row, "the model added a row to the conversation's work plan with the add_row tool", { rows: rows(), tools: tools.slice(-3) });
            await shot('04b-plan-row', { features: ['plan tool call'],
              expect: 'The chat shows the request to call add_row, an add_row tool row (folded to one line; its result "row 1 added: doing" shows only when opened), and the reply "ok".',
              part: '#workbench\\.parts\\.editor' });
          } else {
            /* The fake backend has no plugin, so this writes the row the model would add to the plan. */
            gapCi.writePlan(planFile, [{ title: 'list the files', state: 'doing' }]);
          }

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
            expect: 'Right above the message box, as wide as it, a one-line bar: a list icon and "Plan", a short track coloured by the states of the rows still open (all one colour when the one open row is in progress, empty once every row is done), "1 open", and the row "1 list the files" with its state icon (or a green check and "All rows done"), and an arrow at the right end.',
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

          // 3d. Token mode Interface: the plugin stops adding the plan from the next message. Behind the fake backend no
          // plugin runs, so only the switch is checked there.
          const plugin = () => {
            try { return fs.readFileSync(planLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } }); } catch (_) { return []; }
          };
          const injected = path.join(plansDir, `${sessionId}.injected`);
          const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
          /* First a message the plan is injected into, which also leaves .injected beside the plan. */
          if (real) {
            await turn('Reply with only the word two.', '07b');
            const shown = plugin().filter((l) => l.kind === 'prompt' && l.sessionID === sessionId).pop();
            check(!!shown && shown.chars > 0 && mtime(injected) > 0, 'with the plan open, the next message gets the plan injected', { last: shown, injected: mtime(injected) });
          }
          await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", "interface", vscode.ConfigurationTarget.Global); return true;');
          const off = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(plansDir, 'config.json'), 'utf8')).enabled === false; } catch (_) { return false; } }, 10000);
          check(off, 'switching the token mode to Interface writes enabled: false for the plugin at once');
          if (real) {
            const promptsBefore = plugin().filter((l) => l.kind === 'prompt' && l.sessionID === sessionId);
            const injectedBefore = mtime(injected);
            await turn('Reply with only the word three.', '08');
            await sleep(1500);
            const promptsAfter = plugin().filter((l) => l.kind === 'prompt' && l.sessionID === sessionId);
            const withdrawn = plugin().some((l) => l.kind === 'tools' && l.registered === false);
            const reply = await chat.evaluate(() => document.getElementById('log').textContent);
            /* The plugin still sees the message, and adds nothing to it. */
            const added = promptsAfter.slice(promptsBefore.length).filter((l) => l.chars > 0);
            check(promptsBefore.length > 0 && promptsAfter.length > promptsBefore.length && !added.length && injectedBefore > 0 && mtime(injected) === injectedBefore && withdrawn && /three/i.test(reply),
              'in Interface the next message gets no work plan: no injection in the plugin log, .injected unchanged, the plan tools withdrawn, and the reply still comes',
              { promptsBefore: promptsBefore.length, promptsAfter: promptsAfter.length, added, injectedBefore, injectedAfter: mtime(injected), withdrawn });
            await shot('08-interface-mode', { features: ['token mode Interface'],
              expect: 'The chat shows "Reply with only the word three." and the reply "three", with no plan tool row in that turn.',
              part: '#workbench\\.parts\\.editor' });
          }
          await call('await vscode.workspace.getConfiguration("agentPlus").update("tokenMode", undefined, vscode.ConfigurationTarget.Global); return true;').catch(() => {});

          // 3h. An image pasted into the box goes with the message; Claude Haiku 4.5 reads it, and the fake backend the
          // colour of its first pixel.
          const SEEING = real ? { id: HAIKU, name: 'Claude Haiku 4.5' } : { id: 'fake/fake-large', name: 'Fake Large' };
          await pickModel(chat, SEEING.id);
          const onHaiku = await until(() => chat.evaluate((id) => document.getElementById('model').dataset.current === id, SEEING.id), 15000);
          await chat.evaluate((b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'square.png', { type: 'image/png' }));
            const box = document.getElementById('input');
            box.focus();
            box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          }, solidPng(30, 80, 230).toString('base64'));
          const thumbs = await until(() => chat.evaluate(() => document.querySelectorAll('#attachments .att-image img').length), 10000);
          check(onHaiku && thumbs === 1, `with ${SEEING.name} picked, a pasted image shows as a thumbnail in the box`, { onHaiku, thumbs });
          await shot('10-pasted-image', { features: ['pasted image'],
            expect: `Inside the message box, above the empty text area, a chip with a small blue square thumbnail, the name square.png and a × button; the model pill under the box shows ${SEEING.name}.`,
            part: '#workbench\\.parts\\.editor' });
          await turn('What colour is this image? Answer with one word and do not use any tool.', '10b');
          const colour = await lastReply();
          const imgChips = await lastUserChips();
          check(/blue/i.test(colour) && imgChips.includes('Image'), 'the model answers the colour of the pasted image, and the message shows it had one', { colour, imgChips });
          await pickModel(chat, MODEL);
          await until(() => chat.evaluate((id) => document.getElementById('model').dataset.current === id, MODEL), 15000);

          // 3i. @ lists the workspace's files; the one picked goes with the message.
          await chat.fill('#input', 'What is the code word in @codew');
          const atList = await until(async () => { const l = await menuItems(); return l.includes('codeword.txt') ? l : null; }, 20000);
          check(!!atList, 'typing @ lists the workspace files that match', atList || await menuItems());
          await shot('11-at-menu', { features: ['@ file list'],
            expect: 'Above the message box, which holds "What is the code word in @codew", a list with codeword.txt highlighted (a file at the top of the folder has no folder written after its name).',
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
          check(/colours\.txt:2/.test(selLabel || '') && /colours\.txt:2/.test(selChip || ''), 'with text selected in an editor the page offers it, and adding it shows it in the box', { selLabel, selChip });
          await shot('11c-selection', { features: ['selection button'],
            expect: 'The editor is split: colours.txt on the right with line 2 selected; in the chat, in the row of buttons under the message box, a pill "colours.txt:2" with a selection icon, and inside the box a chip "Selection colours.txt:2" with a × button.',
            part: '#workbench\\.parts\\.editor' });
          await turn('What colour of the day does the attached selection name? One word, no tools.', '11d');
          const dayColour = await lastReply();
          check(/magenta/i.test(dayColour) && (await lastUserChips()).some((c) => /colours\.txt:2/.test(c)), 'the model answers from the selection sent with the message', { dayColour });
          await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === vscode.Uri.file(${JSON.stringify(colours)}).toString());
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
            expect: 'Above the message box (the plan bar may sit between them), a framed question box: a tab-like heading with the question\'s short name, the question about red or blue, each choice a row with a round button (Red, Blue), an own-answer box, a full-width Submit row, a Cancel button and a hint about Esc.',
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
          check(/blue/i.test(chosen) && /^Answered: .*Blue/i.test(settledQ), 'after Submit the model gets the answer: it replies with the colour chosen, and the answered question shows the answer', { chosen, settledQ });
          await shot('12b-answered', { features: ['question answered'],
            expect: 'Above it the question tool row (folded), then the answered question, now a row in the log reading "Answered: … Blue" under a framed copy of the form: Blue\'s choice is checked and in bold, the other choice is faded (an own-answer box left empty may be left out), and there are no buttons; below it the reply "Blue" (or "blue"), its time followed by the figures.',
            part: '#workbench\\.parts\\.editor' });

          // 3l. Rename from the chat tab's menu: the tab, the page, the Conversations list, Agent Plus and OpenCode all show the
          // new title.
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

          // 3m. While it waits for an approval, a delivery through the source is refused with the reason; when the turn
          // ends, the latest reply is written beside the plan.
          let refused = null;
          const askText = 'Run the command `echo waiting-check` with the shell tool, then reply with only the word done.';
          const beforeAsk = await figures();
          await chat.fill('#input', askText);
          await chat.press('#input', 'Enter');
          /* Sent before waitTurn, which answers the request the moment it sees it. */
          const asked = await until(async () => {
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) return true;
            return null;
          }, 120000, 200);
          if (asked) refused = await ext('return api.test.source.deliverAnswer(arg, "a message from the steward", { deliveryId: "window-test-1" });', sessionId);
          await waitTurn(beforeAsk, '14');
          check(!!refused && refused.outcome === 'notReceived' && /^\S+ is waiting for approval in its window$/.test(refused.reason || ''),
            "while the conversation waits for an approval, the source's deliverAnswer refuses the message and names what it waits for", refused);
          const replyFile = path.join(plansDir, `${sessionId}.reply.json`);
          let latest = null;
          try { latest = JSON.parse(fs.readFileSync(replyFile, 'utf8')); } catch (_) { /* none */ }
          check(!!latest && latest.format === 1 && latest.said.length > 0 && latest.said[latest.said.length - 1].text === askText && /done/i.test(latest.reply)
            && !/a message from the steward/.test(JSON.stringify(latest)),
          'when the turn ends, the latest reply is written beside the plan: the message just sent and the reply to it, and not the refused one', { latest, shown: await lastReply() });

          // 3n. A reply in a tab not in front: an envelope after its title, gone once the tab comes to the front.
          await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
          const secondId = await until(async () => {
            const u = await call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.toString() : null;');
            return u && u !== `opencodeagentplus-session:/${sessionId}` ? u.replace(/^opencodeagentplus-session:\//, '') : null;
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
            expect: `Two chat tabs, each with the activity bar's OpenCode mark as its icon and no dot (neither conversation is working or waiting): the one in front is a new, empty conversation; the other reads "${NEW_TITLE} 📩", the envelope after its title.`,
            part: '#workbench\\.parts\\.editor' });
          const all = (await ext('return api.test.source.listAllConversations();')) || [];
          let windowFile = null;
          try { windowFile = JSON.parse(fs.readFileSync(await ext('return api.test.windowFile;'), 'utf8')); } catch (_) { /* none */ }
          check(all.some((c) => c.sessionId === sessionId) && all.some((c) => c.sessionId === secondId) && !!windowFile && windowFile.conversations.some((c) => c.sessionId === sessionId),
            "listAllConversations gives both conversations, and this window's file holds them for the other windows",
            { all: all.map((c) => c.sessionId), file: windowFile && windowFile.conversations.map((c) => c.sessionId) });
          await call('return vscode.commands.executeCommand("opencodeAgentPlus.openConversation", arg);', sessionId);
          const seen = await until(async () => { const t = await tabOf(sessionId); return t && t.active && t.label === NEW_TITLE ? t : null; }, 15000);
          check(!!seen, 'once that tab comes to the front, the envelope is gone', seen || await tabOf(sessionId));
          await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === "opencodeagentplus-session:/" + arg);
            await vscode.window.tabGroups.close(tabs); return true;`, secondId).catch(() => {});
          await sleep(1000);
          chat = await frameWith(page, '#input', 30000);
          await shot('15b-envelope-gone', { features: ['unread envelope'],
            expect: `One chat tab, "${NEW_TITLE}", in front with no envelope; its page ends with the reply "five".`,
            part: '#workbench\\.parts\\.editor' });

          // 3o. A permission request answered from its diff's title bar; step 3p rewinds the files this turn changes.
          const notes = path.join(p.folder, 'notes.txt');
          const rewound = path.join(p.folder, 'rewind-me.txt');
          const REWIND_TEXT = 'Use the write tool to create a file named rewind-me.txt containing exactly v1, then use the edit tool to change notes.txt so that it contains exactly: Changed notes. Then reply with only the word done.';
          const beforeEdit = await figures();
          await chat.fill('#input', REWIND_TEXT);
          await chat.press('#input', 'Enter');
          let titled = null, viaTitle = false;
          await waitTurn(beforeEdit, '16', async () => {
            if (titled) return;
            const card = await chat.$('#log .permission:not(.settled) button.diff:not([hidden])');
            if (!card) return;
            titled = 'opened';
            await card.click();
            const allow = await page.waitForSelector('.editor-actions [aria-label="Allow Once"]', { timeout: 15000 }).catch(() => null);
            if (!allow) return;
            await shot('16-diff-title-bar', { features: ['diff title bar answers'],
              expect: 'A diff editor "… (proposed change)" for rewind-me.txt or notes.txt is open; at the right end of the tab row, before the usual editor actions, a check, a double check and a cross icon (Allow Once, Allow in This Project, Deny).' });
            /* VS Code redraws the title bar as context keys change, so the button is looked up at the moment it is clicked. */
            await page.locator('.editor-actions [aria-label="Allow Once"]').first().click();
            viaTitle = await until(() => call('return !vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => /proposed change/.test(t.label));'), 10000);
            /* The chat page was hidden behind the diff, so VS Code drew it again when the diff closed. */
            chat = await frameWith(page, '#input', 30000);
            titled = 'answered';
          });
          const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
          const settledWords = await chat.evaluate(() => [...document.querySelectorAll('#log .permission .perm-result')].map((e) => e.textContent).filter(Boolean));
          check(titled === 'answered' && viaTitle && settledWords.includes('Allowed once'), "Allow Once in a diff's title bar answers the request it shows, and the diff closes", { titled, viaTitle, settledWords });
          check(read(rewound) === 'v1' && /^Changed notes\.?\s*$/.test(read(notes) || ''), 'the turn wrote rewind-me.txt and changed notes.txt', { rewound: read(rewound), notes: read(notes) });

          // 3p. Rewind to before that message: cancelled first (the files come back), then confirmed.
          const rewindOn = () => chat.evaluate((t) => {
            const msg = [...document.querySelectorAll('#log .msg.user')].reverse().find((m) => m.querySelector('.bubble').textContent === t);
            const b = msg && msg.querySelector('button.rewind');
            if (!b || b.hidden) return false;
            b.click();
            return true;
          }, REWIND_TEXT);
          const dialog = () => page.evaluate(() => { const d = document.querySelector('.monaco-dialog-box'); return d ? d.textContent : ''; });
          const clickDialog = (label) => page.locator('.monaco-dialog-box .dialog-buttons a, .monaco-dialog-box .dialog-buttons button', { hasText: label }).first().click();
          const offered = await rewindOn();
          const asking = await until(dialog, 20000);
          const midway = { rewound: read(rewound), notes: read(notes) };
          check(offered && /Rewind the conversation to before this message\?/.test(asking || '') && /rewind-me\.txt: removed/.test(asking || '') && /notes\.txt: changed back/.test(asking || ''),
            'Rewind to here asks first, listing the files that go back', { offered, asking, midway });
          await shot('17-rewind-confirm', { features: ['rewind confirmation'],
            expect: 'A dialog over the window: "Rewind the conversation to before this message?", saying the message and all messages after it will be removed from the conversation, listing rewind-me.txt (removed) and notes.txt (changed back), that Cancel undoes it, and that rewinding is experimental; buttons Rewind and Cancel.' });
          if (asking) await clickDialog('Cancel');
          const restored = await until(() => (read(rewound) === 'v1' && /^Changed notes/.test(read(notes) || '') ? { rewound: read(rewound), notes: read(notes) } : null), 20000);
          const stillThere = await chat.evaluate((t) => [...document.querySelectorAll('#log .msg.user .bubble')].some((b) => b.textContent === t), REWIND_TEXT);
          check(!!restored && stillThere, 'Cancel puts the files back as the turn left them, and the conversation is unchanged', { restored, stillThere });
          await sleep(1000);
          await rewindOn();
          const again = await until(dialog, 20000);
          if (again) await clickDialog('Rewind');
          let lastSeen = null;
          const after = await until(async () => {
            const gone = await chat.evaluate((t) => ![...document.querySelectorAll('#log .msg.user .bubble')].some((b) => b.textContent === t), REWIND_TEXT);
            const box = await chat.inputValue('#input');
            lastSeen = { gone, box };
            return gone && read(rewound) === null && read(notes) === 'Some notes.\n' && box === REWIND_TEXT ? { box } : null;
          }, 30000);
          let stored = null;
          if (!real) stored = gapCi.fakeUserTexts(p.agentHome, sessionId);
          else {
            const exported = cp.spawnSync(OPENCODE, ['session', 'export', sessionId, '--standalone'], { env: { ...process.env, ...xdgEnv, OPENCODE_DISABLE_AUTOUPDATE: '1' }, encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
            try { stored = JSON.parse(exported.stdout).messages.filter((m) => m.type === 'user').map((m) => m.text); } catch (_) { /* below */ }
          }
          check(!!after && after.box === REWIND_TEXT && !!stored && !stored.includes(REWIND_TEXT) && stored.length > 0,
            'after Rewind the files are as before the message, the page and OpenCode no longer have it, and its text is back in the box', { after, lastSeen, stored: stored && stored.slice(-3), files: { rewound: read(rewound), notes: read(notes) } });
          const rewoundFigures = await chat.evaluate(() => [...document.querySelectorAll('#log .figures')].map((x) => x.textContent));
          check(rewoundFigures.some((x) => /ctx \d+%/.test(x)) && rewoundFigures.some((x) => /\$\d/.test(x)), 'after Rewind the turns drawn again show their context use and cost', rewoundFigures.slice(-4));
          await shot('17b-rewound', { features: ['rewound conversation'],
            expect: 'The conversation ends with the turn before the rewound message (the earlier replies are all there); the message box holds the rewound request ("Use the write tool to create a file named…").',
            part: '#workbench\\.parts\\.editor' });
          await chat.fill('#input', '');

          // 3q. A reply that links a local image shows the image.
          const square = path.join(p.folder, 'red-square.png');
          fs.writeFileSync(square, solidPng(220, 40, 40, 48));
          await turn('Reply with exactly the following line and nothing else, and do not use any tool: ![red square](' + square + ')', '18');
          const img = await until(() => chat.evaluate(() => {
            const i = [...document.querySelectorAll('#log .msg.reply img.reply-image')].pop();
            return i && /^data:image\/png;base64,/.test(i.getAttribute('src') || '') && i.naturalWidth > 0 ? { w: i.naturalWidth, title: i.title } : null;
          }), 20000);
          check(!!img && img.w === 48, 'a reply that links a local image shows the image', img || await lastReply());
          await shot('18-reply-image', { features: ['images in replies'],
            expect: 'The last reply shows a red square image (48 by 48 pixels) instead of the markdown text; that row\'s time is followed by the figures.',
            part: '#workbench\\.parts\\.editor' });

          // 3r. A shell command moved to the background shows on the background pill while it runs.
          await turn('Use the shell tool to start the command "sleep 25; echo bg-done" in the background, without waiting for it to finish. Then reply with only the word started and end your response at once.', '19');
          const bgLine = await until(() => chat.evaluate(() => { const b = document.getElementById('background'); return b && !b.hidden ? b.querySelector('summary').textContent : null; }), 20000);
          if (bgLine) await chat.click('#background summary');
          const bgRows = bgLine && await chat.evaluate(() => [...document.querySelectorAll('#background .bg-row')].map((r) => r.textContent));
          check(/^1 command running$/.test(bgLine || '') && !!bgRows && bgRows.some((t) => /sleep 25/.test(t)), 'a command moved to the background shows on the background pill under the input box, with what it runs', { bgLine, bgRows });
          await shot('19-background', { features: ['background pill'],
            expect: 'In the row of buttons under the message box a pill with a green dot, "1 command running"; it is open, and a framed list above the message box headed BACKGROUND WORK has a row "Command  sleep 25; echo bg-done  process <n> · since <time>".',
            part: '#workbench\\.parts\\.editor' });
          const bgGone = await until(async () => {
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) await b.click();
            return chat.evaluate(() => document.getElementById('background').hidden && document.body.dataset.status === 'idle');
          }, 120000, 1000);
          check(bgGone, 'once the command has ended (OpenCode goes on by itself), the background pill is gone');

          // 3s. Esc stops a turn.
          const beforeEsc = await figures();
          await chat.fill('#input', 'Use the shell tool to run the command "sleep 45" in the foreground (not in the background), then reply with only the word slept.');
          await chat.press('#input', 'Enter');
          const sleeping = (after) => until(async () => {
            for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) await b.click();
            if (await chat.evaluate(() => !!document.querySelector('#log .tool.state-running') && document.body.dataset.status === 'working')) return 'running';
            return (await status()) === 'idle' && (await figures()) > after ? 'answered' : null;
          }, 90000, 500);
          let running = (await sleeping(beforeEsc)) === 'running';
          /* A model may answer without running the command; it is asked once more. */
          if (!running) {
            console.log(`  note  the model answered without running sleep 45: ${JSON.stringify((await lastReply()).slice(0, 120))}; asking again`);
            const again = await figures();
            await chat.fill('#input', 'You did not run it. Call the shell tool now with the command "sleep 45", in the foreground, and wait for it to finish before you reply.');
            await chat.press('#input', 'Enter');
            running = (await sleeping(again)) === 'running';
          }
          await chat.focus('#input');
          await chat.press('#input', 'Escape');
          const stopped = await until(() => chat.evaluate(() => document.body.dataset.status === 'idle' && [...document.querySelectorAll('#log .notice')].some((n) => /^Stopped\.$/.test(n.textContent))), 20000);
          check(running && stopped && (await figures()) > beforeEsc, 'Esc stops the running turn', { running, stopped });
          await shot('20-esc-stopped', { features: ['Esc stops'],
            expect: real
              ? 'The shell row for "sleep 45" ends in an error OpenCode gave it (a red dot; opened, its OUT says the command was interrupted by the user); after its answered permission row (allowed once), a "Stopped." notice and the figures on a line of their own; the square stop button under the message box is back to the send arrow.'
              : 'The shell row for "sleep 45" ends with the word "Stopped" in a faded row; after it a "Stopped." notice and the figures on a line of their own; the square stop button under the message box is back to the send arrow.',
            part: '#workbench\\.parts\\.editor' });

          // 3t. The info box.
          await chat.click('#infoBtn');
          const info = await until(() => chat.evaluate(() => { const b = document.getElementById('infoBox'); return b && !b.hidden && b.querySelector('.info-row') ? [...b.querySelectorAll('.info-row')].map((r) => [r.querySelector('.info-label').textContent, r.querySelector('.info-value').textContent]) : null; }), 15000);
          const infoOf = Object.fromEntries(info || []);
          const runs = real ? { version: '2.4.1', db: path.join(xdgEnv.XDG_DATA_HOME, 'opencode', 'opencode.db') } : { version: '2.0.0-fake', db: path.join(p.agentHome, 'fake-backend.json') };
          /* On Windows the folder's drive letter can come back upper or lower case. */
          const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
          const versionRow = new RegExp(`^${runs.version.replace(/\./g, '\\.')}, acp process \\d+$`);
          check(!!info && infoOf.Session === sessionId && versionRow.test(infoOf.OpenCode || '') && samePath(infoOf.Folder, p.folder)
            && samePath(infoOf['Session database'] || '', runs.db) && infoOf['Token mode'] === 'All features',
          'the info box shows the session, the folder, OpenCode and its acp process, the session database and the token mode', infoOf);
          await shot('21-info', { features: ['session info'],
            expect: `A box with no heading, opened from the "ℹ" button under the message box and drawn above it, with Session, Folder, OpenCode ("${runs.version}, acp process <n>"), Session database (a path ending ${path.basename(runs.db)}) and Token mode (All features), and a Copy all button.`,
            part: '#workbench\\.parts\\.editor' });
          await chat.press('#input', 'Escape');

          // 3u. The MCP servers, in an output channel.
          const mcp = await ext('return api.test.mcp();');
          /* The output view draws spaces as no-break spaces. */
          const mcpShown = await until(() => page.evaluate(() => { const e = document.getElementById('workbench.parts.panel'); return !!e && /No MCP servers configured/.test(e.textContent.replace(/\u00a0/g, ' ')); }), 20000);
          check(/No MCP servers configured/.test(mcp || '') && mcpShown, 'Show MCP Servers puts the output of opencode mcp list in an output channel', { mcp, mcpShown });
          await shot('22-mcp', { features: ['MCP servers'],
            expect: 'The panel at the bottom shows the output channel "OpenCode Agent Plus: MCP Servers": a line "$ opencode mcp list (…)", "No MCP servers configured" and a line on adding a server with opencode mcp add.',
            part: '#workbench\\.parts\\.panel' });
          await call('await vscode.commands.executeCommand("workbench.action.closePanel"); return true;').catch(() => {});

          // 3v. Fork from the chat tab's menu; the Conversations view splits into its two groups.
          const items = await tabMenu((await tabOf(sessionId) || {}).label || '');
          let forked = '';
          if (items.includes('Fork Conversation')) {
            /* A menu ignores a click that comes right after it opened. */
            await sleep(700);
            await page.locator('.monaco-menu .action-label', { hasText: 'Fork Conversation' }).first().click();
            forked = await until(async () => {
              const u = await call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.toString() : null;');
              return u && u !== 'opencodeagentplus-session:/' + sessionId ? u.replace(/^opencodeagentplus-session:\//, '') : null;
            }, 30000);
          } else await page.keyboard.press('Escape');
          const forkPage = forked && await frameWith(page, '#input', 30000);
          const copied = forkPage && await until(() => forkPage.evaluate(() => /列出工作目录下的文件/.test(document.getElementById('log').textContent) && /red square/.test(document.getElementById('log').textContent)), 30000);
          check(!!forked && !!copied, "Fork Conversation in the chat tab's menu opens a copy of the whole conversation in a new tab", { items, forked, copied });
          if (copied) {
            const forkFigures = await forkPage.evaluate(() => [...document.querySelectorAll('#log .figures')].map((x) => x.textContent));
            check(forkFigures.some((x) => /ctx \d+%/.test(x)) && forkFigures.some((x) => /\$\d/.test(x)), "the fork's replayed turns show their context use and cost", forkFigures.slice(-4));
          }
          await call('await vscode.commands.executeCommand("workbench.view.extension.opencodeAgentPlus"); return true;');
          const groups = await until(() => page.evaluate(() => { const t = document.getElementById('workbench.parts.sidebar').textContent; return /Open in this window/.test(t) && /Other conversations/.test(t); }), 20000);
          check(groups, 'the Conversations view puts the conversations open here under "Open in this window" and the rest under "Other conversations"');
          await shot('23-fork-groups', { features: ['fork', 'open conversations first'],
            expect: real
              ? 'The editor shows the fork in a new tab (the same conversation); the Conversations view has three groups: "Recently closed" with the untitled one closed earlier, "Open in this window" with the conversation and its fork, and "Other conversations" with the untitled one again; each group header shows a count.'
              : 'The editor shows the fork in a new tab (the same conversation); the Conversations view has three groups: "Recently closed" with the untitled one closed earlier and the first fork ("Renamed in the fake run (fork)"), "Open in this window" with the conversation and its new fork, and "Other conversations" with those two closed ones again; each group header shows a count.' });
          if (forked) {
            await call('const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === "opencodeagentplus-session:/" + arg); await vscode.window.tabGroups.close(tabs); return true;', forked).catch(() => {});
            await sleep(1000);
          }
          chat = await frameWith(page, '#input', 30000);

          // 3w. Links: the model names the fork by its session id; the page links it, and a click opens the fork.
          if (forked) {
            await turn(`Reply with exactly this line and nothing else: The copy is session ${forked}.`, '23b');
            const l = await until(async () => { const x = await convLinks(chat); return x.some((y) => y.session === forked) ? x : null; }, 20000);
            check(!!l && l.every((y) => y.session !== sessionId && y.source === 'opencode-plus'), "a reply naming another conversation by its session id links it, and the page's own id is never linked",
              { links: l || await convLinks(chat), reply: await lastReply() });
            await shot('23b-conversation-link', { features: ['links to other conversations'],
              expect: 'The last reply reads "The copy is session ses_…" with the id drawn as a link (link colour, dotted underline); the rail of five small buttons on the right edge is there; no list is open over the log.',
              part: '#workbench\\.parts\\.editor' });
            const went = await followLink(chat, forked);
            check(!!went, 'a click on the link opens that conversation in its tab', { went, active: await activeUri() });
            await closeChat(forked);
            await sleep(1000);
            chat = await frameWith(page, '#input', 30000);
          }

          // 3x. Recently closed: the fork, then the empty conversation the envelope step closed.
          const forkRow = ((await ext('return api.test.sessions();')) || []).find((r) => r.id === forked) || {};
          await recentStep([(forkRow.title || 'Untitled conversation').slice(0, 12), 'Untitled conversation'], '23c-recently-closed',
            'The Conversations view, the pointer on the clear-all button at the right end of the "Recently closed" row at the top, maybe with its label "Clear Recently Closed"; the group lists the fork first and the "Untitled conversation" second; below it "Open in this window" and "Other conversations".');

          // 3y. Find Conversation by part of the fork's id.
          if (forked && await findStep(forked, '23d-find-conversation',
            'A quick pick at the top titled "Find a conversation", its box holding a few characters of a session id, and one row: the fork\'s title with "active … ago", and below it the full ses_… id and the folder.')) {
            await closeChat(forked);
            await sleep(1000);
            chat = await frameWith(page, '#input', 30000);
          }

          // 3z. The outline of the messages so far; the fake run went through it in its own steps.
          if (real) {
            await outlineStep(chat, '23e-outline',
              'Over the top right of the conversation a framed list lists every user message with its date and time ("列出工作目录下的文件" first), each cut to one line; the log is scrolled to the first message, which has a thin focus-coloured outline; the middle button of the rail on the right edge is pressed.');
          }

          /* Last of these: the first message after compacting carries the work plan's reminder again, and a model may
             answer that instead of the message. */
          // 3g. Slash commands: / lists OpenCode's commands; /compact, picked from the list and sent, compacts the conversation.
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
          const marked = await until(async () => { const x = await outlineOf(chat); return x.rows.some((r) => r.kind === 'compaction' && /Compacted/.test(r.text)) ? x : null; }, 10000);
          check(!!marked, 'the outline marks where the conversation was compacted', marked || await outlineOf(chat));
          await chat.evaluate(() => {
            const d = [...document.querySelectorAll('#log .compaction-summary')].pop();
            const log = document.getElementById('log');
            if (d) { d.open = true; log.scrollTop = d.closest('.compaction').offsetTop - log.offsetTop; }
          });
          await shot('09b-compacted', { features: ['compaction divider'],
            expect: 'A horizontal line labelled "Conversation compacted", scrolled as near the top as the log goes, with a "Summary" below it, unfolded to show the summary OpenCode wrote (headings such as Objective); the figures line of the /compact turn follows the summary, possibly below the visible part. The rail of five small buttons is on the right edge.',
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
      expect: 'The panel at the bottom shows Agent Plus\'s Conversations view, which lists this conversation by its title (possibly cut short) with no icon in front of it (Agent Plus draws a source\'s logo only once more than one source is registered) and no activity dot, since the conversation has stopped.',
      part: '#workbench\\.parts\\.panel' });

    // 4b. With a second source registered, Agent Plus draws this source's logo on its rows, in each theme.
    const second = await call(`const ap = vscode.extensions.getExtension('xnervwang.agent-plus').exports.agentPlus;
      const r = ap.registerSource({ protocol: 1, id: 'look-second', label: 'Second source', listConversations: async () => [] });
      global.__lookSecond = r.registration; return r.accepted;`);
    const logoShown = () => until(() => page.evaluate(() => {
      const panel = document.getElementById('workbench.parts.panel');
      return !!panel && [...panel.querySelectorAll('.monaco-list-row *')].some((e) => /conversation-icons/.test(e.style.backgroundImage || ''));
    }), 30000);
    check(second === true && await logoShown(), "with a second source registered, Agent Plus's rows of this source show the OpenCode Agent Plus logo", { second });
    await page.mouse.move(800, 300);
    await shot('05b-agent-plus-logo-dark', { features: ['Agent Plus logo'],
      expect: 'Agent Plus\'s Conversations view in the dark theme: this conversation\'s row starts with the OpenCode Agent Plus logo, the OpenCode mark: an upright rectangular frame whose lower inner half is filled in a fainter tone of the same colour, in light grey, readable against the dark panel, about the size of a tree icon, with no activity dot since the conversation has stopped.',
      part: '#workbench\\.parts\\.panel' });
    const setTheme = async (theme, cls) => {
      await call('await vscode.workspace.getConfiguration().update("workbench.colorTheme", arg, vscode.ConfigurationTarget.Global); return true;', theme);
      return until(() => page.evaluate((c) => document.querySelector('.monaco-workbench').classList.contains(c), cls), 20000);
    };
    check(await setTheme('Default Light Modern', 'vs'), 'the window switches to the light theme');
    await logoShown();
    await page.mouse.move(800, 300);
    await shot('05c-agent-plus-logo-light', { features: ['Agent Plus logo'],
      expect: 'The same Conversations view in the light theme: the row\'s OpenCode Agent Plus logo is now dark grey on the light panel (the OpenCode mark: an upright rectangular frame whose lower inner half is filled in a fainter tone of the same colour), readable, with no dot.',
      unchanged: 'The rows and their titles, apart from the colours of the theme.',
      part: '#workbench\\.parts\\.panel' });
    await barQuiet();
    await shot('05d-activity-bar-icon-light', { features: ['activity bar icon'],
      expect: 'A close-up of the activity bar in the light theme. The OpenCode Agent Plus icon (the OpenCode mark: an upright rectangular frame whose lower inner half is filled in a fainter tone of the same colour) is drawn in the same dark grey as the other icons, about their size, sharp and readable against the light bar.',
      part: '#workbench\\.parts\\.activitybar' });
    check(await setTheme('Default Dark Modern', 'vs-dark'), 'the window switches back to the dark theme');
    await call('if (global.__lookSecond) global.__lookSecond.dispose(); global.__lookSecond = null; return true;');
    await call('await vscode.commands.executeCommand("workbench.action.closePanel"); return true;').catch(() => {});

    // 5. The Conversations view lists it. (Clicking the icon of the container already shown would hide the side bar.)
    await call('await vscode.commands.executeCommand("workbench.view.extension.opencodeAgentPlus"); return true;');
    const inList = await until(async () => page.evaluate((t) => document.getElementById('workbench.parts.sidebar').textContent.includes(t), await titleNow()), 30000);
    check(inList, 'the Conversations view lists the conversation');
    await shot('06-sessions', { features: ['session list'],
      expect: real && line >= 2
        ? 'The OpenCode Agent Plus Conversations view has three groups: "Recently closed" with the fork (the same title, or one OpenCode gave it), whose tab was closed last; "Open in this window" with the conversation by its title; and "Other conversations" with the fork and an "Untitled conversation", the empty one the envelope step opened and closed (OpenCode keeps a conversation from the moment it is made); speech-bubble icons, and a relative time such as "now" that a long title may cut off.'
        : real
          ? 'The OpenCode Agent Plus Conversations view lists one row with the conversation title and a speech-bubble icon (a relative time such as "now" may be cut off by a long title).'
          : 'The OpenCode Agent Plus Conversations view has three groups: "Recently closed" with the second fork ("Renamed by the window test (fork)"), whose tab was closed last; "Open in this window" with "Renamed by the window test"; and "Other conversations" with both forks (the first is "Renamed in the fake run (fork)") and an "Untitled conversation", the empty one the envelope step opened and closed.',
      part: '#workbench\\.parts\\.sidebar' });

    // 6. A reload brings the tabs back with their history: this conversation's, one behind it and one in a split to the
    //    right (lib/gap-ci.js).
    const recentBefore = ((await ext('return api.test.recent();')) || []).map((e) => e.id);
    const firstText = real ? '列出工作目录下的文件' : 'subtracted instead of adding';
    const reloadCtx = { page, call, ext, check, until };
    const reloadTabs = await gapCi.openTabs(reloadCtx, { id: sessionId, text: firstText });
    /* Records the log's entries by kind and each turn's figures, to compare with the page after the reload. */
    const logShape = (f) => f.evaluate(() => {
      const kinds = {};
      for (const e of document.querySelectorAll('#log [data-id]')) {
        if (/-row$/.test(e.dataset.id) || (e.parentElement && e.parentElement.closest('#log [data-id]'))) continue;
        const c = e.classList;
        const k = ['user', 'subagent', 'tool', 'permission', 'question', 'compaction', 'figures', 'notice', 'reasoning'].find((x) => c.contains(x)) || (c.contains('msg') ? 'reply' : c[0] || '?');
        kinds[k] = (kinds[k] || 0) + 1;
      }
      return { kinds, figures: [...document.querySelectorAll('#log .figures')].map((x) => x.textContent) };
    });
    const beforeReload = await gapCi.pageOf(reloadCtx, { id: sessionId, text: firstText }).then((f) => (f ? logShape(f) : null)).catch(() => null);
    await w.reload();
    await until(() => ext('return !!(api && api.test);'), 60000);
    const back = await until(() => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat").map((t) => t.input.uri.toString());`), 30000);
    check(Array.isArray(back) && back.includes(`opencodeagentplus-session:/${sessionId}`), 'after a reload the chat tab is back for the same conversation', back);
    const again = await gapCi.pageOf(reloadCtx, { id: sessionId, text: firstText });
    const history = again && await until(() => again.evaluate((re) => new RegExp(re).test(document.getElementById('log').textContent), firstText), 30000);
    check(!!history, 'the restored tab shows the conversation so far');
    /* OpenCode's record of a session holds no requests and no stop reasons, so answered permission requests, questions and
       notices such as "Stopped." are not replayed. Nor is a /compact the user typed: OpenCode records only the compaction.
       Every other entry comes back. */
    const afterReload = again ? await logShape(again).catch(() => null) : null;
    const lost = beforeReload && afterReload ? Object.keys({ ...beforeReload.kinds, ...afterReload.kinds })
      .filter((k) => (beforeReload.kinds[k] || 0) !== (afterReload.kinds[k] || 0)).map((k) => `${k} ${beforeReload.kinds[k] || 0}->${afterReload.kinds[k] || 0}`) : null;
    if (lost && lost.length) console.log(`  note  entries before and after the reload differ in: ${lost.join(', ')}`);
    const compacted = beforeReload ? beforeReload.kinds.compaction || 0 : 0;
    const users = beforeReload ? beforeReload.kinds.user || 0 : 0;
    check(!!lost && lost.every((d) => /^(permission|question|notice) /.test(d) || (real && compacted > 0 && d === `user ${users}->${users - compacted}`)),
      'after the reload the page has the same messages, replies, tool rows, subagent boxes and compaction lines as before', { before: beforeReload, after: afterReload && afterReload.kinds });
    check(!!afterReload && afterReload.figures.some((x) => /ctx \d+%/.test(x)) && afterReload.figures.some((x) => /\$\d/.test(x)),
      "after the reload the replayed turns show their context use and cost", afterReload && afterReload.figures.slice(-4));
    const recentAfter = (await ext('return api.test.recent();')) || [];
    check(!recentAfter.some((e) => e.id === sessionId) && JSON.stringify(recentAfter.map((e) => e.id)) === JSON.stringify(recentBefore),
      'Recently closed outlasts the reload, and the reload did not count as closing the chat tab', { before: recentBefore, after: recentAfter });
    if (again && firstSentAt) {
      const reloadedAt = Date.now();
      const firstTime = await again.evaluate(() => { const t = document.querySelector('#log .msg.user .time'); return t ? t.textContent : ''; });
      const shownAt = pageTime(firstTime, firstSentAt);
      /* The page shows whole seconds; the reload comes well after the message on both OpenCode lines. */
      check(!!shownAt && Math.abs(shownAt - firstSentAt) <= 5000 && reloadedAt - shownAt >= 10000,
        'after the reload the first message keeps the time it was sent, from the export, not the moment of the reload',
        { firstTime, sent: new Date(firstSentAt).toISOString(), reloaded: new Date(reloadedAt).toISOString() });
    }
    if (real && line === 1) {
      await sleep(3000);
      const again2 = await toldV2();
      check(again2 === 0, 'after the reload the notice is not shown again', { told: again2 });
    }
    await gapCi.checkTabs(reloadCtx, reloadTabs);
    await shot('07-after-reload', { features: ['reload', 'restored history'],
      expect: 'After the reload the editor area is split in two again. On the left, two chat tabs; the one in front shows the same conversation as before: its messages, the tool rows on the line down the left and its last reply. On the right, a third chat tab with "Reply with only the word charlie." and the reply "charlie".',
      part: '#workbench\\.parts\\.editor' });
    await gapCi.closeTabs(call, reloadTabs.slice(1));
    await sleep(800);

    // 7. Every editor's title bar has the OpenCode mark, which starts another conversation.
    const markAt = '.editor-actions [aria-label^="OpenCode Agent Plus: New Conversation"]';
    const mark = await page.waitForSelector(markAt, { timeout: 15000 }).catch(() => null);
    check(!!mark, 'the editor title bar has the OpenCode mark that starts a new conversation');
    await page.mouse.move(800, 600);
    await shot('07b-editor-title-mark-dark', { features: ['new conversation from the editor title bar'],
      expect: 'At the right end of the chat tab\'s title bar, beside the split editor and "..." buttons, is a small light grey OpenCode mark (an upright rectangular frame whose lower inner half is fainter), the same size and tone as the buttons next to it.',
      part: '#workbench\\.parts\\.editor' });
    check(await setTheme('Default Light Modern', 'vs'), 'the window switches to the light theme for the title bar shots');
    await page.mouse.move(800, 600);
    await shot('07c-editor-title-mark-light', { features: ['new conversation from the editor title bar'],
      expect: 'The same title bar in the light theme: the OpenCode mark is dark grey like the buttons beside it and readable on the light bar.',
      unchanged: 'The buttons and their order, apart from the colours of the theme.',
      part: '#workbench\\.parts\\.editor' });
    check(await setTheme('Default Dark Modern', 'vs-dark'), 'the window switches back to the dark theme');
    if (mark) {
      await page.locator(markAt).first().click();
      const other = await until(() => call(`const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat" ? t.input.uri.toString() : null;`)
        .then((u) => (u && u !== `opencodeagentplus-session:/${sessionId}` ? u : null)), 30000);
      check(!!other, 'clicking the mark opens a new conversation in its own tab', other);
    }

    // 8. With a split to the right in front, a new conversation still opens in the main editor area.
    await call(`const chats = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat");
      if (chats.length) await vscode.window.tabGroups.close(chats);
      global.__splitLeft = await vscode.workspace.openTextDocument({ content: "" });
      await vscode.window.showTextDocument(global.__splitLeft, { viewColumn: vscode.ViewColumn.One, preview: false });
      global.__splitRight = await vscode.workspace.openTextDocument({ content: "" });
      await vscode.window.showTextDocument(global.__splitRight, { viewColumn: vscode.ViewColumn.Two, preview: false });
      return true;`);
    const layout = () => call(`return { groups: vscode.window.tabGroups.all.length, active: vscode.window.tabGroups.activeTabGroup.viewColumn,
      chat: vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter((t) => t.isActive && t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat").map(() => g.viewColumn)) };`);
    const before8 = await layout();
    check(before8.groups === 2 && before8.active === 2, 'the window has a split to the right, and it is the active group', before8);
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
    const first8 = await until(async () => { const l = await layout(); return l.chat.length ? l : null; }, 30000);
    check(!!first8 && first8.groups === 2 && first8.chat[0] === 1, 'a new conversation opens in the main editor area, and no split is added', first8);
    await call('await vscode.window.showTextDocument(global.__splitRight, { viewColumn: vscode.ViewColumn.Two, preview: false }); return true;');
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
    const chatsLeft = () => call(`return vscode.window.tabGroups.all.find((g) => g.viewColumn === 1).tabs.filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat").length;`);
    const second8 = await until(async () => { const n = await chatsLeft(); return n === 2 ? n : null; }, 30000);
    const after8 = await layout();
    check(second8 === 2 && after8.groups === 2, 'with the split in front again, the next conversation joins the first one in the main editor area', { second8, after8 });
    await page.mouse.move(800, 600);
    await shot('08-main-editor-area', { features: ['conversations open in the main editor area'],
      expect: 'Two editor groups side by side. The left one is the main editor area, with an untitled text tab and two chat tabs; the chat tab in front shows an empty conversation. The right one has only an untitled text tab.',
      part: '#workbench\\.parts\\.editor' });

    // 9. No frame shows a black disc while chat tabs are switched or a new one opens.
    const chatUris = () => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat").map((t) => t.input.uri.toString());`);
    const front = (uri) => call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.toString() === arg);
      await vscode.commands.executeCommand("vscode.openWith", t.input.uri, "opencodeAgentPlus.chat", { viewColumn: t.group.viewColumn, preview: false });
      return true;`, uri);
    const editorBox = await page.evaluate(() => { const r = document.querySelector('#workbench\\.parts\\.editor').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, page: window.innerWidth }; });
    const cdp = await page.context().newCDPSession(page);
    /* Captures the frames the window draws from just before `action` until `ms` after it. */
    const record = async (action, ms = 2000) => {
      const frames = [];
      const onFrame = (f) => { frames.push({ data: f.data, at: f.metadata.timestamp }); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); };
      cdp.on('Page.screencastFrame', onFrame);
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await sleep(500);
      const from = frames.length;
      await action();
      await sleep(ms);
      await cdp.send('Page.stopScreencast').catch(() => {});
      cdp.off('Page.screencastFrame', onFrame);
      return frames.slice(from);
    };
    /* Counts the black or nearly black pixels in each frame's editor area. The dark theme paints that area #1f1f1f. It also
       counts the pixels in that area's lowest quarter that differ from the background: the page's input box is drawn there. */
    const paintOf = (frames) => page.evaluate(async ({ frames, box }) => {
      const counts = [];
      for (const { data } of frames) {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const k = img.naturalWidth / box.page;
        const c = document.createElement('canvas');
        c.width = Math.round(box.width * k); c.height = Math.round(box.height * k);
        const g = c.getContext('2d');
        g.drawImage(img, box.x * k, box.y * k, c.width, c.height, 0, 0, c.width, c.height);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let black = 0, drawn = 0;
        const low = Math.floor(c.height * 0.75) * c.width * 4;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] <= 10 && px[i + 1] <= 10 && px[i + 2] <= 10) black++;
          if (i >= low && (Math.abs(px[i] - 31) > 12 || Math.abs(px[i + 1] - 31) > 12 || Math.abs(px[i + 2] - 31) > 12)) drawn++;
        }
        counts.push({ black: Math.round(black / (k * k)), drawn: Math.round(drawn / (k * k)) });
      }
      return counts;
    }, { frames, box: editorBox });
    /* A frame as a screenshot in look.json, like shot() makes. */
    const keepFrame = (name, data, entry) => {
      const full = path.join(shots, `${name}-full.png`);
      fs.writeFileSync(full, Buffer.from(data, 'base64'));
      const head = fs.readFileSync(full);
      steps.push({ name, features: entry.features, expect: entry.expect, unchanged: null, image: path.basename(full), full: path.basename(full),
        previous: previous ? path.basename(previous) : null, width: head.readUInt32BE(16), height: head.readUInt32BE(20), log: [] });
      previous = full;
      fs.writeFileSync(path.join(shots, 'look.json'), JSON.stringify(steps, null, 2));
    };
    /* The unstyled ring fills the page's width, some 200,000 black pixels here. */
    const DISC = 1500;
    const uris9 = await chatUris();
    check(uris9.length === 2, 'two chat tabs are open', uris9);
    if (uris9.length === 2) {
      await front(uris9[1]);
      let chat9 = await frameWith(page, '#input', 20000);
      check(!!chat9 && await chat9.evaluate(() => { window.__tabSwitchMark = 9; return true; }), 'a mark is set on the chat page in front');
      const bare = chat9 ? await chat9.evaluate(() => {
        const sheets = [...document.styleSheets];
        for (const s of sheets) s.disabled = true;
        const size = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; };
        const ring = document.querySelector('#ring svg');
        const out = { ring: ring ? size(ring) : 'none', fills: ring ? [...ring.querySelectorAll('circle')].map((c) => getComputedStyle(c).fill) : [],
          oversized: [...document.querySelectorAll('svg')].filter((v) => {
            const r = v.getBoundingClientRect();
            const w = Number(v.getAttribute('width')), h = Number(v.getAttribute('height'));
            return !(w && h) || Math.round(r.width) > w || Math.round(r.height) > h;
          }).map(size) };
        for (const s of sheets) s.disabled = false;
        return out;
      }) : null;
      check(!!bare && bare.ring === '16x16' && bare.fills.length === 2 && bare.fills.every((f) => f === 'none') && !bare.oversized.length,
        'with the stylesheet off, the ring stays 16 by 16 and unfilled, and every svg keeps the size written on it', bare);
      await front(uris9[0]);
      await sleep(1000);
      const back = await record(() => front(uris9[1]));
      const backPaint = await paintOf(back);
      const backBlack = backPaint.map((x) => x.black);
      check(back.length > 0 && Math.max(...backBlack) < DISC, 'while switching back to a chat tab, no frame shows a black disc in the editor area', { frames: back.length, black: backBlack });
      const shownAt = backPaint.findIndex((x) => x.drawn > 500);
      console.log(`  note  switching back: ${back.length} frames; the page shows in frame ${shownAt + 1}${shownAt >= 0 ? `, ${Math.round((back[shownAt].at - back[0].at) * 1000)} ms after the first` : ''}`);
      chat9 = await frameWith(page, '#input', 20000);
      const kept = chat9 ? await chat9.evaluate(() => window.__tabSwitchMark === 9) : false;
      check(kept, 'switching back shows the same page, mark and all');
      if (back.length) keepFrame('09-tab-switch-first-frame', back[0].data, { features: ['switching chat tabs'],
        expect: 'The first frame after switching back to an empty conversation: its tab is in front, and the chat area may still be the plain editor background. No black disc anywhere.' });
      if (shownAt >= 0) keepFrame('09b-tab-switch-page-shown', back[shownAt].data, { features: ['switching chat tabs'],
        expect: 'The first frame that shows the conversation\'s page: model picker and small ring at the top, input box at the bottom. No unstyled controls.' });
      const hiddenText = 'Written while this tab was hidden.';
      await front(uris9[0]);
      await sleep(800);
      const hiddenId = uris9[1].replace(/^opencodeagentplus-session:\//, '');
      const activity = async () => (((await ext('return api.test.conversations();')) || []).find((x) => x.sessionId === hiddenId) || {}).activity;
      await ext('await api.test.send(arg.id, arg.text); return true;', { id: hiddenId, text: `Say: ${hiddenText}` });
      await until(async () => ((await activity()) !== 'stopped' ? true : null), 10000);
      const endedHidden = await until(async () => ((await activity()) === 'stopped' ? true : null), 120000);
      check(!!endedHidden, 'the turn in the hidden tab ends before the tab is shown again');
      await front(uris9[1]);
      chat9 = await frameWith(page, '#input', 20000);
      /* Once in the user message and once in the reply. */
      const late = chat9 ? await until(() => chat9.evaluate((t) => (document.querySelector('#log').textContent.split(t).length - 1 >= 2) || null, hiddenText), 10000) : null;
      check(!!late, 'the hidden tab\'s reply shows when the tab is back in front');
      const opened = await record(() => call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");'), 3000);
      const openedBlack = (await paintOf(opened)).map((x) => x.black);
      check(opened.length > 0 && Math.max(...openedBlack) < DISC, 'a new conversation opens without a black disc in any frame', { frames: opened.length, black: openedBlack });
    }
    await cdp.detach().catch(() => {});

    // 10. Show Logs, saving edited files before a message goes, the new-conversation key in a chat tab, and VS Code
    //     reopening a closed chat tab.
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.showLogs");');
    const logShown = await until(() => call(`return vscode.workspace.textDocuments.some((d) => d.uri.scheme === "output" && decodeURIComponent(d.uri.toString()).includes(arg)) || null;`, ID), 10000);
    check(!!logShown, "Show Logs opens the extension's log in the Output panel");
    const chats10 = await chatUris();
    const folder10 = await call('return vscode.workspace.workspaceFolders[0].uri.fsPath;');
    const unsaved = path.join(folder10, 'autosave-me.txt');
    fs.writeFileSync(unsaved, 'as on disk\n');
    const dirty = await call(`const d = await vscode.workspace.openTextDocument(arg);
      const e = await vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.Two, preview: false });
      await e.edit((b) => b.replace(new vscode.Range(0, 0, d.lineCount, 0), "as in the editor\\n"));
      return d.isDirty;`, unsaved);
    check(dirty === true, 'a file edited in the editor is not saved yet', dirty);
    if (chats10.length) {
      await front(chats10[chats10.length - 1]);
      const chat10 = await frameWith(page, '#input', 20000);
      if (chat10) {
        await chat10.fill('#input', 'Reply with only the words: Sent once the files were saved. Use no tool.');
        await chat10.press('#input', 'Enter');
        await until(() => chat10.evaluate(() => document.querySelector('#log').textContent.includes('Sent once the files were saved.') || null), 20000);
        /* Lets the turn end, denying any request it makes, so that no conversation is still waiting during the later steps. */
        await until(async () => {
          const deny = await chat10.$('#log .permission:not(.settled) button[data-decision="deny"]');
          if (deny && await deny.isVisible()) await deny.click().catch(() => {});
          return (await chat10.evaluate(() => document.body.dataset.status)) === 'idle' ? true : null;
        }, real ? 180000 : 30000, 500);
      }
      const after = await call('const d = vscode.workspace.textDocuments.find((x) => x.uri.fsPath === arg); return { dirty: !!d && d.isDirty };', unsaved);
      check(!after.dirty && fs.readFileSync(unsaved, 'utf8') === 'as in the editor\n', 'sending a message saves the edited file first, so OpenCode reads what the editor shows', after);
      if (process.platform !== 'win32') {
        await front(chats10[chats10.length - 1]);
        await sleep(500);
        const before = (await chatUris()).length;
        await page.keyboard.press('Meta+Shift+Escape');
        const more = await until(async () => ((await chatUris()).length > before ? true : null), 15000);
        check(!!more, 'Meta+Shift+Esc in a chat tab starts a new conversation', { before, after: (await chatUris()).length });
      } else {
        console.log('  note  the new-conversation key is not pressed on Windows, where the Windows key belongs to the system');
      }
      const reopen = chats10[0];
      await call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && x.input.uri.toString() === arg);
        await vscode.window.tabGroups.close(t); return true;`, reopen);
      await until(async () => (!(await chatUris()).includes(reopen) ? true : null), 10000);
      await call('await vscode.commands.executeCommand("workbench.action.reopenClosedEditor"); return true;');
      const back10 = await until(async () => ((await chatUris()).includes(reopen) ? true : null), 15000);
      const page10 = back10 ? await frameWith(page, '#input', 20000) : null;
      check(!!back10 && !!page10, "VS Code's Reopen Closed Editor brings a closed chat tab back with its page", { back: !!back10, page: !!page10 });
    }
    await require('./lib/gap-page').run({ page, call, ext, check, shot, until, sleep, frameWith, real, line });
    await require('./lib/retry').run({ page, call, check, shot, until, sleep, frameWith, real });
    await require('./lib/gap-host').run({ page, call, ext, check, shot, until, sleep, frameWith, real, line, folder: p.folder, out: OUT, chatUris, front, home: p.agentHome });
    await require('./lib/model-groups').run({ page, call, check, until, sleep, shot, frameWith, real });
    await require('./lib/prefill').run({ page, call, ext, check, shot, until, sleep, frameWith, chatUris, front, real });
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
