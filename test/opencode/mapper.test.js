// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMapper, permissionRequest, modelsFromConfig, toProviderError, normalizeTitle, toolNameOf } = require('../../src/opencode/mapper');

const clock = () => { let t = 1000; return () => (t += 10); };

test('a live turn: user message, reasoning, text, a tool call and its result, usage, end', () => {
  const m = createMapper({ now: clock() });
  const evs = [
    ...m.begin('t1', 'list the files', 500, 'amazon-bedrock/us.xai.grok-4.7'),
    ...m.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I will run ls.' } }),
    ...m.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'execute', status: 'pending', rawInput: {} }),
    ...m.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'ls -la', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls -la' } }),
    ...m.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'total 0' } }] }),
    ...m.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'It is empty.' } }),
    ...m.update({ sessionUpdate: 'usage_update', used: 24000, size: 500000, cost: { amount: 0.1, currency: 'USD' } }),
    ...m.end({ stopReason: 'end_turn', usage: { inputTokens: 24000, outputTokens: 50, cachedReadTokens: 29 } }),
  ];
  assert.deepEqual(evs.map((e) => e.type), ['turnStart', 'userMessage', 'reasoning', 'toolCall', 'toolResult', 'text', 'usage', 'usage', 'turnEnd']);
  assert.equal(evs[0].modelId, 'amazon-bedrock/us.xai.grok-4.7');
  assert.deepEqual(evs[3], { type: 'toolCall', id: 'c1', name: 'bash', input: { command: 'ls -la' }, at: evs[3].at });
  assert.equal(evs[4].content, 'total 0');
  assert.equal(evs[4].isError, false);
  assert.equal(evs[6].contextUsed, 24000);
  assert.equal(evs[6].costUsd, 0.1);
  assert.equal(evs[7].input, 24000);
  assert.equal(evs[7].cacheRead, 29);
  assert.equal(evs[7].contextUsed, 24000);
  assert.equal(evs[7].costUsd, undefined);
  assert.equal(evs[8].reason, 'endTurn');
  assert.equal(m.contextWindow, 500000);
  assert.equal(m.inTurn, false);
});

test('usage_update cost is a running total; each event carries the difference', () => {
  const m = createMapper({ now: clock() });
  m.begin('t', 'x');
  const a = m.update({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.25 } })[0];
  const b = m.update({ sessionUpdate: 'usage_update', used: 0, size: 100, cost: { amount: 0.4 } })[0];
  assert.equal(a.costUsd, 0.25);
  assert.ok(Math.abs(b.costUsd - 0.15) < 1e-12);
  assert.equal(b.contextUsed, 10, 'a zero `used` keeps the last known context');
});

test('stop reasons and errors end a turn the way contracts.js names them', () => {
  const cases = [['end_turn', 'endTurn'], ['max_tokens', 'maxTokens'], ['max_turn_requests', 'maxTokens'], ['refusal', 'refused'], ['cancelled', 'aborted']];
  for (const [stop, reason] of cases) {
    const m = createMapper({ now: clock() });
    m.begin('t', 'x');
    assert.equal(m.end({ stopReason: stop }).pop().reason, reason, stop);
  }
  const m = createMapper({ now: clock() });
  m.begin('t', 'x');
  const end = m.end(null, { message: 'Authentication required: provider authentication required', code: -32000 }).pop();
  assert.equal(end.reason, 'error');
  assert.equal(end.error.kind, 'auth');
  assert.equal(m.end({ stopReason: 'end_turn' }).length, 0, 'nothing to end twice');
});

test('a failed tool call is an error result', () => {
  const m = createMapper({ now: clock() });
  m.begin('t', 'x');
  m.update({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'bash', kind: 'execute', status: 'pending' });
  const evs = m.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'failed', rawInput: { command: 'rm x' }, rawOutput: { error: 'The user rejected permission' } });
  assert.deepEqual(evs.map((e) => e.type), ['toolCall', 'toolResult']);
  assert.equal(evs[1].isError, true);
  assert.match(evs[1].content, /rejected/);
});

