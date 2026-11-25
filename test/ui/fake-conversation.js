// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation that plays scripted AgentEvents, with the methods src/ui/chat-panel.js calls: on, send, abort,
 * setModel, dispose. Each send() plays the next script turn; a send during a turn waits in a queue, as the agent does.
 *
 * A turn is an array of steps:
 *   an AgentEvent            emitted as is; `at` is filled in where the event has one and the step has none
 *   { wait: ms }             pauses
 *   a 'permission' event     pauses until respond(requestId, decision), then emits permissionSettled
 *   a 'question' event       pauses until respondQuestion(requestId, answer), then emits questionSettled
 *   a function               called with what each request of this conversation was answered, by request id (a
 *                            permission's decision, a question's answer, null when the turn was stopped); the step or
 *                            array of steps it returns, if any, plays in its place
 * turnStart, userMessage and turnEnd ('endTurn') are added around each turn unless the turn emits them itself. The
 * turnStart added gets the fields opts.turnStart() returns at that moment, the userMessage an id from opts.messageId().
 * When the script runs out, a send plays `fallback` (by default one short text reply); script(steps) puts a turn of
 * its own first. start(steps) plays a turn the agent begins by itself, with no user message, once nothing else plays.
 */

const TIMED = new Set(['turnStart', 'userMessage', 'toolCall', 'toolResult', 'turnEnd']);

/* Splits a reply into text deltas, as a stream would deliver it. */
function streamText(text, size = 12, type = 'text') {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push({ type, delta: text.slice(i, i + size) });
  return out;
}

/* A turn that touches every kind of item the page draws. */
function demoTurns() {
  return [
    [
      ...streamText('The user wants the failing test fixed. Read the test first.', 16, 'reasoning'),
      ...streamText("I'll look at the test first.", 8),
      { type: 'toolCall', id: 'tool-1', name: 'read_file', input: { path: 'test/sum.test.js' } },
      { wait: 5 },
      { type: 'toolResult', id: 'tool-1', content: "1\tconst sum = require('../sum');\n2\tassert.equal(sum(2, 2), 4);", isError: false },
      { type: 'usage', input: 4200, output: 120, contextUsed: 4320, costUsd: 0.0123 },
      { type: 'toolCall', id: 'tool-2', name: 'edit_file', input: { path: 'sum.js', old_string: 'a - b', new_string: 'a + b' } },
      {
        type: 'permission', requestId: 'perm-1',
        request: {
          kind: 'edit', tool: 'edit_file', summary: 'Edit sum.js', path: 'sum.js',
          diff: { path: 'sum.js', before: 'module.exports = (a, b) => a - b;\n', after: 'module.exports = (a, b) => a + b;\n' },
        },
      },
      { type: 'toolResult', id: 'tool-2', content: 'Edited sum.js (1 replacement).', isError: false },
      { type: 'retry', attempt: 1, waitMs: 20, error: { kind: 'throttled', message: 'Too many requests' } },
      { wait: 20 },
      ...streamText('Fixed: `sum` subtracted instead of adding.\n\n```js\nmodule.exports = (a, b) => a + b;\n```\n', 10),
      { type: 'usage', input: 4600, output: 80, contextUsed: 4680, costUsd: 0.0131 },
    ],
  ];
}

