// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the chat page's input does with `/` and `@`, without the page: which word is being typed, what the lists show
 * for it, and the text once one is picked. The page loads it as window.ChatComposer; the tests require it.
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

  return { slashToken, filterCommands, atToken, insertToken, filesInText, imageOfDataUrl };
}));
