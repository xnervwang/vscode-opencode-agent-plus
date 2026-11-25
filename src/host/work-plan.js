// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan in this window. The plugin and the shared scripts are copied to where OpenCode finds them
 * (src/workplan).
 *
 *   config.json   { enabled, brief, tellTimeZone, replyImages } from Agent Plus's token mode (src/shared/token-mode.js):
 *                 Interface turns them off and unloads the plugin, Essential keeps the plan and the time-zone
 *                 note without the brief, All keeps all three, and in Custom opencodeAgentPlus.workPlan,
 *                 opencodeAgentPlus.conversationBrief and opencodeAgentPlus.tellOpenCodeYourTimeZone decide. replyImages is on outside
 *                 Interface: the chat page draws the local images a reply links. Written at activation and on every change of those
 *                 settings; the plugin reads it at each user message, so a change applies from the next one.
 *   launcher.json the Python found (src/shared/python-runtime.js). With none, the plugin adds nothing, and a row above
 *                 the plan says so; on Windows python.org's build is offered once per machine and Python version
 *                 (src/shared/python-offer.js).
 *   OpenCode 1    keeps no plan. The user hears it once per workspace and OpenCode version (a reload starts a new
 *                 extension host, so memory alone would say it again), and a row above the plan keeps showing it.
 *
 * In Restricted Mode nothing is copied or written until the workspace is trusted.
 */
const fs = require('fs');
const path = require('path');
const brand = require('../brand');
const workplan = require('../workplan');
const tokenMode = require('../shared/token-mode');
const hookSettings = require('../shared/hook-settings');
const runtime = require('../shared/python-runtime');
const pythonOffer = require('../shared/python-offer');

/* By the token mode's feature id. */
const KEYS = Object.freeze({ workPlan: `${brand.prefix}.workPlan`, conversationBrief: `${brand.prefix}.conversationBrief`,
  timeZone: `${brand.prefix}.tellOpenCodeYourTimeZone` });
const DOWNLOAD = `${brand.prefix}.downloadPython`;
const RETRY = `${brand.prefix}.findPython`;
const WITHOUT = 'Until then the plugin adds nothing to the conversations.';
const TOLD_KEY = `${brand.prefix}.toldWorkPlanNeedsOpenCode2`;

/*
 * deps:
 *   vscode, extensionPath, storage   the API, this extension's folder, its global storage folder (the marker in config.json)
 *   tell(text)                       shows a message
 *   memo                             optional Memento (workspaceState) remembering which OpenCode version was told about
 *   log(line)                        optional
 *   find, download                   python-runtime's, replaceable in tests
 */
