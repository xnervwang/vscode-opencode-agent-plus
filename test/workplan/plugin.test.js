// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The OpenCode plugin against a fake OpenCode 2 context and a fake OpenCode 1 input. The shared scripts are stand-ins
 * written in JavaScript and started with this Node through launcher.json, so the plugin's own process handling runs
 * as it does with Python; each stand-in records its arguments, its input and, for the reminder, the turn record it was
 * handed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plugin = require('../../opencode-plugin/agent-work-plan/index.js');

const SID = 'ses_df3c28ab2ffe0TYFbXAnoBpqy6';
const OTHER = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';

const RECORDER = `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let payload = null;
  try { payload = JSON.parse(input); } catch (_) {}
  const name = require('path').basename(__filename);
  const entry = { name, args: process.argv.slice(2), payload, tools: process.env.OPENCODE_AGENT_PLUS_PLAN_TOOLS };
  if (payload && payload.transcript_path) entry.record = fs.readFileSync(payload.transcript_path, 'utf8');
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
  main(payload, process.argv.slice(2));
});
`;
const SCRIPTS = {
  'inject-work-plan.py': `${RECORDER}
function main(p) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'PLAN ' + p.session_id + ' ' + p.turn_id } })); }`,
  'resume-work-plan.py': `${RECORDER}
function main(p) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RESUME ' + p.session_id } })); }`,
  'nudge-work-plan.py': `${RECORDER}
function main(p) { if (process.env.FAKE_QUIET) return; console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'NUDGE ' + p.turn_id } })); }`,
  'plan-row.py': `${RECORDER}
function main(p, args) {
  if (args.includes('refuse')) { process.stderr.write('Refused: no.\\n'); process.exit(1); }
  if (args.includes('slow')) { setTimeout(() => {}, 60000); return; }
  console.log('row 1 added: doing');
}`,
};

function makeEnv({ python = process.execPath } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'na-plugin-'));
  const hooks = path.join(root, 'hooks');
  const home = path.join(root, 'home');
  fs.mkdirSync(hooks);
  fs.mkdirSync(path.join(home, 'plans'), { recursive: true });
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(hooks, name), text);
  fs.writeFileSync(path.join(hooks, 'launcher.json'), JSON.stringify({ row: [python] }));
  const log = path.join(root, 'scripts.jsonl');
  process.env.OPENCODE_AGENT_PLUS_HOOKS_DIR = hooks;
  process.env.OPENCODE_AGENT_PLUS_HOME = home;
  process.env.FAKE_LOG = log;
  delete process.env.OPENCODE_AGENT_PLUS_PLAN_NUDGE;
  delete process.env.FAKE_QUIET;
  return {
    root, hooks, home, plans: path.join(home, 'plans'),
    runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    config: (value) => fs.writeFileSync(path.join(home, 'plans', 'config.json'), JSON.stringify(value)),
  };
}

function channel() {
  const items = [];
  let wake = null;
  let closed = false;
  const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
  return {
    push(v) { items.push(v); poke(); },
    close() { closed = true; poke(); },
    async *iterate() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

function fakeCtx({ context = [] } = {}) {
  const hooks = {};
  const disposedHooks = [];
  const toolRegs = [];
  const synthetics = [];
  const events = channel();
  const subscriptions = [];
  const ctx = {
    app: { version: '2.4.1' },
    location: { directory: '/work/repo' },
    session: {
      async hook(name, cb) { hooks[name] = cb; return { dispose: async () => { disposedHooks.push(name); delete hooks[name]; } }; },
      async context({ sessionID }) { ctx.contextAsked = sessionID; return context; },
      async synthetic(input) { synthetics.push(input); return { id: 'inbox_1' }; },
    },
    tool: {
      async transform(cb) {
        const added = [];
        cb({ add: (t) => added.push(t) });
        const reg = { added, disposed: false, dispose: async () => { reg.disposed = true; } };
        toolRegs.push(reg);
        return reg;
      },
    },
    model: { async list() { return [{ providerID: 'amazon-bedrock', id: 'us.xai.grok-4.7', modelID: 'us.xai.grok-4.7', limit: { context: 256000, output: 8192 } }]; } },
    event: {
      subscribe({ types, signal }) {
        subscriptions.push(types);
        signal.addEventListener('abort', () => events.close());
        return events.iterate();
      },
    },
  };
  const liveTools = () => toolRegs.filter((r) => !r.disposed);
  const tool = (name) => liveTools().flatMap((r) => r.added).find((t) => t.name === name);
  return { ctx, hooks, disposedHooks, toolRegs, liveTools, tool, synthetics, events, subscriptions };
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const userMessage = (text, metadata) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) });
const prompt = (sessionID, messageID, text) => ({ sessionID, messageID, prompt: { text, files: [] }, metadata: { source: 'x' }, delivery: 'steer' });

test('setup with a context that has no session hooks registers nothing', async () => {
  makeEnv();
  assert.equal(await plugin.setup({ options: {}, agent: {} }), undefined);
  assert.equal(await plugin.setup(undefined), undefined);
});

test('setup registers the three session hooks, the four plan tools, and subscribes to the three events it uses', async () => {
  makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  assert.deepEqual(Object.keys(f.hooks).sort(), ['compaction', 'context', 'prompt']);
  assert.equal(f.liveTools().length, 1);
  const added = f.liveTools()[0].added;
  assert.deepEqual(added.map((t) => t.name), ['set_row', 'add_row', 'set_summary', 'set_status']);
  for (const t of added) {
    assert.equal(t.input.type, 'object');
    assert.equal(t.input.additionalProperties, false);
    assert.ok(!('plan' in t.input.properties), `${t.name} takes no plan path`);
    assert.deepEqual(t.options, { codemode: false });
    assert.equal(typeof t.execute, 'function');
  }
  assert.deepEqual(added[0].input.required, ['row']);
  assert.deepEqual(added[1].input.required, ['state', 'title']);
  assert.deepEqual(added[3].input.required, ['doing', 'progress', 'next']);
  assert.deepEqual(f.subscriptions, [['session.compaction.ended', 'session.usage.updated', 'session.execution.succeeded']]);
  await stop();
});

