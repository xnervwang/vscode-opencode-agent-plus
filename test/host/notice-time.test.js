// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Every notification this extension shows starts with its time (src/shared/notice-time.js, a copy of Agent Plus's):
 * the source calls the wrappers rather than vscode.window's show…Message, which only a modal dialog, not a
 * notification, still calls; and the wrapper puts the time in the reader's zone once the extension has handed it over.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const noticeTime = require('../../src/shared/notice-time');

const ROOT = path.join(__dirname, '..', '..');
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'shared' ? [] : sources(p);
  return e.name.endsWith('.js') ? [p] : [];
});

test('no notification is shown without the time: show…Message is called directly only for a modal dialog', () => {
  const direct = [];
  for (const file of [path.join(ROOT, 'extension.js'), ...sources(path.join(ROOT, 'src'))]) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\.window\.show(Information|Warning|Error)Message\(/.test(line) && !/modal: true/.test(line)) direct.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(direct, []);
});

test('the wrapper puts the time in the reader\'s zone before the text once that zone is handed over, and names this machine\'s before', () => {
  const shown = [];
  const vscode = { window: { showInformationMessage: (...a) => { shown.push(a); return Promise.resolve(); } } };
  const now = Date.now();
  noticeTime.setReaderZone(() => '');
  noticeTime.info(vscode, 'Before');
  noticeTime.setReaderZone(() => 'Asia/Kolkata');
  noticeTime.info(vscode, 'After', 'OK');
  noticeTime.setReaderZone(null);
  const kolkata = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  assert.match(shown[0][0], /^\[\d\d:\d\d [^\]]+\] Before$/);
  assert.ok([now, now + 60000].map((t) => `[${kolkata.format(new Date(t))}] After`).includes(shown[1][0]), shown[1][0]);
  assert.deepStrictEqual(shown[1].slice(1), ['OK']);
});
