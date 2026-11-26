// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Agent Plus's prefill, through the source's prefill(): it opens a conversation whose tab is closed, brings it to the
 * front and puts the text in its message box after whatever the box already holds, and sends nothing. An id with no
 * conversation behind it gets notReceived.
 */
const SCHEME = 'opencodeagentplus-session:';
const FIRST = 'About row 1 (list the files): ';
const SECOND = 'About row 2 (check the box): ';
const MISSING = 'ses_prefillwindowtestmissing00';

/* t: { page, call, ext, check, shot, until, sleep, frameWith, chatUris, front, real } */
async function run(t) {
  const { page, call, ext, check, shot, until, sleep, frameWith, chatUris, front, real } = t;
  const idOf = (uri) => decodeURIComponent(uri.slice(SCHEME.length).replace(/^\/+/, ''));
  const tabOf = 'vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.input instanceof vscode.TabInputCustom && "opencodeagentplus-session:/" + x.input.uri.path.split("/")[1] === arg)';
  const close = (uri) => call(`const t = ${tabOf}; if (t) await vscode.window.tabGroups.close(t); return true;`, uri);
  const inFront = () => call('const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputCustom ? "opencodeagentplus-session:/" + t.input.uri.path.split("/")[1] : "";');
  const boxes = async () => {
    const out = [];
    for (const f of page.frames()) {
      try {
        const b = await f.evaluate(() => {
          const i = document.getElementById('input');
          if (!i) return null;
          return { value: i.value, start: i.selectionStart, end: i.selectionEnd, focused: document.activeElement === i && document.hasFocus(),
            users: document.querySelectorAll('#log .msg.user').length };
        });
        if (b) out.push({ f, ...b });
      } catch (_) { /* detached */ }
    }
    return out;
  };
  const holding = async (text) => (await boxes()).find((b) => b.value === text) || null;
  /* A reopened conversation's box starts with the draft it was closed with, so this matches the end of its text. */
  const ending = async (text) => (await boxes()).find((b) => b.value.endsWith(text)) || null;
  const setBox = (f, text) => f.evaluate((v) => {
    const i = document.getElementById('input');
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  const prefill = (id, text) => ext('return api.test.source.prefill(arg.id, arg.text);', { id, text }, 20000);

  const listed = async () => (await ext('return api.test.source.listAllConversations();')) || [];
  const lastUser = async (id) => ((await listed()).find((c) => c.sessionId === id) || {}).lastUserAt || 0;
  const written = async () => (await listed()).filter((c) => c.lastUserAt > 0 && c.activity === 'stopped').sort((a, b) => b.lastUserAt - a.lastUserAt)[0];
  let pick = await written();
  if (!pick) {
    const blank = (await listed()).find((c) => c.activity === 'stopped');
    if (blank) await ext('return api.test.source.deliverAnswer(arg, "Reply with only the word four.", { deliveryId: "window-test-prefill" });', blank.sessionId);
    pick = blank ? await until(async () => { const c = (await listed()).find((x) => x.sessionId === blank.sessionId); return c && c.lastUserAt > 0 && c.activity === 'stopped' ? c : null; }, real ? 120000 : 30000) : null;
  }
  if (!pick) { check(false, 'the window has a conversation with messages in it', await listed()); return; }
  const id = pick.sessionId, target = `${SCHEME}/${id}`, lastBefore = pick.lastUserAt;
  if ((await chatUris()).includes(target)) {
    await front(target);
    const f = await until(async () => ((await inFront()) === target ? frameWith(page, '#input', 5000) : null), 15000);
    if (f) await setBox(f, '');
  }
  await close(target);
  await until(async () => (!(await chatUris()).includes(target) ? true : null), 10000);
  /* The page's count of the user's messages, once the history it replays has stopped adding to it. */
  const settled = async (text) => {
    let last = -1;
    return until(async () => {
      const b = await ending(text);
      if (!b || !b.users) return null;
      const same = b.users === last;
      last = b.users;
      return same ? b.users : null;
    }, 15000, 700);
  };

  const had = await ext('return api.test.source.features;');
  check(Array.isArray(had) && had.includes('prefill'), "the source tells Agent Plus it has the 'prefill' feature", had);
  const r1 = await prefill(id, FIRST);
  const box1 = await until(() => ending(FIRST), 15000);
  check(!!r1 && r1.outcome === 'drafted' && !!box1 && (await inFront()) === target && box1.start === box1.value.length && box1.end === box1.value.length && box1.focused,
    "prefill opens a conversation whose tab is closed, brings it to the front and puts the text in its message box, which has the focus, with the caret at the end",
    { r1, box1: box1 && { ...box1, f: undefined }, front: await inFront(),
      where: await page.evaluate(() => { const a = document.activeElement; return { window: document.hasFocus(), active: a ? `${a.tagName}.${String(a.className).slice(0, 80)}` : null }; }).catch(() => null) });

  const usersBefore = box1 ? await settled(FIRST) : null;
  /* After reopening, the conversation's last-message time comes from OpenCode's export, which can differ from the
     time this window sent it by a second or so. */
  const lastOpened = await lastUser(id);
  if (box1) await setBox(box1.f, 'first words');
  const r2 = await prefill(id, SECOND);
  const want = `first words ${SECOND}`;
  const box2 = await until(() => holding(want), 15000);
  check(!!r2 && r2.outcome === 'drafted' && !!box2 && box2.start === want.length,
    'with text already in the box, prefill puts its text after it, a space between them', { r2, boxes: (await boxes()).map((b) => b.value) });

  await sleep(1500);
  const after = await holding(want);
  const lastAfter = await lastUser(id);
  check(!!after && !!usersBefore && after.users === usersBefore && lastOpened > 0 && lastAfter === lastOpened,
    'prefill sends nothing: the text stays in the box and the conversation has no new message from the user',
    { usersBefore, lastBefore, lastOpened, lastAfter, after: after && { value: after.value, users: after.users } });
  await shot('15-prefill', { features: ['prefill'],
    expect: `The chat tab in front, its message box holding "${want}" with the caret after it; the conversation above ends as before, with no new message from the user.`,
    part: '#workbench\\.parts\\.editor' });
  if (after) await setBox(after.f, '');

  const started = Date.now();
  const r3 = await prefill(MISSING, FIRST);
  check(!!r3 && r3.outcome === 'notReceived' && !(await ending(FIRST)),
    'prefill on an id that names no conversation answers notReceived, and no message box gets the text', { r3, ms: Date.now() - started });
  console.log(`  note  prefill on an id with no conversation answered after ${Date.now() - started} ms`);
  await close(`${SCHEME}/${MISSING}`);
}

module.exports = { run };
