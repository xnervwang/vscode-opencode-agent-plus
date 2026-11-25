// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The "latest reply" file beside a conversation's plan, <plans>/<session id>.reply.json, rewritten when a turn ends: what
 * a steward in Claude Code Plus reads to tell what an OpenCode conversation said, as its steward-peek.py reads Claude
 * Code's transcript. Its limits are that script's:
 *
 *   { format: 1, at, lastUserAt, said: [{ text, at }], reply }
 *
 * `said` is the user's latest messages, oldest first; `reply` is the text the conversation wrote after the user's last
 * message (no reasoning, no tool output), its parts joined by a blank line and cut to its last MAX_REPLY_CHARS. Text a
 * plugin added for the model (a synthetic userMessage) is not the user's. For a conversation opened from history the
 * state is first built from its stored events. Deleting the conversation deletes the file (src/workplan removePlan).
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const SUFFIX = '.reply.json';
const MAX_SAID = 5;
const MAX_SAID_CHARS = 2000;
const MAX_REPLY_CHARS = 6000;
/* Kept while it builds up, so a long turn is not held whole in memory. */
const KEEP_CHARS = MAX_REPLY_CHARS * 2;

const cutSaid = (t) => (t.length <= MAX_SAID_CHARS ? t : `${t.slice(0, MAX_SAID_CHARS)}...`);
const cutReply = (t) => (t.length <= MAX_REPLY_CHARS ? t : `...${t.slice(-MAX_REPLY_CHARS)}`);

/* Builds the file's body event by event. */
function createReplyState() {
  const st = { said: [], reply: '', lastUserAt: 0, at: 0, joinNext: false };
  return {
    state: st,
    take(ev) {
      if (!ev || typeof ev !== 'object') return false;
      if (ev.type === 'userMessage') {
        if (ev.synthetic === true) return false;
        const at = Number(ev.at) || 0;
        st.said.push({ text: cutSaid(String(ev.text || '')), at });
        while (st.said.length > MAX_SAID) st.said.shift();
        st.lastUserAt = at;
        st.reply = '';
        st.joinNext = false;
        return false;
      }
      if (ev.type === 'text' && typeof ev.delta === 'string' && ev.delta) {
        if (st.joinNext && st.reply) st.reply += '\n\n';
        st.joinNext = false;
        st.reply += ev.delta;
        if (st.reply.length > KEEP_CHARS) st.reply = st.reply.slice(-KEEP_CHARS);
        return false;
      }
      if (ev.type === 'toolCall' || ev.type === 'toolResult' || ev.type === 'reasoning' || ev.type === 'turnStart') { st.joinNext = true; return false; }
      if (ev.type === 'turnEnd') { st.at = Number(ev.at) || Date.now(); st.joinNext = true; return true; }
      return false;
    },
    body() {
      return { format: FORMAT, at: st.at, lastUserAt: st.lastUserAt, said: st.said.slice(), reply: cutReply(st.reply) };
    },
  };
}

/*
 * deps:
 *   dir()      the plans folder
 *   log(line)  optional
 */
function createReplyFiles(deps) {
  const log = (line) => { try { if (deps.log) deps.log(line); } catch (_) { /* not logged */ } };
  const fileOf = (id) => path.join(deps.dir(), `${id}${SUFFIX}`);

  function write(id, body) {
    const file = fileOf(id);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      log(`writing the latest reply of ${id} failed: ${(e && e.message) || e}`);
      return false;
    }
  }

  return {
    fileOf,
    /* Replays `history`, then rewrites the file at the end of each turn of `conversation`; call the returned function
       to stop. */
    track(id, conversation, history) {
      const r = createReplyState();
      for (const ev of Array.isArray(history) ? history : []) r.take(ev);
      const off = conversation.on((ev) => { if (r.take(ev)) write(id, r.body()); });
      return () => { try { if (typeof off === 'function') off(); else if (off && off.dispose) off.dispose(); } catch (_) { /* gone */ } };
    },
  };
}

module.exports = { createReplyFiles, createReplyState, SUFFIX, MAX_SAID, MAX_SAID_CHARS, MAX_REPLY_CHARS, FORMAT };
