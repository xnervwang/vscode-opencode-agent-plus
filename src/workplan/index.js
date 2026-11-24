// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The extension's side of the work plan on OpenCode: puts the OpenCode plugin (opencode-plugin/agent-work-plan) and
 * the shared Python scripts where a running OpenCode keeps finding them, and says what to add to OpenCode's launch.
 * No vscode API here.
 *
 * Copies go under paths.root() rather than being used from the extension's folder: that folder is named by version
 * and removed on update, while an OpenCode another window started before the update still loads the plugin and runs
 * the scripts from where it was told. (OpenCode 2's `acp` runs a private server that ends with it; it does not use the
 * shared background service.)
 */
const fs = require('fs');
const path = require('path');
const url = require('url');
const paths = require('../paths');

const PLUGIN_ID = 'agent-work-plan';
/* An OpenCode session id, on 1.x and 2.x alike; the plugin and the shared scripts name plans by it. */
const SESSION_ID = /^ses_[0-9A-Za-z]{8,64}$/;
const NEEDS_V2 = 'The work plan needs OpenCode 2.';
/* What the shared hooks keep for one conversation in the plans folder, <session id><suffix>: the plan and the *_SUFFIX
   files of plan_common.py. */
const SIDE_SUFFIXES = Object.freeze(['.json', '.turn', '.nudged', '.settled', '.offered', '.watermark', '.tz', '.images-told',
  '.compacted', '.briefed', '.injected']);
/* What this extension itself keeps beside a plan: the latest reply for a steward (src/host/reply-file.js). */
const OWN_SUFFIXES = Object.freeze(['.reply.json']);

/* The plugin as it ships in this extension. */
function sourceFile() {
  return path.join(__dirname, '..', '..', 'opencode-plugin', PLUGIN_ID, 'index.js');
}

/* The folder OpenCode is told to load the plugin from. */
function pluginDir(root = paths.root()) {
  return path.join(root, 'opencode-plugin', PLUGIN_ID);
}

/* The shared scripts' folder beside the plugin: what OPENCODE_PLUS_HOOKS_DIR names. */
function scriptsDir(root = paths.root()) {
  return path.join(pluginDir(root), 'hooks');
}

/* Writes `data` to `file` unless it already holds exactly that; true when it wrote. */
function writeIfDifferent(file, data) {
  try {
    if (fs.readFileSync(file).equals(data)) return false;
  } catch (_) { /* absent */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
  return true;
}

/* Copies the plugin into pluginDir(root). Returns { dir, file, changed }. Throws when it cannot write. */
function installPlugin({ root = paths.root(), source = sourceFile() } = {}) {
  const dir = pluginDir(root);
  const file = path.join(dir, 'index.js');
  const changed = writeIfDifferent(file, fs.readFileSync(source));
  return { dir, file, changed };
}

/*
 * Copies the shared scripts (every *.py file directly in `source`) into scriptsDir(root). Files only there are left:
 * the plugin runs scripts by name, and launcher.json there is written by whoever finds Python. Returns
 * { dir, changed: [names written] }.
 */
function installScripts({ root = paths.root(), source }) {
  const dir = scriptsDir(root);
  const changed = [];
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    if (!name.endsWith('.py') || !fs.statSync(from).isFile()) continue;
    if (writeIfDifferent(path.join(dir, name), fs.readFileSync(from))) changed.push(name);
  }
  return { dir, changed };
}

function majorOf(version) {
  if (typeof version === 'number') return version;
  return version && typeof version.major === 'number' ? version.major : 0;
}

