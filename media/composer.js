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

  /* Whether `token` stands in `text` as a word of its own: followed by the end, a space or a punctuation mark. */
  function hasToken(text, token) {
    if (!token) return false;
    for (let i = text.indexOf(token); i >= 0; i = text.indexOf(token, i + 1)) {
      const after = text.charAt(i + token.length);
      if (after === '' || /[\s.,;:!?)]/.test(after)) return true;
    }
    return false;
  }

  /* The picked files still named in the text, once each: as their `token` (@<rel>, or @<rel>#L3-5 for lines of a file
     that the editor added), or as @<rel>. */
  function filesInText(text, files) {
    const t = String(text || '');
    const seen = new Set();
    const out = [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || !f.rel) continue;
      const token = f.token || `@${f.rel}`;
      const key = `${f.path}#${f.startLine || 0}-${f.endLine || 0}`;
      if (seen.has(key)) continue;
      if (hasToken(t, token)) { seen.add(key); out.push(f); }
    }
    return out;
  }

  /* Puts the tokens of `refs` into `text` at `caret` (the end when it is not a number), each set off by spaces;
     returns the new text and caret. */
  function insertRefs(text, caret, refs) {
    const t = String(text || '');
    const at = typeof caret === 'number' && caret >= 0 && caret <= t.length ? caret : t.length;
    const tokens = (Array.isArray(refs) ? refs : []).map((r) => r && r.token).filter(Boolean);
    if (!tokens.length) return { text: t, caret: at };
    const before = t.slice(0, at);
    const after = t.slice(at);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const add = `${lead}${tokens.join(' ')}${after.startsWith(' ') ? '' : ' '}`;
    return { text: before + add + after, caret: at + add.length };
  }

  /* The box's text with `draft` added after it, a blank line between. */
  function appendDraft(text, draft) {
    const t = String(text || '');
    const d = String(draft || '');
    if (!d) return t;
    if (!t.trim()) return d;
    return `${t.replace(/\s+$/, '')}\n\n${d}`;
  }

  /* The action for a key in the message box: 'accept' the list's item, 'send', or null for the default (such as a new line).
     With `ctrlEnter`, Enter makes a new line and Ctrl or Cmd with Enter sends. */
  function enterAction({ key, shiftKey = false, ctrlKey = false, metaKey = false, composing = false, menu = false, ctrlEnter = false } = {}) {
    if (composing) return null;
    if (menu && ((key === 'Enter' && !shiftKey && !ctrlKey && !metaKey) || key === 'Tab')) return 'accept';
    if (key !== 'Enter') return null;
    if (ctrlEnter) return ctrlKey || metaKey ? 'send' : null;
    return shiftKey ? null : 'send';
  }

  /* The permission modes the mode pill offers, from OpenCode's mode option ({ value, values }) or none, and whether
     edits are allowed without asking: { entries: [{ value, name, description }], value }. Build is offered twice, as
     Ask before edits (its own value) and Edit automatically (AUTO); plan and any other mode once each, with OpenCode's
     value. */
  const ASK = 'build';
  const AUTO = 'build:auto';
  function permissionModes(modeOption, autoEdit) {
    const values = modeOption && Array.isArray(modeOption.values) ? modeOption.values.filter((v) => v && typeof v.value === 'string') : [];
    const current = modeOption && typeof modeOption.value === 'string' ? modeOption.value : '';
    const build = values.find((v) => v.value === 'build');
    const entries = [
      { value: ASK, name: 'Ask before edits', description: 'Each file edit waits for your answer' },
      { value: AUTO, name: 'Edit automatically', description: 'Edits of files in this folder are allowed without asking; commands still ask' },
    ];
    for (const v of values) {
      if (v === build) continue;
      entries.push({ value: v.value, name: v.value === 'plan' ? 'Plan' : v.name || v.value, description: v.description || '' });
    }
    const onBuild = !values.length || !current || current === 'build';
    const value = onBuild ? (autoEdit ? AUTO : ASK) : current;
    return { entries, value };
  }

  /*
   * The pill under the message box for what the editor offers, `ctx` being { selection, file }, each null or { key,
   * label, ... }: { item: { kind, ...ctx entry }, goes } or null. In order of preference it shows the
   * selection while `settings.selection` is on, the open file while `settings.file` is on, or a selection the user may add; `goes`
   * says whether it goes with the message; leaving it out of this message puts its key in `dropped`. A selection added
   * already (its key in `pinned`) stays on the pill as `pinned`, and does not go along a second time.
   */
  function contextPill(ctx, settings, dropped, pinned) {
    const c = ctx || {};
    const s = settings || {};
    const has = (set, k) => !!set && typeof set.has === 'function' && set.has(k);
    if (c.selection && c.selection.key && has(pinned, c.selection.key)) return { item: { kind: 'selection', ...c.selection }, goes: false, pinned: true };
    const sel = c.selection && c.selection.key ? { kind: 'selection', ...c.selection } : null;
    const file = c.file && c.file.key ? { kind: 'file', ...c.file } : null;
    if (sel && s.selection) return { item: sel, goes: !has(dropped, sel.key) };
    if (file && s.file) return { item: file, goes: !has(dropped, file.key) };
    if (sel) return { item: sel, goes: false };
    return null;
  }

  /* The editor item that goes with a message automatically (contextPill's item while it goes), or null. */
  function autoContext(ctx, settings, dropped, pinned) {
    const p = contextPill(ctx, settings, dropped, pinned);
    return p && p.goes ? p.item : null;
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

  /* The words on the background pill for head().background and the detached commands found, or '' when nothing
     runs. */
  function backgroundSummary(list, detached = 0) {
    const items = Array.isArray(list) ? list : [];
    const away = Number(detached) > 0 ? Math.floor(Number(detached)) : 0;
    if (!items.length && !away) return '';
    const subs = items.filter((b) => b && b.kind === 'subagent').length;
    const cmds = items.length - subs;
    const parts = [];
    if (subs) parts.push(`${subs} subagent${subs === 1 ? '' : 's'}`);
    if (cmds) parts.push(`${cmds} command${cmds === 1 ? '' : 's'}`);
    const running = parts.length ? `${parts.join(', ')} running` : '';
    return [running, away ? `${away} detached` : ''].filter(Boolean).join(' · ');
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

  /* The text on a queued message's row: the message's text, or for a message without text, what it carries. */
  function queuedText(q) {
    const text = String((q && q.text) || '').trim();
    if (text) return text;
    const n = (k, one) => { const c = Math.max(0, Math.floor(Number(q && q[k]) || 0)); return c ? `${c} ${one}${c === 1 ? '' : 's'}` : ''; };
    return [n('images', 'image'), n('selections', 'selection')].filter(Boolean).join(' and ');
  }

  function prefillText(value, text) {
    const v = String(value || '');
    const t = String(text || '');
    if (!v) return t;
    return /\s$/.test(v) ? v + t : `${v} ${t}`;
  }

  /* Whether the models listed are only OpenCode's own free ones (opencode/…), as before any provider is connected. */
  function onlyFreeModels(list) {
    const l = Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
    return l.length > 0 && l.every((m) => m.id.startsWith('opencode/'));
  }

  /* Bedrock's cross-Region geographies, named as OpenCode's model list names them, in the order the picker lists them. */
  const GEOGRAPHIES = { global: 'Global', us: 'US', eu: 'EU', apac: 'APAC', jp: 'JP', au: 'AU', in: 'India', ca: 'Canada', 'us-gov': 'GovCloud' };
  const GEO_ORDER = Object.keys(GEOGRAPHIES);
  /* A Bedrock id is vendor.model, so a geography prefix leaves at least two dots: `us.xai.grok-4.7` is one, while
     `deepseek.v3.2` is not. The id without the prefix calls the model in the Region OpenCode uses. */
  function modelVariant(id) {
    const s = String(id || '');
    const cut = s.lastIndexOf('/') + 1;
    const m = /^(us-gov|us|eu|apac|jp|au|in|ca|global)\.([^.]+\..+)$/.exec(s.slice(cut));
    return m ? { base: s.slice(0, cut) + m[2], geo: m[1], label: GEOGRAPHIES[m[1]] } : { base: s, geo: '', label: 'In-Region' };
  }

  /*
   * The model picker's rows: [{ label, families: [{ key, name, variants: [{ id, name, geo, label }] }] }]. The
   * variants of one model across geographies share a row, named without its geography; groups and rows are sorted by
   * name, and a model's variants put the geographies in GEO_ORDER, then the In-Region id.
   */
  function modelFamilies(models, groupOf) {
    const groups = new Map();
    for (const m of Array.isArray(models) ? models : []) {
      if (!m || typeof m.id !== 'string') continue;
      const label = groupOf(m);
      if (!groups.has(label)) groups.set(label, new Map());
      const v = modelVariant(m.id);
      const fams = groups.get(label);
      if (!fams.has(v.base)) fams.set(v.base, { key: v.base, name: '', variants: [] });
      const name = String(m.name || m.id);
      fams.get(v.base).variants.push({ id: m.id, name, geo: v.geo, label: v.label });
    }
    const rank = (v) => (v.geo ? GEO_ORDER.indexOf(v.geo) : GEO_ORDER.length);
    const byName = (a, b) => a.name.localeCompare(b.name);
    return [...groups].map(([label, fams]) => ({
      label,
      families: [...fams.values()].map((f) => {
        f.variants.sort((a, b) => rank(a) - rank(b));
        const plain = f.variants.find((v) => !v.geo);
        f.name = plain ? plain.name : f.variants[0].name.replace(/\s*\([^()]*\)\s*$/, '') || f.variants[0].name;
        return f;
      }).sort(byName),
    })).sort((a, b) => a.label.localeCompare(b.label));
  }

  /* The groups of modelFamilies narrowed to a query: every word must appear in a variant's model name, id, geography
     or group, and only the variants that match are kept. */
  function filterModelFamilies(groups, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return groups;
    const hit = (text) => words.every((w) => text.includes(w));
    return groups.map((g) => ({
      label: g.label,
      families: g.families.map((f) => ({ ...f, variants: f.variants.filter((v) => hit(`${g.label} ${f.name} ${v.name} ${v.id} ${v.label}`.toLowerCase())) }))
        .filter((f) => f.variants.length),
    })).filter((g) => g.families.length);
  }

  return { slashToken, filterCommands, atToken, insertToken, filesInText, imageOfDataUrl, escapeAction, chimeKind, ringLow, imageKind, driveSlashes, backgroundSummary,
    outlineRows, subagentShare, onlyFreeModels, modelVariant, modelFamilies, filterModelFamilies, queuedText, prefillText, hasToken, insertRefs, appendDraft, enterAction, permissionModes, contextPill, autoContext, ASK, AUTO };
}));
