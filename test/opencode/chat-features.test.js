// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Chat page features on OpenCode 2.4.1, tested against recordings: slash commands, compaction, images and files sent
 * with a message, the question tool's forms, and a subagent's progress under the call that started it.
 */
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCode, fileBlocks } = require('../../src/opencode');
const server = require('../../src/opencode/server');
const { fakeStarter } = require('./fake-agent');

const V2 = { major: 2, minor: 4, patch: 1, text: '2.4.1' };
const CWD = '/work/project';
const GROK = 'amazon-bedrock/us.xai.grok-4.7';
const HAIKU = 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0';
const CMDS = 'ses_df2f99704ffebYXxf2fpaBiDAi';
const ATTACH = 'ses_df2f99495ffeMgMULrpGSOSnTK';
const ASKING = 'ses_df2f994b2ffe2fbLxhoOXHlJIc';
const PARENT = 'ses_df2f996ffffeLwA1ybtBSrRv0s';
const CHILD = 'ses_df2f98d80ffe7j34s9Psh2tGdb';

function setup(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-feat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starter = fakeStarter(script);
  const oc = createOpenCode({
    root,
    findOpenCode: () => ({ path: '/fake/bin/opencode', version: V2 }),
    startAcp: starter.start,
    idleStopMs: 0,
    execFile: (file, args, opts, cb) => cb(new Error('not expected')),
    ownQuietMs: 300,
    ownAfterTextMs: 40,
  });
  t.after(() => oc.dispose());
  return { oc, agents: starter.agents };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const prompts = (agent) => agent.received.filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt);

test('2.x: the client declares compaction updates, forms and child-session updates in its capabilities', async (t) => {
  const { oc, agents } = setup(t, 'v2-cmds.jsonl');
  await oc.createSession(CWD, { model: GROK });
  const caps = agents[0].received.find((m) => m.method === 'initialize').params.clientCapabilities;
  assert.deepEqual(caps.elicitation, { form: {} });
  assert.deepEqual(caps.session, { compaction: {} });
  assert.equal(caps._meta['opencode/child-session-updates'], true);
  assert.equal(server.permissionConfig(server.parseVersion('2.4.1')).permissions.some((r) => r.action === 'question'), false, 'the question tool is not turned off on 2.4.1');
  assert.equal(server.permissionConfig(server.parseVersion('2.3.0')).permissions.some((r) => r.action === 'question' && r.effect === 'deny'), true, 'an earlier 2.x was not tried, so it stays off');
  assert.equal(server.permissionConfig(server.parseVersion('1.19.6')).permission.question, 'deny', '1.x has no way to ask, so it stays off there');
});

test('2.x: slash commands come right after session/new, and a /compact turn reports compacting and its summary', async (t) => {
  const { oc } = setup(t, 'v2-cmds.jsonl');
  const s = await oc.createSession(CWD, { model: GROK });
  await until(() => s.commands().length > 0);
  assert.deepEqual(s.commands().map((c) => c.name), ['init', 'review', 'goal', 'automation', 'compact']);
  assert.equal(s.commands().find((c) => c.name === 'compact').description, 'Compact the session');
  const events = [];
  s.on((ev) => events.push(ev));
  await s.send('Remember the word OSPREY. Reply with ok.');
  events.length = 0;
  const end = await s.send('/compact');
  assert.equal(end.reason, 'endTurn');
  const comp = events.filter((e) => e.type === 'compaction');
  assert.deepEqual(comp.map((e) => e.status), ['running', 'completed']);
  assert.match(comp[1].summary, /OSPREY/, 'the summary OpenCode wrote');
  assert.equal(comp[0].id, comp[1].id);
  const i = events.findIndex((e) => e.type === 'compaction');
  assert.ok(events.findIndex((e) => e.type === 'userMessage') < i && i < events.findIndex((e) => e.type === 'turnEnd'), 'inside the /compact turn');
  const reply = [];
  s.on((ev) => { if (ev.type === 'text') reply.push(ev.delta); });
  await s.send('What word did I ask you to remember? Reply with the word only.');
  assert.equal(reply.join(''), 'OSPREY');
});

