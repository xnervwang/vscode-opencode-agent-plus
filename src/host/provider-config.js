// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The settings OpenCode starts with: opencodeAgentPlus.opencode.path, .askPermissions and .environment, and for Amazon
 * Bedrock the settings opencodeAgentPlus.bedrock.profile and .region plus an API key kept only in VS Code's secret
 * storage. OpenCode gets these three as AWS_PROFILE, AWS_REGION and AWS_BEARER_TOKEN_BEDROCK in its environment, over the
 * same names in .environment. An empty setting adds nothing, so what the user set up in OpenCode or in the environment
 * stays in force. A change restarts OpenCode (backend.restart).
 *
 * opencodeAgentPlus.todoList adds `todo` to OPENCODE_FLAGS, which turns on OpenCode 2's experimental todowrite tool.
 * OpenCode reads that variable as names separated by commas, `-name` turning one off; a list that already names todo
 * either way is kept as it is. OpenCode 1 has no such variable and ignores it.
 *
 * opencodeAgentPlus.openCodeModels set to `hide` has OpenCode leave out its own provider (`disabled_providers`), whose
 * free models run on opencode.ai; `auto` and `show` leave OpenCode as it is, and the model lists sort out the rest
 * (src/host/models.js visibleModels).
 */
const brand = require('../brand');

const SECRET_KEY = `${brand.prefix}.bedrock.apiKey`;
/* OpenCode's own provider: its free models, run on opencode.ai. */
const OPENCODE_PROVIDER = 'opencode';
const SECTION = brand.prefix;
const OUR_WAY = `Or set "${brand.displayName} › Bedrock: Profile" and "Region" in the settings, or run "${brand.displayName}: Set Amazon Bedrock API Key".`;

/*
 * deps:
 *   vscode, secrets      VS Code's API and the extension's SecretStorage
 *   restart(options)     backend.restart
 *   log(line)            optional
 *   baseEnv              the environment OpenCode inherits; process.env when left out
 */