test('prompt keeps inject-work-plan.py\'s text in the message metadata, wrapped as a harness block', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const ev = prompt(SID, 'msg_1', 'do the thing');
  await f.hooks.prompt(ev);
  assert.deepEqual(ev.metadata, { source: 'x', agentWorkPlan: `<system-update>\nPLAN ${SID} msg_1\n</system-update>` });
  assert.equal(ev.prompt.text, 'do the thing');
  const [run] = env.runs();
  assert.equal(run.name, 'inject-work-plan.py');
  assert.deepEqual(run.args, [env.plans]);
  const { transcript_path: record, ...given } = run.payload;
  assert.deepEqual(given, { hook_event_name: 'UserPromptSubmit', session_id: SID, turn_id: 'msg_1', prompt: 'do the thing', cwd: '/work/repo', in_panel: true });
  assert.ok(path.isAbsolute(record) && !fs.existsSync(record), 'a turn record made for the call, gone after it');
  assert.equal(run.record, '', 'with no usage seen yet it is empty');
  assert.equal(run.tools, 'tools');
  await stop();
});

test('prompt leaves a session without an OpenCode id alone and runs nothing', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const ev = prompt('not-a-session', 'msg_1', 'x');
  await f.hooks.prompt(ev);
  assert.deepEqual(ev.metadata, { source: 'x' });
  assert.deepEqual(env.runs(), []);
  await stop();
});

test('context puts each user message\'s kept text back after its own content, and touches nothing else', async () => {
  makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const ev = {
    sessionID: SID, model: { providerID: 'amazon-bedrock', id: 'us.xai.grok-4.7' }, system: [{ type: 'text', text: 'sys' }],
    messages: [
      userMessage('first', { agentWorkPlan: 'K1' }),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], metadata: { agentWorkPlan: 'not mine' } },
      userMessage('second'),
      userMessage('third', { agentWorkPlan: 'K3', other: 1 }),
    ],
  };
  f.hooks.context(ev);
  assert.deepEqual(ev.messages[0].content, [{ type: 'text', text: 'first' }, { type: 'text', text: 'K1' }]);
  assert.deepEqual(ev.messages[1].content, [{ type: 'text', text: 'ok' }]);
  assert.deepEqual(ev.messages[2].content, [{ type: 'text', text: 'second' }]);
  assert.deepEqual(ev.messages[3].content, [{ type: 'text', text: 'third' }, { type: 'text', text: 'K3' }]);
  assert.deepEqual(ev.system, [{ type: 'text', text: 'sys' }]);
  await stop();
});

test('compaction puts the kept texts back and adds the plan file, as it is, to the summary request', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const none = { sessionID: SID, system: [], messages: [userMessage('a', { agentWorkPlan: 'K' })] };
  f.hooks.compaction(none);
  assert.deepEqual(none.system, [], 'no plan file, nothing added');
  assert.equal(none.messages[0].content[1].text, 'K');
  const plan = path.join(env.plans, `${SID}.json`);
  fs.writeFileSync(plan, '{"format": 1, "nodes": [{"title": "T", "state": "doing"}]}\n');
  const ev = { sessionID: SID, system: [], messages: [] };
  f.hooks.compaction(ev);
  assert.equal(ev.system.length, 1);
  assert.ok(ev.system[0].text.includes(plan));
  assert.ok(ev.system[0].text.includes('"title": "T"'));
  assert.match(ev.system[0].text, /resumes by reading that file/);
  fs.writeFileSync(plan, JSON.stringify({ nodes: [{ title: 'x'.repeat(9000), state: 'todo' }] }));
  const big = { sessionID: SID, system: [], messages: [] };
  f.hooks.compaction(big);
  assert.ok(big.system[0].text.length < 7000);
  assert.match(big.system[0].text, /the file has the rest/);
  await stop();
});

test('the plan tools run plan-row.py on this session\'s plan with every value as --name=value before --', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const plan = path.join(env.plans, `${SID}.json`);
  const call = async (name, input) => (await f.tool(name).execute(input, { sessionID: SID })).content;
  assert.equal(await call('add_row', { state: 'doing', title: '-dash title', note: '-n', under: 2 }), 'row 1 added: doing');
  await call('set_row', { row: '1.2', state: 'waiting', waiting_on: 'user', question: 'Merge it?', detail: '' });
  await call('set_row', { row: 3, note: 'only a note' });
  await call('set_summary', { text: 'what this is for' });
  await call('set_status', { doing: 'a', progress: 'b', next: 'none' });
  const args = env.runs().map((r) => r.args);
  assert.deepEqual(args, [
    [plan, 'add', '--under=2', '--note=-n', '--', 'doing', '-dash title'],
    [plan, 'set', '--detail=', '--waiting-on=user', '--question=Merge it?', '--', '1.2', 'waiting'],
    [plan, 'set', '--note=only a note', '--', '3'],
    [plan, 'summary', '--', 'what this is for'],
    [plan, 'status', '--doing=a', '--progress=b', '--next=none'],
  ]);
  assert.ok(env.runs().every((r) => r.name === 'plan-row.py'));
  await stop();
});

test("a refused change returns plan-row.py's message; a session id not in OpenCode's shape is refused before anything runs", async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  assert.equal((await f.tool('set_row').execute({ row: 'refuse' }, { sessionID: SID })).content, 'Refused: no.');
  assert.match((await f.tool('set_row').execute({ row: '1' }, { sessionID: 'x' })).content, /is not an OpenCode session id/);
  assert.equal(env.runs().length, 1);
  await stop();
});