function createWorkPlan({ vscode, extensionPath, storage, memo = null, tell = () => {}, log = () => {}, find = runtime.findPython, download = runtime.download }) {
  const noticed = new vscode.EventEmitter();
  const subs = [noticed];
  let installProblem = null;
  let pythonProblem = null;
  let python = null;
  let told = false;
  let oldOpenCode = null;
  let started = false;
  const trusted = () => vscode.workspace.isTrusted !== false;

  /* Whether feature `id` of the token mode runs now: outside Custom the mode's table decides, in Custom our own setting
     does. */
  function runs(id) {
    const key = KEYS[id];
    if (tokenMode.switchOf(key)) return tokenMode.effective(vscode, key) !== false;
    const by = tokenMode.onIn(tokenMode.modeNow(vscode), id);
    if (by !== null) return by;
    const [section, name] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    return vscode.workspace.getConfiguration(section).get(name, true) !== false;
  }

  const values = () => ({ enabled: runs('workPlan'), brief: runs('conversationBrief'), tellTimeZone: runs('timeZone'),
    replyImages: !tokenMode.unloadsPlugin(tokenMode.modeNow(vscode)) });

  function writeSettings() {
    if (!trusted()) return false;
    try {
      const wrote = hookSettings.writeHookSettings(workplan.planDir(), values(), { marker: storage });
      if (wrote) log(`work plan settings: ${JSON.stringify(values())} (${tokenMode.labelOf(tokenMode.modeNow(vscode))})`);
      return wrote;
    } catch (e) {
      log(`writing the work plan settings failed: ${e.message}`);
      return false;
    }
  }

  function install() {
    try {
      const p = workplan.installPlugin();
      const s = workplan.installScripts({ source: path.join(extensionPath, 'opencode-plugin', workplan.PLUGIN_ID, 'hooks') });
      if (p.changed || s.changed.length) log(`work plan plugin copied to ${p.dir}${s.changed.length ? ` with ${s.changed.length} scripts` : ''}`);
      installProblem = null;
    } catch (e) {
      installProblem = { step: 'Copying the work plan plugin', said: e.message };
      log(`${installProblem.step} failed: ${e.message}`);
    }
    noticed.fire();
  }

  async function findPython() {
    const tried = runtime.pythons(storage);
    let found = null;
    try { found = await find(undefined, tried); } catch (e) { log(`looking for Python failed: ${e.message}`); }
    python = found;
    if (found) {
      try { workplan.writeLauncher(found); } catch (e) { log(`writing launcher.json failed: ${e.message}`); }
      log(`work plan Python: ${found.executable} (${found.version})`);
      pythonProblem = null;
    } else {
      pythonProblem = pythonOffer.notice(tried, { download: DOWNLOAD, install: RETRY, without: WITHOUT });
      log(`work plan Python: none found (tried ${tried.map((l) => l.join(' ')).join(', ')})`);
    }
    noticed.fire();
    return found;
  }

  /* One download at a time in this window. */
  const getPython = pythonOffer.single(() => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading Python ${runtime.VERSION} from python.org` },
    async () => {
      const r = await download(undefined, { userAgent: brand.packageName });
      log(`python download: ${r.said}`);
      if (!r.ok) { Promise.resolve(vscode.window.showErrorMessage(`${brand.displayName}: downloading Python failed. ${r.said}`)).catch(() => {}); return false; }
      await findPython();
      tell(`${brand.displayName}: Python is installed; the work plan starts with the next message.`);
      return true;
    }));

  async function start() {
    if (started || !trusted()) return;
    started = true;
    install();
    writeSettings();
    const found = await findPython();
    if (!found) {
      await pythonOffer.offer({ ask: (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons), get: getPython })
        .catch((e) => log(`asking whether to download Python failed: ${e.message}`));
    }
  }

  subs.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(tokenMode.SETTING) || Object.values(KEYS).some((k) => e.affectsConfiguration(k))) writeSettings();
    }),
    tokenMode.warnOutsideCustom(vscode, Object.values(KEYS), { who: brand.displayName, log }),
    vscode.commands.registerCommand(DOWNLOAD, async () => {
      const pick = await vscode.window.showInformationMessage(`Download Python ${runtime.VERSION} from python.org?`,
        { modal: true, detail: `11 MB, saved in ${runtime.home()}.` }, 'Download');
      return pick === 'Download' ? getPython() : false;
    }),
    vscode.commands.registerCommand(RETRY, () => findPython()),
  );
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') subs.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { start(); }));

  return {
    start,
    writeSettings,
    values,
    findPython,
    /* Adds the plugin's environment, its inline configuration and each conversation's folder for images (written
       without asking) to the options OpenCode starts with. Only while the plugin is in place: it is not copied in
       Restricted Mode, nor when copying failed. */
    launch(options) {
      const o = options || {};
      if (!fs.existsSync(path.join(workplan.pluginDir(), 'index.js'))) return { ...o, quietFolder: null };
      return { ...o, env: { ...(o.env || {}), ...workplan.pluginEnv() }, config: (line) => workplan.configFor(line),
        quietFolder: (id) => workplan.scratchDir(id) };
    },
    brief() { const v = values(); return v.enabled && v.brief; },
    /* `version` is what detect() found. */
    checkVersion(version) {
      const s = workplan.support(version);
      const text = String((version && version.text) || (version && version.major) || version || '');
      const was = oldOpenCode;
      oldOpenCode = s.workPlan ? null : { text, message: s.message };
      if ((was && was.text) !== (oldOpenCode && oldOpenCode.text)) noticed.fire();
      if (s.workPlan || told) return s;
      told = true;
      log(s.message);
      let seen = '';
      try { seen = memo ? memo.get(TOLD_KEY, '') : ''; } catch (_) { /* not remembered */ }
      if (seen === text) return s;
      tell(s.message);
      try { if (memo) Promise.resolve(memo.update(TOLD_KEY, text)).catch(() => {}); } catch (_) { /* told again next time */ }
      return s;
    },
    planNotice() {
      if (oldOpenCode) {
        return { title: 'Work plans need OpenCode 2', description: oldOpenCode.text ? `OpenCode ${oldOpenCode.text} is in use` : 'click to choose another OpenCode',
          detail: `${oldOpenCode.message} Click to set the OpenCode this extension starts.`, command: 'workbench.action.openSettings', arguments: [`${brand.prefix}.opencode.path`] };
      }
      if (installProblem) {
        return { title: 'The work plan plugin is not in place', description: 'reload the window to try again',
          detail: `${installProblem.step} failed: ${installProblem.said} ${WITHOUT}`, command: 'workbench.action.reloadWindow', arguments: [] };
      }
      return pythonProblem;
    },
    onDidChangeNotice: noticed.event,
    get python() { return python; },
    dispose() { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } },
  };
}

module.exports = { createWorkPlan, KEYS, DOWNLOAD, RETRY, TOLD_KEY };
