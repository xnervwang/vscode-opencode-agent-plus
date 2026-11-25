// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The fake backend of the window tests, with OPENCODE_AGENT_PLUS_FAKE_DEMO=1 as test/vscode/run.js starts it: what it
 * answers the prompts run.js sends, what it says a message carried, and rewinding the files a turn wrote.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-backend-test-'));
process.env.OPENCODE_AGENT_PLUS_HOME = HOME;
process.env.OPENCODE_AGENT_PLUS_FAKE_DEMO = '1';
const { createOpenCode, pngColour, received } = require('./fake-backend');
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/* A PNG of one colour whose rows use PNG filter `filter`; Sub and the others leave the first pixel as it is. */
function png(r, g, b, { filter = 0, alpha = false } = {}) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const size = 4, px = alpha ? [r, g, b, 255] : [r, g, b];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  /* Sub stores each byte less the one a pixel before it: the first pixel whole, then zeros. */
  const row = filter === 1 ? [1, ...px, ...Array(px.length * (size - 1)).fill(0)] : [0, ...Array.from({ length: size }, () => px).flat()];
  const raw = Buffer.from(Array.from({ length: size }, () => row).flat());
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
};
const folder = () => {
  const d = fs.mkdtempSync(path.join(HOME, 'ws-'));
  fs.writeFileSync(path.join(d, 'notes.txt'), 'Some notes.\n');
  return d;
};
const texts = (c) => c.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
const db = () => JSON.parse(fs.readFileSync(path.join(HOME, 'fake-backend.json'), 'utf8'));

test('names the colour of a PNG\'s first pixel, whatever filter its rows use', () => {
  assert.equal(pngColour(png(30, 80, 230)), 'blue');
  assert.equal(pngColour(png(220, 40, 40, { filter: 1 })), 'red');
  assert.equal(pngColour(png(40, 200, 60, { alpha: true })), 'green');
  assert.equal(pngColour(png(250, 250, 250)), 'white');
  assert.equal(pngColour(Buffer.from('not a png')), '');
});

test('says what a message carried, and shows it on the message as the real backend does', () => {
  const d = folder();
  const got = received({ images: [{ mediaType: 'image/png', data: png(30, 80, 230).toString('base64'), name: 'square.png' }],
    files: [{ path: path.join(d, 'notes.txt'), name: 'notes.txt' }, { path: path.join(d, 'c.txt'), name: 'c.txt', text: 'The colour is MAGENTA.', startLine: 2, endLine: 2 }] });
  assert.deepEqual(got.attachments.map((a) => [a.kind, a.name]), [['image', 'square.png'], ['file', 'notes.txt'], ['selection', 'c.txt:2']]);
  assert.match(got.lines.join('\n'), /square\.png \(image\/png\) is a blue image/);
  assert.match(got.lines.join('\n'), /notes\.txt reads: Some notes\./);
  assert.match(got.lines.join('\n'), /The selection c\.txt:2 reads: The colour is MAGENTA\./);
});