test('without Python, or without the scripts folder, nothing is injected and the tools say why', async () => {
  makeEnv({ python: '/nonexistent/python3' });
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const ev = prompt(SID, 'msg_1', 'x');
  await f.hooks.prompt(ev);
  assert.deepEqual(ev.metadata, { source: 'x' });
  assert.match((await f.tool('add_row').execute({ state: 'todo', title: 't' }, { sessionID: SID })).content, /needs Python 3/);
  process.env.OPENCODE_AGENT_PLUS_HOOKS_DIR = '';
  const ev2 = prompt(SID, 'msg_2', 'x');
  await f.hooks.prompt(ev2);
  assert.deepEqual(ev2.metadata, { source: 'x' });
  assert.match((await f.tool('add_row').execute({ state: 'todo', title: 't' }, { sessionID: SID })).content, /scripts folder is missing/);
  await stop();
});

test('a plan command that hangs is stopped and the model is told', { timeout: 30000 }, async () => {
  makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const text = (await f.tool('set_row').execute({ row: 'slow' }, { sessionID: SID })).content;
  assert.match(text, /did not finish within 15 seconds/);
  await stop();
});

test('plans switched off in config.json: nothing injected, the tools withdrawn; switched on again: registered again', async () => {
  const env = makeEnv();
  env.config({ enabled: false });
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  assert.equal(f.liveTools().length, 0);
  const ev = prompt(SID, 'msg_1', 'x');
  await f.hooks.prompt(ev);
  assert.deepEqual(ev.metadata, { source: 'x' });
  assert.deepEqual(env.runs(), []);
  env.config({ enabled: true });
  await f.hooks.prompt(prompt(SID, 'msg_2', 'x'));
  assert.equal(f.liveTools().length, 1);
  env.config({ enabled: false });
  await f.hooks.prompt(prompt(SID, 'msg_3', 'x'));
  assert.equal(f.liveTools().length, 0);
  assert.equal(f.toolRegs.length, 1);
  env.config({ enabled: true, extensionMarkers: [path.join(env.root, 'gone')] });
  await f.hooks.prompt(prompt(SID, 'msg_4', 'x'));
  assert.equal(f.liveTools().length, 0, 'an uninstalled extension counts as off');
  await stop();
});

test('after session.compaction.ended, resume-work-plan.py runs and the next prompt carries its text before the plan', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  f.events.push({ type: 'session.compaction.ended', data: { sessionID: SID } });
  await until(() => env.runs().some((r) => r.name === 'resume-work-plan.py'));
  const run = env.runs().find((r) => r.name === 'resume-work-plan.py');
  const { transcript_path: record, ...given } = run.payload;
  assert.deepEqual(given, { hook_event_name: 'SessionStart', source: 'compact', session_id: SID, in_panel: true });
  assert.ok(path.isAbsolute(record));
  assert.deepEqual(run.args, [env.plans]);
  await new Promise((r) => setTimeout(r, 50));
  const ev = prompt(SID, 'msg_9', 'next');
  await f.hooks.prompt(ev);
  assert.equal(ev.metadata.agentWorkPlan, `<system-update>\nRESUME ${SID}\n\nPLAN ${SID} msg_9\n</system-update>`);
  const later = prompt(SID, 'msg_10', 'again');
  await f.hooks.prompt(later);
  assert.equal(later.metadata.agentWorkPlan, `<system-update>\nPLAN ${SID} msg_10\n</system-update>`, 'said once');
  await stop();
});

test('session.usage.updated is recorded and handed on as the context in use and the model\'s window', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  await f.hooks.prompt(prompt(SID, 'msg_1', 'x'));
  f.hooks.context({ sessionID: SID, model: { providerID: 'amazon-bedrock', id: 'us.xai.grok-4.7' }, messages: [] });
  f.events.push({ type: 'session.usage.updated', data: { sessionID: SID, cost: 0.01, tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 8000, write: 200 } } } });
  await new Promise((r) => setTimeout(r, 100));
  await f.hooks.prompt(prompt(SID, 'msg_2', 'y'));
  const inject = env.runs().filter((r) => r.name === 'inject-work-plan.py');
  assert.equal(inject[1].payload.context_tokens, 9200);
  assert.equal(inject[1].payload.context_window, 256000);
  assert.ok(!('context_tokens' in inject[0].payload));
  await stop();
});