/* `dir`, and its real path when a symbolic link leads to it, for a folder that may not exist yet. */
function spellings(dir) {
  let at = dir;
  let rest = '';
  for (;;) {
    try {
      const real = path.join(fs.realpathSync(at), rest);
      return real === dir ? [dir] : [dir, real];
    } catch (_) {
      const up = path.dirname(at);
      if (up === at) return [dir];
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  }
}

/*
 * The inline OpenCode configuration the work plan needs, for OpenCode `version` ({ major } or a number), to be merged
 * over the launch's own (src/opencode acpLaunch `config`: arrays are appended there, so these rules come last and win).
 * OpenCode 2 takes the plugin's folder under `plugins`, and two rules that let the model read the plans folder, which
 * is outside every project, without asking: the plan text tells it to read the plan after a compaction. Writing there
 * still asks; the plan tools write without going through a permission. OpenCode matches these rules against canonical
 * paths, so a folder reached through a symbolic link is listed under both names. OpenCode 1 gets a file URL under
 * `plugin`, where the plugin only logs that it needs OpenCode 2.
 */
function configFor(version, { dir = pluginDir(), plans = planDir() } = {}) {
  if (majorOf(version) >= 2) {
    const permissions = [];
    for (const p of spellings(plans)) {
      permissions.push({ action: 'external_directory', resource: `${p}/*`, effect: 'allow' },
        { action: 'read', resource: `${p}/*`, effect: 'allow' });
    }
    return { plugins: [dir], permissions };
  }
  return { plugin: [url.pathToFileURL(path.join(dir, 'index.js')).href] };
}

/* What the plugin reads from its environment. */
function pluginEnv({ hooksDir = scriptsDir(), home = paths.root() } = {}) {
  return { OPENCODE_PLUS_HOOKS_DIR: hooksDir, OPENCODE_PLUS_HOME: home };
}

/* Whether conversations on OpenCode `version` keep a work plan; `message` is what to tell the user when they do not. */
function support(version) {
  const major = majorOf(version);
  if (major >= 2) return { workPlan: true, message: '' };
  const named = version && version.text ? ` This is OpenCode ${version.text}.` : '';
  return { workPlan: false, message: `${NEEDS_V2}${named} Update OpenCode to keep a work plan in these conversations.` };
}

/* For the Agent Plus source: the folder of plan files, and one conversation's plan (null for an id of another shape). */
function planDir() {
  return paths.plansDir();
}

function planPath(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? path.join(planDir(), `${sessionId}.json`) : null;
}

/*
 * When the user deletes a conversation: its plan, the files the hooks and this extension keep beside it and its rows
 * moved to closed/.
 * Agent Plus only reads the plans folder, so nothing else clears them. Only names built from a session id of OpenCode's
 * shape are touched. Returns the names removed, relative to `dir`.
 */
function removePlan(sessionId, dir = planDir()) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  const names = [...SIDE_SUFFIXES, ...OWN_SUFFIXES].map((s) => `${sessionId}${s}`).concat(path.join('closed', `${sessionId}.json`));
  const removed = [];
  for (const name of names) {
    try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch (_) { /* not there */ }
  }
  return removed;
}

/*
 * The folder the shared hooks name for one conversation's images (plan_agent.py scratch_dir: <root>/scratch/<id>), or
 * null for an id of another shape. Nothing creates it here; the model does when it first saves an image.
 */
function scratchDir(sessionId, root = paths.root()) {
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? path.join(root, 'scratch', sessionId) : null;
}

/*
 * When the user deletes a conversation: its scratch folder and everything in it, which nothing else clears. A symbolic
 * link there is removed, not followed. Returns whether there was something to remove.
 */
function removeScratch(sessionId, root = paths.root()) {
  const dir = scratchDir(sessionId, root);
  if (!dir) return false;
  try { fs.lstatSync(dir); } catch (_) { return false; }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/*
 * Tells the plugin which Python to start, in launcher.json beside the scripts: `python` is what
 * src/shared/python-runtime.js findPython gave. Its full path is written, since OpenCode starts it without a shell.
 * Returns whether the file changed.
 */
function writeLauncher(python, dir = scriptsDir()) {
  if (!python || !python.executable) return false;
  return writeIfDifferent(path.join(dir, 'launcher.json'), Buffer.from(`${JSON.stringify({ row: [python.executable] })}\n`));
}

module.exports = {
  PLUGIN_ID,
  SESSION_ID,
  sourceFile,
  pluginDir,
  scriptsDir,
  installPlugin,
  installScripts,
  configFor,
  pluginEnv,
  support,
  planDir,
  planPath,
  writeLauncher,
  removePlan,
  scratchDir,
  removeScratch,
  SIDE_SUFFIXES,
  OWN_SUFFIXES,
};
