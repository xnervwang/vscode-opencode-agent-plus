// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('../../src/ui/view-model');

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const GROK = { id: 'us.xai.grok-4.7', name: 'Grok 4.7', vendor: 'xAI', contextWindow: 200000 };

function run(events, opts = {}) {
  let s = vm.initialState();
  if (opts.model !== null) s = vm.reduce(s, { type: 'ui.model', model: opts.model || GROK });
  let t = T0;
  for (const ev of events) {
    t += 1000;
    s = vm.reduce(s, ev, t);
  }
  return s;
}

const kinds = (s) => s.items.map((i) => i.kind);

test('text deltas stream into one reply item, reasoning into its own', () => {
  const s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'userMessage', text: 'hi', at: T0 },
    { type: 'reasoning', delta: 'Think' },
    { type: 'reasoning', delta: 'ing.' },
    { type: 'text', delta: 'Hel' },
    { type: 'text', delta: 'lo' },
  ]);
  assert.deepEqual(kinds(s), ['user', 'reasoning', 'text']);
  assert.equal(s.items[1].text, 'Thinking.');
  assert.equal(s.items[2].text, 'Hello');
  assert.equal(s.items[2].at, T0 + 5000, 'a reply block takes the time its first delta arrived');
  assert.equal(s.status, 'working');
});

test('changed items are found by identity, untouched ones keep theirs', () => {
  const a = run([{ type: 'turnStart', turnId: 't1', at: T0 }, { type: 'userMessage', text: 'q', at: T0 }, { type: 'text', delta: 'A' }]);
  const b = vm.reduce(a, { type: 'text', delta: 'B' }, T0 + 9000);
  assert.equal(b.items[0], a.items[0]);
  const changed = vm.changedItems(a, b);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].text, 'AB');
  assert.deepEqual(vm.changedItems(null, b).map((i) => i.id), ['i1', 'i2']);
});

test('tool calls become cards that take their result, and an error marks the card', () => {
  const s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'userMessage', text: 'run tests', at: T0 },
    { type: 'text', delta: 'Running.' },
    { type: 'toolCall', id: 'c1', name: 'bash', input: { command: 'npm test\necho done' }, at: T0 + 2000 },
    { type: 'toolCall', id: 'c2', name: 'read_file', input: { path: 'a.js', offset: 10, limit: 5 }, at: T0 + 2500 },
    { type: 'toolResult', id: 'c1', content: 'fail: 1', isError: true, at: T0 + 4000 },
    { type: 'toolResult', id: 'c2', content: '10\tx', isError: false, at: T0 + 4100 },
    { type: 'text', delta: 'One failed.' },
  ]);
  assert.deepEqual(kinds(s), ['user', 'text', 'tool', 'tool', 'text']);
  const [bash, read] = [s.items[2], s.items[3]];
  assert.equal(bash.name, 'bash');
  assert.equal(bash.summary, 'npm test');
  assert.equal(bash.state, 'error');
  assert.equal(bash.result, 'fail: 1');
  assert.equal(bash.at, T0 + 2000);
  assert.equal(bash.doneAt, T0 + 4000);
  assert.match(bash.input, /"command": "npm test\\necho done"/);
  assert.equal(read.summary, 'a.js:10-14');
  assert.equal(read.state, 'done');
  assert.equal(s.items[4].text, 'One failed.', 'text after a tool card starts a new block');
});

test('long tool results are clipped with a count of what was left out', () => {
  const s = run([
    { type: 'toolCall', id: 'c1', name: 'bash', input: { command: 'cat big' }, at: T0 },
    { type: 'toolResult', id: 'c1', content: 'x'.repeat(20010), isError: false, at: T0 },
  ]);
  assert.match(s.items[0].result, /… \(10 more characters\)$/);
});