test('at the end of a turn nudge-work-plan.py reads a turn record, and what it says is kept as one synthetic message', async () => {
  const env = makeEnv();
  const t0 = Date.parse('2026-11-24T06:00:00.250Z');
  const context = [
    { id: 'u0', type: 'user', time: { created: t0 - 60000 }, text: 'earlier' },
    { id: 'c0', type: 'compaction', time: { created: t0 - 30000 }, summary: 'S' },
    { id: 's0', type: 'synthetic', time: { created: t0 - 20000 }, text: 'a reminder' },
    { id: 'msg_1', type: 'user', time: { created: t0 }, text: 'merge it' },
    { id: 'a1', type: 'assistant', time: { created: t0 + 100, completed: t0 + 900 }, content: [
      { type: 'reasoning', text: 'hm' },
      { type: 'tool', id: 't1', name: 'bash', time: { created: t0 + 400 }, state: { status: 'completed', input: { command: 'git merge x' } } },
      { type: 'tool', id: 't2', name: 'set_row', time: { created: t0 + 500 }, state: { status: 'completed', input: { row: '1', state: 'done' } } },
      { type: 'tool', id: 't3', name: 'write', time: { created: t0 + 600 }, state: { status: 'completed', input: { filePath: '/x', content: 'y'.repeat(9000) } } },
    ] },
    { id: 'a2', type: 'assistant', time: { created: t0 + 1000, completed: t0 + 1500 }, content: [{ type: 'text', text: 'Merged. Should I push?' }] },
  ];
  const f = fakeCtx({ context });
  const stop = await plugin.setup(f.ctx);
  await f.hooks.prompt(prompt(SID, 'msg_1', 'merge it'));
  f.hooks.context({ sessionID: SID, model: { providerID: 'amazon-bedrock', id: 'us.xai.grok-4.7' }, messages: [] });
  f.events.push({ type: 'session.usage.updated', data: { sessionID: SID, tokens: { input: 10, output: 1, cache: { read: 90, write: 0 } } } });
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  await until(() => f.synthetics.length === 1);
  assert.deepEqual(f.synthetics[0], { sessionID: SID, text: '<system-update>\nNUDGE msg_1\n</system-update>', description: 'Work plan reminder',
    metadata: { agentWorkPlan: 'reminder' }, resume: false });
  const run = env.runs().find((r) => r.name === 'nudge-work-plan.py');
  assert.equal(f.ctx.contextAsked, SID);
  assert.deepEqual(run.args, [env.plans]);
  assert.equal(run.payload.hook_event_name, 'Stop');
  assert.equal(run.payload.session_id, SID);
  assert.equal(run.payload.turn_id, 'msg_1');
  assert.equal(run.payload.last_assistant_message, 'Merged. Should I push?');
  assert.equal(run.payload.stop_hook_active, false);
  assert.equal(run.payload.context_tokens, 100);
  assert.ok(!fs.existsSync(run.payload.transcript_path), 'the turn record is removed afterwards');
  const lines = run.record.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ['user_message', 'user_message', 'tool_call', 'tool_call', 'tool_call', 'assistant_text', 'usage']);
  assert.deepEqual(lines[1], { type: 'user_message', timestamp: '2026-11-24T06:00:00.250Z', text: 'merge it' });
  assert.deepEqual(lines[2], { type: 'tool_call', timestamp: '2026-11-24T06:00:01.000Z', name: 'bash', input: { command: 'git merge x' } });
  assert.equal(lines[3].plan, path.join(env.plans, `${SID}.json`), 'a plan tool call names the plan');
  assert.ok(JSON.stringify(lines[4].input).length < 4100, 'a long input is cut');
  assert.equal(lines[5].text, 'Merged. Should I push?');
  assert.equal(lines[6].tokens, 100);
  assert.equal(lines[6].window, 256000);
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: OTHER } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(env.runs().filter((r) => r.name === 'nudge-work-plan.py').length, 1, 'once per turn, and only for a turn this plugin saw begin');
  assert.equal(f.synthetics.length, 1);
  await stop();
});

test('nothing said at the end of a turn means no message; OPENCODE_AGENT_PLUS_PLAN_NUDGE picks resume or off', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  process.env.FAKE_QUIET = '1';
  await f.hooks.prompt(prompt(SID, 'msg_1', 'x'));
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  await until(() => env.runs().some((r) => r.name === 'nudge-work-plan.py'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.synthetics.length, 0);
  delete process.env.FAKE_QUIET;
  process.env.OPENCODE_AGENT_PLUS_PLAN_NUDGE = 'resume';
  await f.hooks.prompt(prompt(SID, 'msg_2', 'x'));
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  await until(() => f.synthetics.length === 1);
  assert.equal(f.synthetics[0].resume, true);
  process.env.OPENCODE_AGENT_PLUS_PLAN_NUDGE = 'off';
  await f.hooks.prompt(prompt(SID, 'msg_3', 'x'));
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(env.runs().filter((r) => r.name === 'nudge-work-plan.py').length, 2);
  delete process.env.OPENCODE_AGENT_PLUS_PLAN_NUDGE;
  await stop();
});

test('the cleanup setup returns disposes every hook and the tools, and ends the event subscription', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  await f.hooks.prompt(prompt(SID, 'msg_1', 'x'));
  await stop();
  assert.deepEqual(f.disposedHooks.sort(), ['compaction', 'context', 'prompt']);
  assert.equal(f.liveTools().length, 0);
  f.events.push({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.runs().filter((r) => r.name === 'nudge-work-plan.py').length, 0);
});

test('OpenCode 1: server() returns no hooks and logs one line saying the plan needs OpenCode 2', async () => {
  makeEnv();
  const logged = [];
  const hooks = await plugin.server({ client: { app: { log: async (x) => { logged.push(x); } } }, directory: '/w' });
  assert.deepEqual(hooks, {});
  assert.equal(logged.length, 1);
  assert.equal(logged[0].body.service, 'agent-work-plan');
  assert.match(logged[0].body.message, /needs OpenCode 2/);
  assert.deepEqual(await plugin.server({}), {});
});

