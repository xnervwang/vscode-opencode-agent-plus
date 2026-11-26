// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * For test/vscode/run.js. What the fake backend keeps of a session, read where the run against a real OpenCode reads
 * OpenCode's own record of it; the work plan the fake run writes itself, since no plugin runs there; and the reload with
 * three chat tabs open (one behind another, one in a split to the right), each checked after it for its editor group,
 * its page and its conversation.
 */
const fs = require('fs');
const path = require('path');

const SCHEME = 'opencodeagentplus-session:/';

function fakeDb(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'fake-backend.json'), 'utf8')); } catch (_) { return { sessions: {} }; }
}

/* Session `id` as the fake backend recorded it, with the fields run.js reads from OpenCode's session.list. */
function fakeRecord(home, id) {
  const s = fakeDb(home).sessions[id];
  return s ? { id, title: s.title, agent: s.agent || '', model: { id: s.model, variant: s.variant || '' } } : null;
}

/* Subagent session id -> its parent's, as OpenCode's adapter keeps them in opencode-sessions.json. */
function fakeParents(home) {
  const out = {};
  for (const s of Object.values(fakeDb(home).sessions)) if (s && s.parent) out[s.id] = s.parent;
  return out;
}

/* The texts of session `id`'s user messages, oldest first; null when there is no such session. */
function fakeUserTexts(home, id) {
  const s = fakeDb(home).sessions[id];
  return s ? s.events.filter((e) => e.type === 'userMessage').map((e) => String(e.text)) : null;
}

/* A work plan whose top rows are `rows` ({ title, state }), in the format the plugin's plan-row.py writes. */
function writePlan(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ format: 1, nodes: rows }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/* The chat tabs: [{ id, column, active }], in the order of the editor groups. */
const chatTabs = (call) => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "opencodeAgentPlus.chat")
  .map((t) => ({ id: t.input.uri.path.split('/')[1], column: g.viewColumn, active: t.isActive })));`);

/* Brings the chat tab of `id` to the front of the group it is in. */
const reveal = (call, id) => call(`const t = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && "opencodeagentplus-session:/" + x.input.uri.path.split("/")[1] === arg);
  if (!t) return false;
  await vscode.commands.executeCommand("vscode.openWith", t.input.uri, "opencodeAgentPlus.chat", { viewColumn: t.group.viewColumn, preview: false });
  return true;`, SCHEME + id);

/* The webview frame on screen whose log contains `text`; lib/window.js frameWith decides what counts as on screen. */
async function frameShowing(page, until, text, ms = 30000) {
  const shown = async (f) => {
    let top = f;
    while (top.parentFrame() && top.parentFrame().parentFrame()) top = top.parentFrame();
    const el = top.parentFrame() ? await top.frameElement() : null;
    return !el || await el.isVisible();
  };
  return until(async () => {
    for (const f of page.frames()) {
      try {
        if (await f.$('#input') && await f.evaluate((t) => document.getElementById('log').textContent.includes(t), text) && await shown(f)) return f;
      } catch (_) { /* detached */ }
    }
    return null;
  }, ms, 300);
}

/* Brings `tab` ({ id, text }) to the front and returns the page whose log shows `text`. */
async function pageOf(ctx, tab) {
  await reveal(ctx.call, tab.id);
  return frameShowing(ctx.page, ctx.until, tab.text);
}

/*
 * Before the reload, opens two more conversations beside `first` ({ id, text }), the only chat tab open, and sends
 * each a message of its own; the first of them stays in the main editor group behind `first`, the second goes to a
 * split to the right, and `first` ends in front. Returns the three tabs as { id, text, column }.
 */
async function openTabs(ctx, first) {
  const { call, ext, until, check } = ctx;
  const tabs = [{ ...first }];
  for (const word of ['bravo', 'charlie']) {
    const known = (await chatTabs(call)).map((t) => t.id);
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
    const id = await until(async () => { const t = (await chatTabs(call)).find((x) => x.active && !known.includes(x.id)); return t ? t.id : null; }, 30000);
    if (!id) break;
    const text = `Reply with only the word ${word}.`;
    if (word === 'charlie') await call('await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup"); return true;');
    await ext('await api.test.send(arg.id, arg.text); return true;', { id, text });
    tabs.push({ id, text });
  }
  const done = (id) => ext('const s = api.test.snapshot(arg); return !!s && s.activity === "stopped" && !!s.lastReplyAt;', id).catch(() => false);
  await until(async () => (await Promise.all(tabs.slice(1).map((t) => done(t.id)))).every(Boolean), 180000, 500);
  /* The tab behind `first` is reopened from its conversation now that the conversation has a title, as a list or a link
     would open it: the tab's resource then carries the title, which names the tab after a reload until the tab is shown. */
  await reveal(call, first.id);
  if (tabs[1]) {
    await call('await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.path.split("/")[1] === arg)); return true;', tabs[1].id);
    await until(async () => (!(await chatTabs(call)).some((x) => x.id === tabs[1].id) || null), 10000);
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.openConversation", arg);', tabs[1].id);
    await until(async () => ((await chatTabs(call)).some((x) => x.id === tabs[1].id) || null), 20000);
  }
  await reveal(call, first.id);
  const now = await chatTabs(call);
  for (const t of tabs) t.column = (now.find((x) => x.id === t.id) || {}).column || 0;
  const behind = now.find((x) => x.id === (tabs[1] || {}).id);
  check(tabs.length === 3 && tabs[0].column === 1 && tabs[1].column === 1 && tabs[2].column === 2 && !!behind && !behind.active
    && now.find((x) => x.id === first.id).active, 'before the reload three chat tabs are open: two in the main editor group, the second behind the first, and one in a split to the right',
  { tabs, now });
  return tabs;
}

/* After the reload: each tab is back in its group, and each, brought to the front, loads its own conversation, which
   its info box names. The first tab is in front again at the end. */
async function checkTabs(ctx, tabs) {
  const { call, check } = ctx;
  const now = await ctx.until(async () => { const n = await chatTabs(call); return tabs.every((t) => n.some((x) => x.id === t.id)) ? n : null; }, 30000) || await chatTabs(call);
  const groups = tabs.map((t) => ({ id: t.id, before: t.column, after: (now.find((x) => x.id === t.id) || {}).column || 0 }));
  check(now.length === tabs.length && groups.every((g) => g.before === g.after), 'after the reload each chat tab is back in the editor group it was in', { groups, now });
  const pages = [];
  for (const t of [...tabs.slice(1), tabs[0]]) {
    const f = await pageOf(ctx, t);
    let session = '';
    if (f) {
      await f.click('#infoBtn').catch(() => {});
      session = await ctx.until(() => f.evaluate(() => {
        const row = [...document.querySelectorAll('#infoBox:not([hidden]) .info-row')].find((r) => r.querySelector('.info-label').textContent === 'Session');
        return row ? row.querySelector('.info-value').textContent : '';
      }), 15000) || '';
      await f.press('#input', 'Escape').catch(() => {});
    }
    pages.push({ id: t.id, page: !!f, session });
  }
  check(pages.every((x) => x.page && x.session === x.id), 'each restored chat tab, once brought to the front, loads its own conversation, and its info box names that session', pages);
}

const closeTabs = (call, tabs) => call(`const ids = arg.map((t) => t.id);
  await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.scheme === "${SCHEME.replace(/:\/$/, '')}" && ids.includes(t.input.uri.path.split('/')[1])));
  return true;`, tabs).catch(() => false);

module.exports = { fakeRecord, fakeParents, fakeUserTexts, writePlan, openTabs, checkTabs, pageOf, closeTabs, frameShowing };
