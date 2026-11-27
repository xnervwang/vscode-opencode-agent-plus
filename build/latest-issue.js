// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The issue .github/workflows/opencode-check.yml opens when the daily check of the newest OpenCode fails on a system:
 * one issue per OpenCode version, open or closed, as a daily schedule would otherwise file the same news every day.
 * Only a check that no longer holds (exit 1 of build/latest-check.js) files one; a check that could not run (exit 2)
 * says nothing about OpenCode, and filing it would put an untrue claim in the tracker.
 *
 *   issueFor({ version, reports, runUrl })   { title, body } or null; `reports` is [{ os, code, text }]
 *   file({ github, context, core, ..., dryRun })   opens it unless one with its title exists; 'none', 'known', 'dry' or 'filed'
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
    `The daily check ran what this extension does with OpenCode against OpenCode **${v}**, the newest \`@opencode/cli\` on npm,`,
    `and a check no longer held on ${bad.map((r) => r.os).join(', ')}${ok.length ? ` (it held on ${ok.join(', ')})` : ''}.`,
    'Users who update OpenCode to this version, or install it fresh, get what the failing lines below describe.',
    '',
    '### What the check said',
    '',
    `The lines that failed are below; each system's whole report is in the summary of [the run](${runUrl}).`,
    '',
    quoted.trim(),
    '',
    '### Where to look',
    '',
    '- The archive name, size or SHA-256: `src/opencode/download.js`, whose `ASSETS` table names each system\'s archive.',
    '- Finding OpenCode or reading its version: `findOpenCode` and `readVersion` in `src/opencode/server.js`.',
    '- Starting it, its capabilities, or a conversation round trip: `src/opencode/index.js`, over ACP.',
    '- The npm install: `build/npm-check.js`, which installs it the way the install hint tells users to.',
    '',
    `To reproduce: \`node build/latest-check.js --version ${v}\` and \`node build/npm-check.js --version ${v}\`.`,
  ].join('\n');
  return { title: titleOf(v), body };
}

async function file({ github, context, core, version, reports, runUrl, dryRun = false }) {
  const issue = issueFor({ version, reports, runUrl });
  if (!issue) { core.info('no check failed, so no issue'); return 'none'; }
  const all = await github.paginate(github.rest.issues.listForRepo, { owner: context.repo.owner, repo: context.repo.repo, state: 'all', per_page: 100 });
  if (all.some((i) => i.title === issue.title && !i.pull_request)) { core.info(`already reported: ${issue.title}`); return 'known'; }
  if (dryRun) { core.info(`would open: ${issue.title}\n\n${issue.body}`); return 'dry'; }
  await github.rest.issues.create({ owner: context.repo.owner, repo: context.repo.repo, title: issue.title, body: issue.body });
  return 'filed';
}

module.exports = { issueFor, file, titleOf };
