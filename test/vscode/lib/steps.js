// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of test/vscode/run.js to take. The steps share one window and run in their order in run.js, and a step can
 * rely on what one before it left: a conversation with messages in it, or tabs it opened. OPENCODE_AGENT_PLUS_UI_STEPS
 * holds a regular expression of step names; the steps it matches run, each with the steps of NEEDS it relies on,
 * followed through. Left empty, every step runs. A run with --restricted, --download, --steward or --title-order is one
 * step of its own, named after that option.
 */

/* The steps of the run without those options, in their order, each with the earlier steps it relies on. */
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
  rewind: ['opencode'],
  replies: ['opencode'],
  fork: ['opencode', 'replies'],
  outline: ['opencode'],
  compact: ['opencode'],
  'agent-plus': [],
  sessions: [],
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
/* Run whenever a step of NEEDS is: the conversation the others work in. */
const BASE = ['new-conversation'];
const RUNS = ['restricted', 'download', 'steward', 'title-order'];

/*
 * The steps that `run` (one of RUNS, or '' for the run with the steps of NEEDS) takes for `pattern`, the text of
 * OPENCODE_AGENT_PLUS_UI_STEPS: null when every step runs, otherwise a Set of names, empty when none of this run's steps
 * matches. Throws when the pattern is not a regular expression, or matches no step of any run.
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

/* The names NEEDS gives as needed that are not steps, and those that come after the step needing them. */
function outOfStep() {
  const names = Object.keys(NEEDS);
  return names.flatMap((x) => NEEDS[x].filter((y) => !names.includes(y) || names.indexOf(y) >= names.indexOf(x)).map((y) => `${x} needs ${y}`));
}

module.exports = { NEEDS, BASE, RUNS, chosen, outOfStep };