function createFakeConversation(opts = {}) {
  const turns = (opts.turns || []).slice();
  const fallback = opts.fallback || [...streamText('OK.')];
  const stepMs = opts.stepMs || 0;
  const now = opts.now || Date.now;
  const startFields = typeof opts.turnStart === 'function' ? opts.turnStart : () => ({});
  const messageId = typeof opts.messageId === 'function' ? opts.messageId : null;
  const listeners = new Set();
  const waiting = new Map();
  /* requestId -> the decision or answer it got */
  const answered = {};
  const queue = [];
  let playing = null;
  let turnNo = 0;
  let aborted = false;

  const fake = {
    sent: [],
    aborts: 0,
    models: [],
    decisions: [],
    events: [],
    disposed: false,

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    emit(ev) {
      const out = TIMED.has(ev.type) && ev.at == null ? { ...ev, at: now() } : ev;
      fake.events.push(out);
      for (const l of [...listeners]) l(out);
      return out;
    },

    send(text) {
      fake.sent.push(text);
      return enqueue({ text });
    },

    /* A turn the agent begins by itself, as OpenCode does when a background task ends. */
    start(steps) {
      return enqueue({ steps: Array.isArray(steps) ? steps : [], own: true });
    },

    abort() {
      fake.aborts++;
      if (!playing) return;
      aborted = true;
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
    },

    setModel(model) {
      fake.models.push(model);
    },

    respond(requestId, decision) {
      fake.decisions.push({ requestId, decision });
      const resolve = waiting.get(requestId);
      if (!resolve) return false;
      waiting.delete(requestId);
      resolve(decision);
      return true;
    },

    respondQuestion(requestId, answer) {
      fake.decisions.push({ requestId, answer });
      const resolve = waiting.get(requestId);
      if (!resolve) return false;
      waiting.delete(requestId);
      resolve(answer && typeof answer === 'object' ? answer : { action: 'cancel' });
      return true;
    },

    /* The next send plays `steps` instead of the script's next turn. */
    script(steps) {
      turns.unshift(steps);
    },

    /* Resolves once nothing plays and nothing waits in the queue. */
    idle() {
      return playing ? playing.then(() => fake.idle()) : Promise.resolve();
    },

    get busy() {
      return !!playing;
    },

    dispose() {
      fake.disposed = true;
      fake.abort();
      listeners.clear();
    },
  };

  const pause = (ms) => new Promise((r) => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));

  function enqueue(job) {
    if (playing) queue.push(job);
    else playing = play(job);
    return Promise.resolve();
  }

  async function play(job) {
    const steps = job.steps || (turns.length ? turns.shift() : fallback);
    const turnId = `turn-${++turnNo}`;
    aborted = false;
    if (!steps.some((s) => s && s.type === 'turnStart')) fake.emit({ type: 'turnStart', turnId, ...startFields(), ...(job.own ? { unsolicited: true } : {}) });
    if (!job.own && !steps.some((s) => s && s.type === 'userMessage')) fake.emit({ type: 'userMessage', text: job.text, ...(messageId ? { messageId: messageId() } : {}) });
    let ended = false;
    const todo = steps.slice();
    while (todo.length && !aborted && !fake.disposed) {
      const step = todo.shift();
      if (!step) continue;
      if (typeof step === 'function') {
        const more = step(answered);
        if (more) todo.unshift(...(Array.isArray(more) ? more : [more]));
        continue;
      }
      await pause(stepMs);
      if (aborted || fake.disposed) break;
      if (typeof step.wait === 'number') {
        /* In steps of at most 100 ms, so that abort() ends a long wait. */
        for (let left = step.wait; left > 0 && !aborted && !fake.disposed; left -= 100) await pause(Math.min(left, 100));
        continue;
      }
      if (step.type === 'turnEnd') ended = true;
      if (step.type === 'permission') {
        const decided = new Promise((resolve) => waiting.set(step.requestId, resolve));
        fake.emit(step);
        const decision = await decided;
        answered[step.requestId] = decision;
        if (decision) fake.emit({ type: 'permissionSettled', requestId: step.requestId, decision });
        continue;
      }
      if (step.type === 'question') {
        const asked = new Promise((resolve) => waiting.set(step.requestId, resolve));
        fake.emit(step);
        const answer = await asked;
        answered[step.requestId] = answer;
        if (answer) fake.emit({ type: 'questionSettled', requestId: step.requestId, action: answer.action === 'accept' ? 'accept' : 'cancel' });
        continue;
      }
      fake.emit({ turnId, ...step });
    }
    if (aborted) fake.emit({ type: 'turnEnd', turnId, reason: 'aborted' });
    else if (!ended && !fake.disposed) fake.emit({ type: 'turnEnd', turnId, reason: 'endTurn' });
    await pause(0);
    playing = null;
    if (queue.length && !fake.disposed) playing = play(queue.shift());
  }

  return fake;
}

module.exports = { createFakeConversation, streamText, demoTurns };
