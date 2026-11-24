// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan on OpenCode 2. The OpenCode Plus extension copies this file to <OPENCODE_PLUS_HOME>/opencode-plugin/
 * agent-work-plan/ and names that folder in OPENCODE_CONFIG_CONTENT (src/workplan). OpenCode 2 reads `id` and calls
 * setup(ctx); OpenCode 1 calls server(), which only says the plan needs OpenCode 2.
 *
 * What the model is told, and every change to a plan, comes from the shared Python scripts in OPENCODE_PLUS_HOOKS_DIR,
 * run as Claude Code runs its hooks: the plans folder as the first argument, the event as JSON on standard input.
 * Without Python or those scripts nothing is injected and the tools say why.
 *
 *   prompt       inject-work-plan.py's text for this turn, with tell-time-zone.py's and tell-reply-images.py's (which
 *                run whether or not the plan is on: their own settings in config.json say), kept in the user message's
 *                metadata; run-hooks.py runs the three in one Python process
 *   context      every user message's kept text put back on every request, so the request prefix never changes
 *   compaction   the same, plus the plan file, in the summary request
 *   tools        set_row, add_row, set_summary, set_status, each one run of plan-row.py
 *   events       session.compaction.ended runs resume-work-plan.py and the two notes again; session.usage.updated is recorded;
 *                session.execution.succeeded runs nudge-work-plan.py and keeps what it says as a synthetic message
 *
 * Environment: OPENCODE_PLUS_HOOKS_DIR (the scripts), OPENCODE_PLUS_HOME (plans are in its plans/, ~/.opencode-plus by default),
 * OPENCODE_PLUS_PLAN_NUDGE ("note", the default, keeps the reminder for the next turn; "resume" also runs a turn for it;
 * "off"), OPENCODE_PLUS_PLAN_LOG (a file to append a JSON line to for each thing done, for tests).
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = 'agent-work-plan';
const SESSION = /^ses_[0-9A-Za-z]{8,64}$/;
/* Longer than plan_common.LOCK_WAIT, so a run waiting for the plan's lock is not cut off first. */
const PYTHON_TIMEOUT_MS = 15000;
const OUTPUT_LIMIT = 1024 * 1024;
const META_KEY = 'agentWorkPlan';
/* The longest a plan file put in a summary request may be; inject-work-plan.py keeps its own text to the same. */
const PLAN_IN_SUMMARY_CHARS = 6000;
/* The longest a tool call's input is copied into the turn record nudge-work-plan.py reads. */
const INPUT_CHARS = 4000;
const MAX_SESSIONS = 64;
const EVENTS = ['session.compaction.ended', 'session.usage.updated', 'session.execution.succeeded'];
/* Runs several scripts on one event in one Python process; without it each runs in its own. */
const RUNNER = 'run-hooks.py';
/* Said on a user message and after a compaction besides the plan, each by its own setting. */
const NOTES = ['tell-time-zone.py', 'tell-reply-images.py'];

const home = () => process.env.OPENCODE_PLUS_HOME || path.join(os.homedir(), '.opencode-plus');
const plansDir = () => path.join(home(), 'plans');
const planPath = (sessionID) => path.join(plansDir(), `${sessionID}.json`);
const hooksDir = () => {
  const d = process.env.OPENCODE_PLUS_HOOKS_DIR || '';
  return d && path.isAbsolute(d) ? d : '';
};

function log(kind, data) {
  const file = process.env.OPENCODE_PLUS_PLAN_LOG;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n'); } catch (_) { /* never breaks a turn */ }
}

/* What config.json in the plans folder says about `enabled`, read the way plan_common.settings reads it. */
function enabled() {
  let given;
  try { given = JSON.parse(fs.readFileSync(path.join(plansDir(), 'config.json'), 'utf8')); } catch (_) { return true; }
  if (!given || typeof given !== 'object') return true;
  const markers = Array.isArray(given.extensionMarkers) ? given.extensionMarkers.filter((m) => typeof m === 'string' && path.isAbsolute(m)) : [];
  if (markers.length && !markers.some((m) => { try { return fs.statSync(m).isDirectory(); } catch (_) { return false; } })) return false;
  return typeof given.enabled === 'boolean' ? given.enabled : true;
}

/* Which of the notes config.json leaves on, read the way plan_common.settings reads it: tellTimeZone on and
   replyImages off when not written, both off once the extension is uninstalled everywhere. */