test('the plugin is one CommonJS file that requires only Node\'s own modules', () => {
  const text = fs.readFileSync(require.resolve('../../opencode-plugin/agent-work-plan/index.js'), 'utf8');
  const required = [...text.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(required.sort(), ['child_process', 'fs', 'os', 'path']);
  assert.equal(plugin.id, 'agent-work-plan');
});

/* Stand-ins for the time-zone and reply-image notes. */
const NOTE_SCRIPTS = {
  'tell-time-zone.py': `${RECORDER}
function main(p) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: p.hook_event_name, additionalContext: 'ZONE ' + p.hook_event_name } })); }`,
  'tell-reply-images.py': `${RECORDER}
function main(p) { if (!p.in_panel) return; console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: p.hook_event_name, additionalContext: 'IMAGES' } })); }`,
};
/* run-hooks.py's stand-in: one process answers for every script named on its command line, in run-hooks.py's { texts } shape. */
const RUNNER_STANDIN = `${RECORDER}
function main(p, args) {
  const texts = {};
  for (const n of args.slice(1)) texts[n] = n === 'inject-work-plan.py' ? 'PLAN ' + p.turn_id : n === 'tell-time-zone.py' ? 'ZONE' : n === 'resume-work-plan.py' ? 'RESUME' : '';
  console.log(JSON.stringify({ texts }));
}`;

test('the notes go with every user message, with the plan or without it, and read the last usage from a turn record', async () => {
  const env = makeEnv();
  for (const [name, text] of Object.entries(NOTE_SCRIPTS)) fs.writeFileSync(path.join(env.hooks, name), text);
  env.config({ enabled: true, tellTimeZone: true, replyImages: true });
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const first = prompt(SID, 'msg_0', 'warm up');
  await f.hooks.prompt(first);
  await until(() => env.runs().length >= 3);
  /* Usage is kept for a conversation once it has had a message. */
  f.events.push({ type: 'session.usage.updated', data: { sessionID: SID, tokens: { input: 1200, cache: { read: 300, write: 0 } } } });
  await new Promise((r) => setTimeout(r, 80));
  const ev = prompt(SID, 'msg_1', 'go');
  await f.hooks.prompt(ev);
  assert.equal(ev.metadata.agentWorkPlan, `<system-update>\nPLAN ${SID} msg_1\n\nZONE UserPromptSubmit\n\nIMAGES\n</system-update>`);
  const zone = env.runs().filter((r) => r.name === 'tell-time-zone.py').pop();
  assert.equal(zone.payload.in_panel, true);
  assert.match(zone.record, /"type":"usage"/);
  env.config({ enabled: false, tellTimeZone: true, replyImages: true });
  const off = prompt(SID, 'msg_2', 'again');
  await f.hooks.prompt(off);
  assert.equal(off.metadata.agentWorkPlan, '<system-update>\nZONE UserPromptSubmit\n\nIMAGES\n</system-update>', 'the plan off, the notes stay');
  /* All three off, as in Interface: no Python is started. */
  env.config({ enabled: false, tellTimeZone: false, replyImages: false });
  const runs = env.runs().length;
  const none = prompt(SID, 'msg_3', 'quiet');
  await f.hooks.prompt(none);
  assert.deepEqual(none.metadata, { source: 'x' });
  assert.equal(env.runs().length, runs);
  /* With no config.json the time zone is on and the images off, as plan_common.py defaults them. */
  fs.rmSync(path.join(env.plans, 'config.json'));
  const bare = prompt(SID, 'msg_4', 'bare');
  await f.hooks.prompt(bare);
  assert.equal(bare.metadata.agentWorkPlan, `<system-update>\nPLAN ${SID} msg_4\n\nZONE UserPromptSubmit\n</system-update>`);
  await stop();
});

test('with run-hooks.py there, one Python process answers for the plan and the notes', async () => {
  const env = makeEnv();
  env.config({ enabled: true, tellTimeZone: true, replyImages: true });
  fs.writeFileSync(path.join(env.hooks, 'run-hooks.py'), RUNNER_STANDIN);
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const ev = prompt(SID, 'msg_1', 'go');
  await f.hooks.prompt(ev);
  assert.equal(ev.metadata.agentWorkPlan, '<system-update>\nPLAN msg_1\n\nZONE\n</system-update>');
  const runs = env.runs();
  assert.deepEqual(runs.map((r) => r.name), ['run-hooks.py']);
  assert.deepEqual(runs[0].args, [env.plans, 'inject-work-plan.py', 'tell-time-zone.py', 'tell-reply-images.py']);
  await stop();
});

test('after a compaction the notes are sent again, separately from the plan, so turning plans off leaves them in', async () => {
  const env = makeEnv();
  for (const [name, text] of Object.entries(NOTE_SCRIPTS)) fs.writeFileSync(path.join(env.hooks, name), text);
  env.config({ enabled: true, tellTimeZone: true, replyImages: true });
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  f.events.push({ type: 'session.compaction.ended', data: { sessionID: SID } });
  await until(() => env.runs().filter((r) => r.payload && r.payload.hook_event_name === 'SessionStart').length >= 3);
  /* A stand-in writes its log line as it runs, before the plugin has read its output. */
  await new Promise((r) => setTimeout(r, 100));
  env.config({ enabled: false, tellTimeZone: true, replyImages: true });
  const ev = prompt(SID, 'msg_9', 'next');
  await f.hooks.prompt(ev);
  assert.equal(ev.metadata.agentWorkPlan, '<system-update>\nZONE SessionStart\n\nIMAGES\n\nZONE UserPromptSubmit\n\nIMAGES\n</system-update>');
  await stop();
});

/* ---------- the steward line and steward_handoff ---------- */

/* The line Claude Code Plus's own conversations get (its hooks/steward.py watched(), with two example stewards),
   with the two changes this plugin makes: the steward_handoff tool for the relay command,
   and the tool's `to` for --to. */
const CCPLUS_ONE = 'A steward, "Docs steward" (aaaaaaaa-1111-4222-8333-444444444444), watches this one for the user through Claude Code Plus: it reads your work plan and latest reply, and speaks for the user by typing messages here, which come as the user\'s own. Each such message starts with the line `Sent by the steward "<title>" (<session id>) for the user:`, which names the steward that sent it. Do not send it status messages; put questions for the user in your plan as rows waiting on the user, where it sees them. If a message plainly belongs elsewhere (meant for another conversation, unrelated to the work here, or better done by another one), do not start background work for it here: run python3 \'<plugin>/hooks/steward-relay.py\' --handoff with a here-document holding the user\'s words, where it should go (a session id, or a folder for a new conversation) and why, and say in one sentence what it answered.';
const CCPLUS_MANY = 'Stewards "Docs steward" (aaaaaaaa-1111-4222-8333-444444444444) and "Night steward" (bbbbbbbb-1111-4222-8333-444444444444) watch this one for the user through Claude Code Plus: they read your work plan and latest reply, and speak for the user by typing messages here, which come as the user\'s own. Each such message starts with the line `Sent by the steward "<title>" (<session id>) for the user:`, which names the steward that sent it. Do not send them status messages; put questions for the user in your plan as rows waiting on the user, where they see them. If a message plainly belongs elsewhere (meant for another conversation, unrelated to the work here, or better done by another one), do not start background work for it here: run python3 \'<plugin>/hooks/steward-relay.py\' --handoff with a here-document holding the user\'s words, where it should go (a session id, or a folder for a new conversation) and why, and say in one sentence what it answered. It goes to the steward whose message started this turn, or else to the one the user last typed to; to hand it to another of them, add --to and that steward\'s session id.';
const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `once in the original: ${from}`); return text.replace(from, to); };
const ours = (text) => once(once(text, "run python3 '<plugin>/hooks/steward-relay.py' --handoff with a here-document holding", 'call the steward_handoff tool with'),
  "add --to and that steward's session id", "set the tool's `to` to that steward's session id");
