// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * OpenCode 2's own record of its sessions, for the session list: what ACP's session/list leaves out. Each row of
 * /api session.list carries the session's folder, parent, cost and tokens, and its times: created; busy and idle, which
 * only a turn moves (an archive, an unarchive or a rename moves `updated` instead); viewed, which a viewer such as the
 * terminal interface writes when it shows a finished turn; archived.
 *
 * The rows are read from the background service when one runs: state/service.json names its address, process and
 * password, and a file whose process is gone is left over from a crash. Otherwise from a private server of that one
 * command (`opencode api ... --standalone`). Never with `opencode api` alone: with no service running it starts one, and
 * a service that starts resumes every turn a crash left unfinished.
 *
 * session.list filters a folder by exact match, so the whole list is read a page at a time and filtered here, which keeps
 * the folders below a workspace folder. It is read again only once OpenCode's database has changed.
 */
const fsDefault = require('fs');
const path = require('path');
const httpDefault = require('http');

const PAGE = 1000;
const MOST = 20000;
const SERVICE_TIMEOUT_MS = 5000;

const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/* Whether `dir` is `folder` or below it. Windows paths compare without case. */
function within(dir, folder, platform = process.platform) {
  if (!dir || !folder) return false;
  const norm = (p) => {
    let s = path.normalize(String(p)).replace(/[\\/]+$/, '');
    if (platform === 'win32') s = s.replace(/\//g, '\\').toLowerCase();
    return s;
  };
  const d = norm(dir);
  const f = norm(folder);
  if (!f) return false;
  const sep = platform === 'win32' ? '\\' : '/';
  return d === f || d.startsWith(f.endsWith(sep) ? f : f + sep);
}

/* A row of /api session.list as the session list needs it. */
function toRecord(row) {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  const t = row.time || {};
  const created = num(t.created);
  const busy = num(t.busy);
  const idle = num(t.idle);
  const tokens = row.tokens || {};
  const cache = tokens.cache || {};
  const model = row.model && typeof row.model.id === 'string'
    ? `${typeof row.model.providerID === 'string' ? `${row.model.providerID}/` : ''}${row.model.id}` : '';
  return {
    id: row.id,
    title: typeof row.title === 'string' ? row.title : '',
    cwd: (row.location && typeof row.location.directory === 'string' && row.location.directory) || '',
    parentId: typeof row.parentID === 'string' ? row.parentID : '',
    createdAt: created,
    lastActiveAt: Math.max(busy, idle) || created,
    lastReplyAt: idle,
    viewedAt: num(t.viewed),
    archivedAt: num(t.archived),
    /* A turn that began and has not ended, as OpenCode recorded it; a process that crashed mid-turn leaves this on. */
    busy: busy > idle,
    cost: typeof row.cost === 'number' && isFinite(row.cost) ? row.cost : 0,
    tokens: { input: num(tokens.input), output: num(tokens.output), reasoning: num(tokens.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) },
    model,
    outcome: typeof row.outcome === 'string' ? row.outcome : '',
  };
}

/*
 * deps:
 *   found()          { path, version } of the OpenCode in use; throws when there is none
 *   paths()          Promise of `opencode debug paths` as { state, db, ... }
 *   execFile         child_process.execFile
 *   env              the environment for subcommands
 *   request          optional (url, { headers, timeout }) => Promise<{ status, body }>, plain HTTP GET
 *   fs, platform, log
 */
function createSessionIndex(deps) {
  const fs = deps.fs || fsDefault;
  const platform = deps.platform || process.platform;
  const log = deps.log || (() => {});
  const request = deps.request || httpGet;
  let cache = null;
  let reading = null;

  /* The background service, when its state file names a process that runs: { url, password, pid }, else null. */
  async function service() {
    const p = await deps.paths().catch(() => null);
    if (!p || !p.state) return null;
    let v;
    try { v = JSON.parse(fs.readFileSync(path.join(p.state, 'service.json'), 'utf8')); } catch (_) { return null; }
    if (!v || typeof v.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(v.url) || typeof v.password !== 'string') return null;
    if (!processAlive(v.pid)) return null;
    return { url: v.url, password: v.password, pid: v.pid };
  }

  async function fromService(svc, apiPath) {
    const auth = `Basic ${Buffer.from(`opencode:${svc.password}`).toString('base64')}`;
    const r = await request(`${svc.url}${apiPath}`, { headers: { authorization: auth }, timeout: SERVICE_TIMEOUT_MS });
    if (!r || r.status !== 200) throw new Error(`the background service answered ${r ? r.status : 'nothing'}`);
    return JSON.parse(r.body);
  }

  function fromPrivate(params) {
    const found = deps.found();
    const args = ['api', 'session.list', ...params.flatMap(([k, v]) => ['--param', `${k}=${v}`]), '--standalone'];
    return new Promise((resolve, reject) => {
      deps.execFile(found.path, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, env: deps.env || process.env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) { reject(new Error(String(stderr || err.message).trim().slice(0, 300))); return; }
        try { resolve(JSON.parse(String(stdout))); } catch (e) { reject(new Error(`session.list was not JSON: ${e.message}`)); }
      });
    });
  }

  /* Every session OpenCode has, newest first, one page after another. */
  async function readAll() {
    const svc = await service();
    const rows = [];
    let cursor = '';
    for (let i = 0; rows.length < MOST && i < MOST / PAGE + 1; i++) {
      const params = [['limit', String(PAGE)]];
      if (cursor) params.push(['cursor', cursor]);
      const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const page = svc ? await fromService(svc, `/api/session?${query}`) : await fromPrivate(params);
      const data = page && Array.isArray(page.data) ? page.data : [];
      for (const r of data) { const rec = toRecord(r); if (rec) rows.push(rec); }
      cursor = page && page.cursor && typeof page.cursor.next === 'string' ? page.cursor.next : '';
      if (!cursor || data.length < PAGE) break;
    }
    return rows;
  }

  /* Changes whenever OpenCode writes its database (the file, or its write-ahead log). */
  async function stamp() {
    const p = await deps.paths().catch(() => null);
    if (!p || !p.db) return '';
    const one = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch (_) { return '-'; } };
    return `${one(p.db)}|${one(`${p.db}-wal`)}`;
  }

  async function all() {
    const s = await stamp();
    if (cache && s && cache.stamp === s) return cache.rows;
    if (!reading) {
      reading = readAll().then((rows) => { cache = { stamp: s, rows }; return rows; })
        .finally(() => { reading = null; });
    }
    return reading;
  }

  return {
    /* The records of the sessions in `folders` (real paths) or folders below them. */
    async list({ folders = [] } = {}) {
      const rows = await all();
      return rows.filter((r) => folders.some((f) => within(r.cwd, f, platform)));
    },
    /* Every record, for looking one up by id. */
    all,
    /* The ids of the sessions in a turn in the background service, or an empty set when none runs. */
    async active() {
      const svc = await service();
      if (!svc) return new Set();
      try {
        const v = await fromService(svc, '/api/session/active');
        return new Set(Object.keys((v && v.data) || {}));
      } catch (e) {
        log(`asking OpenCode's background service which sessions run failed: ${e.message}`);
        return new Set();
      }
    },
    service,
    invalidate() { cache = null; },
  };
}

function httpGet(url, { headers = {}, timeout = SERVICE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpDefault.get(url, { headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

module.exports = { createSessionIndex, toRecord, within, processAlive, PAGE };
