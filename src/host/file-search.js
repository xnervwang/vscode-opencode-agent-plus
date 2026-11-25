// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Workspace files for the chat page's @ list. vscode.workspace.findFiles runs where the extension runs, which is the
 * remote machine under Remote-SSH. While @ is typed the list is read again only after `ttlMs`; it holds up to
 * `maxFiles` files and leaves out what files.exclude and search.exclude set to true, plus node_modules and .git. The
 * query is matched here.
 */
const path = require('path');

const MAX_FILES = 5000;
const TTL_MS = 30000;
const ALWAYS = Object.freeze(['**/node_modules/**', '**/.git/**']);

/* One glob of the patterns to leave out. Patterns with braces or commas of their own cannot sit in the group. */
function excludeGlob(read) {
  const keys = [...ALWAYS];
  for (const section of ['files.exclude', 'search.exclude']) {
    let o = null;
    try { o = read(section); } catch (_) { o = null; }
    for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) {
      if (v === true && !/[{},]/.test(k) && !keys.includes(k)) keys.push(k);
    }
  }
  return `{${keys.join(',')}}`;
}

function inOrder(s, q) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i += 1;
  return i === q.length;
}

/*
 * Files for a query, best first, in four tiers: name prefix, name substring, path substring, then the query's letters
 * in order anywhere in the path.
 */
function rank(files, query, limit = 50) {
  const q = String(query || '').toLowerCase();
  const scored = [];
  for (const f of files) {
    const rel = f.rel.toLowerCase();
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const score = !q ? 3 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : rel.includes(q) ? 2 : inOrder(rel, q) ? 3 : -1;
    if (score >= 0) scored.push([score, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].rel.length - b[1].rel.length || a[1].rel.localeCompare(b[1].rel));
  return scored.slice(0, limit).map((x) => x[1]);
}

function createFileSearch({ vscode, now = Date.now, maxFiles = MAX_FILES, ttlMs = TTL_MS }) {
  let cache = null;
  let loading = null;
  function list() {
    if (cache && now() - cache.at < ttlMs) return Promise.resolve(cache.files);
    if (!loading) {
      loading = Promise.resolve().then(async () => {
        const read = (section) => vscode.workspace.getConfiguration().get(section);
        const uris = await vscode.workspace.findFiles('**/*', excludeGlob(read), maxFiles);
        const files = (uris || []).filter((u) => u && u.scheme === 'file')
          .map((u) => ({ path: u.fsPath, rel: String(vscode.workspace.asRelativePath(u)).split(path.sep).join('/') }));
        cache = { at: now(), files };
        return files;
      }).finally(() => { loading = null; });
    }
    return loading;
  }
  return {
    /* [{ path, rel, name }] for the query, at most `limit`. */
    async search(query, limit = 50) {
      const files = await list();
      return rank(files, query, limit).map((f) => ({ path: f.path, rel: f.rel, name: path.basename(f.path) }));
    },
    clear() { cache = null; },
  };
}

module.exports = { createFileSearch, rank, excludeGlob, MAX_FILES };
