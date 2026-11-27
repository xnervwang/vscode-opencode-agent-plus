// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The window steps on Agent Plus's session list (its activity bar container agentPlusSessions, view agentPlus.sessions)
 * that check the rows this extension's source (src/host/session-source.js) gives it and the actions it carries out, on
 * the fake backend:
 *
 *   rows       the conversations of the window's folder: the one open here with the solid stripe, those closed here in
 *              Recently closed and with the light blue stripe in Ungrouped, one without a message left out.
 *   dots       each of the five, from what another VS Code window reports of its conversations (the window states
 *              src/host/window-states.js reads) and from the plans' questions; one open in that window is dimmed, and
 *              its hover names the window.
 *   actions    rename, the source's own Fork, archive and unarchive, and delete from Archived, carried out by OpenCode;
 *              no Delete for the one open here.
 *   reopening  a row of Recently closed, and Find Conversation by part of the id.
 *   New        the New bar's OpenCode, in a tab.
 *   usage      this extension's part of Account & usage.
 *   look       the list in the dark and light themes, a narrow side bar, search and a chip, a group and Archived.
 *
 * The conversations these steps make are deleted at the end, so the steps after them find the window as it was.
 */
const fs = require('fs');
const path = require('path');

const SOURCE = 'opencode-plus';
const OTHER = 'proj-b [SSH: host-b]';
const SIDEBAR = '#workbench\\.parts\\.sidebar';
const T = { green: 'A turn is running', ring: 'Background work only', blue: 'Waits for a permission', red: 'Asked which branch to release',
  redRing: 'Asked a question, still working' };

/* The helpers that read and drive the list's page. */
function create({ page, call, until, sleep }) {
  const h = { sl: null };
  h.frame = () => until(async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!document.querySelector('.sl-root .sl-new'))) return f; } catch (_) { /* not that frame */ } }
    return null;
  }, 30000);
  h.show = async () => {
    await call('await vscode.commands.executeCommand("workbench.view.extension.agentPlusSessions"); return true;');
    await sleep(500);
    h.sl = await h.frame();
    return h.sl;
  };
  h.rows = () => h.sl.evaluate(() => [...document.querySelectorAll('.sl-row')].map((r) => {
    let key = [];
    try { key = JSON.parse(r.dataset.key || '[]'); } catch (_) { /* none */ }
    const sec = r.closest('.sl-section');
    return { source: key[0] || '', id: key[1] || '', title: r.querySelector('.sl-title').textContent, section: sec ? sec.dataset.key : '',
      dot: r.dataset.dot, stripe: r.dataset.stripe, dim: r.classList.contains('sl-elsewhere'), shown: !!r.offsetParent && !r.closest('.sl-hidden'),
      marks: r.querySelector('.sl-marks').textContent, time: (r.querySelector('.sl-time') || {}).textContent || '' };
  }));
  h.wait = (fn, ms = 15000) => until(async () => { const r = await h.rows().catch(() => null); return r && fn(r) ? r : null; }, ms);
  h.find = (rs, id, section) => (rs || []).find((r) => r.id === id && (!section || r.section === section));
  h.row = (id, section) => h.sl.locator(`${section ? `.sl-section[data-key="${section}"]` : '.sl-section:not([data-key="closed"])'} .sl-row[data-key='${JSON.stringify([SOURCE, id])}']`).first();
  h.head = (label) => h.sl.locator('.sl-head').filter({ has: h.sl.locator('.sl-head-label', { hasText: new RegExp(`^${label}$`, 'i') }) }).first();
  h.expand = async (label) => { const x = h.head(label); if (!await x.evaluate((e) => e.parentElement.classList.contains('sl-open'))) await x.click(); };
  h.collapse = async (label) => { const x = h.head(label); if (await x.evaluate((e) => e.parentElement.classList.contains('sl-open'))) await x.click(); };
  h.menu = () => until(() => h.sl.evaluate(() => {
    const b = document.querySelector('.sl-ctx:not(.sl-ctx-sub)');
    return b ? [...b.querySelectorAll('.sl-ctx-item')].map((x) => x.textContent.replace('›', '').replace('✓', '').trim()) : null;
  }), 5000);
  h.item = (label, sub = false) => h.sl.locator(sub ? '.sl-ctx-sub .sl-ctx-item' : '.sl-ctx:not(.sl-ctx-sub) .sl-ctx-item').filter({ hasText: label }).first();
  h.act = async (id, what, section) => { const r = h.row(id, section); await r.hover(); await r.locator(`.sl-act[data-act="${what}"]`).click(); await h.away(); };
  h.hover = () => h.sl.evaluate(() => { const x = document.querySelector('.sl-hover'); return x && !x.classList.contains('sl-hidden') ? x.textContent : ''; });
  h.notice = () => h.sl.evaluate(() => [...document.querySelectorAll('.sl-notice')].filter((n) => n.offsetParent).map((n) => ({ text: n.querySelector('.sl-note-text').textContent,
    buttons: [...n.querySelectorAll('.sl-note-btn')].map((b) => b.textContent) })));
  h.box = () => page.locator(SIDEBAR);
  /* A row's hover box stays up until the pointer leaves the row inside the list, so the pointer goes to the empty
     bottom of the list first, then out of the window's way. */
  h.away = async () => {
    const b = await h.box().boundingBox().catch(() => null);
    if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height - 12); await sleep(400); }
    await page.mouse.move(5, 5);
    await sleep(200);
  };
  /* Whether the list's page has been drawn in the light or dark theme. */
  h.themed = (light) => until(() => h.sl.evaluate((l) => document.body.classList.contains(l ? 'vscode-light' : 'vscode-dark'), light), 15000);
  h.frontId = () => call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? t.input.uri.path.split("/")[1] : "";');
  h.close = (id) => call('const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.path.split("/")[1] === arg); await vscode.window.tabGroups.close(tabs); return true;', id).catch(() => false);
  /* The side bar's width, dragged by its edge. */
  h.width = async (want) => {
    const edge = await page.evaluate(() => {
      const b = document.getElementById('workbench.parts.sidebar').getBoundingClientRect();
      const s = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
        .find((r) => r.height > 100 && Math.abs((r.left + r.right) / 2 - b.right) < 4);
      return s && { x: (s.left + s.right) / 2, y: b.top + b.height / 2, width: b.width };
    });
    if (!edge) return 0;
    await page.mouse.move(edge.x, edge.y);
    await page.mouse.down();
    await page.mouse.move(edge.x + (want - edge.width), edge.y, { steps: 10 });
    await page.mouse.up();
    await sleep(500);
    return page.evaluate(() => Math.round(document.getElementById('workbench.parts.sidebar').getBoundingClientRect().width));
  };
  return h;
}

