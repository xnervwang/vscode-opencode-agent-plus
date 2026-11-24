// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The settings OpenCode starts with: newAgent.opencode.path and .askPermissions, and for Amazon Bedrock
 * newAgent.bedrock.profile and .region and an API key kept in VS Code's secret storage only, which reach OpenCode as
 * AWS_PROFILE, AWS_REGION and AWS_BEARER_TOKEN_BEDROCK in its environment. An empty setting adds nothing, so what the
 * user set up in OpenCode or in the environment stays in force. A change starts OpenCode again (backend.restart).
 */
const brand = require('../brand');

const SECRET_KEY = `${brand.prefix}.bedrock.apiKey`;
const SECTION = brand.prefix;
const OUR_WAY = `Or set "${brand.displayName} › Bedrock: Profile" and "Region" in the settings, or run "${brand.displayName}: Set Amazon Bedrock API Key".`;

/*
 * deps:
 *   vscode, secrets      VS Code's API and the extension's SecretStorage
 *   restart(options)     starts OpenCode again with new options
 *   log(line)            optional
 */
function createProviderConfig({ vscode, secrets, restart, log = () => {} }) {
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
    };
  };

  /* What createOpenCode and restart() take. */
  function options() {
    const s = read();
    const env = {};
    if (s.profile) env.AWS_PROFILE = s.profile;
    if (s.region) env.AWS_REGION = s.region;
    if (key) env.AWS_BEARER_TOKEN_BEDROCK = key;
    return { binaryPath: s.binaryPath, permissions: s.permissions, env };
  }

  /* The options without the key's value, to tell whether anything changed and to log. */
  const shape = (o) => JSON.stringify({ ...o, env: Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, k === 'AWS_BEARER_TOKEN_BEDROCK' ? `<${v.length} chars>` : v])) });

  function changed(why) {
    const next = options();
    const now = shape(next);
    if (now === last) return;
    last = now;
    log(`OpenCode settings changed (${why}); it starts again with ${Object.keys(next.env).join(', ') || 'no extra environment'}`);
    Promise.resolve().then(() => restart(next)).catch((e) => log(`restarting OpenCode failed: ${(e && e.message) || e}`));
  }

  /* Reads the key once at activation; `ready` settles when it has been read. */
  const ready = Promise.resolve().then(() => secrets.get(SECRET_KEY)).then((v) => { key = v || ''; }, () => { key = ''; })
    .then(() => { const was = last; last = shape(options()); if (was !== null && was !== last) changed('API key read'); });
  last = shape(options());

  subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${SECTION}.bedrock`) || e.affectsConfiguration(`${SECTION}.opencode`)) changed('settings');
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
      prompt: 'Paste an Amazon Bedrock API key. It is kept in VS Code secret storage on this machine and given to OpenCode as AWS_BEARER_TOKEN_BEDROCK.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (String(v || '').trim() ? null : 'Enter a key.'),
    });
    if (!value || !value.trim()) return false;
    await secrets.store(SECRET_KEY, value.trim());
    vscode.window.showInformationMessage('The Amazon Bedrock API key is saved; OpenCode starts again with it.');
    return true;
  }

  async function clearApiKey() {
    await secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('The Amazon Bedrock API key is removed from this machine.');
  }

  /*
   * What OpenCode can reach, in one message: `status` is bedrockStatus() of src/opencode/index.js, `models` the model
   * list, `found` what detect() gave, or the error it threw.
   */
  function describe({ status, models, found, error }) {
    if (error) return { level: 'error', text: error.message || String(error) };
    const where = found ? `OpenCode ${found.version && found.version.text ? found.version.text : found.version || ''}`.trim() : 'OpenCode';
    if (!status || status.state === 'unknown') {
      return { level: 'info', text: `${where} is installed. It lists its models once a conversation has been opened.` };
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