test('permission requests: commands, edits with their diff, new files, reads and the rest', () => {
  const cmd = permissionRequest({ toolCallId: 'a', title: 'ls -la', kind: 'execute', rawInput: { command: 'ls -la' } }, 'bash');
  assert.deepEqual(cmd, { kind: 'command', tool: 'bash', summary: 'Run ls -la', command: 'ls -la' });
  const edit = permissionRequest({ kind: 'edit', title: '/p/a.txt', rawInput: { filepath: '/p/a.txt', diff: '...' },
    content: [{ type: 'diff', path: '/p/a.txt', oldText: 'hello world', newText: 'hello there' }] }, 'edit');
  assert.equal(edit.kind, 'edit');
  assert.deepEqual(edit.diff, { path: '/p/a.txt', before: 'hello world', after: 'hello there' });
  const write = permissionRequest({ kind: 'edit', content: [{ type: 'diff', path: '/p/b.txt', oldText: '', newText: 'x' }] }, 'write');
  assert.equal(write.kind, 'write');
  assert.equal(write.summary, 'Write /p/b.txt');
  const read = permissionRequest({ kind: 'read', title: 'read', rawInput: { filePath: '/etc/hosts' } }, 'read');
  assert.equal(read.kind, 'read-outside');
  assert.equal(read.path, '/etc/hosts');
  const other = permissionRequest({ kind: 'fetch', title: 'https://example.com', rawInput: { url: 'https://example.com' } }, 'webfetch');
  assert.equal(other.kind, 'other');
  assert.equal(other.summary, 'https://example.com');
});

test('a permission before the tool call was announced still shows the call first', () => {
  const m = createMapper({ now: clock() });
  m.begin('t', 'x');
  const r = m.permission('p1', { toolCallId: 'c9', title: 'ls', kind: 'execute', rawInput: { command: 'ls' } });
  assert.deepEqual(r.events.map((e) => e.type), ['toolCall', 'permission']);
  assert.equal(r.events[1].requestId, 'p1');
  assert.equal(r.tool, 'ls');
  assert.equal(toolNameOf({ title: 'ls -la', kind: 'execute' }), 'bash');
  assert.equal(toolNameOf({ name: 'shell', title: 'ls -la', kind: 'execute' }), 'shell');
  assert.equal(toolNameOf({ title: '/p/a.txt', kind: 'edit' }), 'edit');
  assert.deepEqual(m.settled('p1', 'deny'), [{ type: 'permissionSettled', requestId: 'p1', decision: 'deny' }]);
});

test('a replayed history splits into turns at each user message', () => {
  const m = createMapper({ now: clock() });
  m.replayStart();
  const evs = [
    ...m.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first ' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } }),
    ...m.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer one' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second' } }),
    ...m.update({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'bash', kind: 'execute', status: 'completed', rawInput: { command: 'ls' }, content: [] }),
    ...m.replayEnd(),
  ];
  assert.deepEqual(evs.map((e) => e.type), ['turnStart', 'userMessage', 'text', 'turnEnd', 'turnStart', 'userMessage', 'toolCall', 'toolResult', 'turnEnd']);
  assert.equal(evs[1].text, 'first question');
  assert.equal(evs[5].text, 'second');
  assert.equal(m.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } }).length, 0, 'live user chunks are ignored');
});

