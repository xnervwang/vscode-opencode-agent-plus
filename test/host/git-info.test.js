// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Tests for src/host/git-info.js: the branch checked out in a folder and the linked worktrees of its repository, read
 * from the files under .git.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createGitInfo, pointer, branchIn, TTL_MS } = require('../../src/host/git-info');

function tmp(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-git-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('a gitdir line and a HEAD file are read as git writes them', () => {
  assert.equal(pointer('gitdir: /r/.git/worktrees/a\n', '/w', path.posix), '/r/.git/worktrees/a');
  assert.equal(pointer('gitdir: ../r/.git/worktrees/a', '/w/x', path.posix), '/w/r/.git/worktrees/a', 'a relative path from the folder');
  assert.equal(pointer('nonsense', '/w', path.posix), '');
  assert.equal(branchIn('ref: refs/heads/feature/x\n'), 'feature/x');
  assert.equal(branchIn('4b825dc642cb6eb9a060e54bf8d69288fbee4904\n'), '', 'detached');
});

test('a repository laid out by hand: the branch of a folder below its top, its linked worktrees, and nothing outside it', async (t) => {
  const root = tmp(t);
  const repo = path.join(root, 'repo');
  const common = path.join(repo, '.git');
  write(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  /* One worktree outside the repository with an absolute gitdir, one inside it with relative ones, one whose folder is gone. */
  const outside = path.join(root, 'data', 'worktree', 'abc123', 'wt1');
  write(path.join(common, 'worktrees', 'wt1', 'gitdir'), `${path.join(outside, '.git')}\n`);
  write(path.join(common, 'worktrees', 'wt1', 'commondir'), '../..\n');
  write(path.join(common, 'worktrees', 'wt1', 'HEAD'), '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n');
  write(path.join(outside, '.git'), `gitdir: ${path.join(common, 'worktrees', 'wt1')}\n`);
  const inside = path.join(repo, '.claude', 'worktrees', 'fix');
  write(path.join(common, 'worktrees', 'fix', 'gitdir'), '../../../.claude/worktrees/fix/.git\n');
  write(path.join(common, 'worktrees', 'fix', 'commondir'), '../..\n');
  write(path.join(common, 'worktrees', 'fix', 'HEAD'), 'ref: refs/heads/fix-it\n');
  write(path.join(inside, '.git'), 'gitdir: ../../../.git/worktrees/fix\n');
  write(path.join(common, 'worktrees', 'gone', 'gitdir'), `${path.join(root, 'gone', '.git')}\n`);
  const other = path.join(root, 'plain');
  fs.mkdirSync(other);

  const git = createGitInfo({ fs });
  assert.equal(await git.branchOf(repo), 'main');
  assert.equal(await git.branchOf(path.join(repo, 'src', 'deep')), 'main');
  assert.equal(await git.branchOf(outside), '', 'detached');
  assert.equal(await git.branchOf(path.join(inside)), 'fix-it');
  const trees = (await git.worktreesOf(repo)).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(trees, [{ name: 'fix', dir: inside }, { name: 'wt1', dir: outside }], 'not the one whose folder is gone');
  assert.deepEqual((await git.worktreesOf(outside)).map((x) => x.name).sort(), ['fix', 'wt1'], 'the same from inside a worktree');
  assert.equal(await git.branchOf(other), '');
  assert.deepEqual(await git.worktreesOf(other), []);
  assert.equal(await git.branchOf(''), '');
});

test('answers are cached for a while, then read again', async (t) => {
  const repo = tmp(t);
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/one\n');
  let clock = 1000;
  const git = createGitInfo({ fs, now: () => clock });
  assert.equal(await git.branchOf(repo), 'one');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/two\n');
  clock += TTL_MS - 1;
  assert.equal(await git.branchOf(repo), 'one');
  clock += 2;
  assert.equal(await git.branchOf(repo), 'two');
});

let gitWorks = false;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); gitWorks = true; } catch (_) { /* no git here */ }

test('a repository git itself made: a worktree added outside it, its branch, and a detached HEAD', { skip: !gitWorks && 'no git on this machine' }, async (t) => {
  const root = tmp(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, stdio: 'pipe' });
  run('init', '-q');
  run('commit', '-q', '--allow-empty', '-m', 'first');
  const wt = path.join(root, 'elsewhere', 'feature-wt');
  run('worktree', 'add', '-q', '-b', 'feature', wt);
  const loose = path.join(root, 'elsewhere', 'loose');
  run('worktree', 'add', '-q', '--detach', loose);
  const git = createGitInfo({ fs });
  assert.equal(await git.branchOf(repo), 'main');
  assert.equal(await git.branchOf(wt), 'feature');
  assert.equal(await git.branchOf(loose), '');
  const trees = (await git.worktreesOf(repo)).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(trees.map((x) => x.name), ['feature-wt', 'loose']);
  assert.equal(path.resolve(trees[0].dir).toLowerCase(), fs.realpathSync.native(wt).toLowerCase());
});