test('2.x: a compacted conversation replays the compaction between its turns, and its commands after loading', async (t) => {
  const { oc } = setup(t, 'v2-cmds-load.jsonl');
  const s = await oc.openSession(CMDS, { cwd: CWD });
  const h = await s.history();
  const kinds = h.map((e) => e.type).filter((k) => ['turnStart', 'turnEnd', 'compaction', 'userMessage'].includes(k));
  assert.deepEqual(kinds, ['turnStart', 'userMessage', 'turnEnd', 'compaction', 'turnStart', 'userMessage', 'turnEnd']);
  assert.match(h.find((e) => e.type === 'compaction').summary, /OSPREY/);
  const seen = [];
  s.on((ev) => { if (ev.type === 'commands') seen.push(ev.commands.map((c) => c.name)); });
  await until(() => s.commands().length > 0);
  assert.ok(s.commands().some((c) => c.name === 'compact'));
});

test('2.x: images and files go with a message as image, resource_link and resource blocks, and are named in it', async (t) => {
  const { oc, agents } = setup(t, 'v2-attach.jsonl');
  const s = await oc.createSession(CWD, { model: HAIKU });
  assert.deepEqual(s.attachments(), { images: true, files: true, selection: true });
  const events = [];
  s.on((ev) => events.push(ev));
  const text = () => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  const png = 'iVBORw0KGgo=';
  await s.send('What colour is this image? Answer with one word, no tools.', { images: [{ mediaType: 'image/png', data: png }] });
  assert.equal(text(), 'Blue');
  events.length = 0;
  await s.send('What is the code word in @notes.txt?', { files: [{ path: '/work/project/notes.txt' }] });
  assert.equal(text(), 'KIWI-93');
  events.length = 0;
  await s.send('What colour of the day does the attached selection name?', { files: [{ path: '/work/project/colors.js', text: '// The colour of the day is MAGENTA.', startLine: 2, endLine: 2 }] });
  assert.equal(text(), 'Magenta');
  const [img, link, sel] = prompts(agents[0]);
  assert.deepEqual(img[1], { type: 'image', mimeType: 'image/png', data: png });
  assert.deepEqual(link[1], { type: 'resource_link', uri: 'file:///work/project/notes.txt', name: 'notes.txt' });
  assert.deepEqual(sel[1], { type: 'resource', resource: { uri: 'file:///work/project/colors.js#L2', mimeType: 'text/plain', text: '// The colour of the day is MAGENTA.' } });
  const user = events.find((e) => e.type === 'userMessage');
  assert.deepEqual(user.attachments, [{ kind: 'selection', name: 'colors.js:2', path: '/work/project/colors.js' }]);
  s.send('old form', [{ mediaType: 'image/png', data: 'AAAA' }]);
  await until(() => prompts(agents[0]).length === 4);
  assert.equal(prompts(agents[0])[3][1].type, 'image', 'an array is still taken as the images');
});

test('a selection goes as text when OpenCode takes no embedded context; a file link names its type', () => {
  const inline = fileBlocks([{ path: '/w/a.js', text: 'x = 1', startLine: 3, endLine: 5 }], false);
  assert.deepEqual(inline.prompt, [{ type: 'text', text: '[/w/a.js:3]\nx = 1' }]);
  assert.deepEqual(inline.shown, [{ kind: 'selection', name: 'a.js:3-5', path: '/w/a.js' }]);
  const embedded = fileBlocks([{ path: '/w/a.js', text: 'x = 1', startLine: 3, endLine: 5 }], true);
  assert.equal(embedded.prompt[0].resource.uri, 'file:///w/a.js#L3-L5');
  assert.deepEqual(fileBlocks([{ path: '/w/shot.PNG' }, { path: 'relative.txt' }, null], true).prompt, [{ type: 'resource_link', uri: 'file:///w/shot.PNG', name: 'shot.PNG', mimeType: 'image/png' }]);
  assert.equal(fileBlocks([{ path: '/w/a b#c.txt' }], true).prompt[0].uri, 'file:///w/a%20b%23c.txt');
});

