// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The status line of a turn that OpenCode is about to retry, for test/vscode/run.js after its other steps. Only the
 * fake backend runs it: a real provider is not made to fail on purpose. Its turn reports attempt 2 with a wait and an
 * error, clears it when the attempt starts, then replies.
 */

/* t: { page, call, check, shot, until, sleep, frameWith, real } */
async function run(t) {
  const { page, call, check, shot, until, sleep, frameWith, real } = t;
  if (real) return;
  await call('await vscode.commands.executeCommand("notifications.clearAll"); return vscode.commands.executeCommand("opencodeAgentPlus.newConversation");').catch(() => {});
  await sleep(1500);
  const chat = await frameWith(page, '#input', 20000);
  if (!check(!!chat, 'a new conversation opens for the retry')) return;
  await chat.fill('#input', 'Retry once, then reply with only the word ready.');
  await chat.press('#input', 'Enter');
  const status = () => chat.evaluate(() => { const s = document.getElementById('status'); return s && !s.hidden ? { cls: s.className, text: s.textContent } : null; });
  const retrying = await until(async () => { const s = await status(); return s && s.cls === 'retry' ? s : null; }, 15000, 100);
  check(!!retrying && /^Retrying, attempt 2 in \d+s · .*Too many requests/.test(retrying.text),
    'while OpenCode waits to retry, the status line gives the attempt, the seconds left and the error', retrying);
  if (retrying) {
    await page.mouse.move(2, 450);
    await shot('r1-retrying', { features: ['retry notice'],
      expect: 'Above the message box, the status line reads "Retrying, attempt 2 in Ns" followed by the error about too many requests. The user message is in the log and no reply has started.',
      part: '#workbench\\.parts\\.editor', settle: 0 });
  }
  /* "ready" is in the message too, so the reply is the second one. */
  const replied = await until(() => chat.evaluate(() => (document.querySelector('#log').textContent.split('ready').length > 2 ? true : null)), 20000);
  const after = await until(async () => { const s = await status(); return !s || s.cls !== 'retry' ? (s || 'hidden') : null; }, 5000, 100);
  check(!!replied && !!after, 'once the attempt starts the notice goes, and the reply comes', { replied: !!replied, after });
}

module.exports = { run };
