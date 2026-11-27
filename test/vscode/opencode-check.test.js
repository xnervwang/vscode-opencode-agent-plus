// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* The daily check of the newest OpenCode (.github/workflows/opencode-check.yml) and the issue it opens
   (build/latest-issue.js): one per version, only for a check that no longer holds, quoting the lines that failed. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const issue = require('../../build/latest-issue');

const ROOT = path.join(__dirname, '..', '..');
const YML = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'opencode-check.yml'), 'utf8');
const RUN = 'https://github.com/o/r/actions/runs/1';
const report = (lines) => ['OpenCode 2.5.0, the newest on npm (the extension pins 2.4.1), on linux x64', ...lines, 'A check failed: 1 of the checks above did not hold.'].join('\n');

test('the workflow runs once a day and by hand, checks each system, and may open issues only in its last job', () => {
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

test('a failed check opens an issue named after the version, quoting the failing lines of each system and linking the run', () => {
  const got = issue.issueFor({ version: '2.5.0', runUrl: RUN, reports: [
    { os: 'ubuntu-latest', code: 1, text: report(['ok   the release has opencode-linux-x64-baseline.tar.gz', 'FAIL it no longer says it can fork conversations (sessionCapabilities.fork)']) },
    { os: 'windows-latest', code: 0, text: 'Every check held.' },
    { os: 'macos-latest', code: 2, text: 'could not run: npm answered 503' },
  ] });
  assert.strictEqual(got.title, 'OpenCode 2.5.0 failed the daily check');
  assert.match(got.body, /OpenCode \*\*2\.5\.0\*\*/);
  assert.match(got.body, /no longer held on ubuntu-latest \(it held on windows-latest\)/);
  assert.match(got.body, /#### ubuntu-latest\n\n```\nFAIL it no longer says it can fork conversations/);
  assert.ok(!got.body.includes('ok   the release has'), 'only the failing lines are quoted');
  assert.ok(!got.body.includes('#### macos-latest'), 'a system where the check could not run is not reported as failing');
  assert.ok(got.body.includes(`(${RUN})`));
  assert.match(got.body, /node build\/latest-check\.js --version 2\.5\.0/);
});

test('no issue when every check held or could only not run', () => {
  assert.strictEqual(issue.issueFor({ version: '2.5.0', runUrl: RUN, reports: [{ os: 'ubuntu-latest', code: 0, text: '' }, { os: 'macos-latest', code: 2, text: '' }] }), null);
});

test('one issue per version: none is opened when one with its title exists, open or closed; a dry run opens none', async () => {
  const made = [];
  const listed = [];
  const fake = (existing) => ({
    paginate: async (fn, opts) => { listed.push(opts.state); return existing; },
    rest: { issues: { listForRepo: () => {}, create: async (o) => { made.push(o.title); } } },
  });
  const context = { repo: { owner: 'o', repo: 'r' } };
  const core = { info: () => {} };
  const reports = [{ os: 'ubuntu-latest', code: 1, text: 'FAIL something' }];
  const known = await issue.file({ github: fake([{ title: 'OpenCode 2.5.0 failed the daily check', state: 'closed' }]), context, core, version: '2.5.0', reports, runUrl: RUN });
  const pr = await issue.file({ github: fake([{ title: 'OpenCode 2.5.0 failed the daily check', pull_request: {} }]), context, core, version: '2.5.0', reports, runUrl: RUN });
  const dry = await issue.file({ github: fake([]), context, core, version: '2.6.0', reports, runUrl: RUN, dryRun: true });
  const filed = await issue.file({ github: fake([]), context, core, version: '2.6.0', reports, runUrl: RUN });
  assert.deepStrictEqual([known, pr, dry, filed, made, listed.every((s) => s === 'all')], ['known', 'filed', 'dry', 'filed', ['OpenCode 2.5.0 failed the daily check', 'OpenCode 2.6.0 failed the daily check'], true]);
});
