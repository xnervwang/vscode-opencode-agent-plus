// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's logic that needs no DOM, so the tests can require it. The page loads it as window.ChatComposer.
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

  /* Commands matching a query, best first: name prefix, then name substring, then description substring. */
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

  /* Replaces the token with `insert` and a space (unless one follows already); returns the new text and caret. */
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

  /* What Esc does: close the open box, else close the list, else stop a running turn. Null when there is nothing
     to do. */
  function escapeAction({ box = false, menu = false, status = 'idle' } = {}) {
    if (box) return 'closeBox';
    if (menu) return 'closeMenu';
    return status && status !== 'idle' ? 'abort' : null;
  }

  /* The chime for a change from head `was` to `now` ({ status, pending, waitingFor }): 'permission' or 'question' for a
     new request, 'done' for a turn going idle. Null otherwise, and for the first head after a reset. */
  function chimeKind(was, now) {
    if (!was || !now) return null;
    if ((now.pending || 0) > (was.pending || 0)) return now.waitingFor === 'question' ? 'question' : 'permission';
    return was.status !== 'idle' && now.status === 'idle' ? 'done' : null;
  }

  /* The ring is outlined once 15% of the window or less is left. */
  const ringLow = (pct) => typeof pct === 'number' && pct >= 0 && 100 - pct <= 15;

  /* How an image in a reply is shown: 'data' as it is, 'local' read by the extension, else 'link' (a web address is
     never fetched; a relative path names no folder). */
  function imageKind(src, localOk) {
    const s = String(src || '');
    if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(s)) return 'data';
    if (localOk && /^(?:file:\/\/|\/|[A-Za-z]:[\\/])/.test(s)) return 'local';
    return 'link';
  }

  /* Markdown drops a backslash before punctuation, so the link C:\a\_temp\x.png would become C:\a_temp\x.png: a drive
     path in a link or an image gets forward slashes, which Windows reads the same. Code blocks and code spans stay. */
  const DRIVE_LINK = /(\]\(<?)([A-Za-z]:\\[^)\s>]*)/g;
  function driveSlashes(text) {
    let fence = false;
    return String(text || '').split('\n').map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return line; }
      if (fence) return line;
      return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(DRIVE_LINK, (m, open, p) => open + p.replace(/\\/g, '/')))).join('');
    }).join('\n');
  }

  /* The words on the background pill for head().background, or '' when nothing runs. */
  function backgroundSummary(list) {
    const items = Array.isArray(list) ? list : [];
    if (!items.length) return '';
    const subs = items.filter((b) => b && b.kind === 'subagent').length;
    const cmds = items.length - subs;
    const parts = [];
    if (subs) parts.push(`${subs} subagent${subs === 1 ? '' : 's'}`);
    if (cmds) parts.push(`${cmds} command${cmds === 1 ? '' : 's'}`);
    return `${parts.join(', ')} running`;
  }

  const COMPACTION_WORDS = { running: 'Compacting…', completed: 'Compacted', failed: 'Compacting failed', cancelled: 'Compacting cancelled' };
  const OUTLINE_CHARS = 80;
  /* The outline beside the log: the user's messages, numbered, and the points where the conversation was compacted, in
     the order of `items` ({ id, kind, text, at, status, hidden }). */
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

  return { slashToken, filterCommands, atToken, insertToken, filesInText, imageOfDataUrl, escapeAction, chimeKind, ringLow, imageKind, driveSlashes, backgroundSummary,
    outlineRows, subagentShare };
}));