const ONE_TEXT = once(CCPLUS_ONE, "run python3 '<plugin>/hooks/steward-relay.py' --handoff with a here-document holding", 'call the steward_handoff tool with');
const MANY_TEXT = ours(CCPLUS_MANY);
const DOCS = { sourceId: 'claude-code', sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', title: 'Docs steward' };
const NIGHT = { sourceId: 'claude-code', sessionId: 'bbbbbbbb-1111-4222-8333-444444444444', title: 'Night steward' };
const STEWARD_ID = DOCS.sessionId;
const PLAN_TOOLS = ['set_row', 'add_row', 'set_summary', 'set_status'];
/* The steward file as the extension writes it. */
const watch = (env, id = SID, list = [DOCS]) => fs.writeFileSync(path.join(env.plans, `${id}.steward.json`),
  JSON.stringify({ format: 1, sourceId: list[0].sourceId, sessionId: list[0].sessionId, stewards: list }));
const toolNames = (f) => f.liveTools().flatMap((r) => r.added).map((t) => t.name);
const handoffFiles = (env) => fs.readdirSync(env.plans).filter((n) => n.includes('.handoff-'));

test('the steward line after the plan and the steward_handoff tool come with a steward file, and go without one or with plans off', async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  assert.deepEqual(toolNames(f), PLAN_TOOLS, 'no steward anywhere: four tools');
  const first = prompt(SID, 'msg_1', 'x');
  await f.hooks.prompt(first);
  assert.equal(first.metadata.agentWorkPlan, `<system-update>\nPLAN ${SID} msg_1\n</system-update>`);

  watch(env);
  const second = prompt(SID, 'msg_2', 'x');
  await f.hooks.prompt(second);
  assert.equal(second.metadata.agentWorkPlan, `<system-update>\nPLAN ${SID} msg_2\n\n${ONE_TEXT}\n</system-update>`, "with one steward, the text is Claude Code Plus's one-steward line");
  assert.deepEqual(toolNames(f), [...PLAN_TOOLS, 'steward_handoff'], 'registered again as one set, steward_handoff last');
  assert.equal(f.liveTools().length, 1);
  const tool = f.tool('steward_handoff');
  assert.deepEqual(tool.input.required, ['text']);
  assert.equal(tool.input.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.input.properties), ['text', 'to']);
  assert.equal(tool.input.properties.to.type, 'string');
  assert.deepEqual(tool.options, { codemode: false });
  assert.ok(tool.description.length < 250, 'a short description');

  /* Tools are per OpenCode process, so the other session gets steward_handoff as well; there it answers that the
     conversation has no steward. */
  const other = prompt(OTHER, 'msg_3', 'x');
  await f.hooks.prompt(other);
  assert.ok(!other.metadata.agentWorkPlan.includes('through Claude Code Plus'));
  assert.equal((await tool.execute({ text: 'x' }, { sessionID: OTHER })).content, 'This conversation has no steward.');
  fs.writeFileSync(path.join(env.plans, `${OTHER}.steward.json`), '{"format": 1, "sourceId": "claude-code"}');
  assert.equal((await tool.execute({ text: 'x' }, { sessionID: OTHER })).content, 'This conversation has no steward.', 'a file without a steward counts as none');
  assert.equal((await tool.execute({ text: 'x' }, { sessionID: 'not-a-session' })).content, 'This conversation has no steward.');

  env.config({ enabled: false });
  const off = prompt(SID, 'msg_4', 'x');
  await f.hooks.prompt(off);
  assert.ok(!off.metadata.agentWorkPlan || !off.metadata.agentWorkPlan.includes('through Claude Code Plus'), 'plans off: no steward line');
  assert.deepEqual(toolNames(f), [], 'plans off: no tools at all');

  env.config({ enabled: true });
  fs.unlinkSync(path.join(env.plans, `${SID}.steward.json`));
  const gone = prompt(SID, 'msg_5', 'x');
  await f.hooks.prompt(gone);
  assert.equal(gone.metadata.agentWorkPlan, `<system-update>\nPLAN ${SID} msg_5\n</system-update>`);
  assert.deepEqual(toolNames(f), PLAN_TOOLS, 'no steward left: steward_handoff withdrawn');
  await stop();
});

