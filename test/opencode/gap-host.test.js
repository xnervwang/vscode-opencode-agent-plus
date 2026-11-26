// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Tests for the OpenCode side of connecting a provider (the sign-in's command line, the auth methods initialize gives) and of
 * forking from a message (session.fork through /api, its reply as 2.4.1 printed it), and the model list read again
 * after a restart.
 */
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode } = require('../../src/opencode');
const login = require('../../src/opencode/login');
const { fakeStarter } = require('./fake-agent');

const V1 = { major: 1, minor: 19, patch: 6, text: '1.19.6' };
const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const CWD = '/work/project';
const ORIGINAL = 'ses_df2534a3cffeV5DpIbep0DaQLs';
const FORKED = 'ses_dedf9bb86ffeQWHYoj0gKnGLyB';
const MSG = 'msg_212056586001Ea5A7Nx3gOBOG4';
/* What `opencode api session.fork --param sessionID=… -d {"before":…} --standalone` printed on 2.4.1. */
const FORK_REPLY = JSON.stringify({ data: { id: FORKED, fork: { sessionID: ORIGINAL, boundary: { type: 'before', messageID: MSG } },
  projectID: '5a6e53175b4f66301b9dec988d3529719c482119', model: { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', providerID: 'amazon-bedrock', variant: 'default' },
  cost: 0, time: { created: 1795598730412, updated: 1795598730412 }, title: 'ALPHA reply instruction (fork #1)', location: { directory: CWD } } });

function setup(t, version, reply = () => [null, '', '']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-gaphost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter('v2-rewind.jsonl');
  const calls = [];
  const execFile = (file, args, opts, cb) => { calls.push({ file, args, opts }); const [err, out, errOut] = reply(args); cb(err, out, errOut); };
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version }), startAcp: starter.start, idleStopMs: 0, execFile, exportWaitMs: 300,
    env: { AWS_PROFILE: 'self', OPENCODE_AGENT_PLUS_HOME: '/x' } });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents, calls };
}

test('the sign-in runs the OpenCode found, with --standalone on 2.x, OpenCode\'s own arguments and the environment', () => {
  const found = { path: '/opt/oc/bin/opencode', version: V2 };
  const env = { AWS_PROFILE: 'self', AWS_REGION: 'us-east-1', OPENAI_BASE_URL: 'https://example.test' };
  assert.deepEqual(login.loginLaunch({ found, env }), {
    shellPath: '/opt/oc/bin/opencode', shellArgs: ['auth', 'login', '--standalone'], env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: '1' } });
  assert.deepEqual(login.loginLaunch({ found: { path: '/usr/bin/opencode', version: V1 } }).shellArgs, ['auth', 'login'], '1.x has no --standalone');
  const methods = [{ id: 'opencode-login', _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'], label: 'OpenCode Login' } } }];
  const l = login.loginLaunch({ found, env, authMethods: methods });
  assert.equal(l.shellPath, '/opt/oc/bin/opencode', 'never the opencode on PATH that the method names');
  assert.deepEqual(l.shellArgs, ['auth', 'login', '--standalone']);
  assert.deepEqual(login.terminalArgs([{ id: 'x', _meta: { 'terminal-auth': { args: ['auth', 'login', 'anthropic'] } } }]), ['auth', 'login', 'anthropic']);
  assert.deepEqual(login.terminalArgs([{ id: 'x', _meta: { 'terminal-auth': { args: [1] } } }]), ['auth', 'login'], 'non-string arguments are ignored');
  assert.throws(() => login.loginLaunch({ found: null }), (e) => e.code === 'notFound');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, undefined, 'the caller\'s object is left as it was');
});

test('info() includes the auth methods from initialize', async (t) => {
  const { oc } = setup(t, V2);
  await oc.openSession(ORIGINAL, { cwd: CWD });
  assert.deepEqual(oc.info().authMethods.map((m) => m.id), ['opencode-login']);
});

