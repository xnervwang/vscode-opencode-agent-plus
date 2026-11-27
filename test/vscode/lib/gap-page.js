// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's coloured code blocks, an edit's change in its row, links to the files a reply names, Focus view and
 * its key, the pinned prompt, folded thinking and a todo list, for test/vscode/run.js after its other steps. With the
 * fake backend the demo turns of test/vscode/fake-backend.js (page-*) play; with a real model it is asked for the same
 * things, and on OpenCode 2 also to keep a todo list with its todowrite tool. The pictures are taken in the dark theme
 * and again in the light one.
 */

const DARK = 'Default Dark Modern';
const LIGHT = 'Default Light Modern';
const EDITOR = '#workbench\\.parts\\.editor';

/* t: { page, call, ext, check, shot, until, sleep, frameWith, real, line } */
async function run(t) {
  const { page, call, check, shot, until, sleep, frameWith, real } = t;
  const v2 = real && t.line >= 2;
  const theme = (name) => call(`await vscode.workspace.getConfiguration().update("workbench.colorTheme", arg, vscode.ConfigurationTarget.Global); return true;`, name);
  const setting = (key, value) => call(`await vscode.workspace.getConfiguration("opencodeAgentPlus").update(arg.key, arg.value, vscode.ConfigurationTarget.Global); return true;`, { key, value });
  const read = (key) => call('return vscode.workspace.getConfiguration("opencodeAgentPlus").get(arg);', key);
  /* The pointer goes to the activity bar's edge before each picture, so that no button looks hovered. */
  const picture = async (name, opts) => { await page.mouse.move(2, 450); await shot(name, opts); };

  // G1. A conversation of its own, in one editor group across the window.
  await call('await vscode.commands.executeCommand("workbench.action.editorLayoutSingle"); await vscode.commands.executeCommand("notifications.clearAll"); return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");').catch(() => {});
  await sleep(1500);
  let chat = await frameWith(page, '#input', 30000);
  check(!!chat, 'a new chat page opens for the page checks');
  if (!chat) return;
  const idle = (ms = real ? 240000 : 30000) => until(() => chat.evaluate(() => document.body.dataset.status === 'idle' || null), ms);
  const users = () => chat.evaluate(() => document.querySelectorAll('#log .msg.user').length);
  /* Sends `text` and waits until the turn it starts has ended, answering a permission request with Allow once. */
  const turn = async (text, ms) => {
    const before = await users();
    await chat.fill('#input', text);
    await chat.press('#input', 'Enter');
    await until(async () => ((await users()) > before ? true : null), 30000);
    const end = Date.now() + (ms || (real ? 240000 : 30000));
    for (;;) {
      const state = await chat.evaluate(() => ({ status: document.body.dataset.status, ask: !!document.querySelector('#log .permission:not(.settled) button[data-decision="allowOnce"]') }));
      if (state.ask) await chat.click('#log .permission:not(.settled) button[data-decision="allowOnce"]').catch(() => {});
      else if (state.status === 'idle') return true;
      if (Date.now() > end) return false;
      await sleep(400);
    }
  };
  /* Scrolls the log until your message number `n` (counting from 1) is at the top, which brings the turn after it into
     view. */
  const toUser = (n) => chat.evaluate((i) => { const u = document.querySelectorAll('#log .msg.user')[i - 1]; const l = document.getElementById('log');
    if (u) l.scrollTop += u.getBoundingClientRect().top - l.getBoundingClientRect().top - 8; }, n);

  // G2. Code blocks that name a language are coloured; one without stays plain.
  const codeTurn = real
    ? 'Reply with exactly two fenced code blocks and nothing else: a JavaScript function of about 15 lines in a ```js fence, then a short Python function in a ```python fence. Do not use any tools.'
    : 'Demo: page-code';
  const codeDone = await turn(codeTurn);
  const code = await chat.evaluate(() => {
    const blocks = [...document.querySelectorAll('#log .msg.reply pre code')];
    const of = (b) => ({ lang: (/language-(\w+)/.exec(b.className) || [])[1] || '', spans: b.querySelectorAll('[class^="hljs-"]').length,
      keyword: (() => { const k = b.querySelector('.hljs-keyword'); return k ? getComputedStyle(k).color : ''; })(), plain: getComputedStyle(b).color });
    return blocks.map(of);
  });
  const coloured = code.filter((b) => b.lang && b.spans > 0 && b.keyword && b.keyword !== b.plain);
  check(codeDone && coloured.some((b) => /^(js|javascript)$/.test(b.lang)) && coloured.some((b) => /^(python|py)$/.test(b.lang))
    && (real || code.some((b) => !b.lang && b.spans === 0)),
  'code blocks that name a language are highlighted, with keywords in their own colour; a block without a language stays plain', code);
  await toUser(1);
  await picture('g01-code-dark', { features: ['code highlighting'], part: EDITOR,
    expect: `The reply holds ${real ? 'a JavaScript and a Python code block' : 'a JavaScript code block, a Python one and a third block without a language'}. In the JavaScript and Python blocks, keywords (function, const, return, def) are blue, strings orange, numbers pale green, comments green and italic, and function names purple, all from the dark theme and readable on the block's dark background.${real ? '' : ' The last block is plain grey-white text.'}` });

  /* Scrolls down to the last code block for the next picture. */
  await chat.evaluate(() => { const b = [...document.querySelectorAll('#log .msg.reply pre')].pop(); const l = document.getElementById('log');
    if (b) l.scrollTop += b.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom + 60; });
  await picture('g01b-code-rest-dark', { features: ['code highlighting'], part: EDITOR,
    expect: real ? 'The end of the reply with code: the Python block, its keywords, strings and numbers coloured from the dark theme like the JavaScript one above it.'
      : 'The end of the reply with code: the Python block coloured from the dark theme (def and return as keywords, the docstring as a string), then the line "And its output, a block with no language:" and a last block "sum(2, 3) = 5" in plain grey-white text, no colours.' });

  // G3. An edit's row opens to its change as red and green lines; a long change is cut short and says how many lines
  // it leaves out.
  const editTurn = real
    ? 'Use your edit tool on the file notes.txt to replace the text "Some notes." with three lines: "Some notes.", "Line two." and "Line three.". Then reply "Edited." and nothing else.'
    : 'Demo: page-edit';
  const editDone = await turn(editTurn);
  const editRows = () => chat.evaluate(() => [...document.querySelectorAll('#log .tool:not(.subagent)')].filter((e) => e.querySelector('.tool-diff'))
    .map((e) => ({ name: e.querySelector('.tool-name').textContent, state: e.querySelector('.tool-state').textContent, open: e.classList.contains('open'),
      diff: !e.querySelector('.tool-diff').hidden, adds: e.querySelectorAll('.diff-row.d-add').length, dels: e.querySelectorAll('.diff-row.d-del').length,
      more: (e.querySelector('.diff-more') || {}).textContent || '', inShown: !e.querySelector('.tool-in').hidden })));
  let rows = (await editRows()).filter((r) => r.diff);
  const edit = rows.find((r) => /edit/i.test(r.name));
  if (edit) {
    await chat.evaluate(() => { for (const e of document.querySelectorAll('#log .tool:not(.subagent)')) if (!e.querySelector('.tool-diff').hidden && !e.classList.contains('open')) e.querySelector('.tool-head').click(); });
    await sleep(400);
    rows = (await editRows()).filter((r) => r.diff);
  }
  const opened = rows.find((r) => /edit/i.test(r.name));
  check(editDone && !!opened && opened.open && opened.adds >= 1 && !opened.inShown && /^(\+\d+( -\d+)?|-\d+)$/.test(opened.state) && (real || opened.dels >= 1),
    "an edit's row shows +added -removed, and opens to its change as red and green lines in place of its input", rows);
  if (!real) {
    const write = rows.find((r) => r.name === 'write');
    const patch = rows.find((r) => r.name === 'apply_patch');
    check(!!write && write.state === '300 lines' && /^\d+ more lines not shown$/.test(write.more) && !!patch && patch.adds === 2,
      "a write's row counts its lines and a long one says how many lines it leaves out; a patch's row shows its added lines", { write, patch });
  }
  const diffBtn = await chat.evaluate(() => document.querySelectorAll('#log .permission button.diff:not([hidden])').length);
  if (real) check(diffBtn >= 1, 'the answered permission request keeps its View diff button', diffBtn);
  await toUser(2);
  await picture('g02-edit-dark', { features: ['edit diff in the tool row'], part: EDITOR,
    expect: `An edit tool row opened under its time: the row reads the tool's name, the file and a green "+n" (and a red "-n" when lines were removed); the open box shows the changed lines, removed ones on a red background with "-", added ones on a green background with "+"${real ? ', with line numbers at the left' : ''}, no IN row.${real ? '' : ' Under it a write row ("300 lines") opened to green lines that end with "… more lines not shown", and an apply_patch row with "Update README.md" and two green lines.'}` });

  /* Scrolls down to the end of the edit rows for the next picture. */
  await chat.evaluate(() => { const rows = [...document.querySelectorAll('#log .tool:not(.subagent)')].filter((e) => !e.querySelector('.tool-diff').hidden); const e = rows.pop(); const l = document.getElementById('log');
    if (e) l.scrollTop += e.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom + 60; });
  await picture('g02b-edit-rest-dark', { features: ['edit diff in the tool row'], part: EDITOR,
    expect: real ? 'The end of the edit row, opened to show its change: green added lines with line numbers, then its OUT row; the reply after it.'
      : 'The end of the write row opened to its green lines, which stop with an italic grey "… more lines not shown" line, then an apply_patch row ("+2") opened to a bold grey "Update README.md" line, an "@@" line, the unchanged "# Demo project" and two green added lines; the reply after them.' });

  // G4. Paths named in a reply, and the file name in a read row, become links that open the file at its line.
  const pathTurn = real
    ? 'Read the file src/sum.js with your read tool, then reply with one sentence that names it as `src/sum.js:1` in backticks and also names README.md. Nothing else.'
    : 'Demo: page-paths';
  const pathDone = await turn(pathTurn);
  const links = await until(async () => {
    const l = await chat.evaluate(() => ({ links: [...document.querySelectorAll('#log .msg.reply a.file-link')].map((a) => ({ path: a.dataset.path, line: a.dataset.line || '', text: a.textContent })),
      tools: [...document.querySelectorAll('#log .tool .tool-summary.file-link')].map((s) => s.dataset.path),
      web: [...document.querySelectorAll('#log .msg.reply a:not(.file-link)')].map((a) => a.getAttribute('href')) }));
    return l.links.some((x) => /src\/sum\.js$/.test(x.path) && x.line === '1') && l.links.some((x) => /README\.md$/.test(x.path)) && l.tools.some((p) => /sum\.js$/.test(p)) ? l : null;
  }, 15000);
  check(pathDone && !!links && (real || (!links.links.some((x) => /missing/.test(x.path)) && links.links.some((x) => x.path === 'notes.txt') && links.web.includes('https://example.com/README.md'))),
    "paths in a reply that are workspace files become links, missing files do not, and the read row's file is also a link", links
      || await chat.evaluate(() => document.getElementById('log').lastElementChild && document.getElementById('log').textContent.slice(-400)));
  if (links) {
    await chat.click('#log .msg.reply a.file-link[data-line="1"] >> nth=-1');
    const shown = await until(() => call(`const e = vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath.endsWith("sum.js"));
      return e ? { line: e.selection.active.line, column: e.viewColumn } : null;`), 15000);
    check(!!shown && shown.line === 0, 'a click on src/sum.js:1 opens it in an editor beside the chat, at line 1', shown);
    await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input instanceof vscode.TabInputText && x.input.uri.fsPath.endsWith("sum.js"));
      await vscode.window.tabGroups.close(tabs); await vscode.commands.executeCommand("workbench.action.editorLayoutSingle"); return true;`).catch(() => {});
    chat = await frameWith(page, '#input', 20000);
  }
  await toUser(3);
  await picture('g03-file-links-dark', { features: ['file links'], part: EDITOR,
    expect: `A read row whose file (src/sum.js) is drawn in the link colour, and a reply in which src/sum.js:1 (in a code span) and README.md are links as well${real ? '' : '; notes.txt is a link too, src/missing.js is plain text, and the https address is an ordinary link'}.` });

  // G5. The thinking row is folded: grey, "Thinking", and opens to the reasoning on a click.
  if (!real) await turn('Demo: page-thinking');
  const thinking = await chat.evaluate(() => {
    const d = [...document.querySelectorAll('#log details.reasoning')].pop();
    return d ? { open: d.open, label: d.querySelector('summary .label').textContent, body: d.querySelector('.md').checkVisibility(), color: getComputedStyle(d).color,
      text: getComputedStyle(document.querySelector('#log .msg.reply .md')).color } : null;
  });
  if (thinking || !real) {
    check(!!thinking && !thinking.open && thinking.label === 'Thinking' && !thinking.body && thinking.color !== thinking.text,
      'thinking is one grey "Thinking" row, folded until clicked', thinking);
  } else {
    console.log('  note  the model gave no reasoning in this conversation, so the thinking row is not checked here');
  }
  const thinkShots = async (mode) => {
    if (!thinking) return;
    await chat.evaluate(() => { const d = [...document.querySelectorAll('#log details.reasoning')].pop(); d.open = false; const l = document.getElementById('log');
      l.scrollTop += d.getBoundingClientRect().top - l.getBoundingClientRect().top - 120; });
    await picture(`g04-thinking-closed-${mode}`, { features: ['thinking folded'], part: EDITOR,
      expect: `In the ${mode} theme, a reply's thinking is one row with its small grey time and the grey word "Thinking"; the reasoning itself is not shown. The reply's text follows it.` });
    await chat.click('#log details.reasoning >> nth=-1 >> summary');
    const open = await chat.evaluate(() => { const d = [...document.querySelectorAll('#log details.reasoning')].pop(); return d.open && d.querySelector('.md').checkVisibility(); });
    if (mode === 'dark') check(open, 'a click on the thinking row opens it to the reasoning', open);
    await picture(`g04-thinking-open-${mode}`, { features: ['thinking opened'], part: EDITOR,
      expect: `In the ${mode} theme, the "Thinking" row is open: under it the model's reasoning in grey, slightly smaller text; the reply's text follows it in the normal colour.` });
  };
  await thinkShots('dark');

  // G6. A todowrite call is a list, open from the start: what is done ticked and struck through, what is under way in
  //     bold, what was dropped struck through and faded.
  let todos = null;
  if (!real || v2) {
    const todoTurn = real
      ? 'Use your todowrite tool to write a todo list of exactly three steps for adding a CSV export to a small app, with the first step in_progress and the other two pending. Do not do the steps and use no other tool. Then reply "Listed." and nothing else.'
      : 'Demo: page-todo';
    const todoDone = await turn(todoTurn);
    todos = await until(() => chat.evaluate(() => {
      const e = [...document.querySelectorAll('#log .tool')].reverse().find((x) => x.querySelector('.todo-list:not([hidden]) .todo'));
      return e ? { open: e.classList.contains('open'), name: e.querySelector('.tool-name').textContent, rows: [...e.querySelectorAll('.todo')].map((r) => ({ state: r.className.replace('todo todo-', ''), text: r.textContent,
        strike: getComputedStyle(r.querySelector('.todo-text')).textDecorationLine, weight: getComputedStyle(r.querySelector('.todo-text')).fontWeight })), inShown: !e.querySelector('.tool-in').hidden } : null;
    }), 15000);
    const states = todos ? todos.rows.map((r) => r.state) : [];
    check(todoDone && !!todos && todos.open && !todos.inShown && todos.name === 'todowrite' && (real ? todos.rows.length >= 3 && states.includes('in_progress')
      : states.join() === 'completed,in_progress,pending,cancelled' && todos.rows[0].strike === 'line-through' && Number(todos.rows[1].weight) >= 600 && todos.rows[3].strike === 'line-through'),
    "a todowrite call shows its list open: done items struck through, the one under way in bold, dropped ones struck through", todos);
    await chat.evaluate(() => { const e = [...document.querySelectorAll('#log .tool')].reverse().find((x) => x.querySelector('.todo-list:not([hidden]) .todo')); const l = document.getElementById('log');
      if (e) l.scrollTop += e.getBoundingClientRect().top - l.getBoundingClientRect().top - 80; });
    await picture('g05-todo-dark', { features: ['todo list'], part: EDITOR,
      expect: `A todowrite row open to a list of ${real ? 'three or more items' : 'four items'}, one per line with an icon: ${real ? 'the item under way has a filled blue circle and bold text, the others an empty circle' : 'a green tick and grey struck-through text for "Read the exporter", a filled blue circle and bold text for "Write the CSV export", an empty circle for "Run the tests", and a faded, struck-through "Ask about an Excel export" with a crossed-circle icon'}. No IN or OUT box under the list.` });
  } else {
    console.log('  note  OpenCode 1 has no todowrite tool, so the todo list is checked on OpenCode 2 only');
  }

  // G7. Your message stays pinned at the top while its reply scrolls by; a click goes back to it.
  if (!real) await turn('Demo: page-long');
  const pinState = () => chat.evaluate(() => { const p = document.getElementById('pinned'); return { shown: !p.hidden && p.getClientRects().length > 0, text: p.querySelector('.pinned-text').textContent, item: p.dataset.item || '' }; });
  /* Scrolls the log so that one of your messages is just above the top: the last one that has more than 160 px of reply
     after it and is far enough from the end for the log to scroll it out of sight. */
  const pastLast = () => chat.evaluate(() => {
    const l = document.getElementById('log');
    const us = [...document.querySelectorAll('#log .msg.user')];
    const lt = l.getBoundingClientRect().top;
    const max = l.scrollHeight - l.clientHeight;
    for (let i = us.length - 1; i >= 0; i--) {
      const box = us[i].querySelector('.user-box').getBoundingClientRect();
      const next = us[i + 1] ? us[i + 1].getBoundingClientRect().top : l.scrollHeight + lt - l.scrollTop;
      const want = l.scrollTop + box.bottom - lt + 40;
      if (next - box.bottom > 160 && want <= max) { l.scrollTop = want; return { index: i, text: us[i].querySelector('.bubble').textContent }; }
    }
    return null;
  });
  const past = await pastLast();
  await sleep(400);
  const pinned = await pinState();
  check(!!past && pinned.shown && pinned.text === past.text, 'scrolled past your message, it stays pinned at the top of the log', { past, pinned });
  await picture('g06-pinned-dark', { features: ['pinned prompt'], part: EDITOR,
    expect: 'At the top of the conversation, over its rows, a box like your messages (a bar down its left edge, its small time before the text) holds your message, which has scrolled out of view; its reply is visible below.' });
  if (pinned.shown) {
    await chat.click('#pinned');
    await sleep(500);
    const back = await chat.evaluate((id) => { const m = document.querySelector(`#log [data-id="${id}"]`); const l = document.getElementById('log');
      return m ? { offset: Math.round(m.getBoundingClientRect().top - l.getBoundingClientRect().top), pinned: !document.getElementById('pinned').hidden } : null; }, pinned.item);
    check(!!back && Math.abs(back.offset) <= 40 && !back.pinned, 'a click on the pinned message scrolls back to it, and the pin goes', back);
  }
  await setting('pinPrompt', false);
  await until(async () => (await read('pinPrompt')) === false || null, 5000);
  await sleep(400);
  await pastLast();
  await sleep(400);
  const unpinned = await pinState();
  check(!unpinned.shown, 'with opencodeAgentPlus.pinPrompt off, nothing is pinned', unpinned);
  await setting('pinPrompt', true);

  // G8. Focus view: Ctrl+Alt+F in the chat tab, and the button under the message box, show only your messages and the
  //     last reply of each turn.
  const focusOf = () => chat.evaluate(() => {
    const seen = (e) => !!e && e.getClientRects().length > 0;
    const b = document.getElementById('focusBtn');
    return { on: document.body.classList.contains('focus-view'), button: seen(b), pressed: b.getAttribute('aria-pressed'),
      users: [...document.querySelectorAll('#log .msg.user')].filter(seen).length, allUsers: document.querySelectorAll('#log .msg.user').length,
      tools: [...document.querySelectorAll('#log .tool')].filter(seen).length, thinking: [...document.querySelectorAll('#log details.reasoning')].filter(seen).length,
      replies: [...document.querySelectorAll('#log .msg.reply')].filter(seen).length,
      early: [...document.querySelectorAll('#log .msg.reply')].filter((r) => /Making a list of the steps first/.test(r.textContent)).map(seen) };
  });
  const before = await focusOf();
  await chat.click('#input');
  await page.keyboard.press('Control+Alt+KeyF');
  const on = await until(async () => { const f = await focusOf(); return f.on ? f : null; }, 10000);
  const set = await read('focusView');
  check(!!on && set === true && on.users === on.allUsers && on.tools === 0 && on.thinking === 0 && on.replies >= 1 && on.pressed === 'true'
    && (real || (before.early.join() === 'true' && on.early.join() === 'false')),
  'Ctrl+Alt+F in the chat tab turns Focus view on, which keeps your messages and the last reply of each turn and hides tool rows, thinking and the earlier replies of a turn', { before, on, set });
  await toUser(3);
  await picture('g07-focus-view-dark', { features: ['focus view'], part: EDITOR,
    expect: 'Focus view is on: the conversation shows only your messages (boxes with a bar down the left) and one reply row under each, the last of its turn, with its time (followed by the turn\'s figures, if any); no tool rows, thinking rows or todo list. The eye button under the message box shows as pressed. A message of yours may be pinned over the top row.' });
  await chat.click('#focusBtn');
  await chat.hover('#log').catch(() => {});
  const off = await until(async () => { const f = await focusOf(); return !f.on && (await read('focusView')) === false ? f : null; }, 10000);
  check(!!off && off.tools === before.tools && off.pressed === 'false', "the Focus button under the message box turns it off again, and the setting follows", off);

  // G8b. With an editor beside it the log is narrow, and the time of each message takes a line of its own, so that the
  //      text keeps one left edge.
  const metaOf = () => chat.evaluate(() => { const r = document.querySelector('#log .msg.reply .meta'); const u = document.querySelector('#log .msg.user .meta');
    const l = document.getElementById('log'); return { width: l.clientWidth, reply: r && getComputedStyle(r).float, user: u && getComputedStyle(u).float }; });
  const wide = await metaOf();
  await call(`const d = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "README.md"));
    await vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.Beside, preview: false }); return true;`);
  chat = await frameWith(page, '#input', 20000);
  const narrow = chat ? await until(async () => { const m = await metaOf(); return m.width <= 600 && m.reply === 'none' ? m : null; }, 10000) : null;
  check(wide.reply === 'left' && wide.user === 'left' && !!narrow && narrow.user === 'none',
    'in a wide log the time sits before the text; with an editor beside the chat the log is narrow and the time takes a line of its own', { wide, narrow });
  if (chat) {
    await toUser(3);
    await picture('g08-narrow-dark', { features: ['narrow log'], part: EDITOR,
      expect: 'The chat on the left half of the editor area, a text editor on the right. In the chat, the time of each of your messages, and the time (and figures) of each reply row, sit on a line of their own above the text, so every line of text starts at the same left edge; no text squeezed into a narrow column beside the time.' });
  }
  await call(`const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((x) => x.input instanceof vscode.TabInputText && x.input.uri.fsPath.endsWith("README.md"));
    await vscode.window.tabGroups.close(tabs); await vscode.commands.executeCommand("workbench.action.editorLayoutSingle"); return true;`).catch(() => {});
  chat = await frameWith(page, '#input', 20000);

  // G9. The same pictures in the light theme.
  await theme(LIGHT);
  await sleep(1500);
  chat = await frameWith(page, '#input', 20000);
  if (chat) {
    await toUser(1);
    await picture('g01-code-light', { features: ['code highlighting'], part: EDITOR,
      expect: 'The light theme. The code blocks of the first reply use its colours: keywords dark blue, strings dark red, numbers dark green, comments green and italic, function names purple, all readable on the light grey block.' });
    await toUser(2);
    await picture('g02-edit-light', { features: ['edit diff in the tool row'], part: EDITOR,
      expect: 'The light theme. The edit row is open and shows its change: removed lines on a pale red background with "-", added ones on a pale green background with "+", readable dark text; its row shows a green "+n" and a red "-n".' });
    await thinkShots('light');
    if (todos) {
      await chat.evaluate(() => { const e = [...document.querySelectorAll('#log .tool')].reverse().find((x) => x.querySelector('.todo-list:not([hidden]) .todo')); const l = document.getElementById('log');
        if (e) l.scrollTop += e.getBoundingClientRect().top - l.getBoundingClientRect().top - 80; });
      await picture('g05-todo-light', { features: ['todo list'], part: EDITOR,
        expect: 'The light theme. The todowrite row is open and shows its list: each item with its icon, the one under way in bold with a filled blue circle, done ones ticked in green and struck through in grey, dropped ones struck through and faded; all readable.' });
    }
  }
  await theme(DARK);
  await sleep(800);
}

module.exports = { run };
