// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * src/host/retitle.js: the requests the plugin's set_title tool writes in <plans>/retitle/, taken by the window that has
 * the conversation open and saw its own set_title call, and the answers written back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRetitles, cleanTitle } = require('../../src/host/retitle');
const marks = require('../../src/shared/title-marks');

const A = 'ses_retitlehost0000000000a';
const B = 'ses_retitlehost0000000000b';
const KEY = '19c3f0a1b2c3abcdef12';

function conversation() {
  const listeners = new Set();
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(ev) { for (const fn of listeners) fn(ev); },
  };
}

function setup({ open = [A], rename, confirmMs = 200, now } = {}) {
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'na-retitle-'));
  const dir = path.join(plans, 'retitle');
  fs.mkdirSync(dir);
  const renamed = [];
  const r = createRetitles({
    dir: () => plans,
    ids: () => open,
    rename: rename || (async (id, title) => { renamed.push([id, title]); }),
    strip: (t) => marks.withoutMarks(t),
    confirmMs,
    pollMs: 60000,
    ...(now ? { now } : {}),
  });
  const ask = (body, key = KEY) => fs.writeFileSync(path.join(dir, `${key}.json`),
    JSON.stringify({ format: 1, key, agent: 'OpenCode', sessionId: A, title: 'Parser rewrite', at: Date.now(), via: 'tool', ...body }));
  const answer = (key = KEY) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${key}.result.json`), 'utf8')); } catch (_) { return null; } };
  return { plans, dir, r, renamed, ask, answer, names: () => fs.readdirSync(dir).sort() };
}

test('a request from a conversation open here, whose own set_title call was seen, is renamed and answered', async () => {
  const t = setup();
  const conv = conversation();
  t.r.track(A, conv);
  conv.emit({ type: 'toolCall', id: 'c1', name: 'set_title', input: { title: '  Parser   rewrite 📩 ' } });
  t.ask({ title: '  Parser   rewrite 📩 ' });
  await t.r.take(`${KEY}.json`);
  const a = t.answer();
  assert.deepEqual([a.format, a.key, a.outcome, a.reason, a.title], [1, KEY, 'done', '', 'Parser rewrite']);
  assert.deepEqual(t.renamed, [[A, 'Parser rewrite']], 'the title is cleaned of its marks and extra spaces');
  assert.deepEqual(t.names(), [`${KEY}.result.json`], 'the claimed request is gone once answered');
});

test('a request whose call this window did not see is refused, and one for a conversation not open here is left alone', async () => {
  const t = setup();
  t.r.track(A, conversation());
  t.ask({});
  await t.r.take(`${KEY}.json`);
  assert.equal(t.answer().outcome, 'refused');
  assert.match(t.answer().reason, /did not see the conversation ask for that title itself/);
  assert.deepEqual(t.renamed, []);

  const u = setup({ open: [A] });
  u.ask({ sessionId: B });
  await u.r.take(`${KEY}.json`);
  assert.deepEqual(u.names(), [`${KEY}.json`], 'left for the window that has it open');
});

test('a call with another title does not confirm a request, a call of another tool neither', async () => {
  const t = setup();
  const conv = conversation();
  t.r.track(A, conv);
  conv.emit({ type: 'toolCall', id: 'c1', name: 'set_title', input: { title: 'Something else' } });
  conv.emit({ type: 'toolCall', id: 'c2', name: 'set_row', input: { title: 'Parser rewrite' } });
  t.ask({});
  await t.r.take(`${KEY}.json`);
  assert.equal(t.answer().outcome, 'refused');
});

test('a title that is only marks is refused, and a rename that throws is answered as failed', async () => {
  const t = setup();
  const conv = conversation();
  t.r.track(A, conv);
  conv.emit({ type: 'toolCall', id: 'c1', name: 'set_title', input: { title: ' 📩 ' } });
  t.ask({ title: ' 📩 ' });
  await t.r.take(`${KEY}.json`);
  assert.equal(t.answer().outcome, 'refused');

  const u = setup({ rename: async () => { throw new Error('OpenCode did not rename the conversation: busy.'); } });
  const c2 = conversation();
  u.r.track(A, c2);
  c2.emit({ type: 'toolCall', id: 'c1', name: 'set_title', input: { title: 'Parser rewrite' } });
  u.ask({});
  await u.r.take(`${KEY}.json`);
  assert.deepEqual([u.answer().outcome, u.answer().reason], ['failed', 'OpenCode did not rename the conversation: busy']);
});

test('requests from other agents and files of another format are not taken; leftovers older than ten minutes go', async () => {
  let clock = Date.now();
  const t = setup({ now: () => clock });
  const conv = conversation();
  t.r.track(A, conv);
  t.ask({ agent: 'Codex' });
  await t.r.take(`${KEY}.json`);
  assert.deepEqual(t.names(), [`${KEY}.json`]);
  fs.writeFileSync(path.join(t.dir, 'aaaaaaaaaaaa.result.json'), '{}');
  clock += 11 * 60 * 1000;
  t.r.scan();
  assert.deepEqual(t.names(), [`${KEY}.json`], 'an old answer nobody read is removed; the request stays for its own window');
});

test('the title is cut at 80 characters and runs of white space become one space', () => {
  assert.equal(cleanTitle(`a\t\nb${'x'.repeat(200)}`), `a b${'x'.repeat(77)}`);
  assert.equal(cleanTitle('👑 Release notes'), 'Release notes');
});
