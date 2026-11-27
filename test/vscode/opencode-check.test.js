// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The daily check of the newest OpenCode (.github/workflows/opencode-check.yml) and the issues it opens and closes
   (build/latest-issue.js). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const issue = require('../../build/latest-issue');

const ROOT = path.join(__dirname, '..', '..');
const YML = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'opencode-check.yml'), 'utf8');
const RUN = 'https://github.com/o/r/actions/runs/1';
const report = (lines) => ['OpenCode 2.5.0, the newest on npm (the extension pins 2.4.1), on linux x64', ...lines, '1 of the checks above failed.'].join('\n');

test('the workflow runs daily on three systems, and only its last job can write issues', () => {
  assert.match(YML, /schedule:\s*\n\s*#[^\n]*\n\s*- cron: '23 11 \* \* \*'/);
  assert.match(YML, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*version:/);
  assert.match(YML, /push:\s*\n\s*#[^\n]*\n\s*branches: \['ci\/\*\*'\]/);
  assert.match(YML, /DRY_RUN: \$\{\{ github\.event_name == 'push' \|\| inputs\.dry_run \}\}/, 'a run on a ci/ branch opens no issue');
  assert.match(YML, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(YML, /node build\/latest-check\.js --version "\$VERSION"/);
  assert.match(YML, /node build\/npm-check\.js --version "\$VERSION"/);
  assert.strictEqual((YML.match(/issues: write/g) || []).length, 1);
  assert.match(YML, /^permissions:\s*\n\s*contents: read\s*\n\s*\njobs:/m);
});

test('the issue for a failed check names the version and quotes the failing lines of each system', () => {
  const got = issue.issueFor({ version: '2.5.0', runUrl: RUN, reports: [
    { os: 'ubuntu-latest', code: 1, text: report(['ok   the release has opencode-linux-x64-baseline.tar.gz', 'FAIL it does not say it can fork conversations: no sessionCapabilities.fork']) },
    { os: 'windows-latest', code: 0, text: 'Every check passed.' },
    { os: 'macos-latest', code: 2, text: 'could not run: npm answered 503' },
  ] });
  assert.strictEqual(got.title, 'OpenCode 2.5.0 failed the daily check');
  assert.match(got.body, /OpenCode \*\*2\.5\.0\*\*/);
  assert.match(got.body, /failed on ubuntu-latest \(it held on windows-latest\)/);
  assert.match(got.body, /#### ubuntu-latest\n\n```\nFAIL it does not say it can fork conversations/);
  assert.ok(!got.body.includes('ok   the release has'), 'an ok line is not quoted');
  assert.ok(!got.body.includes('#### macos-latest'), 'a system where the check could not run is not reported as failing');
  assert.ok(got.body.includes(`(${RUN})`));
  assert.match(got.body, /node build\/latest-check\.js --version 2\.5\.0/);
});

test('no issue when each system either held or could not run', () => {
  assert.strictEqual(issue.issueFor({ version: '2.5.0', runUrl: RUN, reports: [{ os: 'ubuntu-latest', code: 0, text: '' }, { os: 'macos-latest', code: 2, text: '' }] }), null);
});

/* A fake of github-script's client that lists `issues` and records each write. */
function fakeGithub(issues) {
  const writes = [];
  return {
    writes,
    paginate: async (fn, opts) => { writes.push(['list', opts.state]); return issues; },
    rest: { issues: {
      listForRepo: () => {},
      create: async (o) => { writes.push(['create', o.title]); },
      createComment: async (o) => { writes.push(['comment', o.issue_number, o.body]); },
      update: async (o) => { writes.push(['update', o.issue_number, o.state, o.state_reason]); },
    } },
  };
}
const context = { repo: { owner: 'o', repo: 'r' } };
const core = { info: () => {} };
const TITLE = 'OpenCode 2.5.0 failed the daily check';
const failedOn = [{ os: 'ubuntu-latest', code: 1, text: 'FAIL something' }, { os: 'macos-latest', code: 0, text: '' }];
const heldOn = ['ubuntu-latest', 'macos-latest', 'windows-latest'].map((os) => ({ os, code: 0, text: 'Every check passed.' }));
const settle = (issues, reports, more = {}) => {
  const github = fakeGithub(issues);
  return issue.settle({ github, context, core, version: '2.5.0', reports, runUrl: RUN, sha: 'abc1234', ...more }).then((done) => [done, github.writes.filter((w) => w[0] !== 'list')]);
};

test('a failed check opens one issue per version, and no second one while it is open', async () => {
  const github = fakeGithub([]);
  await issue.settle({ github, context, core, version: '2.5.0', reports: failedOn, runUrl: RUN, sha: 'abc1234' });
  assert.deepStrictEqual(github.writes, [['list', 'all'], ['create', TITLE]]);
  assert.deepStrictEqual(await settle([{ number: 7, title: TITLE, state: 'open' }], failedOn), ['known', []]);
  assert.deepStrictEqual(await settle([{ number: 7, title: TITLE, state: 'open', pull_request: {} }], failedOn), ['filed', [['create', TITLE]]],
    'a pull request with that title is not the issue');
});

test('the first run in which every system passes closes the version\'s open issue, with a comment naming the commit', async () => {
  const [done, writes] = await settle([{ number: 7, title: TITLE, state: 'open' }], heldOn);
  assert.strictEqual(done, 'closed');
  assert.deepStrictEqual(writes, [['comment', 7, `The check passed on abc1234 against OpenCode 2.5.0: [the run](${RUN}).`], ['update', 7, 'closed', 'completed']]);
  assert.deepStrictEqual(await settle([{ number: 7, title: TITLE, state: 'closed' }], heldOn), ['none', []], 'a closed one is left closed');
  assert.deepStrictEqual(await settle([], heldOn), ['none', []]);
});

test('a run where one system could not run the check closes nothing', async () => {
  const partly = [heldOn[0], heldOn[1], { os: 'windows-latest', code: 2, text: 'could not run: npm answered 503' }];
  assert.deepStrictEqual(await settle([{ number: 7, title: TITLE, state: 'open' }], partly), ['none', []]);
});

test('a version that fails again reopens its closed issue and quotes the new failing lines', async () => {
  const [done, writes] = await settle([{ number: 7, title: TITLE, state: 'closed' }], failedOn);
  assert.strictEqual(done, 'reopened');
  assert.deepStrictEqual(writes.map((w) => w.slice(0, 2)), [['comment', 7], ['update', 7]]);
  assert.match(writes[0][2], /^The check failed again on abc1234 against OpenCode 2\.5\.0\.\n\n[\s\S]*FAIL something/);
  assert.strictEqual(writes[1][2], 'open');
});

test('a dry run writes nothing', async () => {
  assert.deepStrictEqual(await settle([], failedOn, { dryRun: true }), ['filed', []]);
  assert.deepStrictEqual(await settle([{ number: 7, title: TITLE, state: 'open' }], heldOn, { dryRun: true }), ['closed', []]);
});