function notesOn() {
  let given;
  try { given = JSON.parse(fs.readFileSync(path.join(plansDir(), 'config.json'), 'utf8')); } catch (_) { return [NOTES[0]]; }
  if (!given || typeof given !== 'object') return [NOTES[0]];
  const markers = Array.isArray(given.extensionMarkers) ? given.extensionMarkers.filter((m) => typeof m === 'string' && path.isAbsolute(m)) : [];
  if (markers.length && !markers.some((m) => { try { return fs.statSync(m).isDirectory(); } catch (_) { return false; } })) return [];
  return NOTES.filter((n) => (n === NOTES[0] ? given.tellTimeZone !== false : given.replyImages === true));
}

/* How Python is started: launcher.json beside the scripts (written by the extension where python3 is not the name),
 * else python3. */
function launcher(dir) {
  try {
    const words = JSON.parse(fs.readFileSync(path.join(dir, 'launcher.json'), 'utf8')).row;
    if (Array.isArray(words) && words.length && words.every((w) => typeof w === 'string' && w)) return words;
  } catch (_) { /* absent */ }
  return ['python3'];
}

const MISSING_SCRIPTS = 'The work plan is not set up here: the folder of its scripts is missing, so nothing was written.';
const MISSING_PYTHON = 'The work plan needs Python 3, which was not found on this machine, so nothing was written.';

/* One run of a shared script. Resolves { stdout, stderr, code } or { missing } and never rejects. */
function runScript(script, args, input) {
  const dir = hooksDir();
  const file = dir ? path.join(dir, script) : '';
  if (!file || !fs.existsSync(file)) return Promise.resolve({ missing: MISSING_SCRIPTS });
  const words = launcher(dir);
  const env = { ...process.env, OPENCODE_PLUS_PLAN_TOOLS: 'tools', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.execFile(words[0], [...words.slice(1), file, ...args],
        { env, timeout: PYTHON_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') return resolve({ missing: MISSING_PYTHON });
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code, killed: !!(err && err.killed) });
        });
    } catch (e) {
      return resolve({ missing: MISSING_PYTHON });
    }
    child.on('error', () => { /* reported through the callback */ });
    if (child.stdin) {
      child.stdin.on('error', () => { /* the script may exit without reading */ });
      child.stdin.end(input == null ? '' : input);
    }
  });
}

/* A hook script's additionalContext for `payload`, or ''. */
async function hookText(script, payload) {
  const r = await runScript(script, [plansDir()], JSON.stringify(payload));
  if (r.missing || r.code !== 0 || !r.stdout.trim()) {
    log('hook', { script, missing: r.missing, code: r.code, stderr: r.stderr && r.stderr.slice(-400) });
    return '';
  }
  try {
    const out = JSON.parse(r.stdout);
    const text = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    log('hook', { script, chars: typeof text === 'string' ? text.length : 0 });
    return typeof text === 'string' ? text : '';
  } catch (_) {
    log('hook', { script, unparsed: r.stdout.slice(0, 200) });
    return '';
  }
}

/* Each of `scripts`' additionalContext for `payload`: { name: text }. */
async function hookTexts(scripts, payload) {
  const dir = hooksDir();
  if (dir && fs.existsSync(path.join(dir, RUNNER))) {
    const r = await runScript(RUNNER, [plansDir(), ...scripts], JSON.stringify(payload));
    let texts = null;
    if (!r.missing && r.code === 0) {
      try { const v = JSON.parse(r.stdout); if (v && v.texts && typeof v.texts === 'object') texts = v.texts; } catch (_) { /* below */ }
    }
    if (texts) {
      const out = {};
      for (const name of scripts) {
        out[name] = typeof texts[name] === 'string' ? texts[name] : '';
        log('hook', { script: name, chars: out[name].length, via: RUNNER });
      }
      return out;
    }
    log('hook', { script: RUNNER, missing: r.missing, code: r.code, stderr: r.stderr && r.stderr.slice(-400) });
    if (r.missing) return Object.fromEntries(scripts.map((n) => [n, '']));
  }
  const out = {};
  for (const name of scripts) out[name] = await hookText(name, payload);
  return out;
}

/* OpenCode's harness prompt tells the model that a system-update block is from the harness, not from the user. */
const wrap = (text) => `<system-update>\n${text}\n</system-update>`;

