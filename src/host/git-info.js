// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What git records about a folder, read from the files under .git rather than by running git, which would cost a
 * process per folder on every reading of the session list:
 *
 *   branchOf(dir)     the branch checked out in the working tree that holds `dir`, or '' when HEAD is detached or `dir`
 *                     is in no repository.
 *   worktreesOf(dir)  the linked worktrees of the repository `dir` is in, as [{ name, dir }]: the ones `git worktree
 *                     add` made, wherever they are (OpenCode puts its own under its data folder), not the main one.
 *
 * A worktree's .git is a file naming its folder under the repository's .git/worktrees, and that folder's commondir
 * names the repository's .git. Answers are cached for TTL_MS.
 */
const path = require('path');

const TTL_MS = 10000;

/* The path in a `gitdir: <path>` line, made absolute from `base`. */
function pointer(text, base, P) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(String(text || ''));
  return m ? P.resolve(base, m[1]) : '';
}

function branchIn(head) {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(String(head || ''));
  return m ? m[1] : '';
}

function createGitInfo({ fs = require('fs'), platform = process.platform, now = () => Date.now() } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const fsp = fs.promises;
  const cache = new Map();

  async function kept(key, read) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    let value = null;
    try { value = await read(); } catch (_) { value = null; }
    cache.set(key, { at: now(), value });
    return value;
  }

  /* The repository `dir` is in: { top, gitDir, common }, or null. */
  function repoOf(dir) {
    return kept(`repo\0${dir}`, async () => {
      for (let d = P.resolve(String(dir)); ;) {
        const dotGit = P.join(d, '.git');
        const st = await fsp.stat(dotGit).catch(() => null);
        if (st && st.isDirectory()) return { top: d, gitDir: dotGit, common: dotGit };
        if (st && st.isFile()) {
          const gitDir = pointer(await fsp.readFile(dotGit, 'utf8'), d, P);
          if (!gitDir) return null;
          const back = (await fsp.readFile(P.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
          return { top: d, gitDir, common: back ? P.resolve(gitDir, back) : gitDir };
        }
        const up = P.dirname(d);
        if (up === d) return null;
        d = up;
      }
    });
  }

  async function branchOf(dir) {
    if (!dir) return '';
    const repo = await repoOf(dir);
    if (!repo) return '';
    return (await kept(`head\0${repo.gitDir}`, async () => branchIn(await fsp.readFile(P.join(repo.gitDir, 'HEAD'), 'utf8')))) || '';
  }

  async function worktreesOf(dir) {
    if (!dir) return [];
    const repo = await repoOf(dir);
    if (!repo) return [];
    return (await kept(`trees\0${repo.common}`, async () => {
      const base = P.join(repo.common, 'worktrees');
      const names = await fsp.readdir(base).catch(() => []);
      const out = [];
      for (const name of names) {
        /* The worktree's own .git file, absolute or, with worktree.useRelativePaths, from this folder. */
        const text = (await fsp.readFile(P.join(base, name, 'gitdir'), 'utf8').catch(() => '')).trim();
        if (!text) continue;
        const tree = P.dirname(P.resolve(P.join(base, name), text));
        const st = await fsp.stat(tree).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        const real = await fsp.realpath(tree).catch(() => tree);
        out.push({ name: P.basename(real), dir: real });
      }
      return out;
    })) || [];
  }

  return { branchOf, worktreesOf, forget: () => cache.clear() };
}

module.exports = { createGitInfo, pointer, branchIn, TTL_MS };
