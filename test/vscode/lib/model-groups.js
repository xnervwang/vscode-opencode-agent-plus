// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page's model list: each provider's models under its name. With opencodeAgentPlus.openCodeModels at auto,
 * the default, OpenCode's own free models are left out while another provider is listed; show puts them under their
 * own heading, and hide leaves them out again. The fake backend lists one such model beside its own.
 */
const FREE_GROUP = "OpenCode's free models (opencode.ai)";
const { modelChoices, pickModel } = require('./window');

/* t: { page, call, check, until, sleep, shot, frameWith, real } */
async function run(t) {
  const { page, call, check, until, sleep, shot, frameWith, real } = t;
  const conf = (value) => call('await vscode.workspace.getConfiguration("opencodeAgentPlus").update("openCodeModels", arg, vscode.ConfigurationTarget.Global); return true;', value);
  const f = await frameWith(page, '#model', 20000);
  if (!f) { check(false, 'the window has a chat page with a model list'); return; }
  const groups = async () => (await modelChoices(f)).groups;
  const current = () => f.evaluate(() => document.getElementById('model').dataset.current || '');
  const free = (gs, now) => gs.flatMap((g) => g.ids).filter((id) => id.startsWith('opencode/') && id !== now);
  const now = await current();
  const others = (gs) => gs.filter((g) => g.ids.some((id) => !id.startsWith('opencode/')));
  const auto = await until(async () => { const gs = await groups(); return gs.length && !free(gs, now).length ? gs : null; }, 20000);
  check(!!auto && others(auto).length > 0 && auto.every((g) => g.label !== FREE_GROUP),
    "by default the model list puts each provider's models under its name and leaves out OpenCode's free models while another provider is listed", auto || await groups());
  await conf('show');
  const shown = await until(async () => { const gs = await groups(); const g = gs.find((x) => x.label === FREE_GROUP); return g && g.ids.some((id) => id.startsWith('opencode/')) ? gs : null; }, 30000);
  check(!!shown, `with openCodeModels set to show they are listed under "${FREE_GROUP}"`, shown || await groups());
  await conf('hide');
  const hidden = await until(async () => { const gs = await groups(); return gs.length && !free(gs, now).length ? gs : null; }, real ? 120000 : 30000);
  check(!!hidden, 'with hide they are left out again', hidden || await groups());
  await conf(undefined);
  await until(async () => ((await groups()).some((g) => g.label === FREE_GROUP) ? null : true), real ? 120000 : 30000);

  const state = () => f.evaluate(() => {
    const m = document.getElementById('modelMenu');
    const rows = (sel) => [...m.querySelectorAll(sel)].filter((r) => !r.closest('[hidden]')).map((r) => r.querySelector('.menu-name').textContent);
    return { open: !m.hidden, focused: document.activeElement === m.querySelector('.model-filter'),
      actions: [...m.querySelectorAll('.model-actions .model-action')].map((r) => r.dataset.action), inList: !!m.querySelector('.model-list .model-action'),
      families: rows('.model-row'), variants: rows('.model-variant'), input: document.activeElement === document.getElementById('input') };
  });
  await f.click('#model');
  const opened = await until(async () => { const st = await state(); return st.open && st.focused ? st : null; }, 10000);
  check(!!opened && opened.actions.join(',') === 'connect,reload' && !opened.inList,
    'the model pill opens the picker, focused in its filter, with Connect a provider… and Reload the model list above the list', opened || await state());
  const multi = await f.evaluate(() => { const r = document.querySelector('#modelMenu .model-row.multi'); return r ? { key: r.dataset.family, name: r.querySelector('.menu-name').textContent } : null; });
  if (!multi) { check(false, 'the picker has a model with more than one geography', await state()); return; }
  await f.fill('#modelMenu .model-filter', multi.name);
  const narrowed = await until(async () => { const st = await state(); return st.families.includes(multi.name) && st.variants.length >= 2 ? st : null; }, 10000);
  check(!!narrowed && narrowed.families.every((n) => n.toLowerCase().includes(multi.name.toLowerCase().split(' ')[0])),
    "typing in the filter narrows the list and unfolds the matching model's geographies", narrowed || await state());
  await shot('24-model-picker', { features: ['model picker'], part: '#workbench\\.parts\\.editor',
    expect: `Over the message box, a list as wide as it: a filter box holding "${multi.name}" at the top, then "Connect a provider…" and "Reload the model list", a line, and below it a group heading with the row "${multi.name}" (its geographies in grey on the right) and, indented under it, one row per geography with its model id in grey.` });
  await f.fill('#modelMenu .model-filter', '');
  await until(async () => ((await state()).variants.length === 0 || null), 5000);
  await f.click(`#modelMenu .model-row[data-family="${multi.key}"]`);
  const unfolded = await until(async () => { const st = await state(); return st.variants.length >= 2 ? st : null; }, 5000);
  check(!!unfolded, "clicking a model's row unfolds its geographies", unfolded || await state());
  await f.press('#modelMenu .model-filter', 'Escape');
  const closed = await until(async () => { const st = await state(); return !st.open && st.input ? st : null; }, 5000);
  check(!!closed, 'Esc closes the picker and puts the focus back in the message box', closed || await state());
  if (!real) {
    await f.click('#model');
    await f.fill('#modelMenu .model-filter', 'fake large');
    await f.press('#modelMenu .model-filter', 'Enter');
    const picked = await until(async () => ((await current()) === 'fake/fake-large' ? true : null), 15000);
    check(!!picked, 'Enter in the filter picks the model that matches', await current());
    await pickModel(f, now);
    await until(async () => ((await current()) === now ? true : null), 15000);
  }
  await sleep(200);
}

module.exports = { run };
