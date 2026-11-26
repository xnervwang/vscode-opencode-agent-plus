// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of test/vscode/run.js to take. The steps share one window and run in their order in run.js, and a step can
 * rely on what one before it left: a conversation with messages in it, or tabs it opened. OPENCODE_AGENT_PLUS_UI_STEPS
 * holds a regular expression of step names; the steps it matches run, together with every step they rely on through
 * NEEDS. Left empty, every step runs. A run with --restricted, --download, --steward or --title-order is one
 * step of its own, named after that option.
 */

/* Each step of the run without those options, in order, with the earlier steps it relies on. Behind the fake
   backend only fake-chat's turns record context use and cost, which rewind and fork check on the turns drawn again;
   compact checks the plan bar, which shows only once plan has added its row; a conversation with no message is not listed, so sessions needs
   opencode's turn. */
const NEEDS = {
  basics: [],
  'new-conversation': [],
  'fake-chat': [],
  opencode: [],
  opencode1: ['opencode'],
  modes: ['opencode'],
  subagent: ['opencode'],
  plan: ['opencode'],
  input: ['opencode'],
  rename: ['opencode'],
  rewind: ['fake-chat', 'opencode'],
  replies: ['opencode'],
  fork: ['fake-chat', 'opencode', 'replies'],
  outline: ['opencode'],
  compact: ['opencode', 'plan'],
  'agent-plus': [],
  sessions: ['opencode'],
  reload: ['fake-chat', 'opencode'],
  'title-mark': [],
  split: [],
  'tab-switch': ['split'],
  'show-logs': [],
  'gap-page': [],
  retry: [],
  'gap-host': [],
  'model-groups': [],
  prefill: [],
};
/* The step that makes the conversation the others work in; it runs whenever any step of NEEDS runs. */
const BASE = ['new-conversation'];
const RUNS = ['restricted', 'download', 'steward', 'title-order'];

/*
 * The steps the run `run` takes for `pattern`, the text of OPENCODE_AGENT_PLUS_UI_STEPS; `run` is one of RUNS, or ''
 * for the run whose steps are in NEEDS. Null when every step runs, otherwise a Set of names, empty when none of this
 * run's steps matches. Throws when the pattern is not a regular expression, or matches no step of any run.
 */
function chosen(pattern, run = '') {
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern); } catch (e) { throw new Error(`OPENCODE_AGENT_PLUS_UI_STEPS is not a regular expression: ${e.message}`); }
  const all = [...Object.keys(NEEDS), ...RUNS];
  if (!all.some((x) => re.test(x))) throw new Error(`OPENCODE_AGENT_PLUS_UI_STEPS (${pattern}) matches none of the steps: ${all.join(', ')}`);
  if (run) return new Set(re.test(run) ? [run] : []);
  const out = new Set();
  const add = (x) => { if (out.has(x)) return; out.add(x); for (const y of NEEDS[x]) add(y); };
  for (const x of Object.keys(NEEDS)) if (re.test(x)) add(x);
  if (out.size) for (const x of BASE) add(x);
  return new Set(Object.keys(NEEDS).filter((x) => out.has(x)));
}

/* Entries of NEEDS that are not steps, or that come after the step that needs them. */
function outOfStep() {
  const names = Object.keys(NEEDS);
  return names.flatMap((x) => NEEDS[x].filter((y) => !names.includes(y) || names.indexOf(y) >= names.indexOf(x)).map((y) => `${x} needs ${y}`));
}

module.exports = { NEEDS, BASE, RUNS, chosen, outOfStep };
