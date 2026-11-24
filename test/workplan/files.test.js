// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workplan = require('../../src/workplan');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'na-wpfiles-'));
const SID = 'ses_df3c28ab2ffe0TYFbXAnoBpqy6';
const OTHER = 'ses_df3c28ab2ffe0TYFbXAnoBpqy7';

test('removePlan deletes a conversation\'s plan, its side files and closed rows, and nothing of another', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'closed'));
  const mine = ['.json', '.injected', '.turn', '.settled', '.nudged', '.briefed', '.compacted'].map((s) => `${SID}${s}`);
  for (const n of mine) fs.writeFileSync(path.join(dir, n), '{}');
  fs.writeFileSync(path.join(dir, 'closed', `${SID}.json`), '{}');
  const kept = [`${OTHER}.json`, `${OTHER}.injected`, 'config.json', `${SID}.json.bak`, `${SID}x.json`];
  for (const n of kept) fs.writeFileSync(path.join(dir, n), '{}');
  fs.writeFileSync(path.join(dir, 'closed', `${OTHER}.json`), '{}');

  const gone = workplan.removePlan(SID, dir);
  assert.deepEqual(gone.slice().sort(), mine.concat(path.join('closed', `${SID}.json`)).sort());
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'closed').sort(), kept.slice().sort());
  assert.deepEqual(fs.readdirSync(path.join(dir, 'closed')), [`${OTHER}.json`]);
  assert.deepEqual(workplan.removePlan(SID, dir), [], 'a second call finds nothing');
});

test('removePlan touches nothing for an id that is not OpenCode\'s shape', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '..json'), '{}');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  for (const id of ['', '.', '..', '../x', 'config', '3f2b6c1e-0000-4000-8000-00000000000a', undefined, null, 42]) {
    assert.deepEqual(workplan.removePlan(id, dir), []);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['..json', 'config.json']);
});

test('scratchDir is <root>/scratch/<id>, and removeScratch takes that folder only', () => {
  const root = tmp();
  assert.equal(workplan.scratchDir(SID, root), path.join(root, 'scratch', SID));
  for (const id of ['', '.', '..', '../x', `${SID}/../x`, 'ses_../../x', '3f2b6c1e-0000-4000-8000-00000000000a', undefined, null]) {
    assert.equal(workplan.scratchDir(id, root), null);
    assert.equal(workplan.removeScratch(id, root), false);
  }
  assert.equal(workplan.removeScratch(SID, root), false, 'no folder yet');
  for (const id of [SID, OTHER]) {
    fs.mkdirSync(path.join(root, 'scratch', id, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scratch', id, 'chart.png'), 'png');
    fs.writeFileSync(path.join(root, 'scratch', id, 'sub', 'b.svg'), '<svg/>');
  }
  assert.equal(workplan.removeScratch(SID, root), true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), [OTHER]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'scratch', OTHER)).sort(), ['chart.png', 'sub']);
  assert.equal(workplan.removeScratch(SID, root), false, 'a second call finds nothing');
});

test('removeScratch removes a symbolic link in place of the folder, and nothing where it leads', { skip: process.platform === 'win32' && 'links need rights on Windows' }, () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.symlinkSync(outside, path.join(root, 'scratch', SID));
  assert.equal(workplan.removeScratch(SID, root), true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), []);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
});

test('the side files are the ones plan_common.py names', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'opencode-plugin', 'agent-work-plan', 'hooks', 'plan_common.py'), 'utf8');
  const named = [...text.matchAll(/^[A-Z_]+_SUFFIX = "(\.[a-z-]+)"/gm)].map((m) => m[1]).filter((s) => s !== '.lock');
  assert.deepEqual(workplan.SIDE_SUFFIXES.filter((s) => s !== '.json').slice().sort(), named.sort());
});

test('writeLauncher writes the Python found as its full path, once', () => {
  const dir = tmp();
  const py = { launcher: ['py', '-3'], executable: 'C:/Python312/python.exe', version: '3.12' };
  assert.equal(workplan.writeLauncher(py, dir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'launcher.json'), 'utf8')), { row: ['C:/Python312/python.exe'] });
  assert.equal(workplan.writeLauncher(py, dir), false, 'unchanged, not written');
  assert.equal(workplan.writeLauncher(null, dir), false);
  assert.equal(workplan.writeLauncher({ launcher: ['python3'] }, dir), false, 'nothing to write without a path');
  assert.deepEqual(fs.readdirSync(dir), ['launcher.json']);
});
