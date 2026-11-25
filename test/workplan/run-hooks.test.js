// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * run-hooks.py, with this machine's Python and the real shared scripts: one process answers for several of them, each
 * as it would answer started on its own. Skipped where there is no python3.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workplan = require('../../src/workplan');

const HOOKS = path.join(__dirname, '..', '..', 'opencode-plugin', 'agent-work-plan', 'hooks');
const SID = 'ses_df3c28ab2ffe0TYFbXAnoBpqy6';
const python = (() => { const r = cp.spawnSync('python3', ['--version'], { encoding: 'utf8' }); return r.status === 0 ? 'python3' : ''; })();

function run(plans, names, payload, env = {}) {
  const r = cp.spawnSync(python, [path.join(HOOKS, 'run-hooks.py'), plans, ...names], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).texts;
}

test('one Python process answers for the plan, the time zone and the reply images', { skip: !python && 'no python3' }, (t) => {
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-runhooks-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-runhooks-home-'));
  t.after(() => { fs.rmSync(plans, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(plans, 'config.json'), JSON.stringify({ enabled: true, tellTimeZone: true, replyImages: true }));
  fs.writeFileSync(path.join(plans, 'client-time-zone.json'), JSON.stringify({ timeZone: 'America/Los_Angeles' }));
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: SID, turn_id: 'msg_1', prompt: 'hi', cwd: '/w', in_panel: true };
  const texts = run(plans, ['inject-work-plan.py', 'tell-time-zone.py', 'tell-reply-images.py', 'no-such.py', '../plan-row.py'], payload,
    { OPENCODE_PLUS_HOME: home });
  assert.deepEqual(Object.keys(texts), ['inject-work-plan.py', 'tell-time-zone.py', 'tell-reply-images.py', 'no-such.py', '../plan-row.py']);
  assert.match(texts['tell-time-zone.py'], /^The user is in America\/Los_Angeles \(P[DS]T, UTC-0[78]:00\)/);
  assert.equal(texts['inject-work-plan.py'], '', 'no plan yet');
  /* In the panel the image note names the conversation's own folder under OPENCODE_PLUS_HOME, the one deleting the
     conversation removes. */
  assert.ok(texts['tell-reply-images.py'].startsWith('This panel shows images'), texts['tell-reply-images.py']);
  assert.equal(workplan.scratchDir(SID, home), path.join(home, 'scratch', SID));
  assert.ok(texts['tell-reply-images.py'].includes(` ${workplan.scratchDir(SID, home)} `), texts['tell-reply-images.py']);
  assert.equal(texts['no-such.py'], '');
  assert.equal(texts['../plan-row.py'], '', 'only the hook scripts are run');
  /* The hook records beside the plan that it has given the note, so the next message does not get it again. */
  assert.ok(fs.existsSync(path.join(plans, `${SID}.tz`)));
  assert.equal(run(plans, ['tell-time-zone.py'], payload)['tell-time-zone.py'], '');
  /* Off in config.json says nothing. */
  fs.writeFileSync(path.join(plans, 'config.json'), JSON.stringify({ enabled: true, tellTimeZone: false }));
  assert.equal(run(plans, ['tell-time-zone.py'], { ...payload, session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' })['tell-time-zone.py'], '');
});

test('the same answers as each script started alone', { skip: !python && 'no python3' }, (t) => {
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-runhooks-'));
  t.after(() => fs.rmSync(plans, { recursive: true, force: true }));
  fs.writeFileSync(path.join(plans, 'client-time-zone.json'), JSON.stringify({ timeZone: 'Asia/Kolkata' }));
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: SID, turn_id: 'msg_1', prompt: 'hi', cwd: '/w' };
  const alone = cp.spawnSync(python, [path.join(HOOKS, 'tell-time-zone.py'), plans], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const said = JSON.parse(alone.stdout).hookSpecificOutput.additionalContext;
  fs.rmSync(path.join(plans, `${SID}.tz`));
  const texts = run(plans, ['tell-time-zone.py'], payload);
  assert.equal(texts['tell-time-zone.py'].replace(/\d\d:\d\d/, 'HH:MM'), said.replace(/\d\d:\d\d/, 'HH:MM'));
});
