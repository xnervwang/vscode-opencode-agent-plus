// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The archive of Claude Code's panel that test/vscode/look-alike.js puts beside this page: a picture for every state
 * and theme it pictures, cut the way it cuts its own, and the versions they show.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STATES, TABS, LOWER, THEMES } = require('../vscode/look-alike');

const DIR = path.join(__dirname, '..', 'vscode', 'look-alike');

/* Width and height from a JPEG's start-of-frame segment. */
function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'a JPEG');
  for (let i = 2; i < buf.length;) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error('no frame header');
}

const ARCHIVED = fs.existsSync(path.join(DIR, 'official.json'));

test('every state look-alike.js pictures has an archived picture of Claude Code in each of its themes, cut the same way',
  { skip: !ARCHIVED && 'the archive of the official panel is kept on the developer machine, not in the repository' }, () => {
  const official = JSON.parse(fs.readFileSync(path.join(DIR, 'official.json'), 'utf8'));
  for (const k of ['claudeCode', 'claudeCodePlus', 'vscode', 'window']) assert.ok(official[k], `official.json names ${k}`);
  const [w, h] = official.window.split('x').map(Number);
  assert.deepEqual(Object.keys(THEMES).sort(), Object.keys(official.themes).sort());
  const editor = { width: w - 56, height: h - 67 };
  for (const s of STATES) {
    assert.ok(official.states[s.name], `official.json says how ${s.name} was taken`);
    for (const t of s.themes) {
      const size = jpegSize(fs.readFileSync(path.join(DIR, t, `${s.name}.jpg`)));
      assert.deepEqual(size, { width: editor.width, height: s.lower ? LOWER : editor.height - TABS }, `${t}/${s.name}.jpg`);
    }
  }
  const files = fs.readdirSync(DIR).filter((f) => Object.keys(THEMES).includes(f)).flatMap((t) => fs.readdirSync(path.join(DIR, t)).map((f) => `${t}/${f}`));
  assert.deepEqual(files.sort(), STATES.flatMap((s) => s.themes.map((t) => `${t}/${s.name}.jpg`)).sort(), 'no picture without a state');
});