test('2.x: a replayed message keeps its image and file, and the selection OpenCode wrote into its text becomes a selection attachment again', async (t) => {
  const { oc } = setup(t, 'v2-attach-load.jsonl');
  const s = await oc.openSession(ATTACH, { cwd: CWD });
  const users = (await s.history()).filter((e) => e.type === 'userMessage');
  assert.equal(users.length, 3);
  assert.deepEqual(users[0].attachments, [{ kind: 'image', name: 'image' }]);
  assert.deepEqual(users[1].attachments, [{ kind: 'file', name: 'notes.txt', path: '/work/project/notes.txt' }]);
  assert.equal(users[2].text, 'What colour of the day does the attached selection name? One word, no tools.');
  assert.deepEqual(users[2].attachments, [{ kind: 'selection', name: 'colors.js:2', path: '/work/project/colors.js' }]);
});

test('only a replay is read for selections: text the user sends that looks like one stays as it is', () => {
  const { createMapper } = require('../../src/opencode/mapper');
  const m = createMapper({ now: () => 1 });
  const live = m.begin('t1', 'see\n[/w/a.js:3]\nx = 1', 1);
  assert.equal(live[1].text, 'see\n[/w/a.js:3]\nx = 1');
  m.replayStart();
  const out = [
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'two\n[/w/a.js:3]\nx = 1\n[/w/b.py]\ny = 2' } }),
    ...m.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }),
  ];
  const user = out.find((e) => e.type === 'userMessage');
  assert.equal(user.text, 'two');
  assert.deepEqual(user.attachments.map((a) => a.name), ['a.js:3', 'b.py']);
});

test('2.x: the question tool asks with a form; an answer goes back as accept, cancelling ends the turn', async (t) => {
  const { oc, agents } = setup(t, 'v2-question.jsonl');
  const s = await oc.createSession(CWD, { model: GROK });
  const events = [];
  const seen = { asked: 0 };
  s.on((ev) => {
    events.push(ev);
    if (ev.type !== 'question') return;
    seen.status = s.status;
    seen.kind = s.waitingKind;
    const answer = ++seen.asked === 1
      ? { action: 'accept', content: { q0: 'Blue', q1: ['Apple', 'Plum'] } } : { action: 'cancel' };
    setImmediate(() => { seen.answered = s.respondQuestion(ev.requestId, answer); seen.again = s.respondQuestion(ev.requestId, answer); });
  });
  const first = await s.send('Use the question tool once to ask me two questions together…');
  assert.equal(first.reason, 'endTurn');
  const q = events.find((e) => e.type === 'question');
  assert.equal(q.message, 'Questions');
  assert.equal(q.toolId, 'call_24de96c1f6595a559dc83e0e72b79803', 'the question tool call it belongs to');
  assert.deepEqual(Object.keys(q.schema.properties), ['q0', 'q0_custom', 'q1', 'q1_custom']);
  assert.equal(s.id, ASKING);
  assert.equal(seen.status, 'waiting');
  assert.equal(seen.kind, 'question', 'it waits for an answer, not an approval');
  assert.equal(seen.answered, true);
  assert.equal(seen.again, false, 'a request is answered once');
  const reply = agents[0].received.find((m) => !m.method && m.result && m.result.action);
  assert.deepEqual(reply.result, { action: 'accept', content: { q0: 'Blue', q1: ['Apple', 'Plum'] } });
  assert.deepEqual(events.find((e) => e.type === 'questionSettled'), { type: 'questionSettled', requestId: q.requestId, action: 'accept' });
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), "I'll ask both questions together now.Blue, Apple, Plum");
  assert.equal(s.status, 'idle');

  events.length = 0;
  const second = await s.send('Use the question tool to ask me whether I want tea or coffee…');
  assert.equal(second.reason, 'aborted', 'OpenCode ends the turn as cancelled');
  assert.equal(events.find((e) => e.type === 'questionSettled').action, 'cancel');
  assert.ok(events.some((e) => e.type === 'toolResult' && e.isError && /dismissed/.test(e.content)));
});