test("two stewards get Claude Code Plus's line for several, in the steward file's order, and so do more stewards, untitled ones and old-format files", async () => {
  const env = makeEnv();
  const f = fakeCtx();
  const stop = await plugin.setup(f.ctx);
  const line = async (msg) => { const ev = prompt(SID, msg, 'x'); await f.hooks.prompt(ev); return ev.metadata.agentWorkPlan; };
  watch(env, SID, [DOCS, NIGHT]);
  assert.equal(await line('msg_1'), `<system-update>\nPLAN ${SID} msg_1\n\n${MANY_TEXT}\n</system-update>`);
  watch(env, SID, [NIGHT, DOCS]);
  assert.ok((await line('msg_2')).includes(`Stewards "Night steward" (${NIGHT.sessionId}) and "Docs steward" (${DOCS.sessionId}) watch this one`), 'the order is the file\'s');
  const third = { sourceId: 'claude-code', sessionId: 'cccccccc-1111-4222-8333-444444444444', title: '' };
  watch(env, SID, [DOCS, NIGHT, third]);
  assert.equal(await line('msg_3'), `<system-update>\nPLAN ${SID} msg_3\n\n${MANY_TEXT.replace(`and "Night steward" (${NIGHT.sessionId})`,
    `, "Night steward" (${NIGHT.sessionId}) and ${third.sessionId}`).replace(`"Docs steward" (${DOCS.sessionId}) ,`, `"Docs steward" (${DOCS.sessionId}),`)}\n</system-update>`,
  'three: commas and a last "and"; one without a title is named by its session id');
  fs.writeFileSync(path.join(env.plans, `${SID}.steward.json`), JSON.stringify({ format: 1, sourceId: 'claude-code', sessionId: DOCS.sessionId }));
  assert.equal(await line('msg_4'), `<system-update>\nPLAN ${SID} msg_4\n\n${ONE_TEXT.replace(`"Docs steward" (${DOCS.sessionId})`, DOCS.sessionId)}\n</system-update>`,
    'an older extension\'s file with only the two top fields names one steward, by its session id');
  watch(env, SID, [{ ...DOCS, title: 'Docs\n   steward ' }, { sourceId: 'claude-code' }]);
  assert.equal(await line('msg_5'), `<system-update>\nPLAN ${SID} msg_5\n\n${ONE_TEXT}\n</system-update>`, 'an unusable entry is left out and a title kept on one line');
  await stop();
});

/* Windows keeps no owner, group and other bits: the mode a file is written with only sets its read-only flag, so it
   reads back 0o666. The folders these files live in belong to the user. */
const POSIX_MODES = process.platform !== 'win32';

/* Stands in for the extension: takes the next request in the plans folder and writes `result` as its answer, or no
   answer when `result` is null. */
async function answerNext(env, result) {
  const name = await until(() => fs.readdirSync(env.plans).find((n) => /^ses_\w+\.handoff-[0-9a-z]+\.json$/.test(n)));
  const file = path.join(env.plans, name);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mode = fs.statSync(file).mode & 0o777;
  fs.renameSync(file, `${file.slice(0, -'.json'.length)}.taken-1`);
  fs.unlinkSync(`${file.slice(0, -'.json'.length)}.taken-1`);
  if (result) fs.writeFileSync(`${file.slice(0, -'.json'.length)}.result.json`, JSON.stringify({ format: 1, ...result }));
  return { name, body, mode };
}

test('steward_handoff writes a request beside the plan, waits for the result, and says what came of it', async () => {
  const env = makeEnv();
  process.env.OPENCODE_AGENT_PLUS_HANDOFF_WAIT_MS = '800';
  try {
    watch(env);
    const f = fakeCtx();
    const stop = await plugin.setup(f.ctx);
    await f.hooks.prompt(prompt(SID, 'msg_1', 'x'));
    const tool = f.tool('steward_handoff');
    const said = 'The user wrote "add a dark theme"; it belongs to ses_docs0000000000 because that one owns the styles.';
    const run = (input, context = { sessionID: SID }) => tool.execute(input, context).then((r) => r.content);

    const [handed, taken] = await Promise.all([run({ text: said }), answerNext(env, { outcome: 'submitted', reason: '' })]);
    assert.equal(handed, 'Handed off to the steward, as a notice that says it is not from the user. Say so in one sentence in your reply and leave it to the steward.');
    assert.match(taken.name, new RegExp(`^${SID}\\.handoff-[0-9a-z]{8,64}\\.json$`));
    assert.equal(taken.body.format, 1);
    if (POSIX_MODES) assert.equal(taken.mode, 0o600);
    assert.equal(taken.body.text, said);
    assert.ok(!('to' in taken.body), 'no `to` given, none written');
    assert.ok(Math.abs(Date.now() - taken.body.at) < 5000);
    assert.deepEqual(handoffFiles(env), [], 'the result is removed once read');

    const [named, withTo] = await Promise.all([run({ text: said, to: `  ${NIGHT.sessionId} ` }),
      answerNext(env, { outcome: 'submitted', reason: '', steward: NIGHT.sessionId, title: 'Night steward' })]);
    assert.equal(withTo.body.to, NIGHT.sessionId);
    assert.equal(named, `Handed off to the steward "Night steward" (${NIGHT.sessionId}), as a notice that says it is not from the user. Say so in one sentence in your reply and leave it to the steward.`);
    const [wrong] = await Promise.all([run({ text: said, to: 'cccccccc-1111-4222-8333-444444444444' }),
      answerNext(env, { outcome: 'refused', reason: `cccccccc-1111-4222-8333-444444444444 is not a steward of this conversation; its stewards are "Docs steward" (${DOCS.sessionId}) and "Night steward" (${NIGHT.sessionId})` })]);
    assert.equal(wrong, `Not done: cccccccc-1111-4222-8333-444444444444 is not a steward of this conversation; its stewards are "Docs steward" (${DOCS.sessionId}) and "Night steward" (${NIGHT.sessionId}). To hand it on, call steward_handoff again with \`to\` set to one of those session ids, or leave \`to\` out.`);

    const [refused] = await Promise.all([run({ text: said }), answerNext(env, { outcome: 'notReceived', reason: 'no VS Code window shows that steward' })]);
    assert.equal(refused, 'Not done: no VS Code window shows that steward. Say in your reply where it seems to belong, so the user decides.');
    const [unclear] = await Promise.all([run({ text: said }), answerNext(env, { outcome: 'uncertain', reason: 'a window took it but gave no outcome in time' })]);
    assert.equal(unclear, 'Unclear whether the steward was told: a window took it but gave no outcome in time.');

    const lonely = await run({ text: said });
    assert.equal(lonely, 'Not done: no VS Code window took the handoff within 0.8 seconds. Say in your reply where it seems to belong, so the user decides.');
    assert.deepEqual(handoffFiles(env), [], 'a request nobody took is withdrawn, so no window sends it late');
    const [silent] = await Promise.all([run({ text: said }), answerNext(env, null)]);
    assert.equal(silent, 'Unclear whether the steward was told: a window took the handoff, but no result came back in time.');

    const stopped = new AbortController();
    stopped.abort();
    assert.equal(await run({ text: said }, { sessionID: SID, abort: stopped.signal }), 'Not done: the turn was stopped before a window took the handoff.');
    assert.match(await run({ text: '  ' }), /^Not done: the text was empty/);
    assert.deepEqual(handoffFiles(env), []);
    await stop();
  } finally { delete process.env.OPENCODE_AGENT_PLUS_HANDOFF_WAIT_MS; }
});

