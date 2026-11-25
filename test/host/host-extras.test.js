// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Which message a rewind goes back to, what its confirmation says, and how the local images in a reply are read. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { messageOf, confirmation } = require('../../src/host/rewind');
const { loadImage, sniff, fileOf, MAX_BYTES } = require('../../src/host/reply-images');

const USERS = [
  { id: 'msg_20dacb8aa001b0TY7agRN2JAFo', text: 'Remember the word OSPREY. Reply with ok.' },
  { id: 'msg_20dacbf6a0018X6RZP6hV4o0Fe', text: 'Use the write tool to create a file named revert-me.txt\n[/w/a.txt:3]\nselected text' },
  { id: 'msg_20daccde3001jCP33AM8hXvVUr', text: 'Reply with the word KESTREL only.' },
];

test('a rewind goes by the id a replayed message carries, else by its place and its text', () => {
  assert.equal(messageOf({ messageId: 'msg_given', text: 'x', ordinal: 5 }, []), 'msg_given');
  assert.equal(messageOf({ text: 'Reply with the word KESTREL only.', ordinal: 2 }, USERS), USERS[2].id);
  /* OpenCode stores a selection sent along after the text. */
  assert.equal(messageOf({ text: 'Use the write tool to create a file named revert-me.txt', ordinal: 1 }, USERS), USERS[1].id);
  /* Its place moved (a message the page does not show), the text still names one message. */
  assert.equal(messageOf({ text: 'Reply with the word KESTREL only.', ordinal: 0 }, USERS), USERS[2].id);
  /* The same text twice and neither at the given place: no message, since either could be the wrong one. */
  const twice = [...USERS, { id: 'msg_again', text: 'Reply with the word KESTREL only.' }];
  assert.equal(messageOf({ text: 'Reply with the word KESTREL only.', ordinal: 0 }, twice), '');
  assert.equal(messageOf({ text: 'Reply with the word KESTREL only.', ordinal: 3 }, twice), 'msg_again');
  assert.equal(messageOf({ text: 'not there', ordinal: 0 }, USERS), '');
  assert.equal(messageOf({ text: '', ordinal: 0 }, USERS), '');
});

test('the rewind confirmation names the messages that leave and the files that go back, and says when only the conversation goes back', () => {
  const staged = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'opencode', 'fixtures', 'v2-revert-stage.json'), 'utf8')).data;
  const files = staged.files.map((f) => ({ file: f.file, status: f.status, additions: f.additions, deletions: f.deletions }));
  const c = confirmation({ tracked: true, files });
  assert.equal(c.message, 'Rewind the conversation to before this message?');
  assert.match(c.detail, /This message and all messages after it will be removed from the conversation\./);
  assert.match(c.detail, /revert-me\.txt: removed \(-1\)/);
  assert.match(c.detail, /seed\.txt: changed back \(\+1 -1\)/);
  assert.match(c.detail, /Cancel undoes that/);
  assert.match(c.detail, /experimental/);
  assert.match(confirmation({ tracked: false, files: [] }).detail, /Only the conversation is rewound: this folder is not a git repository, so OpenCode keeps no snapshots of its files/);
  assert.match(confirmation({ tracked: true, files: [] }).detail, /No files were changed after this message/);
  const many = confirmation({ tracked: true, files: Array.from({ length: 25 }, (_, i) => ({ file: `f${i}`, status: 'modified', additions: 1, deletions: 0 })) });
  assert.match(many.detail, /and 5 more/);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077053e0000000c4944415408d763f8cfc00000030101009cf9f6770000000049454e44ae426082', 'hex');

test('a local image becomes a data: URL whose type comes from its bytes; anything else is refused with a reason', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-img-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'chart.png');
  fs.writeFileSync(png, PNG);
  const svg = path.join(dir, 'd.svg');
  fs.writeFileSync(svg, '<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  const fake = path.join(dir, 'secret.png');
  fs.writeFileSync(fake, 'not an image at all');
  const r = await loadImage(png);
  assert.equal(r.ok, true);
  assert.equal(r.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal((await loadImage(`file://${png}`)).ok, true, 'a file:// URL too');
  assert.match((await loadImage(svg)).dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(await loadImage(fake), { ok: false, reason: "The file's contents are not a PNG, JPEG, GIF, WebP or SVG image." });
  assert.deepEqual(await loadImage('chart.png'), { ok: false, reason: 'Only an absolute path or a file:// address is shown as an image.' });
  assert.deepEqual(await loadImage(path.join(dir, 'notes.txt')), { ok: false, reason: 'The file name does not end in .png, .jpg, .jpeg, .gif, .webp or .svg.' });
  assert.deepEqual(await loadImage(path.join(dir, 'gone.png')), { ok: false, reason: 'There is no such file.' });
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(MAX_BYTES + 1));
  assert.match((await loadImage(big)).reason, /over the 8 MB limit for images/);
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniff(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(fileOf('C:\\pics\\a.png', 'win32'), 'C:\\pics\\a.png');
  assert.equal(fileOf('/pics/a.png', 'win32'), null);
});
