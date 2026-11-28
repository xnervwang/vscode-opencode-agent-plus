// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation open in this window asks for a title of its own with the plugin's set_title tool, which writes a
 * request in <plans>/retitle/ and waits for the answer beside it (Agent Plus docs/protocol.md "Retitle requests"):
 *
 *   <key>.json          { format: 1, key, agent, sessionId, title, at, via }, written by the plugin
 *   <key>.claimed       the request once a window has taken it, by renaming it
 *   <key>.result.json   { format: 1, key, outcome, reason, title, at }, what came of it
 *
 * The window that has the conversation open takes its request. It follows the conversation's events and renames only
 * when it saw the conversation's own set_title call carrying the same title, so a request any other process wrote is
 * refused. The title loses the marks this extension draws and extra white space, is cut to 80
 * characters, and is set with the window's own rename. The folder, which the plugin makes, is read every second while a conversation is
 * open here; files older than ten minutes are removed.
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const DIR = 'retitle';
const REQUEST = /^([0-9a-z]{12,40})\.json$/;
const LEFTOVER = /^[0-9a-z]{12,40}\.(?:result\.json|claimed|withdrawn|json\.\d+\.tmp)$/;
const SESSION = /^ses_[0-9A-Za-z]{8,64}$/;
/* The tool's name as the conversation reports the call; OpenCode may put a prefix before a plugin's tool. */
const TOOL = /(?:^|[_.:/-])set_title$/;
const MAX_TITLE = 80;
const POLL_MS = 1000;
/* A call seen confirms a request for SEEN_MS; a request waits up to CONFIRM_MS for its call. OpenCode reports the call
   to this window at about the time the tool starts. */
const SEEN_MS = 5 * 60 * 1000;
const CONFIRM_MS = 5000;
const CONFIRM_POLL_MS = 250;
const LEFTOVER_MS = 10 * 60 * 1000;
const CALLS_KEPT = 8;

function writeJson(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/* Runs of white space as one space, trimmed, cut to MAX_TITLE characters, with `strip` taking the marks off. */
function cleanTitle(title, strip) {
  let t = String(title == null ? '' : title);
  try { t = String(strip ? strip(t) : t); } catch (_) { /* as it is */ }
  t = t.replace(/[\u{1F451}\u{1F4E9}✉️]/gu, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, MAX_TITLE).join('').trim();
}

/*
 * deps:
 *   dir()               the plans folder; requests are in its retitle/ folder
 *   ids()               the conversations open in this window
 *   rename(id, title)   Promise: renames the conversation, in OpenCode and in this window
 *   strip(title)        optional: takes the extension's marks off a title
 *   log(line)           optional
 *   now(), pollMs, confirmMs   optional, for tests
 */
function createRetitles(deps) {
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const now = deps.now || Date.now;
  const pollMs = deps.pollMs || POLL_MS;
  const confirmMs = deps.confirmMs == null ? CONFIRM_MS : deps.confirmMs;
  const folder = () => path.join(deps.dir(), DIR);
  /* id -> the set_title calls seen in it lately: [{ title, at }], newest last. */
  const calls = new Map();
  const busy = new Set();
  let timer = null;
  let gone = false;

  const openIds = () => { try { return new Set(deps.ids()); } catch (_) { return new Set(); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function saw(id, title) {
    const list = (calls.get(id) || []).filter((c) => now() - c.at < SEEN_MS);
    list.push({ title, at: now() });
    calls.set(id, list.slice(-CALLS_KEPT));
  }
  const called = (id, title) => (calls.get(id) || []).some((c) => c.title === title && now() - c.at < SEEN_MS);

  /* Follows `conversation` for its set_title calls; returns a function that stops following. The history is not read:
     a call in it belongs to an earlier request, which has had its answer. */
  function track(id, conversation) {
    const take = (ev) => {
      if (!ev || typeof ev !== 'object' || ev.type !== 'toolCall' || !TOOL.test(String(ev.name || ''))) return;
      const input = ev.input && typeof ev.input === 'object' ? ev.input : {};
      if (typeof input.title === 'string') saw(id, input.title);
    };
    let off = null;
    try { off = conversation && typeof conversation.on === 'function' ? conversation.on(take) : null; } catch (_) { /* nothing to follow */ }
    return () => { try { if (typeof off === 'function') off(); else if (off && off.dispose) off.dispose(); } catch (_) { /* gone */ } };
  }

  async function answer(body) {
    const id = body && typeof body.sessionId === 'string' ? body.sessionId : '';
    const asked = body && typeof body.title === 'string' ? body.title : '';
    if (!SESSION.test(id)) return { outcome: 'refused', reason: 'the request names no OpenCode conversation', title: '' };
    const end = now() + confirmMs;
    while (!called(id, asked) && now() < end && !gone) await sleep(CONFIRM_POLL_MS);
    if (!called(id, asked)) return { outcome: 'refused', reason: 'this window did not see the conversation ask for that title itself', title: '' };
    const title = cleanTitle(asked, deps.strip);
    if (!title) return { outcome: 'refused', reason: 'the title is empty once its marks are taken off', title: '' };
    try {
      await deps.rename(id, title);
    } catch (e) {
      return { outcome: 'failed', reason: String((e && e.message) || e).replace(/\.$/, ''), title: '' };
    }
    calls.set(id, (calls.get(id) || []).filter((c) => c.title !== asked));
    return { outcome: 'done', reason: '', title };
  }

  async function take(name) {
    const m = REQUEST.exec(name);
    if (!m || busy.has(name) || gone) return;
    const dir = folder();
    let body = null;
    try { body = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { return; }
    if (!body || body.format !== FORMAT || body.agent !== 'OpenCode' || !openIds().has(body.sessionId)) return;
    const claimed = path.join(dir, `${m[1]}.claimed`);
    busy.add(name);
    try {
      try { fs.renameSync(path.join(dir, name), claimed); } catch (_) { return; }
      const r = await answer(body);
      log(`retitle of ${body.sessionId}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
      try { writeJson(path.join(dir, `${m[1]}.result.json`), { format: FORMAT, key: m[1], ...r, at: now() }); } catch (e) { log(`writing the retitle answer failed: ${(e && e.message) || e}`); }
      try { fs.unlinkSync(claimed); } catch (_) { /* gone */ }
    } finally {
      busy.delete(name);
    }
  }

  function scan() {
    const dir = folder();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (REQUEST.test(name)) take(name).catch((e) => log(`retitle ${name}: ${(e && e.message) || e}`));
      else if (LEFTOVER.test(name)) {
        const file = path.join(dir, name);
        try { if (now() - fs.statSync(file).mtimeMs > LEFTOVER_MS) fs.unlinkSync(file); } catch (_) { /* gone */ }
      }
    }
  }

  /* Starts or stops reading the folder, which happens only while a conversation is open here; call it when that changes. */
  function opened() {
    const want = !gone && openIds().size > 0;
    if (want && !timer) {
      timer = setInterval(scan, pollMs);
      if (timer.unref) timer.unref();
      scan();
    } else if (!want && timer) {
      clearInterval(timer);
      timer = null;
    }
    const open = openIds();
    for (const id of [...calls.keys()]) if (!open.has(id)) calls.delete(id);
  }

  return {
    track,
    opened,
    scan,
    take,
    watching: () => !!timer,
    dispose() {
      gone = true;
      opened();
    },
  };
}

module.exports = { createRetitles, cleanTitle, DIR, MAX_TITLE };