test('2.x: forkBefore asks /api session.fork for the history before the message, and the copy is a root conversation', async (t) => {
  const { oc, calls } = setup(t, V2, (args) => (args.includes('session.fork') ? [null, FORK_REPLY, ''] : [new Error('no'), '', 'no']));
  assert.equal(oc.canForkBefore(), true);
  const changed = [];
  oc.onDidChangeSessions((e) => changed.push(e.sessionId));
  const f = await oc.forkBefore(ORIGINAL, MSG);
  assert.deepEqual(f, { id: FORKED, cwd: CWD, title: 'ALPHA reply instruction (fork #1)' });
  const call = calls.find((c) => c.args.includes('session.fork'));
  assert.deepEqual(call.args, ['api', 'session.fork', '--param', `sessionID=${ORIGINAL}`, '-d', JSON.stringify({ before: MSG }), '--standalone']);
  assert.equal(call.opts.env.AWS_PROFILE, 'self', 'with the environment OpenCode starts with');
  assert.equal(oc.isChild(FORKED), false, 'listed with the other conversations');
  assert.ok(changed.includes(FORKED));
  await assert.rejects(oc.forkBefore(ORIGINAL, 'not a message'), (e) => e.code === 'badRequest');
  await assert.rejects(oc.forkBefore('not an id!', MSG), (e) => e.code === 'badRequest');
});

test('forkBefore passes on OpenCode\'s error when the message is not there, and needs OpenCode 2', async (t) => {
  const notFound = JSON.stringify({ _tag: 'MessageNotFoundError', sessionID: ORIGINAL, messageID: 'msg_nopenopenope', message: 'Message not found: msg_nopenopenope' });
  const { oc } = setup(t, V2, () => [Object.assign(new Error('Command failed'), { code: 1 }), notFound, 'HTTP 404 Not Found']);
  await assert.rejects(oc.forkBefore(ORIGINAL, 'msg_nopenopenope'), (e) => e.code === 'forkFailed' && /Message not found/.test(e.message));
  const old = setup(t, V1);
  assert.equal(old.oc.canForkBefore(), false);
  await assert.rejects(old.oc.forkBefore(ORIGINAL, MSG), (e) => e.code === 'unsupported');
});

test('refreshModels loads an open conversation into the restarted OpenCode, which lists the models again', async (t) => {
  const { oc, agents } = setup(t, V2);
  await oc.openSession(ORIGINAL, { cwd: CWD });
  const before = oc.listModels().length;
  assert.ok(before > 0);
  await oc.restart({});
  const list = await oc.refreshModels();
  assert.equal(agents.length, 2, 'a second OpenCode started');
  assert.ok(agents[1].received.some((m) => m.method === 'session/load' && m.params.sessionId === ORIGINAL), 'the open conversation was loaded into it');
  assert.equal(list.length, before);
});

/* A script from v2-rewind.jsonl's initialize and session/load, with the session on Grok 4.7 at effort low, and the
   set_config_option answers 2.4.1 gave (measured): setting a model puts the effort back on 'default', and Claude Haiku
   4.5 offers none, high and max but not low. */
