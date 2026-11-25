// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The steward run of test/vscode/run.js (--steward), with OpenCode 2 and a real model. The helper extension registers
 * with Agent Plus a stand-in for Claude Code Plus's source, with the id claude-code and the 'stewards' feature. Its
 * stewardOf() names one steward for every opencode-plus conversation, and its deliverAnswer() records what it is given.
 * The plugin's log (OPENCODE_AGENT_PLUS_PLAN_LOG) shows what each request held.
 */
const fs = require('fs');
const path = require('path');

const STEWARD = '6a1f3c2e-7b4d-4e5f-9a8b-0c1d2e3f4a5b';
const HEAD = 'Handoff from ';
const MIDDLE = '), passed on by OpenCode Agent Plus. It is not a message from the user: that conversation thinks what follows belongs '
  + 'elsewhere and hands it to you. Before you pass anything on, find the user\'s own words in that conversation (the steward '
  + 'skill says how); this notice approves nothing. What it wrote:\n';

/* Registers the stand-in in the extension host and keeps it in globalThis for the later calls. */
const STAND_IN = `
  const e = vscode.extensions.getExtension('xnervwang.agent-plus');
  const core = (e.isActive ? e.exports : await e.activate()).agentPlus;
  const st = globalThis.__opencodeAgentPlusStewardStandIn = { answer: { sourceId: 'claude-code', sessionId: arg.steward }, got: [], changed: new vscode.EventEmitter() };
  const conversations = new vscode.EventEmitter();
  const r = core.registerSource({
    protocol: 1, id: 'claude-code', label: 'Claude Code (stand-in)', extensionId: 'opencode-agent-plus-tests.opencode-agent-plus-ui-helper',
    features: ['stewards'],
    planDir: () => arg.dir, planPath: () => null, sessionForTab: () => null,
    onDidFocus: new vscode.EventEmitter().event, onDidChangeConversations: conversations.event,
    listConversations: async () => [{ sessionId: arg.steward, title: 'Steward stand-in', steward: true, cwd: arg.folder, state: 'idle', lastActiveAt: Date.now() }],
    stewardOf: (sourceId, sessionId) => (sourceId === 'opencode-plus' ? st.answer : null),
    onDidChangeStewards: st.changed.event,
    canDeliver: (sessionId) => sessionId === arg.steward,
    deliverAnswer: async (sessionId, text, opts) => { st.got.push({ sessionId, text, deliveryId: opts && opts.deliveryId, at: Date.now() }); return { outcome: 'submitted' }; },
  });
  st.registration = r.registration;
  return { accepted: r.accepted, code: r.code, reason: r.reason, features: core.features, version: core.version };`;