test('a permission request waits for the user and settles with the decision', () => {
  const diff = { path: 'src/a.js', before: 'old', after: 'new' };
  let s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'toolCall', id: 'c1', name: 'edit_file', input: { path: 'src/a.js' }, at: T0 },
    { type: 'permission', requestId: 'r1', request: { kind: 'edit', tool: 'edit_file', summary: 'Edit src/a.js', path: 'src/a.js', diff } },
  ]);
  assert.equal(s.status, 'waiting');
  const card = s.items[1];
  assert.equal(card.kind, 'permission');
  assert.equal(card.decision, null);
  assert.equal(card.request.hasDiff, true);
  assert.equal(card.request.diff, undefined, 'the diff texts stay out of the posted item');
  assert.deepEqual(s.diffs.r1, diff);
  assert.equal(vm.head(s).pending, 1);

  s = vm.reduce(s, { type: 'permissionSettled', requestId: 'r1', decision: 'allowSession' }, T0 + 9000);
  assert.equal(s.items[1].decision, 'allowSession');
  assert.equal(s.status, 'working');
  assert.deepEqual(s.pending, {});
  assert.deepEqual(s.diffs.r1, diff, 'the diff can still be viewed after the answer');
});

test('ending a turn cancels open permission requests and stops running tools', () => {
  const s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'toolCall', id: 'c1', name: 'bash', input: { command: 'sleep 100' }, at: T0 },
    { type: 'permission', requestId: 'r1', request: { kind: 'command', tool: 'bash', summary: 'Run sleep 100', command: 'sleep 100' } },
    { type: 'turnEnd', turnId: 't1', reason: 'aborted', at: T0 + 5000 },
  ]);
  assert.equal(s.items[0].state, 'aborted');
  assert.equal(s.items[1].decision, 'cancelled');
  assert.equal(s.status, 'idle');
  assert.deepEqual(kinds(s), ['tool', 'permission', 'notice', 'figures']);
  assert.equal(s.items[2].text, 'Stopped.');
});

test('a message sent while working shows as queued until its turn starts', () => {
  let s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'userMessage', text: 'first', at: T0 },
    { type: 'text', delta: 'working on it' },
  ]);
  s = vm.reduce(s, { type: 'ui.queued', text: 'second' }, T0 + 5000);
  s = vm.reduce(s, { type: 'ui.queued', text: 'third' }, T0 + 5100);
  assert.deepEqual(vm.head(s).queued.map((q) => q.text), ['second', 'third']);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 1);

  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: T0 + 6000 }, T0 + 6000);
  s = vm.reduce(s, { type: 'turnStart', turnId: 't2', at: T0 + 6001 }, T0 + 6001);
  s = vm.reduce(s, { type: 'userMessage', text: 'second', at: T0 + 6001 }, T0 + 6001);
  assert.deepEqual(vm.head(s).queued.map((q) => q.text), ['third']);
  assert.equal(s.items[s.items.length - 1].text, 'second');
  assert.equal(s.items[s.items.length - 1].kind, 'user');
});

test('a retry shows until the stream resumes', () => {
  let s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'retry', attempt: 2, waitMs: 4000, error: { kind: 'throttled', message: 'Too many requests' } },
  ]);
  const h = vm.head(s);
  assert.equal(h.retry.attempt, 2);
  assert.equal(h.retry.waitMs, 4000);
  assert.equal(h.retry.error, 'Throttled: Too many requests');
  assert.equal(h.retry.at, T0 + 2000);
  assert.equal(h.status, 'working');
  s = vm.reduce(s, { type: 'text', delta: 'back' }, T0 + 7000);
  assert.equal(vm.head(s).retry, null);
});