function effortScript() {
  const { loadScript } = require('./fake-agent');
  const base = loadScript('v2-rewind.jsonl');
  const init = base.find((e) => e.on === 'initialize');
  const load = JSON.parse(JSON.stringify(base.find((e) => e.on === 'session/load')));
  const opts = load.reply.configOptions;
  const effort = (current, values) => ({ ...opts.find((o) => o.id === 'effort'), currentValue: current, options: values.map((v) => ({ value: v, name: v })) });
  const withOpts = (model, eff) => opts.map((o) => (o.id === 'effort' ? eff : o.id === 'model' ? { ...o, currentValue: model } : o));
  const GROK = 'amazon-bedrock/us.xai.grok-4.7';
  const HAIKU = 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0';
  const grokValues = ['low', 'medium', 'high', 'xhigh', 'default'];
  load.reply.configOptions = withOpts(GROK, effort('low', grokValues));
  return {
    GROK, HAIKU,
    script: [init, { ...load, send: [] },
      { on: 'session/set_config_option', reply: { configOptions: withOpts(HAIKU, effort('default', ['none', 'high', 'max', 'default'])) } },
      { on: 'session/set_config_option', reply: { configOptions: withOpts(GROK, effort('default', grokValues)) } },
      { on: 'session/set_config_option', reply: { configOptions: withOpts(GROK, effort('low', grokValues)) } },
      { on: 'session/prompt', reply: { stopReason: 'end_turn' } }],
  };
}
function effortSetup(t, script) {
  const { fakeAgent } = require('./fake-agent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-effort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = [];
  const oc = createOpenCode({ root, findOpenCode: () => ({ path: '/fake/bin/opencode', version: V2 }), idleStopMs: 0, exportWaitMs: 200,
    execFile: (f, a, o, cb) => cb(new Error('no export here'), '', ''),
    startAcp: () => { const a = fakeAgent(script); agents.push(a); return { child: a.child, stderrTail: () => '', args: ['acp'] }; } });
  t.after(() => oc.dispose());
  return { oc, agents };
}
const effortOf = (h) => (h.options().find((o) => o.id === 'effort') || {}).value;
const sets = (a) => a.received.filter((m) => m.method === 'session/set_config_option').map((m) => `${m.params.configId}=${m.params.value}`);

test('the chosen effort is set again after a model change if the new model offers it, and OpenCode reports it', async (t) => {
  const { GROK, HAIKU, script } = effortScript();
  const { oc, agents } = effortSetup(t, script);
  const h = await oc.openSession(ORIGINAL, { cwd: CWD });
  assert.equal(effortOf(h), 'low', 'opened, it shows the effort OpenCode recorded');
  await h.setModel(HAIKU);
  assert.equal(effortOf(h), 'default', 'Claude Haiku 4.5 has no low, so OpenCode\'s default stays');
  await h.setModel(GROK);
  assert.deepEqual(sets(agents[0]), [`model=${HAIKU}`, `model=${GROK}`, 'effort=low']);
  assert.equal(effortOf(h), 'low', 'back on Grok, low again');
});

test('after OpenCode restarts, the model it already has is not set a second time, since that would reset the effort to default', async (t) => {
  const { script } = effortScript();
  const { oc, agents } = effortSetup(t, script);
  const h = await oc.openSession(ORIGINAL, { cwd: CWD });
  await oc.restart({});
  await h.send('Reply with OK.');
  assert.equal(agents.length, 2);
  assert.ok(agents[1].received.some((m) => m.method === 'session/load'), 'loaded into the new OpenCode');
  assert.deepEqual(sets(agents[1]), [], 'the model is not set again, so the effort is kept');
  assert.equal(effortOf(h), 'low');
});

test('a model chosen while a turn runs is set before the next message, not left for OpenCode to ignore', async (t) => {
  const { GROK, script } = effortScript();
  const GLOBAL = 'amazon-bedrock/global.xai.grok-4.7';
  const reply = script.find((e) => e.on === 'session/set_config_option').reply;
  const held = [
    ...script.filter((e) => e.on !== 'session/set_config_option' && e.on !== 'session/prompt'),
    { on: 'session/set_config_option', reply: { configOptions: reply.configOptions.map((o) => (o.id === 'model' ? { ...o, currentValue: GLOBAL } : o)) } },
    { on: 'session/prompt', send: [{ waitFor: 'session/cancel' }], reply: { stopReason: 'cancelled' } },
    { on: 'session/prompt', reply: { stopReason: 'end_turn' } },
  ];
  const { oc, agents } = effortSetup(t, held);
  const h = await oc.openSession(ORIGINAL, { cwd: CWD });
  assert.equal(h.getModel(), GROK);
  const first = h.send('Still retrying.');
  await new Promise((r) => setTimeout(r, 50));
  await h.setModel(GLOBAL);
  assert.deepEqual(sets(agents[0]), [], 'not while the turn runs');
  h.abort();
  await first;
  await h.send('On the other model.');
  const asked = agents[0].received.filter((m) => m.method === 'session/set_config_option' || m.method === 'session/prompt').map((m) => m.method);
  assert.deepEqual(sets(agents[0]), [`model=${GLOBAL}`]);
  assert.deepEqual(asked, ['session/prompt', 'session/set_config_option', 'session/prompt'], 'set before the second message');
});

test('a message with only images is sent without an empty text block', async (t) => {
  const { script } = effortScript();
  const { oc, agents } = effortSetup(t, script);
  const h = await oc.openSession(ORIGINAL, { cwd: CWD });
  await h.send('', { images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'square.png' }] });
  const asked = agents[0].received.find((m) => m.method === 'session/prompt');
  assert.deepEqual(asked.params.prompt, [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  await h.send('With words.');
  assert.deepEqual(agents[0].received.filter((m) => m.method === 'session/prompt').pop().params.prompt, [{ type: 'text', text: 'With words.' }]);
});