test('models come from the model config option; the context window once usage reported it', () => {
  const { models, current } = modelsFromConfig([{ id: 'model', category: 'model', type: 'select', currentValue: 'opencode/big-pickle', options: [
    { value: 'amazon-bedrock/us.xai.grok-4.7', name: 'Amazon Bedrock/Grok 4.7 (US)' },
    { group: 'g', name: 'Group', options: [{ value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' }] },
  ] }], { 'amazon-bedrock/us.xai.grok-4.7': 500000 });
  assert.equal(current, 'opencode/big-pickle');
  assert.equal(models.length, 2);
  assert.deepEqual(
    { id: models[0].id, invokeId: models[0].invokeId, providerId: models[0].providerId, name: models[0].name, vendor: models[0].vendor, contextWindow: models[0].contextWindow, known: models[0].known },
    { id: 'amazon-bedrock/us.xai.grok-4.7', invokeId: 'us.xai.grok-4.7', providerId: 'amazon-bedrock', name: 'Grok 4.7 (US)', vendor: 'Amazon Bedrock', contextWindow: 500000, known: false },
  );
  assert.equal(models[1].contextWindow, 0);
  assert.deepEqual(modelsFromConfig(null), { models: [], current: '' });
});

test('error messages map to ProviderError kinds; default titles are blank', () => {
  assert.equal(toProviderError('ThrottlingException: Too many requests').kind, 'throttled');
  assert.equal(toProviderError("You don't have access to the model with the specified model ID.").kind, 'modelNotEnabled');
  assert.equal(toProviderError('Internal error: The provided model identifier is invalid.').kind, 'modelNotEnabled');
  assert.equal(toProviderError('prompt is too long: 300000 tokens').kind, 'contextTooLong');
  assert.equal(toProviderError('AWS default credential chain failed: Could not load credentials').kind, 'auth');
  assert.equal(toProviderError('socket hang up').kind, 'unavailable');
  assert.equal(normalizeTitle('New session - 2026-11-24T06:23:04.066Z'), '');
  assert.equal(normalizeTitle(' Counting files '), 'Counting files');
});

test('text for the model only becomes a synthetic userMessage and starts no turn', () => {
  const m = createMapper({ now: clock() });
  m.replayStart();
  const forModel = { audience: ['assistant'] };
  const evs = [
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Reply OK.' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: '[work plan] 1 open', annotations: forModel } }),
    ...m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'OK' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: '[work plan] turn ended', annotations: forModel } }),
    ...m.replayEnd(),
  ];
  assert.deepEqual(evs.map((e) => [e.type, e.text || e.delta || '', e.synthetic || false]), [
    ['turnStart', '', false],
    ['userMessage', 'Reply OK.', false],
    ['userMessage', '[work plan] 1 open', true],
    ['text', 'OK', false],
    ['userMessage', '[work plan] turn ended', true],
    ['turnEnd', '', false],
  ]);
  const live = createMapper({ now: clock() });
  live.begin('t', 'hi');
  assert.deepEqual(live.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'note', annotations: forModel } }).map((e) => [e.type, e.synthetic]), [['userMessage', true]]);
});

test('replayed user chunks with one messageId are one message, a new id is a new turn', () => {
  const m = createMapper({ now: clock() });
  m.replayStart();
  const evs = [
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'a' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'b' } }),
    ...m.replayEnd(),
  ];
  assert.deepEqual(evs.map((e) => e.type), ['turnStart', 'userMessage', 'turnEnd', 'turnStart', 'userMessage', 'turnEnd']);
});

test('usage carries the context window usage_update reported, on its own event and on the one at the turn\'s end', () => {
  const m = createMapper({ now: clock() });
  m.begin('t1', 'hi', 500, 'amazon-bedrock/us.xai.grok-4.7');
  const first = m.update({ sessionUpdate: 'usage_update', used: 24000, size: 500000 })[0];
  assert.equal(first.contextWindow, 500000);
  const end = m.end({ stopReason: 'end_turn', usage: { inputTokens: 23000, outputTokens: 1000 } });
  assert.equal(end.find((e) => e.type === 'usage').contextWindow, 500000);
  const bare = createMapper({ now: clock() });
  bare.begin('t2', 'hi', 500);
  assert.equal('contextWindow' in bare.update({ sessionUpdate: 'usage_update', used: 10 })[0], false);
});

test('a user chunk that is the work plan plugin\'s <system-update> note is synthetic and starts no turn', () => {
  const m = createMapper({ now: clock() });
  m.replayStart();
  const evs = [
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'first' } }),
    ...m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'ok' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'n1', content: { type: 'text', text: '<system-update>\nThis turn is ending with 1 row still `doing`' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'n1', content: { type: 'text', text: ' ... </system-update>' } }),
    ...m.update({ sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: 'second' } }),
    ...m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: { type: 'text', text: 'two' } }),
    ...m.replayEnd(),
  ];
  assert.deepEqual(evs.filter((e) => e.type === 'userMessage').map((e) => [e.text.slice(0, 15), !!e.synthetic]),
    [['first', false], ['<system-update>', true], [' ... </system-u', true], ['second', false]]);
  assert.equal(evs.filter((e) => e.type === 'turnStart').length, 2);
  const live = createMapper({ now: clock() });
  live.begin('t1', 'hi', 500);
  const note = live.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<system-update> x </system-update>' } });
  assert.deepEqual(note.map((e) => [e.type, e.synthetic]), [['userMessage', true]]);
});