/* The plan tools: Codex Plus's plan-mcp.py definitions, without `plan`, since a call names its own session. */
const STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked', 'done', 'dropped'];
const WAITING_ON = ['user', 'build', 'someone', 'session', 'other'];
const BRIEF_WIDTH = { summary: 400, doing: 80, progress: 100, next: 60 };
const COMMON = {
  note: { type: 'string', description: "Replace the row's note; an empty string removes it." },
  waiting_on: { type: 'string', enum: [...WAITING_ON, ''], description: 'Who a waiting row waits on; an empty string removes it.' },
  question: { type: 'string', description: 'With waiting_on user: the one question the user has to answer.' },
};
const TOOLS = [
  {
    name: 'set_row',
    description: "Put a row of this conversation's work plan in a state, or change its note, description, or who it waits on. The time is read from the clock.",
    input: { type: 'object', required: ['row'], additionalProperties: false, properties: {
      row: { type: 'string', description: 'The number in front of the row, such as 3 or 2.1.' },
      state: { type: 'string', enum: STATES, description: "Leave it out to keep the row's state." },
      detail: { type: 'string', description: "Replace the row's description; an empty string removes it." },
      ...COMMON } },
    argv: (a) => ['set', ...opts(a, ['note', 'detail', 'waiting_on', 'question']), '--', str(a.row), ...(a.state ? [str(a.state)] : [])],
  },
  {
    name: 'add_row',
    description: "Add a row to this conversation's work plan, at the end or under another row. Creates the plan file when the conversation has none.",
    input: { type: 'object', required: ['state', 'title'], additionalProperties: false, properties: {
      state: { type: 'string', enum: STATES },
      title: { type: 'string' },
      under: { type: 'string', description: 'The row to add it under, such as 2.' },
      ...COMMON } },
    argv: (a) => ['add', ...opts(a, ['under', 'note', 'waiting_on', 'question']), '--', str(a.state), str(a.title)],
  },
  {
    name: 'set_summary',
    description: "Write this conversation's summary, which Agent Plus shows when its row is clicked: what the conversation is for, the stage it has reached, and the decisions made that later work must not forget. Write it for someone coming back to it, in the conversation's language, with no names coined in it. "
      + `At most ${BRIEF_WIDTH.summary} wide, a CJK character counting 2 and any other 1; a longer one is refused. The time is read from the clock.`,
    input: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', description: 'The summary.' } } },
    argv: (a) => ['summary', '--', str(a.text)],
  },
  {
    name: 'set_status',
    description: 'Write where this conversation stands now, in three parts, for someone who stepped away and has to pick up at once: what you are doing, the latest progress, and who it waits on or the next step. In the conversation\'s language; write none in a part with nothing to say. Widths count a CJK character as 2 and any other as 1, and a part past its limit is refused. The time is read from the clock.',
    input: { type: 'object', required: ['doing', 'progress', 'next'], additionalProperties: false, properties: {
      doing: { type: 'string', description: `What you are doing, at most ${BRIEF_WIDTH.doing} wide.` },
      progress: { type: 'string', description: `The latest progress, at most ${BRIEF_WIDTH.progress} wide.` },
      next: { type: 'string', description: `Who it waits on, or the next step, at most ${BRIEF_WIDTH.next} wide.` } } },
    argv: (a) => ['status', ...opts(a, ['doing', 'progress', 'next'])],
  },
];
const TOOL_NAMES = TOOLS.map((t) => t.name);

function str(v) { return v == null ? '' : String(v); }
/* --name=value, so that a value starting with a dash is never read as an option. */
function opts(a, names) {
  return names.filter((n) => a[n] != null).map((n) => `--${n.replace(/_/g, '-')}=${str(a[n])}`);
}

/* What a plan tool call returns to the model: plan-row.py's own words, or why it could not run. */
async function runTool(tool, sessionID, input) {
  if (!SESSION.test(String(sessionID || ''))) return `This conversation has no session id a work plan can be named by (${sessionID}).`;
  const args = [planPath(sessionID), ...tool.argv(input && typeof input === 'object' ? input : {})];
  const r = await runScript('plan-row.py', args, '');
  if (r.missing) return r.missing;
  if (r.killed) return `The work plan command did not finish within ${PYTHON_TIMEOUT_MS / 1000} seconds; nothing may have been written. Run it again.`;
  const text = (r.code === 0 ? r.stdout : (r.stderr || r.stdout)).trim();
  log('tool', { tool: tool.name, code: r.code, text: text.slice(0, 300) });
  return text || (r.code === 0 ? 'Done.' : `The work plan command failed (exit ${r.code}).`);
}

