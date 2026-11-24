// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Live check against a real OpenCode and Amazon Bedrock. Not part of `node --test` (it calls a paid model):
 *   node test/opencode/live.js --bin <path to opencode> --dir <scratch dir> [--model amazon-bedrock/us.xai.grok-4.7]
 * AWS_PROFILE and AWS_REGION come from this process's environment. --dir gets an empty working folder and OpenCode's
 * data folders, so nothing lands in the real OpenCode database.
 */
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const fs = require('fs');
const path = require('path');
const { createOpenCode } = require('../../src/opencode');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const bin = arg('bin', '');
const scratch = arg('dir', '');
const model = arg('model', 'amazon-bedrock/us.xai.grok-4.7');
if (!bin || !scratch) {
  console.error('usage: node test/opencode/live.js --bin <opencode> --dir <scratch dir> [--model <provider/model>]');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const run = path.join(path.resolve(scratch), `live-${stamp}`);
const cwd = path.join(run, 'empty');
const data = path.join(run, 'opencode-data');
fs.mkdirSync(cwd, { recursive: true });
for (const d of ['share', 'config', 'state', 'cache']) fs.mkdirSync(path.join(data, d), { recursive: true });
const env = {
  ...(process.env.AWS_PROFILE ? { AWS_PROFILE: process.env.AWS_PROFILE } : {}),
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  XDG_DATA_HOME: path.join(data, 'share'),
  XDG_CONFIG_HOME: path.join(data, 'config'),
  XDG_STATE_HOME: path.join(data, 'state'),
  XDG_CACHE_HOME: path.join(data, 'cache'),
};

const t0 = Date.now();
const results = [];
const line = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  line(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const short = (s, n = 120) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

function makeClient(label) {
  return createOpenCode({ binaryPath: bin, env, root: path.join(run, `${label}-root`), log: (l) => line(`${label} log: ${l}`) });
}

function record(session) {
  const events = [];
  session.on((ev) => {
    events.push(ev);
    if (ev.type === 'permission') {
      line(`permission ${ev.requestId}: ${ev.request.kind} ${short(ev.request.summary, 80)} -> allowOnce`);
      setImmediate(() => session.respondPermission(ev.requestId, 'allowOnce'));
    } else if (ev.type === 'toolCall') line(`toolCall ${ev.name} ${short(JSON.stringify(ev.input), 80)}`);
    else if (ev.type === 'toolResult') line(`toolResult ${ev.isError ? 'error' : 'ok'} ${short(ev.content, 80)}`);
    else if (ev.type === 'turnEnd') line(`turnEnd ${ev.reason}${ev.error ? ` ${ev.error.kind}: ${short(ev.error.message)}` : ''}`);
    else if (ev.type === 'usage' && ev.costUsd !== undefined) line(`usage context ${ev.contextUsed} cost +$${ev.costUsd.toFixed(4)}`);
    else if (ev.type === 'title') line(`title ${ev.title}`);
  });
  return events;
}

(async () => {
  const a = makeClient('window1');
  const b = makeClient('window2');
  try {
    const info = await a.start();
    line(`OpenCode ${info.version ? info.version.text : '?'} at ${info.path}; ACP agent ${info.agent ? `${info.agent.name} ${info.agent.version}` : '?'}`);
    line(`session capabilities: ${Object.keys((info.capabilities && info.capabilities.sessionCapabilities) || {}).join(', ')}`);

    const s = await a.createSession(cwd, { model });
    check('create a conversation', /^ses/.test(s.id), `${s.id}, model ${s.getModel()}`);
    const events = record(s);

    const statuses = [];
    const sub = a.onDidChangeSessions((e) => { if (e.sessionId === s.id) statuses.push(s.status); });
    const end1 = await s.send('列出工作目录下的文件');
    const t1 = events.splice(0);
    const tool = t1.find((e) => e.type === 'toolCall');
    const perm = t1.find((e) => e.type === 'permission');
    const text = t1.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    check('a tool call or a permission request, answered', tool || perm,
      `${tool ? `tool ${tool.name}` : 'no tool call'}; ${perm ? `asked (${perm.request.kind}) and allowed once` : 'no permission asked'}`);
    check('the reply text arrives', text.length > 0, short(text));
    check('the turn ends normally', end1 && end1.reason === 'endTurn', end1 && end1.reason);
    check('status went working -> idle', statuses.includes('working') && s.status === 'idle', statuses.join(' > '));
    sub.dispose();

    const end1b = await s.send('Run the shell command `ls -la` with the bash tool and tell me how many entries it printed.');
    const t1b = events.splice(0);
    const ask = t1b.find((e) => e.type === 'permission');
    const settled = t1b.find((e) => e.type === 'permissionSettled');
    const ran = t1b.find((e) => e.type === 'toolResult' && !e.isError);
    check('a command asks first; allowing it once lets it run', ask && ask.request.kind === 'command' && settled && settled.decision === 'allowOnce' && ran,
      ask ? `asked "${short(ask.request.summary, 60)}", ${ran ? 'ran' : 'did not run'}; turn ${end1b && end1b.reason}` : `no permission request; turn ${end1b && end1b.reason}`);

    const pick = [/^us\..*claude-haiku-4-5/, /^us\..*kimi-k3$/, /^us\..*nova-lite/].map((re) => a.listModels().find((x) => x.providerId === 'amazon-bedrock' && re.test(x.invokeId) && x.id !== model)).find(Boolean);
    if (pick) {
      await s.setModel(pick);
      const endM = await s.send('Reply with the single word OK.');
      const tM = events.splice(0);
      const said = tM.filter((e) => e.type === 'text').map((e) => e.delta).join('');
      check('switching the model mid-conversation', s.getModel() === pick.id && endM && endM.reason === 'endTurn' && said.length > 0,
        `now ${s.getModel()}, turn ${endM && endM.reason}, replied "${short(said, 40)}"`);
    } else {
      check('switching the model mid-conversation', false, 'no second Bedrock model to switch to');
    }

    let stopped = false;
    s.on((ev) => { if (ev.type === 'text' && !stopped) { stopped = true; setTimeout(() => { line('abort()'); s.abort(); }, 800); } });
    const end2 = await s.send('Write a 600-word essay about the history of the Unix ls command. Do not use any tools.');
    const t2 = events.splice(0);
    check('stopping mid-reply ends the turn as aborted', end2 && end2.reason === 'aborted',
      `${end2 && end2.reason}, ${t2.filter((e) => e.type === 'text').length} text chunks before it stopped`);

    const listA = await a.listSessions({ cwd });
    const rowA = listA.find((r) => r.id === s.id);
    check('the conversation is in the list', rowA, rowA && `title "${rowA.title}", status ${rowA.status}, lastUserAt ${rowA.lastUserAt ? 'set' : 'unset'}, lastReplyAt ${rowA.lastReplyAt ? 'set' : 'unset'}`);

    const listB = await b.listSessions({ cwd });
    const rowB = listB.find((r) => r.id === s.id);
    check('a second client (another window\'s process) lists it with the same title', rowB && rowA && rowB.title === rowA.title, rowB && `"${rowB.title}"`);
    const sb = await b.openSession(s.id, { cwd });
    check('the second client loads it with the model it was switched to', !pick || sb.getModel() === pick.id, `loaded with ${sb.getModel()}`);
    const hist = await sb.history();
    const users = hist.filter((e) => e.type === 'userMessage').map((e) => e.text);
    const histTools = hist.filter((e) => e.type === 'toolCall').map((e) => e.name);
    check('its history in the second client matches what the first sent', users.length === (pick ? 4 : 3) && users[0] === '列出工作目录下的文件',
      `${users.length} user messages [${users.map((u) => short(u, 30)).join(' | ')}], tools [${histTools.join(', ')}], ${hist.filter((e) => e.type === 'text').length} text chunks`);
    sb.dispose();

    const bedrock = a.bedrockStatus();
    check('Bedrock status', bedrock.state === 'listed', `${bedrock.state}, ${bedrock.models} Bedrock models offered`);
    const models = a.listModels();
    const m = models.find((x) => x.id === model);
    check('the model list has the model, with the context window learned', m && m.contextWindow > 0, m && `${m.name}: ${m.contextWindow} tokens; ${models.length} models in all`);

    const tmp = await b.createSession(cwd);
    await b.deleteSession(tmp.id);
    const after = await b.listSessions({ cwd });
    check('deleting a conversation removes it', !after.some((r) => r.id === tmp.id), `deleted ${tmp.id}`);
  } catch (e) {
    check('no unexpected error', false, (e && e.stack) || String(e));
  } finally {
    await a.dispose();
    await b.dispose();
  }
  const failed = results.filter((r) => !r.ok).length;
  line(`${results.length - failed}/${results.length} passed; scratch ${run}`);
  process.exit(failed ? 1 : 0);
})();