test('reply figures: duration, context share, cost so far and model', () => {
  const s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'userMessage', text: 'one', at: T0 },
    { type: 'usage', input: 60000, output: 1000, contextUsed: 61000, costUsd: 0.25 },
    { type: 'usage', input: 65000, output: 1000, contextUsed: 66000, costUsd: 0.17 },
    { type: 'text', delta: 'done' },
    { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: T0 + 130000 },
  ]);
  const f = s.items[s.items.length - 1];
  assert.equal(f.kind, 'figures');
  assert.equal(f.durationMs, 130000);
  assert.equal(f.contextPct, 33);
  assert.ok(Math.abs(f.costUsd - 0.42) < 1e-9);
  assert.equal(f.model, 'grok-4.7');
  assert.equal(f.text, '2m10s · ctx 33% · $0.42 · grok-4.7');

  const s2 = vm.reduceAll([
    { type: 'turnStart', turnId: 't2', at: T0 + 200000 },
    { type: 'usage', input: 70000, output: 500, contextUsed: 70500, costUsd: 0.08 },
    { type: 'turnEnd', turnId: 't2', reason: 'endTurn', at: T0 + 205000 },
  ], s);
  const f2 = s2.items[s2.items.length - 1];
  assert.ok(Math.abs(f2.turnCostUsd - 0.08) < 1e-9, 'the turn cost is its own');
  assert.ok(Math.abs(f2.costUsd - 0.5) < 1e-9, 'the shown cost is the conversation so far');
  assert.equal(f2.text, '5s · ctx 35% · $0.50 · grok-4.7');
});

test('figures leave out what is unknown: no price, no context window', () => {
  const s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'usage', input: 1500, output: 20, contextUsed: 1520 },
    { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: T0 + 3000 },
  ], { model: { id: 'deepseek.v3.2' } });
  const f = s.items[s.items.length - 1];
  assert.equal(f.costUsd, null);
  assert.equal(f.contextPct, null);
  assert.equal(f.text, '3s · ctx 1.5k · v3.2');
  assert.equal(vm.head(s).costUsd, null);
});

test('turn errors and end reasons leave a notice', () => {
  const s = run([
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'turnEnd', turnId: 't1', reason: 'error', at: T0 + 1000, error: { kind: 'modelNotEnabled', message: 'Enable it in the console.' } },
    { type: 'turnStart', turnId: 't2', at: T0 + 2000 },
    { type: 'text', delta: 'partial' },
    { type: 'turnEnd', turnId: 't2', reason: 'maxTokens', at: T0 + 3000 },
  ]);
  const notices = s.items.filter((i) => i.kind === 'notice');
  assert.equal(notices[0].level, 'error');
  assert.equal(notices[0].text, 'Model not enabled: Enable it in the console.');
  assert.equal(notices[1].level, 'info');
  assert.match(notices[1].text, /output limit/);
});

test('head reports the context ring and the title', () => {
  const s = run([
    { type: 'title', title: 'Fix the sum test' },
    { type: 'turnStart', turnId: 't1', at: T0 },
    { type: 'usage', input: 170000, output: 2000, contextUsed: 172000, costUsd: 1.5 },
  ]);
  const h = vm.head(s);
  assert.equal(h.title, 'Fix the sum test');
  assert.equal(h.contextPct, 86);
  assert.equal(h.contextText, '172.0k of 200.0k tokens');
  assert.equal(h.costText, '$1.50');
  assert.equal(h.model.short, 'grok-4.7');
  assert.equal(h.turnStartedAt, T0);
});