/* Per-session facts the plugin needs between events, for the sessions this plugin instance has seen lately. */
function sessions() {
  const map = new Map();
  return {
    get(id) {
      let s = map.get(id);
      if (s) { map.delete(id); } else { s = { turnId: '', resume: '', resumeNotes: '', nudgedTurn: '', model: null, usage: null }; }
      map.set(id, s);
      while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
      return s;
    },
    peek: (id) => map.get(id),
  };
}

/* Puts back the text each user message was admitted with. Requests are built afresh each time, so this never doubles.
 * Returns how many messages carried one. */
function attach(messages) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const kept = m && m.role === 'user' && m.metadata && m.metadata[META_KEY];
    if (typeof kept === 'string' && kept && Array.isArray(m.content)) { m.content.push({ type: 'text', text: kept }); n++; }
  }
  return n;
}

function readPlanText(sessionID) {
  try { return fs.readFileSync(planPath(sessionID), 'utf8'); } catch (_) { return ''; }
}

/* An ISO time; `up` rounds up to the second, because the shared scripts compare times in whole seconds against a turn
 * start in fractions of one, and a call made in the turn's first second would otherwise fall before it. */
function stamp(ms, up) {
  const t = up ? Math.ceil(ms / 1000) * 1000 : ms;
  return new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
}

function clip(value) {
  let text;
  try { text = JSON.stringify(value === undefined ? {} : value); } catch (_) { text = '{}'; }
  if (text.length <= INPUT_CHARS) return value === undefined ? {} : value;
  const command = value && typeof value === 'object' && typeof value.command === 'string' ? value.command.slice(0, INPUT_CHARS) : undefined;
  return command ? { command } : { cut: text.slice(0, INPUT_CHARS) };
}

/*
 * The turn record nudge-work-plan.py reads in place of a transcript (shared/plugin/opencode/plan_agent.py there says
 * its shape): the user's own messages, each tool call and the text of each reply in the session's context, oldest
 * first, and the last usage. Returns { lines, reply }.
 */
function turnRecord(messages, sessionID, s) {
  const plan = planPath(sessionID);
  const given = Array.isArray(messages) ? messages : (messages && (messages.items || messages.data)) || [];
  const list = (Array.isArray(given) ? given : []).slice()
    .sort((a, b) => ((a && a.time && a.time.created) || 0) - ((b && b.time && b.time.created) || 0));
  const lines = [];
  let reply = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const at = (m.time && m.time.created) || 0;
    if (m.type === 'user') {
      lines.push({ type: 'user_message', timestamp: stamp(at, false), text: str(m.text) });
    } else if (m.type === 'assistant' && Array.isArray(m.content)) {
      let text = '';
      for (const p of m.content) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'tool') {
          const input = p.state && p.state.input;
          const row = { type: 'tool_call', timestamp: stamp((p.time && p.time.created) || at, true), name: str(p.name), input: clip(input) };
          if (TOOL_NAMES.includes(row.name)) row.plan = plan;
          lines.push(row);
        } else if (p.type === 'text' && p.text) {
          text += p.text;
        }
      }
      if (text) {
        lines.push({ type: 'assistant_text', timestamp: stamp((m.time && (m.time.completed || m.time.created)) || at, true), text });
        reply = text;
      }
    }
  }
  if (s && s.usage) lines.push({ type: 'usage', timestamp: stamp(s.usage.at, true), tokens: s.usage.tokens, ...(s.usage.window ? { window: s.usage.window } : {}) });
  return { lines: lines.map((l) => JSON.stringify(l)), reply };
}

async function withRecord(lines, fn) {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plus-plan-'));
    const file = path.join(dir, 'turn.jsonl');
    fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
    return await fn(file);
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* left for the OS */ } }
  }
}

/* A turn record of the last usage alone, for the notes that read the context's size. */
const usageLines = (s) => (s && s.usage ? [JSON.stringify({ type: 'usage', timestamp: stamp(s.usage.at, true), tokens: s.usage.tokens, ...(s.usage.window ? { window: s.usage.window } : {}) })] : []);

const usageFields = (s) => (s && s.usage ? { context_tokens: s.usage.tokens, ...(s.usage.window ? { context_window: s.usage.window } : {}) } : {});

