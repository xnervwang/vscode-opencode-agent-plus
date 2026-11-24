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
const OUT = path.resolve(flag('--out', path.join(os.tmpdir(), `new-agent-ui-${Date.now()}`)));
const AGENT_PLUS = flag('--agent-plus', '');
const BACKEND = flag('--backend', 'fake');
const OPENCODE = flag('--opencode');
const MODEL = flag('--model', BACKEND === 'fake' ? 'fake/fake-small' : 'amazon-bedrock/us.xai.grok-4.7');
const DEPS = flag('--deps');
const FONTS = flag('--fonts');
const ID = 'xnervwang.new-agent';

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

/* OpenCode processes still running with this run's state folder in their environment (2.x's acp starts a background
   service that outlives it); they are stopped. Linux only, where /proc shows another process's environment. */
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

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'new-agent-ui-')));
  const shots = path.join(OUT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const p = { exts: path.join(root, 'exts'), user: path.join(root, 'user'), folder: path.join(root, 'ws'), control: path.join(root, 'ctl'),
    home: path.join(root, 'home'), agentHome: path.join(root, 'agent-home') };
  for (const d of Object.values(p)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(p.folder, 'README.md'), '# Demo project\n');
  fs.writeFileSync(path.join(p.folder, 'notes.txt'), 'Some notes.\n');
  fs.mkdirSync(path.join(p.folder, 'src'));
  fs.writeFileSync(path.join(p.folder, 'src', 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  console.log(`temporary root ${root}; results in ${OUT}`);

  const vsix = path.join(root, 'new-agent.vsix');
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
  const env = cleanEnv(real ? '' : p.home, {
    NEW_AGENT_HOME: p.agentHome, NEW_AGENT_TEST_CONTROL: '1', ...xdgEnv, ...(FONTS ? { FONTCONFIG_FILE: path.resolve(FONTS) } : {}),
    ...(real ? {} : { NEW_AGENT_TEST_BACKEND: path.join(HERE, 'fake-backend.js') }),
  });
  if (real) for (const k of Object.keys(env)) if (/^AWS_/.test(k)) delete env[k];
  const code = cliOf(EXE);
  for (const ext of [AGENT_PLUS, vsix]) {
    const r = code(['--install-extension', ext, `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`, '--force'], env);
    if (r.status !== 0) throw new Error(`installing ${ext} failed: ${r.out}`);
  }
  console.log(code(['--list-extensions', '--show-versions', `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`], env).out);
  writeSettings(p.user, { 'newAgent.model': MODEL, ...(OPENCODE ? { 'newAgent.opencode.path': OPENCODE } : {}),
    ...(real ? { 'newAgent.bedrock.profile': 'self', 'newAgent.bedrock.region': 'us-east-1' } : {}) });

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
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    steps.push({ name, features: features || [name], expect, unchanged, image: path.basename(image), full: path.basename(full),
      previous: previous ? path.basename(previous) : null, width: size.width, height: size.height, log: [], ...(note ? { note } : {}) });
    previous = full;
    fs.writeFileSync(path.join(shots, 'look.json'), JSON.stringify(steps, null, 2));
    void frame;
  };
  const ext = (body, arg, ms) => call(`const e = vscode.extensions.getExtension(${JSON.stringify(ID)}); const api = e.isActive ? e.exports : await e.activate(); ${body}`, arg, ms);

  try {
    await w.hostUp();
    await until(() => ext('return !!(api && api.test);'), 60000);

    // 1. The activity bar icon and the Conversations view.
    const icon = await page.waitForSelector('.activitybar .action-item a[aria-label^="New Agent"], .activitybar .action-item [aria-label^="New Agent"]', { timeout: 30000 }).catch(() => null);
    check(!!icon, 'the activity bar has the New Agent icon');
    if (icon) await icon.click();
    const viewOk = await until(() => page.evaluate(() => [...document.querySelectorAll('.pane-header')].some((h) => /Conversations/i.test(h.textContent))), 20000);
    check(viewOk, 'the Conversations view shows in the side bar');
    await shot('01-activity-bar', { features: ['activity bar icon', 'Conversations view'],
      expect: 'The activity bar on the far left has the New Agent icon (a speech bubble with three dots) selected; the side bar shows the NEW AGENT container with a Conversations view, empty or with a hint.',
      part: '#workbench\\.parts\\.sidebar' });

    // 2. A new conversation opens a chat tab.
    const before = Date.now();
    await page.click('.pane-header [aria-label="New Conversation"], .pane-header .codicon-add').catch(async () => { await call('return vscode.commands.executeCommand("newAgent.newConversation");'); });
    const tab = await until(() => call(`const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputCustom ? { viewType: t.input.viewType, uri: t.input.uri.toString(), label: t.label } : null;`), 30000);
    check(tab && tab.viewType === 'newAgent.chat' && /^newagent-session:\/ses_/.test(tab.uri), 'a new conversation opens a newAgent.chat tab of newagent-session:/<id>', tab);
    const chat = await frameWith(page, '#input', 30000);
    check(!!chat, 'the chat page loaded in the tab');
    await shot('02-new-conversation', { features: ['new conversation', 'chat editor tab'],
      expect: `An editor tab is open with the chat page: a header with a model selector showing ${real ? 'the Grok model' : 'Fake Small'}, an empty message area, and a message box at the bottom with a Send button.`,
      part: '#workbench\\.parts\\.editor' });

    let sessionId = tab ? tab.uri.replace(/^newagent-session:\//, '') : '';
    if (!real) {
      // 3. A message gets a reply; the permission request is answered from the page.
      if (chat) {
        await chat.fill('#input', 'Hello there, please fix the failing test');
        await chat.press('#input', 'Enter');
        const asked = await until(() => chat.$('button[data-decision="allowOnce"]'), 30000);
        check(!!asked, 'the reply streams in and stops at a permission request with Allow once');
        const waiting = await until(() => ext('return api.test.conversations().find((c) => c.activity === "waiting");'), 10000);
        check(!!waiting, 'the conversation is waiting for the user while the request is open', waiting);
        await shot('03-permission', { features: ['streamed reply', 'tool cards', 'permission request'],
          expect: 'The user message "Hello there, please fix the failing test", a reasoning block, a reply that starts "I\'ll look at the test first.", a read_file tool card with its result, and an edit_file card asking for permission with Allow once, Allow for this conversation, Deny and View diff buttons.',
          part: '#workbench\\.parts\\.editor' });
        if (asked) await asked.click();
        const done = await until(() => chat.evaluate(() => document.body.dataset.status === 'idle' && /subtracted instead of adding/.test(document.getElementById('log').textContent)), 30000);
        check(done, 'after Allow once the turn finishes with its last reply');
        await shot('04-reply', { features: ['reply', 'reply figures'],
          expect: 'The edit_file card says it was allowed once, and the reply ends with "Fixed: sum subtracted instead of adding." and a code block; below the reply a line of figures such as a duration, ctx and the model name.',
          part: '#workbench\\.parts\\.editor' });
      }

    } else {
      // 3 (real model). A request that needs a tool: the tool call, the approval, the answer.
      const figures = () => chat.evaluate(() => document.querySelectorAll('#log .figures').length);
      const status = () => chat.evaluate(() => document.body.dataset.status);
      /* Sends `text` and waits for its turn to end, answering Allow once to every permission request on the way. */
      const turn = async (text, name) => {
        const before = await figures();
        await chat.fill('#input', text);
        await chat.press('#input', 'Enter');
        await until(async () => (await status()) !== 'idle' || (await figures()) > before, 60000, 200);
        let approved = 0;
        const end = Date.now() + 300000;
        while (Date.now() < end) {
          /* An answered card keeps its buttons, hidden. */
          let button = null;
          for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { button = b; break; }
          if (button) {
            if (!approved) {
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
        await shot('04-answer', { features: ['answer', 'reply figures'],
          expect: 'The tool card shows its result and the permission card says allowed; the model answer lists the files of the folder (README.md, notes.txt, src); under it a figures line with a duration, ctx, maybe a cost, and the model name grok.',
          part: '#workbench\\.parts\\.editor' });
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
    await call('await vscode.commands.executeCommand("workbench.view.extension.newAgent"); return true;');
    const inList = await until(async () => page.evaluate((t) => document.getElementById('workbench.parts.sidebar').textContent.includes(t), await titleNow()), 30000);
    check(inList, 'the Conversations view lists the conversation');
    await shot('06-sessions', { features: ['session list'],
      expect: 'The NEW AGENT Conversations view lists one row with the conversation title and a speech-bubble icon (a relative time such as "now" may be cut off by a long title).',
      part: '#workbench\\.parts\\.sidebar' });

    // 6. A reload brings the tab back with its history.
    await w.reload();
    await until(() => ext('return !!(api && api.test);'), 60000);
    const back = await until(() => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "newAgent.chat").map((t) => t.input.uri.toString());`), 30000);
    check(Array.isArray(back) && back.includes(`newagent-session:/${sessionId}`), 'after a reload the chat tab is back for the same conversation', back);
    const again = await frameWith(page, '#input', 30000);
    const history = again && await until(() => again.evaluate((re) => new RegExp(re).test(document.getElementById('log').textContent), real ? '列出工作目录下的文件' : 'subtracted instead of adding'), 30000);
    check(!!history, 'the restored tab shows the conversation so far');
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