test('2.x: a question still open when the turn is stopped is cancelled', async (t) => {
  const { oc, agents } = setup(t, 'v2-question.jsonl');
  const s = await oc.createSession(CWD, { model: GROK });
  s.on((ev) => { if (ev.type === 'question') setImmediate(() => s.abort()); });
  await s.send('Use the question tool once…');
  const reply = agents[0].received.find((m) => !m.method && m.result && m.result.action);
  assert.deepEqual(reply.result, { action: 'cancel' });
  assert.ok(agents[0].methods().includes('session/cancel'));
  assert.equal(s.respondQuestion('q1', { action: 'accept', content: {} }), false, 'nothing left to answer');
});

test("2.x: a subagent's progress comes as subagent events that name the call that started it, and a permission request from it names the subagent", async (t) => {
  const { oc } = setup(t, 'v2-subagent-progress.jsonl');
  const s = await oc.createSession(CWD, { model: GROK });
  const events = [];
  s.on((ev) => {
    events.push(ev);
    if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce'));
  });
  await s.send('Use the subagent tool to start one subagent…');
  await until(() => events.some((e) => e.type === 'turnEnd' && e.turnId !== events[0].turnId));
  const call = events.find((e) => e.type === 'toolCall' && e.name === 'subagent');
  const subs = events.filter((e) => e.type === 'subagent');
  assert.ok(subs.length > 5);
  assert.ok(subs.every((e) => e.childId === CHILD && e.toolId === call.id), 'every one names the subagent call, matched by its description first');
  assert.equal(subs[0].title, call.input.description);
  assert.equal(subs[0].status, 'running');
  assert.equal(subs[subs.length - 1].status, 'done');
  const inner = subs.filter((e) => e.event).map((e) => e.event.type);
  for (const k of ['reasoning', 'text', 'toolCall', 'toolResult']) assert.ok(inner.includes(k), k);
  const tools = subs.filter((e) => e.event && e.event.type === 'toolCall').map((e) => e.event.name);
  assert.deepEqual(tools.sort(), ['glob', 'read', 'shell'].sort());
  assert.match(subs.filter((e) => e.event && e.event.type === 'text').map((e) => e.event.delta).join(''), /KIWI-93/);
  const ask = events.find((e) => e.type === 'permission');
  assert.deepEqual(ask.subagent, { childId: CHILD, title: subs[0].title }, 'the request says which subagent asks');
  const result = events.find((e) => e.type === 'toolResult' && e.id === call.id);
  assert.equal(result.display.childId, CHILD, "the call's result names the session too");
});

test("2.x: in the view model, the call that started a subagent holds its steps and state, and a permission request from the subagent carries the subagent's id", async (t) => {
  const vm = require('../../src/ui/view-model');
  const { oc } = setup(t, 'v2-subagent-progress.jsonl');
  const s = await oc.createSession(CWD, { model: GROK });
  const events = [];
  s.on((ev) => {
    events.push(ev);
    if (ev.type === 'permission') setImmediate(() => s.respondPermission(ev.requestId, 'allowOnce'));
  });
  await s.send('Use the subagent tool to start one subagent…');
  await until(() => events.filter((e) => e.type === 'turnEnd').length === 2);
  const view = vm.reduceAll(events, vm.initialState(), 1);
  const card = view.items.find((it) => it.kind === 'tool' && it.name === 'subagent');
  assert.equal(card.child.childId, CHILD);
  assert.equal(card.child.status, 'done');
  assert.deepEqual(card.child.entries.filter((e) => e.kind === 'tool').map((e) => [e.name, e.state]).sort(), [['glob', 'done'], ['read', 'done'], ['shell', 'done']]);
  assert.match(card.child.last, /KIWI-93/);
  assert.ok(!view.items.some((it) => it.kind === 'subagent'), 'no second card for it');
  const ask = view.items.find((it) => it.kind === 'permission');
  assert.equal(ask.subagent.childId, CHILD);
});
