// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The issue .github/workflows/opencode-check.yml opens when the daily check of the newest OpenCode fails: one per
 * version, so the same failure is not filed again every day. Only a check that fails (exit 1 of build/latest-check.js)
 * opens one; a check that could not run (exit 2) says nothing about OpenCode, and filing it would put an untrue claim
 * in the tracker.
 *
 * The check closes that issue itself: the first run in which every check held on every system leaves a comment naming
 * the commit it ran on and closes it. A version that fails again after that has its issue reopened, with the lines
 * that failed this time.
 *
 *   issueFor({ version, reports, runUrl })   { title, body } or null; `reports` is [{ os, code, text }]
 *   settle({ github, context, core, version, reports, runUrl, sha, dryRun })
 *       'filed', 'reopened', 'known' (open already), 'closed', 'none'; with dryRun it only logs what it would do
 */
const LIMIT = 40000;
const titleOf = (version) => `OpenCode ${version} failed the daily check`;
const failing = (text) => String(text || '').split('\n').filter((l) => /^FAIL\b|^could not run:/.test(l)).join('\n');

function issueFor({ version, reports, runUrl }) {
  const bad = (reports || []).filter((r) => Number(r.code) === 1);
  if (!bad.length) return null;
  const v = version || 'an unknown version';
  const per = bad.map((r) => [`#### ${r.os}`, '', '```', failing(r.text).trim() || String(r.text || '').trim().slice(-2000) || 'the check produced no report', '```', '']);
  let quoted = per.flat().join('\n');
  if (quoted.length > LIMIT) quoted = quoted.slice(0, LIMIT) + '\n... cut here; the run summary has every line';
  const ok = (reports || []).filter((r) => Number(r.code) === 0).map((r) => r.os);
  const body = [
    `The daily check tested OpenCode **${v}** and failed on ${bad.map((r) => r.os).join(', ')}${ok.length ? ` (it held on ${ok.join(', ')})` : ''}.`,
    'Archive failures apply to the extension\'s download only if `src/opencode/download.js` pins this version; other failures describe',
    'what happens when the extension uses this version on the system that reported them.',
    '',
    '### What the check said',
    '',
    `The summary of [the run](${runUrl}) has the full report for each system.`,
    '',
    quoted.trim(),
    '',
    '### Where to look',
    '',
    '- The archive name, size or SHA-256: `src/opencode/download.js`, whose `ASSETS` table names each system\'s archive.',
    '- Finding OpenCode or reading its version: `findOpenCode` and `readVersion` in `src/opencode/server.js`.',
    '- Starting it over ACP, the capabilities it states, or the conversation round trip: `src/opencode/index.js`.',
    '- The npm install: `build/npm-check.js`, which runs the install hint\'s `npm install -g @opencode/cli`.',
    '',
    `To reproduce: \`node build/latest-check.js --version ${v}\` and \`node build/npm-check.js --version ${v}\`.`,
  ].join('\n');
  return { title: titleOf(v), body };
}

const passed = (reports) => (reports || []).length > 0 && reports.every((r) => Number(r.code) === 0);
const passedNote = (sha, version, runUrl) => `The check passed on ${sha} against OpenCode ${version}: [the run](${runUrl}).`;

async function settle({ github, context, core, version, reports, runUrl, sha, dryRun = false }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const title = titleOf(version || 'an unknown version');
  const all = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'all', per_page: 100 });
  const had = all.find((i) => i.title === title && !i.pull_request) || null;
  const act = async (what, fn) => { if (dryRun) { core.info(`would ${what}`); return; } await fn(); };

  const issue = issueFor({ version, reports, runUrl });
  if (issue) {
    if (!had) {
      await act(`open: ${issue.title}\n\n${issue.body}`, () => github.rest.issues.create({ ...repo, title: issue.title, body: issue.body }));
      return 'filed';
    }
    if (had.state === 'open') { core.info(`already reported: #${had.number}`); return 'known'; }
    const again = `The check failed again on ${sha} against OpenCode ${version}.\n\n${issue.body}`;
    await act(`reopen #${had.number} with:\n\n${again}`, async () => {
      await github.rest.issues.createComment({ ...repo, issue_number: had.number, body: again });
      await github.rest.issues.update({ ...repo, issue_number: had.number, state: 'open' });
    });
    return 'reopened';
  }
  if (passed(reports) && had && had.state === 'open') {
    const note = passedNote(sha, version, runUrl);
    await act(`close #${had.number} with: ${note}`, async () => {
      await github.rest.issues.createComment({ ...repo, issue_number: had.number, body: note });
      await github.rest.issues.update({ ...repo, issue_number: had.number, state: 'closed', state_reason: 'completed' });
    });
    return 'closed';
  }
  core.info(passed(reports) ? 'every check passed and no issue is open for this version' : 'no check failed, but some systems did not run');
  return 'none';
}

module.exports = { issueFor, settle, titleOf, passedNote };