async function setup(ctx) {
  if (!ctx || !ctx.session || typeof ctx.session.hook !== 'function') {
    /* OpenCode 1.19 also calls setup() with a partial context before server(). */
    return undefined;
  }
  log('setup', { version: ctx.app && ctx.app.version, directory: ctx.location && ctx.location.directory, hooks: hooksDir(), plans: plansDir() });
  const state = sessions();
  const registrations = [];
  const windows = new Map();
  const nudgeMode = () => (['note', 'resume', 'off'].includes(process.env.OPENCODE_PLUS_PLAN_NUDGE) ? process.env.OPENCODE_PLUS_PLAN_NUDGE : 'note');

  /* The tools are registered while plans are on and withdrawn while they are off; requests made after either take it. */
  let tools = null;
  let toolsBusy = Promise.resolve();
  const syncTools = () => {
    toolsBusy = toolsBusy.then(async () => {
      const want = enabled();
      if (want && !tools && ctx.tool && typeof ctx.tool.transform === 'function') {
        tools = await ctx.tool.transform((editor) => {
          for (const t of TOOLS) {
            editor.add({ name: t.name, description: t.description, input: t.input, options: { codemode: false },
              execute: async (input, context) => ({ content: await runTool(t, context && context.sessionID, input) }) });
          }
        });
        log('tools', { registered: true });
      } else if (!want && tools) {
        const t = tools;
        tools = null;
        await t.dispose();
        log('tools', { registered: false });
      }
    }).catch((e) => log('tools-error', { error: String(e && e.message || e) }));
    return toolsBusy;
  };
  await syncTools();

  registrations.push(await ctx.session.hook('prompt', async (ev) => {
    const sessionID = ev && ev.sessionID;
    if (!SESSION.test(String(sessionID || ''))) return;
    await syncTools();
    const s = state.get(sessionID);
    const said = ev.prompt && typeof ev.prompt.text === 'string' ? ev.prompt.text : '';
    s.turnId = String(ev.messageID || `${sessionID}-${Date.now()}`);
    const pending = s.resume;
    const notesAfter = s.resumeNotes;
    s.resume = '';
    s.resumeNotes = '';
    const on = enabled();
    const scripts = [...(on ? ['inject-work-plan.py'] : []), ...notesOn()];
    /* Nothing on: no Python at all. */
    if (!scripts.length) {
      if (notesAfter) ev.metadata = { ...(ev.metadata || {}), [META_KEY]: wrap(notesAfter) };
      log('prompt', { sessionID, turnId: s.turnId, chars: notesAfter.length, resumed: !!pending, plan: on });
      return;
    }
    /* The notes read the context's size from a turn record: here only its last usage. */
    const texts = await withRecord(usageLines(s), (file) => hookTexts(scripts, {
      hook_event_name: 'UserPromptSubmit', session_id: sessionID, turn_id: s.turnId, prompt: said,
      cwd: (ctx.location && ctx.location.directory) || '', transcript_path: file, in_panel: true, ...usageFields(s) }));
    const all = [on ? pending : '', notesAfter, ...scripts.map((n) => texts[n])].filter(Boolean).join('\n\n');
    if (all) ev.metadata = { ...(ev.metadata || {}), [META_KEY]: wrap(all) };
    log('prompt', { sessionID, turnId: s.turnId, chars: all.length, resumed: !!pending, plan: on });
  }));

  registrations.push(await ctx.session.hook('context', (ev) => {
    if (ev && ev.model && SESSION.test(String(ev.sessionID || ''))) {
      const s = state.peek(ev.sessionID);
      if (s) s.model = ev.model;
    }
    const kept = attach(ev && ev.messages);
    if (process.env.OPENCODE_PLUS_PLAN_LOG) {
      const tools = (ev && ev.tools) || {};
      const shell = tools.shell && tools.shell.input && tools.shell.input.properties;
      log('context', { sessionID: ev && ev.sessionID, messages: ((ev && ev.messages) || []).length, kept,
        tools: Object.keys(tools), shellInput: shell ? Object.keys(shell) : null });
    }
  }));

  registrations.push(await ctx.session.hook('compaction', (ev) => {
    const kept = attach(ev && ev.messages);
    log('compaction-request', { sessionID: ev && ev.sessionID, messages: ((ev && ev.messages) || []).length, kept });
    if (!ev || !SESSION.test(String(ev.sessionID || '')) || !Array.isArray(ev.system) || !enabled()) return;
    const text = readPlanText(ev.sessionID).trim();
    if (!text) return;
    const shown = text.length > PLAN_IN_SUMMARY_CHARS ? `${text.slice(0, PLAN_IN_SUMMARY_CHARS)}\n... (cut; the file has the rest)` : text;
    ev.system.push({ type: 'text', text: `This conversation keeps a work plan, one row per task, in ${planPath(ev.sessionID)}. `
      + 'Keep that path in the summary with the rows that are still open, and say that work resumes by reading that file. '
      + `The file as it is now:\n${shown}` });
    log('compaction', { sessionID: ev.sessionID, chars: shown.length });
  }));

  async function windowOf(model) {
    if (!model || !ctx.model || typeof ctx.model.list !== 'function') return 0;
    const key = `${model.providerID}/${model.id}`;
    if (windows.has(key)) return windows.get(key);
    let size = 0;
    try {
      const found = (await ctx.model.list()).find((m) => m && m.providerID === model.providerID && (m.id === model.id || m.modelID === model.id));
      size = (found && found.limit && found.limit.context) || 0;
    } catch (_) { /* unknown */ }
    windows.set(key, size);
    return size;
  }

  async function onCompacted(sessionID) {
    const s = state.get(sessionID);
    const scripts = ['resume-work-plan.py', ...notesOn()];
    const texts = await withRecord(usageLines(s), (file) => hookTexts(scripts, { hook_event_name: 'SessionStart', source: 'compact',
      session_id: sessionID, transcript_path: file, in_panel: true }));
    s.resume = texts['resume-work-plan.py'] || '';
    s.resumeNotes = NOTES.map((n) => texts[n] || '').filter(Boolean).join('\n\n');
    log('compacted', { sessionID, chars: s.resume.length + s.resumeNotes.length });
  }

  async function onUsage(sessionID, tokens) {
    if (!tokens || typeof tokens !== 'object') return;
    const cache = tokens.cache || {};
    const used = [tokens.input, cache.read, cache.write].reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0);
    const s = state.peek(sessionID);
    if (!s) return;
    s.usage = { tokens: used, at: Date.now(), window: await windowOf(s.model) };
  }

  async function onTurnEnd(sessionID) {
    const s = state.peek(sessionID);
    /* Only a turn this instance injected, and only once: the reminder's own message starts no turn, and a compaction's
     * execution ends with no new prompt. */
    if (!s || !s.turnId || s.nudgedTurn === s.turnId || nudgeMode() === 'off' || !enabled()) return;
    s.nudgedTurn = s.turnId;
    let messages = [];
    try { messages = await ctx.session.context({ sessionID }); } catch (e) { log('context-error', { error: String(e && e.message || e) }); }
    const { lines, reply } = turnRecord(messages, sessionID, s);
    const text = await withRecord(lines, (file) => hookText('nudge-work-plan.py', {
      hook_event_name: 'Stop', session_id: sessionID, turn_id: s.turnId, transcript_path: file,
      last_assistant_message: reply, stop_hook_active: false, ...usageFields(s) }));
    log('turn-end', { sessionID, turnId: s.turnId, records: lines.length, chars: text.length });
    if (!text) return;
    await ctx.session.synthetic({ sessionID, text: wrap(text), description: 'Work plan reminder',
      metadata: { [META_KEY]: 'reminder' }, resume: nudgeMode() === 'resume' });
  }

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: EVENTS, signal: controller.signal })) {
        const sessionID = event && event.data && event.data.sessionID;
        if (!SESSION.test(String(sessionID || ''))) continue;
        try {
          if (event.type === 'session.compaction.ended') await onCompacted(sessionID);
          else if (event.type === 'session.usage.updated') await onUsage(sessionID, event.data.tokens);
          else if (event.type === 'session.execution.succeeded') await onTurnEnd(sessionID);
        } catch (e) {
          log('event-error', { type: event.type, error: String(e && e.message || e) });
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) log('events-error', { error: String(e && e.message || e) });
    }
  })();

  return async () => {
    controller.abort();
    for (const r of registrations.splice(0)) { try { await r.dispose(); } catch (_) { /* already gone */ } }
    if (tools) { const t = tools; tools = null; try { await t.dispose(); } catch (_) { /* already gone */ } }
  };
}

/* OpenCode 1: no work plan. One line in its log says why. */
async function server(input) {
  const message = 'The work plan needs OpenCode 2; this plugin does nothing on OpenCode 1.';
  try {
    const app = input && input.client && input.client.app;
    if (app && typeof app.log === 'function') await app.log({ body: { service: ID, level: 'info', message } });
    else process.stderr.write(`[${ID}] ${message}\n`);
  } catch (_) { /* not logged */ }
  log('v1', { message });
  return {};
}

module.exports = { id: ID, setup, server };
