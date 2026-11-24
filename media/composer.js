// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the chat page's input does with `/` and `@`, without the page: which word is being typed, what the lists show
 * for it, and the text once one is picked; and the page's other decisions that need no page: what Esc does, which chime
 * a change of state sounds, when the context ring is outlined, how an image in a reply is shown, the Background
 * line's summary, the rows of the outline of the user's messages, which items the subagent filter hides, and where a
 * reply names another conversation by its id. The page loads it as window.ChatComposer; the tests require it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatComposer = api;
}(typeof self !== 'undefined' ? self : this, () => {
  /* A command being typed: `/` at the very start of the input and no space before the caret. */
  function slashToken(text, caret) {
    const t = String(text || '');
    const at = typeof caret === 'number' ? caret : t.length;
    if (!t.startsWith('/')) return null;
    const head = t.slice(0, at);
    if (/\s/.test(head)) return null;
    return { start: 0, end: at, query: head.slice(1) };
  }

  /* Commands for a query: names starting with it, then names holding it, then descriptions holding it. */
  function filterCommands(commands, query, limit = 30) {
    const q = String(query || '').toLowerCase();
    const list = Array.isArray(commands) ? commands.filter((c) => c && typeof c.name === 'string') : [];
    const score = (c) => {
      const n = c.name.toLowerCase();
      if (n.startsWith(q)) return 0;
      if (n.includes(q)) return 1;
      return String(c.description || '').toLowerCase().includes(q) ? 2 : -1;
    };
    return list.map((c, i) => [score(c), i, c]).filter((x) => x[0] >= 0)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map((x) => x[2]);
  }

  /* A file reference being typed: `@` at the start or after a space, then no space up to the caret. */
  function atToken(text, caret) {
    const t = String(text || '');
    const at = typeof caret === 'number' ? caret : t.length;
    const m = /(^|\s)@([^\s@]*)$/.exec(t.slice(0, at));
    if (!m) return null;
    return { start: at - m[2].length - 1, end: at, query: m[2] };
  }

  /* The text with the token replaced by `insert` and a space, and where the caret goes. */
  function insertToken(text, token, insert) {
    const t = String(text || '');
    const rest = t.slice(token.end);
    const add = rest.startsWith(' ') ? insert : `${insert} `;
    return { text: t.slice(0, token.start) + add + rest, caret: token.start + add.length };
  }

  /* The picked files still named in the text as @<rel>, once each. */
  function filesInText(text, files) {
    const t = String(text || '');
    const seen = new Set();
    const out = [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || !f.rel || seen.has(f.path)) continue;
      const i = t.indexOf(`@${f.rel}`);
      const after = i >= 0 ? t.charAt(i + f.rel.length + 1) : '';
      if (i >= 0 && (after === '' || /[\s.,;:!?)]/.test(after))) { seen.add(f.path); out.push(f); }
    }
    return out;
  }

  /* Base64 of a data: URL and its type, or null for anything that is not an image. */
  function imageOfDataUrl(url) {
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(String(url || ''));
    return m ? { mediaType: m[1], data: m[2], bytes: Math.floor(m[2].length * 3 / 4) } : null;
  }

  /* What Esc does: close the open box or list first, else stop a turn that runs; null for nothing. */
  function escapeAction({ box = false, menu = false, status = 'idle' } = {}) {
    if (box) return 'closeBox';
    if (menu) return 'closeMenu';
    return status && status !== 'idle' ? 'abort' : null;
  }

  /* The chime for a change from head `was` to `now` ({ status, pending, waitingFor }): a new request is a permission
     or a question, a turn going idle is done; null for none, and for the first head a page is given. */
  function chimeKind(was, now) {
    if (!was || !now) return null;
    if ((now.pending || 0) > (was.pending || 0)) return now.waitingFor === 'question' ? 'question' : 'permission';
    return was.status !== 'idle' && now.status === 'idle' ? 'done' : null;
  }

  /* Whether the ring is outlined: 15% of the window or less left. */
  const ringLow = (pct) => typeof pct === 'number' && pct >= 0 && 100 - pct <= 15;

  /* How an image in a reply is shown: 'data' as it is, 'local' read by the extension, 'link' a link to it (a web address
     is never fetched; a relative path names no folder). */
  function imageKind(src, localOk) {
    const s = String(src || '');
    if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(s)) return 'data';
    if (localOk && /^(?:file:\/\/|\/|[A-Za-z]:[\\/])/.test(s)) return 'local';
    return 'link';
  }

  /* The Background line's summary for head().background, or '' when nothing runs. */
  function backgroundSummary(list) {
    const items = Array.isArray(list) ? list : [];
    if (!items.length) return '';
    const subs = items.filter((b) => b && b.kind === 'subagent').length;
    const cmds = items.length - subs;
    const parts = [];
    if (subs) parts.push(`${subs} subagent${subs === 1 ? '' : 's'}`);
    if (cmds) parts.push(`${cmds} command${cmds === 1 ? '' : 's'}`);
    return `Background: ${parts.join(', ')} running`;
  }

  const COMPACTION_WORDS = { running: 'Compacting…', completed: 'Compacted', failed: 'Compacting failed', cancelled: 'Compacting cancelled' };
  const OUTLINE_CHARS = 80;
  /* The outline beside the log: the user's messages, numbered, and the points where the conversation was compacted, in
     the order of `items` (the page's items: { id, kind, text, at, status, hidden }). */
  function outlineRows(items) {
    const out = [];
    let n = 0;
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || it.hidden === true) continue;
      if (it.kind === 'user') {
        n += 1;
        const line = String(it.text || '').replace(/\s+/g, ' ').trim();
        out.push({ id: it.id, kind: 'user', n, at: it.at || 0,
          label: line.length > OUTLINE_CHARS ? `${line.slice(0, OUTLINE_CHARS - 1)}…` : line || '(no text)' });
      } else if (it.kind === 'compaction') {
        out.push({ id: it.id, kind: 'compaction', at: it.at || 0, label: COMPACTION_WORDS[it.status] || 'Compacted' });
      }
    }
    return out;
  }

  /* What the subagent filter does with an item: 'hide' a subagent's own card, a tool call a subagent made, and a
     request a subagent made once it is answered (an open one needs the user, so it stays); 'fold' the parent's call
     that started a subagent, which stays with its progress folded away; '' for the parent's own output. */
  function subagentShare(item) {
    if (!item) return '';
    if (item.kind === 'subagent') return 'hide';
    if (item.subagent && (item.kind === 'tool' || ((item.kind === 'permission' || item.kind === 'question') && item.decision))) return 'hide';
    if (item.kind === 'tool' && item.child) return 'fold';
    return '';
  }

  /* Where `text` names one of the conversations `ids` (a Map or Set keyed by session id) by its whole id:
     [{ start, end, id }]. agentPlusKit finds ids of the UUID form; this is for the others, such as OpenCode's
     ses_… ids. An id that is part of a path or a file name (next to a slash, or before an extension) names that. */
  function idRanges(text, ids) {
    const s = String(text || '');
    const out = [];
    if (!s || !ids || !ids.size) return out;
    const re = /[A-Za-z0-9_-]{8,200}/g;
    let m;
    while ((m = re.exec(s))) {
      if (!ids.has(m[0])) continue;
      const end = m.index + m[0].length;
      const before = s.charAt(m.index - 1), after = s.substr(end, 2);
      if (before === '/' || before === '\\' || /^[/\\]/.test(after) || /^\.[0-9A-Za-z*]/.test(after)) continue;
      out.push({ start: m.index, end, id: m[0] });
    }
    return out;
  }

  return { slashToken, filterCommands, atToken, insertToken, filesInText, imageOfDataUrl, escapeAction, chimeKind, ringLow, imageKind, backgroundSummary,
    outlineRows, subagentShare, idRanges };
}));