/* At the start, before any conversation: the list with no OpenCode rows. */
async function empty(ctx) {
  const { check, shot } = ctx;
  const h = create(ctx);
  check(!!await h.show(), "Agent Plus's session list opens in its own container");
  if (!h.sl) return;
  const rows = await h.wait((r) => !r.some((x) => x.source === SOURCE), 10000);
  check(!!rows, 'with no conversation yet, it has no OpenCode rows', rows);
  await h.away();
  await shot('01-sessions-empty', { features: ['session list', 'empty list'],
    expect: 'The side bar shows Agent Plus\'s session list with nothing in it yet: at the top a New bar (an agent logo with a caret, then New in tab and New in sidebar), a row of chips All, Open, Running and Needs you, and no conversation rows; no error and no notice.',
    part: SIDEBAR });
}

/*
 * The steps with conversations, at a point where `sessionId` is open in this window's tab in front and some
 * conversations of the folder were closed here. `plans` is the plans folder, `home` the extension's own folder.
 */
async function run(ctx, { sessionId, folder, plans, home, setTheme }) {
  const { page, call, ext, check, shot, until, sleep } = ctx;
  const h = create(ctx);
  const made = [];
  const winState = path.join(home, 'windows', `${process.pid}.json`);
  const winEntry = path.join(plans, 'windows', `${process.pid}.json`);
  const planOf = (id) => path.join(plans, `${id}.json`);
  const changed = () => ext('return api.test.sessionsChanged();');
  const opencode = async () => ((await ext('return api.test.sessions();')) || []);
  try {
    /* Five conversations of the folder, each with a message, closed again. */
    for (const title of Object.values(T)) {
      const before = await h.frontId();
      await call('return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");');
      const id = await until(async () => { const f = await h.frontId(); return f && f !== before ? f : null; }, 30000);
      if (!id) break;
      made.push(id);
      await ext('return api.test.send(arg[0], arg[1]);', [id, `Say: ${title}`]);
      await until(async () => { const s = await ext('return api.test.snapshot(arg);', id); return s && s.activity === 'stopped' && s.lastReplyAt; }, 20000);
      await ext('return api.test.source.runSessionAction("rename", [arg[0]], { title: arg[1] });', [id, title]);
      await h.close(id);
      await until(async () => !(await ext('return !!api.test.snapshot(arg);', id)), 10000);
    }
    check(made.length === 5, 'five more conversations are made and closed', made);
    if (made.length < 5) return;
    const [green, ring, blue, red, redRing] = made;
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.openConversation", arg);', sessionId);
    await until(async () => ((await h.frontId()) === sessionId) || null, 15000);

    // The rows.
    await h.show();
    if (!h.sl) { check(false, "Agent Plus's session list opens"); return; }
    const rows = await h.wait((r) => (h.find(r, sessionId, 'ungrouped') || {}).stripe === 'here' && made.every((id) => h.find(r, id, 'ungrouped')), 25000);
    check(!!rows, "the list has this window's OpenCode conversations in Ungrouped, the one open here with the solid stripe", rows || await h.rows());
    if (!rows) return;
    const closed = rows.filter((r) => r.source === SOURCE && r.section === 'closed').map((r) => r.id);
    check(made.every((id) => closed.includes(id)) && made.every((id) => (h.find(rows, id, 'ungrouped') || {}).stripe === 'closed'),
      'those closed here are in Recently closed too, and have the light blue stripe in Ungrouped', rows.filter((r) => made.includes(r.id)).map((r) => [r.title, r.section, r.stripe]));
    const listed = (await ext('return api.test.source.listSessions({ folders: [arg] });', folder)) || { sessions: [] };
    const blank = listed.sessions.filter((s) => s.kind === 'empty').map((s) => s.sessionId);
    check(!blank.length || !rows.some((r) => blank.includes(r.id)), 'a conversation without a message is left out while background conversations are hidden', { blank });

    // The five dots: another VS Code window reports four of them, two have a question waiting in their plan, asked
    // after their last message.
    const now = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const ask = { title: 'Release', nodes: [{ title: 'Pick the branch', state: 'waiting', waitingOn: 'user', question: 'Main or the hotfix branch?',
      opened: iso(now - 3600e3), since: iso(now), asked: iso(now) }] };
    for (const id of [red, redRing]) fs.writeFileSync(planOf(id), JSON.stringify(ask));
    fs.mkdirSync(path.dirname(winState), { recursive: true });
    fs.writeFileSync(winState, JSON.stringify({ format: 1, pid: process.pid, at: now, conversations: [
      { sessionId: green, title: T.green, activity: 'working', running: true },
      { sessionId: ring, title: T.ring, activity: 'background', running: true, background: [{ kind: 'command', title: 'sleep 600', pid: 4242 }] },
      { sessionId: blue, title: T.blue, activity: 'waiting', running: true, waitingFor: { kind: 'permission', tool: 'bash' } },
      { sessionId: redRing, title: T.redRing, activity: 'working', running: true }] }));
    fs.mkdirSync(path.dirname(winEntry), { recursive: true });
    fs.writeFileSync(winEntry, JSON.stringify({ at: now, pid: process.pid, name: OTHER, sessions: [green, ring, blue, redRing] }));
    await changed();
    const dots = await h.wait((r) => [['green', green], ['greenRing', ring], ['blue', blue], ['red', red], ['redRing', redRing]].every(([d, id]) => (h.find(r, id, 'ungrouped') || {}).dot === d)
      && [green, ring, blue, redRing].every((id) => (h.find(r, id, 'ungrouped') || {}).dim), 20000);
    check(!!dots, 'each of the five dots on OpenCode rows: a turn running, background work only, a permission waiting, a plan question after the turn stopped, a plan question during a turn',
      (dots || await h.rows()).filter((r) => made.includes(r.id)).map((r) => [r.title, r.dot, r.stripe, r.dim]));
    check(!!dots && [green, ring, blue, redRing].every((id) => h.find(dots, id, 'ungrouped').stripe === 'elsewhere') && !h.find(dots, red, 'ungrouped').dim,
      'the four open in the other VS Code window are dimmed with the outlined stripe, their dots kept; the one not open anywhere is not dimmed');
    await h.collapse('Recently closed').catch(() => {});
    await h.away();
    await shot('06-sessions-dark', { features: ['session list', 'state dots', 'row stripes'],
      expect: `Agent Plus's session list in the dark theme with OpenCode conversations in UNGROUPED, each row starting with the OpenCode mark (an upright rectangular frame whose lower inner half is fainter): "${T.green}" with a filled green dot at the logo's top right, "${T.ring}" with a hollow green ring, "${T.blue}" with a filled blue dot, "${T.red}" with a filled red dot, "${T.redRing}" with a hollow red ring. The conversation open here has a solid light stripe at its start; the four open in another window have an outlined stripe and greyed title and logo, their dots not greyed.`,
      part: SIDEBAR });
    await shot('06a-sessions-elsewhere', { features: ['open elsewhere'],
      expect: `A close view of the list. The rows "${T.green}", "${T.ring}", "${T.blue}" and "${T.redRing}" stand out as open somewhere else at a glance: an outlined stripe at the row's start and a greyed title and logo, while "${T.red}" and the conversation open here are not greyed. Judge whether that mark is noticeable without being told to look for it.`,
      part: SIDEBAR });
    await h.row(green).hover();
    const tip = await until(async () => { const t = await h.hover(); return t.includes(OTHER) && t; }, 6000);
    check(!!tip && tip.includes(green), 'the hover of one open in another window names that window and the session id', tip || await h.hover());
    await shot('06b-sessions-hover', { features: ['row hover'],
      expect: `A hover box under the row "${T.green}": OpenCode · Ungrouped, its session id ${green}, when it started and was last active, and that it is open in the VS Code window "${OTHER}".`,
      part: SIDEBAR });
    await h.away();

    // Themes and width.
    if (setTheme) {
      check(await setTheme('Default Light Modern', 'vs') && !!await h.themed(true), 'the window and the list switch to the light theme');
      await h.wait((r) => (h.find(r, green, 'ungrouped') || {}).dot === 'green', 10000);
      await h.away();
      await shot('06c-sessions-light', { features: ['session list', 'light theme'],
        expect: 'The same list in the light theme: dark text on a light background, the OpenCode marks drawn dark on the light rows, the five dots in the same colours as in the dark theme, the stripes visible and the four rows open elsewhere still greyed.',
        unchanged: 'The rows and their order.', part: SIDEBAR });
      check(await setTheme('Default Dark Modern', 'vs-dark') && !!await h.themed(false), 'and back to the dark theme');
    }
    const wide = await page.evaluate(() => Math.round(document.getElementById('workbench.parts.sidebar').getBoundingClientRect().width));
    const narrow = await h.width(230);
    const fits = await h.sl.evaluate(() => [...document.querySelectorAll('.sl-row')].filter((r) => r.offsetParent).every((r) => r.scrollWidth <= r.clientWidth + 1));
    check(narrow > 0 && narrow <= 260 && fits, 'in a narrow side bar the rows still fit their width', { wide, narrow, fits });
    await h.away();
    await shot('06d-sessions-narrow', { features: ['narrow side bar'],
      expect: 'The list in a narrow side bar of about 230 pixels: long titles end in an ellipsis, the relative time stays at the right, the logos and dots are whole, nothing overlaps.',
      part: SIDEBAR });
    await h.width(wide);

    // Back to quiet.
    for (const f of [winState, winEntry, planOf(red), planOf(redRing)]) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
    await changed();
    check(!!await h.wait((r) => made.every((id) => { const x = h.find(r, id, 'ungrouped'); return x && x.dot === 'none' && !x.dim; }), 20000),
      'once that window goes and the questions are answered, the rows have no dot and are not dimmed');

    // Actions, carried out by OpenCode.
    await h.act(green, 'rename');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Renamed from the list');
    await page.keyboard.press('Enter');
    const renamed = await until(async () => (await opencode()).some((s) => s.id === green && s.title === 'Renamed from the list'), 10000);
    check(!!renamed && !!await h.wait((r) => (h.find(r, green, 'ungrouped') || {}).title === 'Renamed from the list'), 'Rename on a row changes the title in OpenCode');
    await h.row(green).click({ button: 'right' });
    const items = await h.menu();
    check(!!items && items.includes('Fork Conversation') && items.includes('Rename') && items.includes('Archive') && !items.includes('Delete...'),
      'an OpenCode row\'s menu has its own Fork Conversation, Rename and Archive, and no Delete outside Archived', items);
    const before = await h.frontId();
    await h.item('Fork Conversation').click();
    const fork = await until(async () => { const f = await h.frontId(); return f && f !== before && !made.includes(f) ? f : null; }, 20000);
    check(!!fork && (await opencode()).some((s) => s.id === fork), 'Fork Conversation makes a copy in OpenCode and opens it in a tab', fork);
    if (fork) { made.push(fork); await h.close(fork); }
    await h.show();
    await h.act(ring, 'archive');
    check(!!await h.wait((r) => h.find(r, ring, 'archived') && !h.find(r, ring, 'ungrouped')), 'Archive moves it to Archived');
    await h.expand('Archived');
    await h.row(ring, 'archived').click({ button: 'right' });
    const archivedItems = await h.menu();
    check(!!archivedItems && archivedItems.includes('Delete...'), 'an archived OpenCode conversation\'s menu offers Delete', archivedItems);
    await h.item('Delete...').click();
    const confirm = await until(() => page.evaluate(() => { const d = [...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent); return d ? d.innerText : null; }), 8000);
    check(!!confirm && confirm.includes(T.ring) && /OpenCode/.test(confirm), 'deleting asks first, naming the conversation and saying what goes with it', confirm);
    await page.locator('.monaco-dialog-box .dialog-buttons .monaco-button').filter({ hasText: /^Delete$/ }).first().click().catch(() => {});
    const gone = await until(async () => !(await opencode()).some((s) => s.id === ring), 10000);
    check(!!gone && !!await h.wait((r) => !h.find(r, ring)), 'Delete removes it from OpenCode and from the list');
    if (gone) made.splice(made.indexOf(ring), 1);
    await h.act(sessionId, 'archive');
    await h.wait((r) => h.find(r, sessionId, 'archived'));
    await h.row(sessionId, 'archived').click({ button: 'right' });
    const hereItems = await h.menu();
    check(!!hereItems && !hereItems.includes('Delete...'), 'the menu of a conversation open in this window has no Delete', hereItems);
    await page.keyboard.press('Escape');
    await h.act(red, 'archive');
    await h.wait((r) => h.find(r, red, 'archived'));
    await h.away();
    await shot('06e-sessions-archived', { features: ['archived'],
      expect: `The ARCHIVED section expanded under Ungrouped, listing the conversation open here (with its solid stripe) and "${T.red}", each with the OpenCode mark.`,
      part: SIDEBAR });
    await h.act(sessionId, 'unarchive', 'archived');
    await h.act(red, 'unarchive', 'archived');
    check(!!await h.wait((r) => h.find(r, sessionId, 'ungrouped') && h.find(r, red, 'ungrouped')), 'Unarchive puts them back in Ungrouped');
    await h.collapse('Archived').catch(() => {});

    // A group.
    await call('await vscode.commands.executeCommand("agentPlus.newSessionGroup"); return true;');
    if (await until(() => h.sl.evaluate(() => !!document.querySelector('.sl-head-label.sl-editing')), 8000)) {
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('OpenCode work');
      await page.keyboard.press('Enter');
    }
    const group = await until(() => h.sl.evaluate(() => { const s = [...document.querySelectorAll('.sl-section[data-kind="group"]')].find((x) => x.querySelector('.sl-head-label').textContent === 'OpenCode work'); return s && s.dataset.key; }), 8000);
    if (group) {
      await h.row(blue).click({ button: 'right' });
      /* A click opens the submenu, beside the menu or, in a narrow side bar, in its place. */
      await h.item('Add to Group').click();
      await h.item('OpenCode work', true).click();
      check(!!await h.wait((r) => h.find(r, blue, group)), 'an OpenCode conversation can be added to a group');
      await h.away();
      await shot('06f-sessions-group', { features: ['groups'],
        expect: `Sections in this order: OPENCODE WORK (a folder icon, count 1) holding "${T.blue}", then UNGROUPED with the other OpenCode conversations, then ARCHIVED; each section header is a band with a line above and below.`,
        part: SIDEBAR });
      await h.head('OpenCode work').click({ button: 'right' });
      await h.item('Delete Group').click();
      await h.wait((r) => h.find(r, blue, 'ungrouped'));
    } else check(false, 'New Group makes a group named as typed');

    // Recently closed and Find Conversation.
    await h.expand('Recently closed');
    await h.away();
    await shot('06k-sessions-closed', { features: ['recently closed'],
      expect: 'A RECENTLY CLOSED section with a clock icon near the top of the list, expanded, listing OpenCode conversations whose tabs closed in this window, the latest first, each with "closed now" or "closed Nm" at the right and a light blue stripe at its start; their rows in Ungrouped have that stripe too.',
      part: SIDEBAR });
    await h.row(blue, 'closed').click();
    check(!!await until(async () => ((await h.frontId()) === blue) || null, 15000), 'a row of Recently closed opens that conversation again in a tab');
    await h.close(blue);
    await sleep(500);
    await call('vscode.commands.executeCommand("agentPlus.findConversation"); return true;');
    await page.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 15000 }).catch(() => {});
    await page.keyboard.type(red.slice(4, 14));
    const picks = await until(async () => {
      const r = await page.evaluate(() => [...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].filter((x) => x.offsetParent).map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
      return r.length === 1 && r[0].includes(T.red) ? r : null;
    }, 10000);
    await shot('06g-find-conversation', { features: ['find by session id'],
      expect: `Agent Plus's Find Conversation box at the top, holding part of an OpenCode session id, with one match below: "${T.red}" with OpenCode beside it.`,
      part: '.quick-input-widget' });
    await page.keyboard.press('Enter');
    check(!!picks && !!await until(async () => ((await h.frontId()) === red) || null, 15000), "Agent Plus's Find Conversation matches part of an OpenCode session id and opens the conversation", picks);
    await h.close(red);
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.openConversation", arg);', sessionId);
    await until(async () => ((await h.frontId()) === sessionId) || null, 15000);

    // Search and the Open chip.
    await h.show();
    await call('await vscode.commands.executeCommand("agentPlus.searchSessions"); return true;');
    await until(() => h.sl.evaluate(() => document.activeElement && document.activeElement.tagName === 'INPUT'), 5000);
    await page.keyboard.type('permission');
    const searched = await h.wait((r) => { const s = r.filter((x) => x.shown && x.section !== 'closed'); return s.length === 1 && s[0].id === blue; }, 10000);
    check(!!searched, 'Search keeps only the OpenCode conversation whose title matches', (searched || await h.rows()).filter((x) => x.shown).map((x) => x.title));
    await shot('06h-sessions-search', { features: ['search'],
      expect: `A search box under the chips holding "permission", and only "${T.blue}" left in the list with "permission" highlighted in its title.`,
      part: SIDEBAR });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await h.sl.locator('.sl-chip[data-chip="open"]').click();
    const onlyOpen = await h.wait((r) => { const s = r.filter((x) => x.shown && x.section !== 'closed'); return s.length === 1 && s[0].id === sessionId; }, 10000);
    check(!!onlyOpen, 'the Open chip keeps only the conversation open here', (onlyOpen || await h.rows()).filter((x) => x.shown).map((x) => x.title));
    await h.sl.locator('.sl-chip[data-chip="all"]').click();

    // Account & usage.
    const acct = await until(() => h.sl.evaluate(() => {
      const a = document.querySelector('.sl-section[data-key="account"]');
      return a && !a.classList.contains('sl-hidden') && /Provider/.test(a.innerText) && a.innerText;
    }), 15000);
    if (acct === null || acct === false) await h.expand('Account & usage').catch(() => {});
    const acctText = acct || await until(() => h.sl.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]'); return a && /Provider/.test(a.innerText) && a.innerText; }), 10000);
    check(!!acctText && /Provider/.test(acctText) && /Model/.test(acctText) && /This conversation/i.test(acctText) && /Cost/.test(acctText) && /Tokens/.test(acctText),
      'Account & usage has an OpenCode part: the provider and model, and the cost and tokens of the conversation in front', acctText);
    await h.away();
    await shot('06i-sessions-account-open', { features: ['Account & usage'],
      expect: 'An ACCOUNT & USAGE section at the top of the list, expanded, with an OpenCode block headed by its mark: Provider and Model rows, "Today, all conversations" with a cost, and "This conversation" with its title, a Cost and a Tokens row.',
      part: SIDEBAR });
    await h.collapse('Account & usage').catch(() => {});
    await shot('06j-sessions-account-closed', { features: ['Account & usage'],
      expect: 'The ACCOUNT & USAGE header collapsed to one band with its chevron pointing right, and the sections below it moved up.', part: SIDEBAR });
    await h.expand('Account & usage').catch(() => {});

    // The New bar.
    await h.sl.locator('.sl-new-agent').click();
    const agents = await h.menu();
    const agentTip = await h.sl.evaluate(() => (document.querySelector('.sl-new-agent') || {}).title || '');
    check(!!agents && agents.some((x) => /^OpenCode/.test(x)), "the New bar's logo lists OpenCode Agent Plus among the agents", { agents, agentTip });
    if (agents) await h.item('OpenCode').click().catch(() => {});
    else await page.keyboard.press('Escape');
    await until(() => h.sl.evaluate(() => /OpenCode/.test(document.querySelector('.sl-new-agent').title)), 5000);
    const was = await h.frontId();
    await h.sl.locator('.sl-new-half[data-where="tab"]').click();
    const fresh = await until(async () => { const f = await h.frontId(); return f && f !== was && /^ses_/.test(f) ? f : null; }, 20000);
    check(!!fresh, 'New in tab, with OpenCode Agent Plus picked, opens a new conversation in an editor tab', fresh);
    if (fresh) { made.push(fresh); await h.close(fresh); }
  } finally {
    for (const f of [winState, winEntry]) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
    for (const id of made) {
      await h.close(id);
      await ext('return api.test.source.runSessionAction("delete", [arg], {});', id).catch(() => {});
    }
    await call('return vscode.commands.executeCommand("opencodeAgentPlus.openConversation", arg);', sessionId).catch(() => {});
    await sleep(500);
  }
}