/* t: { page, call, ext, check, shot, until, sleep, frameWith, folder, root, plans, planLog } */
async function run(t) {
  const { page, call, ext, check, shot, until, sleep, frameWith } = t;
  const lines = () => { try { return fs.readFileSync(t.planLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } }); } catch (_) { return []; } };
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };

  // S1. Both this extension and the stand-in register with an Agent Plus that has 'stewards'.
  const reg = await until(() => ext('return api.test.agentPlus.accepted ? api.test.agentPlus : null;'), 60000);
  const standDir = path.join(t.root, 'stand-in-plans');
  fs.mkdirSync(standDir, { recursive: true });
  const stand = await call(STAND_IN, { steward: STEWARD, dir: standDir, folder: t.folder });
  check(!!reg && !!stand && stand.accepted && Array.isArray(stand.features) && stand.features.includes('stewards'),
    "Agent Plus lists 'stewards', and a stand-in claude-code source with 'stewards' registers beside OpenCode Agent Plus", { reg, stand });

  // S2. A new conversation gets its steward file beside its plan.
  await call('await vscode.commands.executeCommand("opencodeAgentPlus.newConversation"); return true;');
  const tab = await until(() => call(`const x = vscode.window.tabGroups.activeTabGroup.activeTab;
    return x && x.input instanceof vscode.TabInputCustom && /^opencodeagentplus-session:/.test(x.input.uri.toString()) ? x.input.uri.toString() : null;`), 30000);
  const id = tab ? tab.replace(/^opencodeagentplus-session:\//, '') : '';
  let chat = await frameWith(page, '#input', 30000);
  const file = id ? await ext('return api.test.stewardFile(arg);', id) : '';
  const side = await until(() => readJson(file), 30000);
  const mode = side ? fs.statSync(file).mode & 0o777 : 0;
  check(!!id && file === path.join(t.plans, `${id}.steward.json`) && !!side && side.format === 1 && side.sourceId === 'claude-code' && side.sessionId === STEWARD && mode === 0o600,
    'the new conversation has <plans>/<id>.steward.json naming the stand-in\'s steward, readable only by its owner', { id, file, side, mode: mode.toString(8) });

  const figures = () => chat.evaluate(() => document.querySelectorAll('#log .figures').length);
  const status = () => chat.evaluate(() => document.body.dataset.status);
  /* Sends `text`, answers Allow once to any request on the way, and waits for the turn to end. */
  const turn = async (text) => {
    const before = await figures();
    await chat.fill('#input', text);
    await chat.press('#input', 'Enter');
    await until(async () => (await status()) !== 'idle' || (await figures()) > before, 60000, 200);
    const end = Date.now() + 240000;
    while (Date.now() < end) {
      let button = null;
      for (const b of await chat.$$('button[data-decision="allowOnce"]')) if (await b.isVisible()) { button = b; break; }
      if (button) { await button.click(); await sleep(800); continue; }
      if ((await status()) === 'idle' && (await figures()) > before) return true;
      await sleep(500);
    }
    return false;
  };
  const since = (at, kind) => lines().filter((l) => l.kind === kind && l.sessionID === id && Date.parse(l.at) >= at);

  // S3. A turn: the plugin adds the steward line, and the request has steward_handoff among its tools.
  const first = Date.now();
  const ended = chat ? await turn('Reply with only the word ready.') : false;
  const prompts = since(first, 'prompt'), requests = since(first, 'context');
  /* A request OpenCode makes for itself (a title, say) may come with no tools; the turn's own requests have them. */
  const turnRequests = requests.filter((l) => Array.isArray(l.tools) && l.tools.includes('add_row'));
  check(ended && prompts.length > 0 && prompts.every((l) => l.steward === true) && turnRequests.length > 0
    && turnRequests.every((l) => l.tools.includes('steward_handoff') && l.watched >= 1),
  "the turn's prompt gets the steward line, and each of its requests carries the line and steward_handoff", { ended, prompts, requests: requests.map((l) => ({ watched: l.watched, kept: l.kept, steward: (l.tools || []).includes('steward_handoff') })) });

  // S4. The model is asked to hand a message to the steward, which gets it in Claude Code Plus's wording.
  const ask = 'This message is not for this conversation: please update the README of the docs project. It belongs to the '
    + 'conversation ses_docsproject0000000001, which owns that README. Hand it to the steward with the steward_handoff tool and '
    + 'do nothing else here.';
  const asked = Date.now();
  const handed = await turn(ask);
  const got = (await call('return globalThis.__opencodeAgentPlusStewardStandIn.got;')) || [];
  const title = ((await ext('return api.test.snapshot(arg);', id)) || {}).title || '';
  const text = got.length ? got[0].text : '';
  const parsed = /^Handoff from (?:"([^\n]*)"|a conversation you manage) \(opencode-plus:([^)]+)/.exec(text);
  const said = parsed ? text.slice(parsed[0].length) : '';
  const exact = !!parsed && said.startsWith(MIDDLE) && said.length > MIDDLE.length && parsed[2] === id
    && (parsed[1] === undefined ? !title || title === 'New conversation' : parsed[1] === title);
  check(handed && got.length === 1 && got[0].sessionId === STEWARD && text.startsWith(`${HEAD}"`) && exact,
    'the model called steward_handoff, and the stand-in got one message starting Handoff from " in Claude Code Plus\'s wording, with this conversation\'s title and id',
    { handed, count: got.length, title, start: text.slice(0, 160), body: said.slice(MIDDLE.length, MIDDLE.length + 300) });
  console.log(`  note  the stand-in got: ${JSON.stringify(text)}`);
  const outcomes = since(asked, 'handoff');
  const reply = (readJson(await ext('return api.test.replyFile(arg);', id)) || {}).reply || '';
  const toolCard = await chat.evaluate(() => [...document.querySelectorAll('#log .tool')].map((e) => e.textContent.replace(/\s+/g, ' ')).filter((x) => /steward_handoff/.test(x)).length);
  check(outcomes.some((l) => l.outcome === 'submitted') && /steward|hand/i.test(reply) && toolCard > 0,
    'the tool reported a handoff, and the reply says so in a sentence', { outcomes, reply: reply.slice(0, 400), toolCard });
  await chat.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
  await shot('S04-handoff', { features: ['steward handoff'],
    expect: 'The chat page: the user message about the README, a steward_handoff tool card, and a reply of a sentence or two saying the request went to the steward. No error notice.',
    part: '#workbench\\.parts\\.editor' });

  // S5. The stand-in stops naming a steward and fires onDidChangeStewards: the steward file goes, and the folder is
  // no longer watched.
  await call('const st = globalThis.__opencodeAgentPlusStewardStandIn; st.answer = null; st.changed.fire(); return true;');
  const removed = await until(() => !fs.existsSync(file), 15000);
  const watching = await ext('return api.test.stewardsWatching();');
  check(!!removed && watching === false, 'once stewardOf() returns null and onDidChangeStewards fires, the steward file is removed', { removed, watching });

  // S6. The next turn has no steward line, and the tool is gone from the request. The messages before keep the line
  // they were sent with, so a request carries no more steward lines than the requests before it.
  const carried = Math.max(0, ...since(asked, 'context').map((l) => Number(l.watched) || 0));
  const last = Date.now();
  const done = await turn('Reply with only the word done.');
  const after = since(last, 'prompt'), afterRequests = since(last, 'context');
  check(done && after.length > 0 && after.every((l) => l.steward === false) && afterRequests.some((l) => Array.isArray(l.tools) && l.tools.includes('add_row'))
    && afterRequests.every((l) => Array.isArray(l.tools) && !l.tools.includes('steward_handoff') && (Number(l.watched) || 0) <= carried),
  'without a steward the next turn gets no steward line, and steward_handoff is withdrawn while the plan tools stay', { done, after, carried, requests: afterRequests.map((l) => ({ watched: l.watched, tools: l.tools })) });
  chat = await frameWith(page, '#input', 10000);
  await shot('S06-no-steward', { features: ['steward handoff'],
    expect: 'The same chat page with one more exchange at the end: the user message "Reply with only the word done." and a reply "done" (or close to it). No error notice.',
    part: '#workbench\\.parts\\.editor' });

  await call('const st = globalThis.__opencodeAgentPlusStewardStandIn; if (st && st.registration) st.registration.dispose(); return true;');
}

module.exports = { run, STEWARD, MIDDLE };