test('a saved session is restored with its turns, tool cards and figures', () => {
  const records = [
    { kind: 'meta', format: 1, id: 's1', cwd: '/w', createdAt: T0, providerId: 'bedrock', modelId: 'us.xai.grok-4.7', title: 'Old chat' },
    { kind: 'message', at: T0 + 1000, message: { role: 'user', content: [{ type: 'text', text: 'read a.js' }] } },
    {
      kind: 'message', at: T0 + 5000, message: {
        role: 'assistant', content: [
          { type: 'reasoning', text: 'Need the file.', providerId: 'bedrock', opaque: 'sig' },
          { type: 'text', text: 'Reading it.' },
          { type: 'toolUse', id: 'u1', name: 'read_file', input: { path: 'a.js' } },
        ],
      },
    },
    { kind: 'usage', at: T0 + 5000, input: 9000, output: 200, cacheRead: 800 },
    {
      kind: 'message', at: T0 + 6000, message: {
        role: 'user', content: [{ type: 'toolResult', toolUseId: 'u1', content: [{ type: 'text', text: '1\tok' }] }],
      },
    },
    { kind: 'message', at: T0 + 9000, message: { role: 'assistant', content: [{ type: 'text', text: 'It says ok.' }] } },
    { kind: 'usage', at: T0 + 9000, input: 9400, output: 100, costUsd: 0.03 },
    { kind: 'title', at: T0 + 9500, title: 'Reading a.js' },
    { kind: 'model', at: T0 + 9600, providerId: 'bedrock', modelId: 'deepseek.v3.2' },
    { kind: 'message', at: T0 + 20000, message: { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }] } },
    { kind: 'message', at: T0 + 22000, message: { role: 'assistant', content: [{ type: 'text', text: 'Welcome.' }] } },
  ];
  const windows = { 'us.xai.grok-4.7': 200000, 'deepseek.v3.2': 128000 };
  const s = vm.fromRecords(records, { modelInfo: (p, id) => ({ id, contextWindow: windows[id] }) });
  assert.deepEqual(kinds(s), ['user', 'reasoning', 'text', 'tool', 'text', 'figures', 'user', 'text', 'figures']);
  assert.equal(s.title, 'Reading a.js');
  assert.equal(s.status, 'idle');
  const tool = s.items[3];
  assert.equal(tool.state, 'done');
  assert.equal(tool.result, '1\tok');
  assert.equal(tool.summary, 'a.js');
  const f1 = s.items[5];
  assert.equal(f1.durationMs, 8000, 'a restored turn ends at its last record');
  assert.equal(f1.model, 'grok-4.7');
  assert.equal(f1.contextUsed, 9500);
  assert.equal(f1.text, '8s · ctx 5% · $0.03 · grok-4.7');
  assert.equal(s.items[6].text, 'thanks\n[1 image]');
  assert.equal(s.items[8].model, 'v3.2', 'the model record changes the model of later turns');
  assert.equal(s.items[8].durationMs, 2000);
});

test('restoring tolerates junk and an empty file', () => {
  assert.deepEqual(vm.fromRecords([]).items, []);
  assert.deepEqual(vm.fromRecords(null).items, []);
  const s = vm.fromRecords([null, { kind: 'weird' }, { kind: 'message', at: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }]);
  assert.deepEqual(kinds(s), ['text', 'figures']);
});

test('formatting helpers', () => {
  assert.equal(vm.fmtDuration(400), '0s');
  assert.equal(vm.fmtDuration(59400), '59s');
  assert.equal(vm.fmtDuration(65000), '1m05s');
  assert.equal(vm.fmtDuration(3723000), '1h02m');
  assert.equal(vm.fmtCost(0.004), '$0.004');
  assert.equal(vm.fmtCost(12.345), '$12.35');
  assert.equal(vm.shortModel('us.xai.grok-4.7'), 'grok-4.7');
  assert.equal(vm.shortModel('global.anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
  assert.equal(vm.shortModel('qwen.qwen3-coder-30b-a3b-v1:0'), 'qwen3-coder-30b-a3b');
  assert.equal(vm.shortModel('openai.gpt-oss-120b-1:0'), 'gpt-oss-120b');
  assert.equal(vm.shortModel('moonshotai.kimi-k2.5'), 'kimi-k2.5');
  assert.equal(vm.summarizeInput('glob', { pattern: '**/*.js', path: 'src' }), '**/*.js  in src');
  assert.equal(vm.summarizeInput('x', { query: 'hello' }), 'hello');
  assert.equal(vm.summarizeInput('x', { n: 3 }), '{"n":3}');
});

test('unknown events and actions leave the state as it was', () => {
  const s = run([{ type: 'turnStart', turnId: 't1', at: T0 }]);
  assert.equal(vm.reduce(s, { type: 'somethingNew' }, T0), s);
  assert.equal(vm.reduce(s, null, T0), s);
  assert.equal(vm.reduce(s, { type: 'permissionSettled', requestId: 'nope', decision: 'deny' }, T0), s);
});

test('turnStart.modelId names the model of the turn; a later ui.model for it brings the context window', () => {
  let s = vm.initialState();
  s = vm.reduce(s, { type: 'ui.model', model: { id: 'amazon-bedrock/us.xai.grok-4.7', name: 'Grok 4.7', contextWindow: 500000 } }, 1000);
  s = vm.reduce(s, { type: 'turnStart', turnId: 't1', at: 1000, modelId: 'amazon-bedrock/us.anthropic.claude-haiku-4-5' }, 1000);
  assert.equal(s.model.id, 'amazon-bedrock/us.anthropic.claude-haiku-4-5');
  assert.equal(s.turn.modelId, 'amazon-bedrock/us.anthropic.claude-haiku-4-5');
  assert.equal(s.turn.contextWindow, 0);
  s = vm.reduce(s, { type: 'ui.model', model: { id: 'amazon-bedrock/us.anthropic.claude-haiku-4-5', name: 'Haiku', contextWindow: 200000 } }, 1100);
  assert.equal(s.turn.contextWindow, 200000);
  s = vm.reduce(s, { type: 'usage', input: 1000, output: 100, contextUsed: 20000 }, 1200);
  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 2000 }, 2000);
  const fig = s.items.find((i) => i.kind === 'figures');
  assert.equal(fig.contextPct, 10);
  const same = vm.reduce(s, { type: 'turnStart', turnId: 't2', at: 3000, modelId: 'amazon-bedrock/us.anthropic.claude-haiku-4-5' }, 3000);
  assert.equal(same.model.name, 'Haiku', 'the same model keeps what was known of it');
});