/* With no OpenCode to find: the note above the list says so, with a button to download it. */
async function missing(ctx) {
  const { check, shot } = ctx;
  const h = create(ctx);
  await h.show();
  if (!h.sl) { check(false, "Agent Plus's session list opens"); return null; }
  const notes = await ctx.until(async () => { const n = await h.notice(); return n.find((x) => /OpenCode was not found/.test(x.text)) || null; }, 30000);
  check(!!notes && /reload the window, or download it with the button here\.$/.test(notes.text) && notes.buttons.includes('Download OpenCode') && notes.buttons.includes('Show Logs'),
    'a note above the session list says OpenCode was not found, with Download OpenCode and Show Logs buttons', notes || await h.notice());
  await h.away();
  await shot('02-sessions-no-opencode', { features: ['session list notice'],
    expect: 'Agent Plus\'s session list with a note above its rows, starting with the OpenCode mark: "OpenCode was not found. Install OpenCode 2 with npm install -g @opencode/cli and reload the window, or download it with the button here.", shown whole, with Download OpenCode and Show Logs buttons; no OpenCode conversation rows.',
    part: SIDEBAR });
  /* With no OpenCode there are no figures, and OpenCode's part of Account & usage says so rather than being left out. */
  const part = () => h.sl.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]'); return a && !a.classList.contains('sl-hidden') ? a.innerText : null; });
  if (!(await part())) await h.expand('Account & usage').catch(() => {});
  const said = await ctx.until(async () => { const t = await part(); return t && /OpenCode/.test(t) && /Not found/.test(t) ? t : null; }, 20000);
  check(!!said, "with OpenCode not found, Account & usage keeps OpenCode's part, with a single Not found row", said || await part());
  await h.away();
  await shot('02c-sessions-no-opencode-account', { features: ['Account & usage'],
    expect: 'The ACCOUNT & USAGE section at the top of the list, expanded, with an OpenCode block, headed by its mark, that has one row: "OpenCode" and "Not found". No provider, model or cost rows.',
    part: SIDEBAR });
  return h;
}

/* In Restricted Mode: Agent Plus's note, and no OpenCode rows since this extension has not started. */
async function restricted(ctx) {
  const { check, shot } = ctx;
  const h = create(ctx);
  await h.show();
  if (!h.sl) { check(false, "Agent Plus's session list opens"); return null; }
  const note = await ctx.until(async () => { const n = await h.notice(); return n.find((x) => /Restricted Mode/.test(x.text)) || null; }, 20000);
  const rows = await h.rows();
  check(!!note && note.buttons.includes('Manage Workspace Trust') && !rows.some((r) => r.source === SOURCE),
    'in Restricted Mode the session list says so, with a Manage Workspace Trust button, and has no OpenCode rows', { note, rows });
  await h.away();
  await shot('R2-sessions-restricted', { features: ['Restricted Mode', 'session list'],
    expect: 'Agent Plus\'s session list in Restricted Mode: a note above it saying the list shows conversations and changes nothing, that some agents start only in a trusted workspace, with a Manage Workspace Trust button; no OpenCode rows.',
    part: SIDEBAR });
  return h;
}

module.exports = { create, empty, run, missing, restricted, SOURCE };