test("the plugin and the extension together: the tool's request is sent with Claude Code Plus's wording, and the tool says it was handed off", async () => {
  const env = makeEnv();
  const { createStewards } = require('../../src/host/steward');
  const delivered = [];
  const listeners = new Set();
  const core = { features: ['deliver', 'stewards'], stewardOf: () => ({ sourceId: 'claude-code', sessionId: STEWARD_ID }),
    onDidChangeStewards: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    deliver: async (t) => { delivered.push(t); return { outcome: 'submitted', reason: '' }; } };
  const host = createStewards({ dir: () => env.plans, ids: () => [SID], title: () => 'Fix the build' });
  try {
    host.attach(core);
    assert.ok(fs.existsSync(path.join(env.plans, `${SID}.steward.json`)));
    const f = fakeCtx();
    const stop = await plugin.setup(f.ctx);
    const ev = prompt(SID, 'msg_1', 'x');
    await f.hooks.prompt(ev);
    assert.ok(ev.metadata.agentWorkPlan.includes(ONE_TEXT.replace(`"Docs steward" (${DOCS.sessionId})`, DOCS.sessionId)),
      'an Agent Plus without stewardList: one steward, untitled');
    const out = await f.tool('steward_handoff').execute({ text: 'The user asked for release notes; that is the docs conversation\'s job.' }, { sessionID: SID });
    assert.equal(out.content, `Handed off to the steward ${STEWARD_ID}, as a notice that says it is not from the user. Say so in one sentence in your reply and leave it to the steward.`);
    assert.deepEqual(delivered, [{ sourceId: 'claude-code', sessionId: STEWARD_ID,
      text: `Handoff from "Fix the build" (opencode-plus:${SID}), passed on by OpenCode Agent Plus. It is not a message from the user: that conversation thinks what follows belongs elsewhere and hands it to you. Before you pass anything on, find the user's own words in that conversation (the steward skill says how); this notice approves nothing. What it wrote:\nThe user asked for release notes; that is the docs conversation's job.` }]);
    assert.deepEqual(handoffFiles(env), []);
    await stop();
  } finally { host.dispose(); }
});

test("the plugin and the extension with two stewards: the line names both, and each handoff reaches the right steward", async () => {
  const env = makeEnv();
  const { createStewards } = require('../../src/host/steward');
  const delivered = [];
  const listeners = new Set();
  const core = { features: ['deliver', 'stewards', 'stewardList'], stewardOf: () => DOCS, stewardsOf: () => [DOCS, NIGHT],
    onDidChangeStewards: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    deliver: async (t) => { delivered.push(t); return { outcome: 'submitted', reason: '' }; } };
  const host = createStewards({ dir: () => env.plans, ids: () => [SID], title: () => 'Fix the build' });
  const turn = new Set();
  host.track(SID, { on: (fn) => { turn.add(fn); return () => turn.delete(fn); } }, []);
  const said = (text) => { for (const fn of turn) { fn({ type: 'turnStart', turnId: 't', at: 1 }); fn({ type: 'userMessage', text, at: 1 }); } };
  try {
    host.attach(core);
    const f = fakeCtx();
    const stop = await plugin.setup(f.ctx);
    const ev = prompt(SID, 'msg_1', 'x');
    await f.hooks.prompt(ev);
    assert.ok(ev.metadata.agentWorkPlan.endsWith(`${MANY_TEXT}\n</system-update>`));
    const hand = (input) => f.tool('steward_handoff').execute({ text: 'This belongs to the docs conversation.', ...input }, { sessionID: SID }).then((r) => r.content);

    said(`Sent by the steward "Night steward" (${NIGHT.sessionId}) for the user:\nPlease write the release notes.`);
    assert.match(await hand({}), new RegExp(`^Handed off to the steward "Night steward" \\(${NIGHT.sessionId}\\)`));
    assert.equal(delivered.at(-1).sessionId, NIGHT.sessionId, 'the steward that signed the message starting the turn');
    assert.match(await hand({ to: DOCS.sessionId }), /^Handed off to the steward "Docs steward"/);
    assert.equal(delivered.at(-1).sessionId, DOCS.sessionId, 'the one `to` names');
    const count = delivered.length;
    assert.match(await hand({ to: 'cccccccc-1111-4222-8333-444444444444' }), /^Not done: cccccccc-1111-4222-8333-444444444444 is not a steward of this conversation; its stewards are "Docs steward" .* and "Night steward" .*\. To hand it on, call steward_handoff again/);
    assert.equal(delivered.length, count);
    said('A message the user typed.');
    await hand({});
    assert.equal(delivered.at(-1).sessionId, DOCS.sessionId, 'an unsigned turn: the first steward');
    assert.deepEqual(handoffFiles(env), []);
    await stop();
  } finally { host.dispose(); }
});