test('a turn writes files once allowed; rewinding stages them back, Cancel restores the turn\'s, Rewind drops the turn', async () => {
  const oc = createOpenCode();
  const d = folder();
  const c = await oc.createSession(d);
  await c.send('Say: first');
  await until(() => c.events.some((e) => e.type === 'turnEnd'));
  const ask = 'Use the write tool to create a file named rewind-me.txt containing exactly v1, then use the edit tool to change notes.txt so that it contains exactly: Changed notes. Then reply with only the word done.';
  await c.send(ask);
  for (let i = 0; i < 2; i++) {
    const p = await until(() => c.events.filter((e) => e.type === 'permission')[i]);
    assert.ok(p && p.request.diff, 'each change asks with a diff');
    c.respondPermission(p.requestId, 'allowOnce');
  }
  await c.idle();
  assert.equal(fs.readFileSync(path.join(d, 'rewind-me.txt'), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(d, 'notes.txt'), 'utf8'), 'Changed notes.');
  assert.match(texts(c), /done$/);
  const users = await oc.userMessages(c.id);
  assert.deepEqual(users.map((u) => u.text), ['Say: first', ask]);
  const staged = await oc.rewindStage(c.id, users[1].id);
  assert.deepEqual(staged.files.map((f) => [f.file, f.status]), [['rewind-me.txt', 'deleted'], ['notes.txt', 'modified']]);
  assert.equal(fs.existsSync(path.join(d, 'rewind-me.txt')), false);
  assert.equal(fs.readFileSync(path.join(d, 'notes.txt'), 'utf8'), 'Some notes.\n');
  await oc.rewindClear(c.id);
  assert.equal(fs.readFileSync(path.join(d, 'rewind-me.txt'), 'utf8'), 'v1', 'Cancel puts back what the turn left');
  await oc.rewindStage(c.id, users[1].id);
  await oc.rewindCommit(c.id);
  assert.deepEqual((await oc.userMessages(c.id)).map((u) => u.text), ['Say: first']);
  assert.equal((await c.reload()).some((e) => e.type === 'toolCall'), false, 'the rewound turn is gone from the history');
  assert.equal(fs.existsSync(path.join(d, 'rewind-me.txt')), false);
  await oc.dispose();
});

test('a subagent\'s session stays out of the list, and the agent goes on by itself once the subagent asks and ends', async () => {
  const oc = createOpenCode();
  const c = await oc.createSession(folder());
  await c.send('Use the subagent tool to start one subagent whose task is: use the shell tool to run the command sleep 8, then reply finished. After launching it, end your response at once without waiting.');
  const sub = await until(() => c.events.find((e) => e.type === 'subagent'));
  assert.equal(oc.isChild(sub.childId), true);
  assert.equal((await oc.listSessions()).some((s) => s.id === sub.childId), false);
  assert.equal(db().sessions[sub.childId].parent, c.id);
  const ask = await until(() => c.events.find((e) => e.type === 'permission'), 10000);
  assert.equal(ask.subagent.childId, sub.childId, 'the request comes from the subagent');
  const own = c.events.filter((e) => e.type === 'turnStart').pop();
  assert.equal(own.unsolicited, true);
  c.respondPermission(ask.requestId, 'allowOnce');
  await until(() => c.events.some((e) => e.type === 'subagent' && e.status === 'done'), 10000);
  await c.idle();
  assert.match(texts(c), /The subagent has finished\.$/);
  await oc.dispose();
});

test('the mode and effort picked show in the turns: Plan writes nothing, Low goes on turnStart and in the record', async () => {
  const oc = createOpenCode();
  const d = folder();
  const c = await oc.createSession(d);
  c.setOption('mode', 'plan');
  await c.send('Use the write tool to create a file named plan-test.txt containing the word hi. Then tell me in one line whether you could.');
  await c.idle();
  assert.equal(fs.existsSync(path.join(d, 'plan-test.txt')), false);
  assert.equal(db().sessions[c.id].agent, 'plan');
  c.setOption('mode', 'build');
  c.setOption('effort', 'low');
  await c.send('Reply with only the word four.');
  await c.idle();
  assert.equal(c.events.filter((e) => e.type === 'turnStart').pop().effort, 'low');
  assert.deepEqual([db().sessions[c.id].agent, db().sessions[c.id].variant], ['build', 'low']);
  assert.match(texts(c), /four$/);
  await oc.dispose();
});

test('the question prompt asks with a form and replies with the choice', async () => {
  const oc = createOpenCode();
  const c = await oc.createSession(folder());
  await c.send('Use the question tool to ask me whether I prefer red or blue (two options). Then reply with only the colour I chose.');
  const q = await until(() => c.events.find((e) => e.type === 'question'));
  assert.deepEqual(q.schema.properties.colour.oneOf.map((o) => o.title), ['Red', 'Blue']);
  assert.equal(c.waitingKind, 'question');
  c.respondQuestion(q.requestId, { action: 'accept', content: { colour: 'blue' } });
  await c.idle();
  assert.match(texts(c), /Blue$/);
  await oc.dispose();
});