test('a synthetic user message is not drawn', () => {
  let s = vm.initialState();
  s = vm.reduce(s, { type: 'turnStart', turnId: 't1', at: 1000 }, 1000);
  s = vm.reduce(s, { type: 'userMessage', text: 'Work plan: row 3 is open', synthetic: true, at: 1000 }, 1000);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 0);
  s = vm.reduce(s, { type: 'userMessage', text: 'hello', at: 1001 }, 1001);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 1);
});

test('stopping a turn drops the queued messages from the view', () => {
  let s = vm.initialState();
  s = vm.reduce(s, { type: 'turnStart', turnId: 't1', at: 1000 }, 1000);
  s = vm.reduce(s, { type: 'ui.queued', text: 'next one' }, 1100);
  assert.equal(s.queued.length, 1);
  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'aborted', at: 1200 }, 1200);
  assert.deepEqual(s.queued, []);
  s = vm.reduce(s, { type: 'ui.queued', text: 'kept' }, 1300);
  s = vm.reduce(s, { type: 'turnEnd', reason: 'endTurn', at: 1400 }, 1400);
  assert.equal(s.queued.length, 1, 'a turn that ended by itself leaves the queue to its next turn');
});

test('a replayed turn with no time and no usage shows neither 0s nor ctx 0%', () => {
  let s = vm.initialState();
  s = vm.reduce(s, { type: 'ui.model', model: { id: 'p/m', name: 'M', contextWindow: 1000 } }, 5000);
  s = vm.reduce(s, { type: 'turnStart', turnId: 't1', at: 5000 }, 5000);
  s = vm.reduce(s, { type: 'userMessage', text: 'q', at: 5000 }, 5000);
  s = vm.reduce(s, { type: 'text', delta: 'a', at: 5000 }, 5000);
  s = vm.reduce(s, { type: 'turnEnd', turnId: 't1', reason: 'endTurn', at: 5000 }, 5000);
  const fig = s.items.find((i) => i.kind === 'figures');
  assert.equal(fig.text, 'm');
});

test('short model names for OpenCode and Bedrock ids', () => {
  const short = (id) => {
    let s = vm.reduce(vm.initialState(), { type: 'turnStart', turnId: 't', at: 1, modelId: id }, 1);
    s = vm.reduce(s, { type: 'turnEnd', turnId: 't', reason: 'endTurn', at: 2 }, 2);
    return s.items.find((i) => i.kind === 'figures').model;
  };
  assert.equal(short('amazon-bedrock/us.xai.grok-4.7'), 'grok-4.7');
  assert.equal(short('openai/gpt-5.1'), 'gpt-5.1');
  assert.equal(short('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(short('amazon-bedrock/deepseek.v3.2'), 'v3.2');
  assert.equal(short('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5-20251001');
});