function createProviderConfig({ vscode, secrets, restart, log = () => {}, baseEnv = process.env }) {
  let key = '';
  let last = null;
  const subs = [];

  const read = () => {
    const c = vscode.workspace.getConfiguration(SECTION);
    return {
      binaryPath: String(c.get('opencode.path') || '').trim(),
      permissions: c.get('opencode.askPermissions') !== false,
      profile: String(c.get('bedrock.profile') || '').trim(),
      region: String(c.get('bedrock.region') || '').trim(),
      environment: c.get('opencode.environment'),
      todoList: c.get('todoList') !== false,
      openCodeModels: String(c.get('openCodeModels') || 'auto'),
    };
  };

  /* Names a shell would accept, with string values; anything else in the setting is left out and logged once. */
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let skipped = '';
  const extraEnv = (value) => {
    const out = {};
    const bad = [];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (NAME.test(k) && typeof v === 'string') out[k] = v;
        else bad.push(k);
      }
    }
    const note = bad.join(', ');
    if (note && note !== skipped) log(`opencode.environment: left out ${note} (names must be letters, digits and _, and values strings)`);
    skipped = note;
    return out;
  };

  /* OPENCODE_FLAGS with todo in it. */
  const withTodo = (value) => {
    const names = String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!names.some((x) => x === 'todo' || x === '-todo')) names.push('todo');
    return names.join(',');
  };

  /* What createOpenCode and restart() take. */
  function options() {
    const s = read();
    const env = extraEnv(s.environment);
    if (s.todoList) env.OPENCODE_FLAGS = withTodo(env.OPENCODE_FLAGS !== undefined ? env.OPENCODE_FLAGS : baseEnv && baseEnv.OPENCODE_FLAGS);
    if (s.profile) env.AWS_PROFILE = s.profile;
    if (s.region) env.AWS_REGION = s.region;
    if (key) env.AWS_BEARER_TOKEN_BEDROCK = key;
    return { binaryPath: s.binaryPath, permissions: s.permissions, env, disabledProviders: s.openCodeModels === 'hide' ? [OPENCODE_PROVIDER] : [] };
  }

  /* The options with the key's value replaced by its length, for comparing and logging. */
  const shape = (o) => JSON.stringify({ ...o, env: Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, k === 'AWS_BEARER_TOKEN_BEDROCK' ? `<${v.length} chars>` : v])) });

  function changed(why) {
    const next = options();
    const now = shape(next);
    if (now === last) return;
    last = now;
    log(`OpenCode settings changed (${why}); restarting it with ${Object.keys(next.env).join(', ') || 'no extra environment'}`);
    Promise.resolve().then(() => restart(next)).catch((e) => log(`restarting OpenCode failed: ${(e && e.message) || e}`));
  }

  /* The key is read once at activation; `ready` settles then. */
  const ready = Promise.resolve().then(() => secrets.get(SECRET_KEY)).then((v) => { key = v || ''; }, () => { key = ''; })
    .then(() => { const was = last; last = shape(options()); if (was !== null && was !== last) changed('API key read'); });
  last = shape(options());

  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${SECTION}.bedrock`) || e.affectsConfiguration(`${SECTION}.opencode`) || e.affectsConfiguration(`${SECTION}.todoList`)
      || e.affectsConfiguration(`${SECTION}.openCodeModels`)) changed('settings');
  }));
  if (typeof secrets.onDidChange === 'function') {
    subs.push(secrets.onDidChange((e) => {
      if (!e || e.key !== SECRET_KEY) return;
      Promise.resolve(secrets.get(SECRET_KEY)).then((v) => { key = v || ''; changed('API key'); }, () => {});
    }));
  }

  async function setApiKey() {
    const value = await vscode.window.showInputBox({
      title: 'Amazon Bedrock API key',
      prompt: 'Paste an Amazon Bedrock API key. It is kept in VS Code\'s secret storage on your computer and given to OpenCode as AWS_BEARER_TOKEN_BEDROCK.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (String(v || '').trim() ? null : 'Enter a key.'),
    });
    if (!value || !value.trim()) return false;
    await secrets.store(SECRET_KEY, value.trim());
    vscode.window.showInformationMessage('Amazon Bedrock API key saved. OpenCode is restarting to use it.');
    return true;
  }

  async function clearApiKey() {
    await secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Amazon Bedrock API key removed from this machine.');
  }

  /*
   * The Test Connection report. `status` is bedrockStatus() of src/opencode/index.js, `found` what detect() gave, or
   * `error` what it threw.
   */
  function describe({ status, models, found, error }) {
    if (error) return { level: 'error', text: error.message || String(error) };
    const where = found ? `OpenCode ${found.version && found.version.text ? found.version.text : found.version || ''}`.trim() : 'OpenCode';
    if (!status || status.state === 'unknown') {
      return { level: 'info', text: `${where} is installed. Its models show up once you open a conversation.` };
    }
    const bedrock = status.models || 0;
    if (status.state === 'listed') return { level: 'info', text: `${where} is connected: ${models.length} models, ${bedrock} of them on Amazon Bedrock.` };
    if (status.state === 'authFailed') return { level: 'error', text: `Amazon Bedrock refused the credentials${status.error ? `: ${status.error}` : ''}.`, detail: `${status.help}\n${OUR_WAY}` };
    return { level: 'warning', text: `${where} lists ${models.length} models, none on Amazon Bedrock.`, detail: `${status.help}\n${OUR_WAY}` };
  }

  async function show(d) {
    const how = 'How to fix';
    const say = d.level === 'error' ? vscode.window.showErrorMessage : d.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await say(d.text, ...(d.detail ? [how] : []));
    if (pick === how) await vscode.window.showInformationMessage(d.text, { modal: true, detail: d.detail });
  }

  return {
    options,
    ready,
    setApiKey,
    clearApiKey,
    describe,
    show,
    dispose() { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } },
  };
}

module.exports = { createProviderConfig, SECRET_KEY, OUR_WAY };
