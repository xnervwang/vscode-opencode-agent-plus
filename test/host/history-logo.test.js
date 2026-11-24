// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { historyFor } = require('../../src/host/history');
const { logoFiles, COLORS } = require('../../src/host/logo');

test('history: records pass, events are replayed with the time before them, messages become records', () => {
  const h = historyFor([
    { kind: 'meta', format: 1, id: 's', cwd: '/w', createdAt: 1, providerId: 'p', modelId: 'm' },
    { type: 'turnStart', turnId: 't', at: 100 },
    { type: 'text', delta: 'Hi' },
    { type: 'turnEnd', turnId: 't', reason: 'endTurn', at: 200 },
    { type: 'text', delta: 'later' },
    { role: 'user', content: [{ type: 'text', text: 'q' }], at: 300 },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    null, 'x', { other: true },
  ]);
  assert.deepStrictEqual(h.records, [
    { kind: 'meta', format: 1, id: 's', cwd: '/w', createdAt: 1, providerId: 'p', modelId: 'm' },
    { kind: 'message', at: 300, message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
    { kind: 'message', at: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
  ]);
  assert.deepStrictEqual(h.events.map((e) => [e.type, e.at]), [['turnStart', 100], ['text', 100], ['turnEnd', 200], ['text', 200]]);
  assert.deepStrictEqual(historyFor(undefined), { records: [], events: [] });
});

test("logo: the activity bar icon in each theme's colour, written again only when it changes", () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'na-logo-'));
  const store = path.join(ext, 'storage');
  fs.mkdirSync(path.join(ext, 'images'));
  fs.writeFileSync(path.join(ext, 'images', 'sidebar.svg'), '<svg stroke="currentColor"><circle fill="currentColor"/></svg>');
  const files = logoFiles(ext, store);
  assert.strictEqual(fs.readFileSync(files.light, 'utf8'), `<svg stroke="${COLORS.light}"><circle fill="${COLORS.light}"/></svg>`);
  assert.strictEqual(fs.readFileSync(files.dark, 'utf8'), `<svg stroke="${COLORS.dark}"><circle fill="${COLORS.dark}"/></svg>`);
  const t = fs.statSync(files.dark).mtimeMs;
  fs.utimesSync(files.dark, new Date(1000), new Date(1000));
  logoFiles(ext, store);
  assert.strictEqual(fs.statSync(files.dark).mtimeMs, 1000, 'unchanged: not written');
  assert.ok(t > 1000);
  assert.strictEqual(logoFiles(path.join(ext, 'nothing'), store), null);
  assert.deepStrictEqual(fs.readdirSync(store).sort(), ['logo-dark.svg', 'logo-light.svg']);
});
