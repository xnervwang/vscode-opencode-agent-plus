// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * OPENCODE_AGENT_PLUS_TEST_BACKEND for the window tests: createOpenCode's shape (src/opencode/index.js) with the scripted
 * conversation of test/ui/fake-conversation.js as each session, so no OpenCode and no model are needed. A session's
 * first turn draws every kind of item, a permission request included; a message "Say: <text>" is answered with <text>,
 * for a reply the test writes itself, and "Demo: <name>" plays the turn listed under <name> in DEMOS, for the pictures
 * that compare the page with Claude Code's. Sessions and the events each one emitted are kept in
 * <OPENCODE_AGENT_PLUS_HOME>/fake-backend.json, so a reloaded window finds them again.
 *
 * With OPENCODE_AGENT_PLUS_FAKE_DEMO=1 each session also offers what a real OpenCode 2 does: a mode and an effort to
 * pick, three slash commands, images, workspace files and selections in a message, and rewinding to before a message.
 * A message with images, files or selections gets a reply that describes them (an image by the colour of its first
 * pixel, a file by its text). Prompts that test/vscode/run.js would send to a real model get scripted answers like
 * a model's (PROMPTS below): a turn may write files in the folder, start a subagent, move a
 * command to the background, ask a question, or start a turn of its own when its background work ends.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createFakeConversation, demoTurns, streamText } = require(path.join(__dirname, '..', 'ui', 'fake-conversation.js'));

const MODELS = [
  { id: 'fake/fake-small', invokeId: 'fake-small', providerId: 'fake', name: 'Fake Small', vendor: 'Test', contextWindow: 32000, maxOutputTokens: 4096, known: false },
  { id: 'fake/fake-large', invokeId: 'fake-large', providerId: 'fake', name: 'Fake Large', vendor: 'Test', contextWindow: 200000, maxOutputTokens: 8192, known: false },
  /* One of OpenCode's own free models, which the lists leave out while another provider is listed. */
  { id: 'opencode/fake-free', invokeId: 'fake-free', providerId: 'opencode', name: 'Fake Free', vendor: 'OpenCode', contextWindow: 32000, maxOutputTokens: 4096, known: false },
];

const DEMO = process.env.OPENCODE_AGENT_PLUS_FAKE_DEMO === '1';
const COMMANDS = [
  { name: 'compact', description: 'Summarize the conversation to make room in the context window' },
  { name: 'init', description: 'Write an AGENTS.md for this project' },
  { name: 'review', description: 'Review the changes in the working tree' },
];
const OPTION_VALUES = {
  mode: { name: 'Mode', values: [{ value: 'build', name: 'Build', description: 'Edits files and runs commands' }, { value: 'plan', name: 'Plan', description: 'Reads and plans, changes nothing' }] },
  effort: { name: 'Effort', values: [{ value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
};

/* The demo turns, by the name after "Demo: ". Each is a list of steps for fake-conversation.js. */
const DEMOS = {
  conversation: () => [
    ...streamText('Read the exporter before changing it.', 16, 'reasoning'),
    ...streamText("I'll add the CSV export first and mark the plan row as in progress.", 12),
    { type: 'toolCall', id: 'd-1', name: 'bash', input: { command: 'ls src && git log --oneline -3', description: 'List the source files and recent commits' } },
    { type: 'toolResult', id: 'd-1', content: 'sum.js\n3f2a1c0 Add sum\n9b8e7d6 First commit', isError: false },
    { type: 'toolCall', id: 'd-2', name: 'write', input: { path: 'src/export.js', content: 'module.exports = (rows) => rows.map((r) => r.join(",")).join("\\n");\n' } },
    { type: 'toolResult', id: 'd-2', content: 'Wrote src/export.js (1 line).', isError: false },
    { type: 'usage', input: 5200, output: 160, contextUsed: 5360, costUsd: 0.0182 },
    ...streamText('The exporter is written. Next I\'ll wire `export` into the CLI with the `--month` filter.\n\n- **src/export.js** joins each row with commas.\n- The tests come next.\n', 14),
  ],
  question: () => [
    { type: 'toolCall', id: 'dq-t', name: 'question', input: { questions: [{ question: 'Which config should I change?', header: 'Config' }] } },
    { type: 'question', requestId: 'dq-1', toolId: 'dq-t', message: 'Which config should I change?', schema: { type: 'object', required: ['config'], properties: {
      config: { type: 'string', title: 'Config', description: 'Which config should I change?', oneOf: [
        { const: 'staging', title: 'Staging', description: 'The staging config' }, { const: 'production', title: 'Production', description: 'The production config' }] },
      config_custom: { type: 'string', description: 'Other' } } } },
    { type: 'toolResult', id: 'dq-t', content: 'Config: Staging', isError: false },
    ...streamText("I'll change the staging config.", 10),
  ],
  subagent: () => [
    { type: 'toolCall', id: 'ds-1', name: 'task', input: { description: 'Look through the notes', prompt: 'Look through notes.txt for the retry delay.', subagent_type: 'general' } },
    { type: 'subagent', childId: 'ses_demo_child', title: 'Look through the notes', status: 'running', toolId: 'ds-1', event: { type: 'toolCall', id: 'dc-1', name: 'read', input: { path: 'notes.txt' } } },
    { type: 'subagent', childId: 'ses_demo_child', status: 'running', event: { type: 'toolResult', id: 'dc-1', content: 'Some notes.', isError: false } },
    { type: 'subagent', childId: 'ses_demo_child', status: 'running', event: { type: 'text', delta: 'The notes do not name a retry delay.' } },
    { wait: 400 },
    { type: 'subagent', childId: 'ses_demo_child', status: 'done' },
    { type: 'toolResult', id: 'ds-1', content: 'The notes do not name a retry delay.', isError: false },
    ...streamText('The helper looked: the notes do not name a retry delay.', 12),
  ],
  helper: () => [
    { type: 'toolCall', id: 'dh-1', name: 'task', input: { description: 'Look through the notes', prompt: 'Look through notes.txt for the retry delay.', subagent_type: 'general' } },
    { type: 'subagent', childId: 'ses_demo_helper', title: 'Look through the notes', status: 'running', toolId: 'dh-1', event: { type: 'toolCall', id: 'dh-c1', name: 'read', input: { path: 'notes.txt' } } },
    ...streamText('A helper is looking through the notes in the background.', 12),
  ],
  background: () => [
    { type: 'toolCall', id: 'db-1', name: 'bash', input: { command: 'sleep 600; echo done', description: 'Start the long job in the background' } },
    { type: 'toolResult', id: 'db-1', content: 'Started in the background (process 4242).', isError: false },
    { type: 'background', id: 'db-1', kind: 'shell', title: 'sleep 600; echo done', status: 'running', pid: 4242 },
    ...streamText('Started the long job in the background.', 12),
  ],
  error: () => [
    { type: 'toolCall', id: 'de-1', name: 'bash', input: { command: 'npm test', description: 'Run the test suite' } },
    { type: 'toolResult', id: 'de-1', content: 'Exit code 127\n/bin/bash: npm: command not found', isError: true },
    ...streamText('npm is not installed on this machine, so the tests did not run.', 12),
  ],
  running: () => [
    ...streamText('Build first, then run the tests.', 16, 'reasoning'),
    { type: 'toolCall', id: 'dr-1', name: 'bash', input: { command: 'npm run build', description: 'Build the project' } },
    { wait: 600000 },
  ],
  compact: () => [
    { type: 'compaction', status: 'running' },
    { wait: 300 },
    { type: 'compaction', status: 'completed', summary: 'The user asked for a CSV export; src/export.js is written and the CLI is next.' },
  ],
  /* The chat page's coloured code, an edit's change, links to files, thinking, a todo list and a long reply
     (test/vscode/lib/gap-page.js). */
  'page-code': () => [
    ...streamText('Here is the helper in JavaScript and in Python:\n\n```js\n// Adds two numbers.\nfunction sum(a, b) {\n  const total = a + b;\n  return total;\n}\n'
      + "module.exports = { sum, name: 'sum', limit: 10 };\n```\n\n```python\ndef total(rows):\n    \"\"\"Sum the amounts.\"\"\"\n"
      + "    return sum(r['amount'] for r in rows if r is not None)\n```\n\nAnd its output, a block with no language:\n\n```\nsum(2, 3) = 5\n```\n", 24),
  ],
  'page-edit': () => [
    { type: 'toolCall', id: 'pe-1', name: 'edit', input: { filePath: 'src/sum.js', oldString: 'module.exports = (a, b) => a + b;',
      newString: '/* Adds two numbers. */\nmodule.exports = (a, b) => {\n  return a + b;\n};' } },
    { type: 'toolResult', id: 'pe-1', content: 'Edit applied successfully.', isError: false },
    { type: 'toolCall', id: 'pe-2', name: 'write', input: { filePath: 'src/table.txt', content: Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join('\n') } },
    { type: 'toolResult', id: 'pe-2', content: 'Wrote file successfully.', isError: false },
    { type: 'toolCall', id: 'pe-3', name: 'apply_patch', input: { patchText: '*** Begin Patch\n*** Update File: README.md\n@@\n # Demo project\n+\n+Adds and exports numbers.\n*** End Patch' } },
    { type: 'toolResult', id: 'pe-3', content: 'Success. Updated README.md', isError: false },
    ...streamText('Changed src/sum.js and README.md, and wrote src/table.txt.', 16),
  ],
  'page-paths': () => [
    { type: 'toolCall', id: 'pp-1', name: 'read', input: { filePath: 'src/sum.js' } },
    { type: 'toolResult', id: 'pp-1', content: '1\tmodule.exports = (a, b) => a + b;', isError: false },
    ...streamText('The sum is in `src/sum.js:1`, and README.md describes the project. notes.txt holds notes; src/missing.js does not exist. '
      + 'The web page is https://example.com/README.md.', 20),
  ],
  'page-thinking': () => [
    ...streamText('The user asks whether the retry delay can change without a restart. The scheduler copies the value once, when it starts, so a change needs a restart.', 20, 'reasoning'),
    ...streamText('Not today: the scheduler reads the delay once, when it starts.', 16),
  ],
  'page-todo': () => [
    ...streamText('Making a list of the steps first.', 16),
    { type: 'toolCall', id: 'pt-1', name: 'todowrite', input: { todos: [
      { content: 'Read the exporter', status: 'completed' }, { content: 'Write the CSV export', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' }, { content: 'Ask about an Excel export', status: 'cancelled' }] } },
    { type: 'toolResult', id: 'pt-1', content: 'Todos updated: 1/4 completed, 1 in progress, 1 pending.', isError: false },
    ...streamText("I'm on the CSV export now.", 16),
  ],
  'page-long': () => [
    ...streamText(Array.from({ length: 40 }, (_, i) => `Step ${i + 1} of the plan: read the next part of the exporter and note what it writes.`).join('\n\n'), 80),
  ],
};

/* How long a backgrounded command runs before it ends and the agent starts a turn of its own. */
const BACKGROUND_MS = 8000;

/* The colour of a PNG's first pixel by name, for 8-bit RGB or RGBA; '' for anything else. Every PNG filter stores the
   first pixel of the first row as it is. */
function pngColour(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return '';
    let at = 8, depth = 0, type = -1;
    const idat = [];
    while (at + 8 <= buf.length) {
      const len = buf.readUInt32BE(at);
      const kind = buf.toString('latin1', at + 4, at + 8);
      const data = buf.subarray(at + 8, at + 8 + len);
      if (kind === 'IHDR') { depth = data[8]; type = data[9]; }
      if (kind === 'IDAT') idat.push(data);
      if (kind === 'IEND') break;
      at += 12 + len;
    }
    if (depth !== 8 || (type !== 2 && type !== 6) || !idat.length) return '';
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const [r, g, b] = [raw[1], raw[2], raw[3]];
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi < 60) return 'black';
    if (lo > 200) return 'white';
    if (hi - lo < 30) return 'grey';
    return hi === r ? 'red' : hi === g ? 'green' : 'blue';
  } catch (_) { return ''; }
}

/* What a message carried, as the real backend shows it on the message (src/opencode/index.js fileBlocks), and the lines
   of a reply that says what each was. */
function received(extra) {
  const attachments = [];
  const lines = [];
  for (const img of (extra && Array.isArray(extra.images) ? extra.images : [])) {
    const name = String(img.name || 'image');
    attachments.push({ kind: 'image', name });
    const colour = pngColour(Buffer.from(String(img.data || ''), 'base64'));
    lines.push(`${name} (${img.mediaType}) is ${colour ? `a ${colour} image` : 'an image'}.`);
  }
  for (const f of (extra && Array.isArray(extra.files) ? extra.files : [])) {
    const name = String(f.name || path.basename(String(f.path)));
    if (typeof f.text === 'string') {
      const from = Number(f.startLine) > 0 ? Number(f.startLine) : 0;
      const to = Number(f.endLine) > from ? Number(f.endLine) : from;
      const label = from ? `${name}:${from}${to > from ? `-${to}` : ''}` : name;
      attachments.push({ kind: 'selection', name: label, path: f.path });
      lines.push(`The selection ${label} reads: ${f.text.trim()}`);
    } else {
      attachments.push({ kind: 'file', name, path: f.path });
      let text = '';
      try { text = fs.readFileSync(f.path, 'utf8').trim().slice(0, 500); } catch (e) { text = `(it could not be read: ${e.code || e.message})`; }
      lines.push(`${name} reads: ${text}`);
    }
  }
  return { attachments, lines };
}

const allowed = (decision) => typeof decision === 'string' && decision !== 'deny';
/* A session's history as OpenCode records it, without the requests a turn made and their answers. */
const ASKED = new Set(['permission', 'permissionSettled', 'question', 'questionSettled']);
const replayed = (events) => events.filter((e) => !ASKED.has(e.type));
const capital = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };

/*
 * The prompts test/vscode/run.js sends, with the turn a model would answer each with. `t` gives a session's folder
 * (cwd), its picked options (option(id)), a fresh id for a tool call or request (id(kind)), a write that rewinding can
 * undo (write(file, text)), a subagent session (child(title)) and a turn of the agent's own after `ms` (later(ms, steps)).
 */
const PROMPTS = [
  [/^Retry once, then reply with only the word (\w+)\.$/, (m) => [
    { type: 'retry', attempt: 2, waitMs: 4000, error: { kind: 'throttled', message: 'Too many requests (fake backend)' } },
    { wait: 2500 },
    { type: 'retry', attempt: 0 },
    ...streamText(m[1], 12),
  ]],
  [/^列出工作目录下的文件$/, (m, t) => {
    const names = fs.readdirSync(t.cwd).filter((n) => !n.startsWith('.')).sort();
    const call = t.id('ls'), ask = t.id('ls');
    return [
      { type: 'toolCall', id: call, name: 'bash', input: { command: 'ls', description: 'List the files in the working folder' } },
      { type: 'permission', requestId: ask, request: { kind: 'execute', tool: 'bash', summary: 'ls', command: 'ls' } },
      (got) => (allowed(got[ask])
        ? [{ type: 'toolResult', id: call, content: names.join('\n'), isError: false }, ...streamText(`工作目录下有：${names.join('、')}。`, 12)]
        : [{ type: 'toolResult', id: call, content: 'The user denied the command.', isError: true }, ...streamText('没有列出文件。', 12)]),
    ];
  }],
  [/^Use the write tool to create a file named (\S+) containing the word (\w+)\./, (m, t) => {
    if (t.option('mode') === 'plan') return streamText(`No: in plan mode I may not write files, so ${m[1]} was not created.`, 12);
    return t.writes([{ name: m[1], text: m[2] }], `Yes: ${m[1]} now holds ${m[2]}.`);
  }],
  [/^Use the write tool to create a file named (\S+?),? containing exactly (\S+?),? then use the edit tool to change (\S+) so that it contains exactly: (.+?) Then reply with only the word (\w+)\.$/,
    (m, t) => t.writes([{ name: m[1], text: m[2] }, { name: m[3], text: m[4], edit: true }], m[5])],
  [/^Use the subagent tool to start one subagent/, (m, t) => {
    const title = 'Sleep and say finished';
    const task = t.id('task'), step = t.id('sub'), ask = t.id('sub');
    const child = t.child(title);
    const sub = { childId: child, title };
    return [
      { type: 'toolCall', id: task, name: 'task', input: { description: title, prompt: 'Use the shell tool to run the command sleep 8, then reply finished.', subagent_type: 'general' } },
      { type: 'subagent', childId: child, title, status: 'running', toolId: task, event: { type: 'toolCall', id: step, name: 'bash', input: { command: 'sleep 8', description: 'Wait eight seconds' } } },
      { type: 'toolResult', id: task, content: `Started the subagent ${child} in the background.`, isError: false },
      ...streamText('Started one subagent; it runs in the background.', 12),
      () => t.later(800, [
        { wait: 1500 },
        { type: 'permission', requestId: ask, request: { kind: 'execute', tool: 'bash', summary: 'sleep 8', command: 'sleep 8' }, subagent: sub },
        { wait: 1500 },
        { type: 'subagent', childId: child, status: 'running', event: { type: 'toolResult', id: step, content: '', isError: false } },
        { type: 'subagent', childId: child, status: 'running', event: { type: 'text', delta: 'finished' } },
        { type: 'subagent', childId: child, status: 'done' },
        ...streamText('The subagent has finished.', 12),
      ]),
    ];
  }],
  [/^Use the question tool to ask me whether I prefer (\w+) or (\w+)/, (m, t) => {
    const [a, b] = [m[1], m[2]];
    const call = t.id('question'), ask = t.id('question');
    const q = `Do you prefer ${a} or ${b}?`;
    return [
      { type: 'toolCall', id: call, name: 'question', input: { questions: [{ question: q, header: 'Colour' }] } },
      { type: 'question', requestId: ask, toolId: call, message: q, schema: { type: 'object', required: ['colour'], properties: {
        colour: { type: 'string', title: 'Colour', description: q, oneOf: [{ const: a, title: capital(a) }, { const: b, title: capital(b) }] },
        colour_custom: { type: 'string', description: 'Other' } } } },
      (got) => {
        const answer = got[ask];
        const c = answer && answer.action === 'accept' && answer.content ? answer.content : null;
        const pick = c ? String(c.colour_custom || (c.colour === a ? capital(a) : c.colour === b ? capital(b) : c.colour || '')) : '';
        return pick
          ? [{ type: 'toolResult', id: call, content: `Colour: ${pick}`, isError: false }, ...streamText(pick, 12)]
          : [{ type: 'toolResult', id: call, content: 'The question was dismissed.', isError: true }, ...streamText('You did not pick a colour.', 12)];
      },
    ];
  }],
  [/^Run the command `([^`]+)` with the shell tool, then reply with only the word (\w+)\.$/, (m, t) => {
    const call = t.id('bash'), ask = t.id('bash');
    return [
      { type: 'toolCall', id: call, name: 'bash', input: { command: m[1], description: 'Run the command' } },
      { type: 'permission', requestId: ask, request: { kind: 'execute', tool: 'bash', summary: m[1], command: m[1] } },
      (got) => (allowed(got[ask])
        ? [{ type: 'toolResult', id: call, content: m[1].replace(/^echo\s+/, ''), isError: false }, ...streamText(m[2], 12)]
        : [{ type: 'toolResult', id: call, content: 'The user denied the command.', isError: true }, ...streamText('The command was not run.', 12)]),
    ];
  }],
  [/^Use the shell tool to start the command "([^"]+)" in the background/, (m, t) => {
    const call = t.id('bg');
    const pid = 4000 + Number(call.split('-').pop());
    const bg = { type: 'background', id: call, kind: 'shell', title: m[1], pid };
    return [
      { type: 'toolCall', id: call, name: 'bash', input: { command: m[1], description: 'Start the command in the background', run_in_background: true } },
      { type: 'toolResult', id: call, content: `Started in the background (process ${pid}).`, isError: false },
      { ...bg, status: 'running' },
      ...streamText('started', 12),
      () => t.later(BACKGROUND_MS, [{ ...bg, status: 'done' }, ...streamText(`The background command has ended: ${m[1].split(/;\s*echo\s+/).pop()}`, 12)]),
    ];
  }],
  [/^Use the shell tool to run the command "([^"]+)" in the foreground/, (m, t) => [
    { type: 'toolCall', id: t.id('bash'), name: 'bash', input: { command: m[1], description: 'Run the command and wait for it' } },
    { wait: 600000 },
    ...streamText('slept', 12),
  ]],
  [/^Reply with exactly (?:the following line and nothing else, and do not use any tool|this line and nothing else): ([\s\S]+)$/, (m) => streamText(m[1], 24)],
  [/^Reply with only the word (\w+)\.$/, (m) => streamText(m[1], 12)],
  [/^\/compact$/, () => [
    { type: 'compaction', status: 'running' },
    { wait: 300 },
    { type: 'compaction', status: 'completed', summary: '## Objective\n\nCheck the chat page against the window test.\n\n## Progress\n\n- The files were listed, a subagent ran, and a turn was rewound.\n' },
  ]],
];

/* Windows refuses a read or a rename for a moment while another process, such as a virus scanner, has the file open. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
function retried(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (process.platform !== 'win32' || !BUSY.has(e && e.code) || i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function createOpenCode() {
  const file = path.join(process.env.OPENCODE_AGENT_PLUS_HOME || '/tmp', 'fake-backend.json');
  const read = () => { try { return JSON.parse(retried(() => fs.readFileSync(file, 'utf8'))); } catch (_) { return { sessions: {} }; } };
  const write = (db) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(db)); retried(() => fs.renameSync(`${file}.tmp`, file)); };
  const listeners = new Set();
  const changed = (sessionId) => { for (const fn of [...listeners]) { try { fn({ sessionId }); } catch (_) { /* the others still run */ } } };
  const live = new Map();

  /* A file written by a turn of `sessionId` whose user message is `msg`, kept so that rewinding to before it can put
     the file back. */
  function writeFile(sessionId, msg, file, text) {
    const db = read();
    const s = db.sessions[sessionId];
    if (s) { (s.writes = s.writes || []).push({ msg, file, before: readText(file) }); write(db); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  /* A subagent's session, which the list leaves out as OpenCode's does. */
  function addChild(parent, title) {
    const db = read();
    const id = `ses_${crypto.randomBytes(8).toString('hex')}`;
    db.sessions[id] = { id, title, cwd: parent.cwd, parent: parent.id, lastActiveAt: Date.now(), lastUserAt: 0, lastReplyAt: 0, model: parent.model, events: [] };
    write(db);
    changed(id);
    return id;
  }

  const putBack = (file, text) => { if (text === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, text); };

  function handle(saved) {
    const picked = { mode: 'build', effort: 'default' };
    const messageId = () => `msg_${crypto.randomBytes(8).toString('hex')}`;
    const c = createFakeConversation({ turns: saved.events.length ? [] : demoTurns(), stepMs: 60, messageId,
      turnStart: () => (picked.effort !== 'default' ? { effort: picked.effort } : {}) });
    let model = saved.model || MODELS[0].id;
    let asking = 0;
    /* The user message whose turn is playing; rewinding to before it puts back the files that turn writes. */
    let current = '';
    let seq = 0;
    const t = {
      cwd: saved.cwd,
      option: (id) => picked[id] || '',
      id: (kind) => `ci-${kind}-${++seq}`,
      write: (file, text) => writeFile(saved.id, current, file, text),
      child: (title) => addChild(saved, title),
      later: (ms, steps) => { setTimeout(() => { if (!c.disposed) c.start(steps); }, ms); },
      /* Writes (or, with `edit`, edits) each file in the folder once its permission request is allowed, then says `reply`. */
      writes(list, reply) {
        const steps = [];
        for (const w of list) {
          const file = path.join(saved.cwd, w.name);
          const before = readText(file);
          const tool = w.edit ? 'edit' : 'write';
          const call = t.id(tool), ask = t.id(tool);
          steps.push(
            { type: 'toolCall', id: call, name: tool, input: w.edit ? { filePath: file, oldString: before || '', newString: w.text } : { filePath: file, content: w.text } },
            { type: 'permission', requestId: ask, request: { kind: 'edit', tool, summary: `${w.edit ? 'Edit' : 'Write'} ${w.name}`, path: w.name, diff: { path: w.name, before: before || '', after: w.text } } },
            (got) => {
              if (!allowed(got[ask])) return { type: 'toolResult', id: call, content: 'The user denied the change.', isError: true };
              t.write(file, w.text);
              return { type: 'toolResult', id: call, content: `${w.edit ? 'Edited' : 'Wrote'} ${w.name}.`, isError: false };
            });
        }
        return [...steps, ...streamText(reply, 12)];
      },
    };
    /* The turn a message gets: what it carried, or the answer PROMPTS has for it; null for the script's next turn. */
    const answer = (text, extra) => {
      const got = received(extra);
      if (got.attachments.length) return [{ type: 'userMessage', text, attachments: got.attachments, messageId: messageId() }, ...streamText(got.lines.join('\n'), 16)];
      for (const [re, make] of PROMPTS) {
        const m = re.exec(text.trim());
        if (m) return make(m, t);
      }
      return null;
    };
    Object.assign(c, {
      id: saved.id, cwd: saved.cwd, title: saved.title, status: 'idle', waitingTool: '', lastUserAt: saved.lastUserAt, lastReplyAt: saved.lastReplyAt,
      respondPermission: (rid, d) => c.respond(rid, d),
      history: async () => replayed(saved.events),
      reload: async () => replayed((read().sessions[saved.id] || saved).events),
      checkBackground: () => {},
      getModel: () => model,
      setModel: (m) => { model = typeof m === 'string' ? m : m.id; const db = read(); if (db.sessions[saved.id]) { db.sessions[saved.id].model = model; write(db); } },
    });
    c.on((ev) => {
      const db = read();
      const s = db.sessions[saved.id];
      if (!s) return;
      s.events.push(ev);
      s.lastActiveAt = Date.now();
      if (ev.type === 'turnStart') { c.status = 'working'; s.agent = picked.mode; s.variant = picked.effort === 'default' ? '' : picked.effort; }
      if (ev.type === 'permission') { asking++; c.status = 'waiting'; c.waitingTool = ev.request.tool; c.waitingKind = 'permission'; }
      if (ev.type === 'question') { asking++; c.status = 'waiting'; c.waitingTool = 'question'; c.waitingKind = 'question'; }
      if ((ev.type === 'permissionSettled' || ev.type === 'questionSettled') && --asking <= 0) { c.status = 'working'; c.waitingTool = ''; c.waitingKind = ''; }
      if (ev.type === 'userMessage') {
        s.lastUserAt = c.lastUserAt = ev.at || Date.now();
        if (!s.title) s.title = c.title = String(ev.text).slice(0, 60);
        if (ev.messageId) current = ev.messageId;
      }
      if (ev.type === 'turnEnd') { s.lastReplyAt = c.lastReplyAt = ev.at || Date.now(); c.status = 'idle'; }
      if (ev.type === 'title') s.title = ev.title;
      write(db);
      if (['turnStart', 'turnEnd', 'permission', 'permissionSettled', 'userMessage'].includes(ev.type)) changed(saved.id);
    });
    if (DEMO) {
      Object.assign(c, {
        commands: () => COMMANDS,
        attachments: () => ({ images: true, files: true, selection: true }),
        options: () => Object.entries(OPTION_VALUES).map(([id, o]) => ({ id, name: o.name, value: picked[id], values: o.values })),
        setOption: (id, value) => { if (OPTION_VALUES[id]) picked[id] = value; },
      });
    }
    const send = c.send;
    let said = 0;
    c.send = (text, extra) => {
      const demo = /^Demo: ([\w-]+)/.exec(String(text));
      if (demo && DEMOS[demo[1]]) c.script(DEMOS[demo[1]]());
      const m = /^Say: ([\s\S]+)$/.exec(String(text));
      if (!m) {
        const steps = !demo && answer(String(text), extra);
        if (steps) c.script(steps);
        return send.call(c, text, extra);
      }
      const turnId = `say-${++said}`;
      setTimeout(() => {
        c.emit({ type: 'turnStart', turnId });
        c.emit({ type: 'userMessage', text: String(text), messageId: messageId() });
        for (let i = 0; i < m[1].length; i += 24) c.emit({ type: 'text', delta: m[1].slice(i, i + 24) });
        c.emit({ type: 'turnEnd', turnId, reason: 'endTurn' });
      }, 60);
      return Promise.resolve();
    };
    const dispose = c.dispose;
    c.dispose = () => { live.delete(saved.id); dispose.call(c); };
    live.set(saved.id, c);
    return c;
  }

  const row = (s) => {
    const c = live.get(s.id);
    const out = { id: s.id, title: s.title, cwd: s.cwd, lastActiveAt: s.lastActiveAt, status: c ? c.status : 'idle', lastUserAt: s.lastUserAt, lastReplyAt: s.lastReplyAt, open: !!c };
    if (c && c.status === 'waiting') out.waitingFor = c.waitingKind === 'question' ? { kind: 'question', tool: '' } : { kind: 'permission', tool: c.waitingTool };
    return out;
  };
  const session = (id) => {
    const db = read();
    const s = db.sessions[id];
    if (!s) throw new Error(`no session ${id}`);
    return { db, s };
  };

  return {
    /* Reports an OpenCode 2, so the extension does not say the work plan needs a newer one. */
    detect: () => ({ path: '/fake/opencode', version: { major: 2, minor: 0, patch: 0, text: '2.0.0-fake' }, line: 2 }),
    listSessions: async () => Object.values(read().sessions).filter((s) => !s.parent).map(row).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    isChild: (id) => !!(read().sessions[id] || {}).parent,
    onDidChangeSessions(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    async createSession(cwd, { model } = {}) {
      const db = read();
      const now = Date.now();
      const s = { id: `ses_${crypto.randomBytes(8).toString('hex')}`, title: '', cwd, lastActiveAt: now, lastUserAt: 0, lastReplyAt: 0, model: model || MODELS[0].id, events: [] };
      db.sessions[s.id] = s;
      write(db);
      changed(s.id);
      return handle(s);
    },
    async openSession(id) {
      if (live.has(id)) return live.get(id);
      const saved = read().sessions[id];
      if (!saved) throw new Error(`no session ${id}`);
      return handle(saved);
    },
    canRename: () => true,
    async renameSession(id, title) {
      const db = read();
      if (!db.sessions[id]) throw new Error(`no session ${id}`);
      db.sessions[id].title = String(title);
      write(db);
      const c = live.get(id);
      if (c) { c.title = String(title); c.emit({ type: 'title', title: String(title) }); }
      changed(id);
    },
    canFork: () => true,
    async forkSession(id) {
      const db = read();
      const from = db.sessions[id];
      if (!from) throw new Error(`no session ${id}`);
      const now = Date.now();
      const s = { ...from, id: `ses_${crypto.randomBytes(8).toString('hex')}`, title: from.title ? `${from.title} (fork)` : '', lastActiveAt: now, events: from.events.slice() };
      db.sessions[s.id] = s;
      write(db);
      changed(s.id);
      return { id: s.id, cwd: s.cwd };
    },
    canRewind: () => DEMO,
    /* Restores each file that the turns from `messageId` onward wrote to its state before the first of them, and keeps
       what they left, for rewindClear. */
    async rewindStage(id, messageId) {
      const { db, s } = session(id);
      const order = s.events.filter((e) => e.type === 'userMessage' && e.messageId).map((e) => e.messageId);
      const at = order.indexOf(messageId);
      if (at < 0) throw new Error(`no message ${messageId} in ${id}`);
      const later = new Set(order.slice(at));
      const first = new Map();
      for (const w of s.writes || []) if (later.has(w.msg) && !first.has(w.file)) first.set(w.file, w.before);
      const left = {};
      const files = [];
      for (const [file, before] of first) {
        const now = readText(file);
        left[file] = now;
        putBack(file, before);
        files.push({ file: path.relative(s.cwd, file), status: before === null ? 'deleted' : now === null ? 'added' : 'modified', additions: 0, deletions: 0 });
      }
      s.staged = { messageId, left };
      write(db);
      return { messageId, tracked: true, files };
    },
    async rewindClear(id) {
      const { db, s } = session(id);
      if (!s.staged) return;
      for (const [file, text] of Object.entries(s.staged.left)) putBack(file, text);
      delete s.staged;
      write(db);
    },
    /* Drops the message rewindStage named, with its turn and everything after it. */
    async rewindCommit(id) {
      const { db, s } = session(id);
      if (!s.staged) throw new Error(`nothing staged for ${id}`);
      const at = s.events.findIndex((e) => e.type === 'userMessage' && e.messageId === s.staged.messageId);
      let from = at;
      for (let i = at; i >= 0; i--) if (s.events[i].type === 'turnStart') { from = i; break; }
      const gone = new Set(s.events.slice(from).filter((e) => e.type === 'userMessage').map((e) => e.messageId));
      s.events = s.events.slice(0, from);
      s.writes = (s.writes || []).filter((w) => !gone.has(w.msg));
      delete s.staged;
      write(db);
      changed(id);
    },
    async userMessages(id) {
      return session(id).s.events.filter((e) => e.type === 'userMessage' && e.messageId).map((e) => ({ id: e.messageId, text: String(e.text || ''), at: e.at || 0 }));
    },
    info: () => ({ path: '/fake/opencode', version: { major: 2, minor: 0, patch: 0, text: '2.0.0-fake' }, pid: process.pid, agent: { name: 'fake' } }),
    dataPaths: async () => ({ db: file }),
    mcpList: async () => 'No MCP servers configured (the fake backend has none)',
    async deleteSession(id) { const c = live.get(id); if (c) c.dispose(); const db = read(); delete db.sessions[id]; write(db); changed(id); },
    listModels: () => MODELS,
    defaultModel: () => MODELS[0],
    bedrockStatus: () => ({ state: 'notListed', models: 0, opencodeMajor: 1, help: 'The fake backend has no Bedrock.' }),
    restart: async () => {},
    async dispose() { for (const c of [...live.values()]) c.dispose(); listeners.clear(); },
  };
}

module.exports = { createOpenCode, MODELS, PROMPTS, pngColour, received };
