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

/* t: { page, call, check, until, frameWith, real } */
async function run(t) {
  const { page, call, check, until, frameWith, real } = t;
  const conf = (value) => call('await vscode.workspace.getConfiguration("opencodeAgentPlus").update("openCodeModels", arg, vscode.ConfigurationTarget.Global); return true;', value);
  const f = await frameWith(page, '#model', 20000);
  if (!f) { check(false, 'the window has a chat page with a model list'); return; }
  const groups = () => f.evaluate(() => [...document.querySelectorAll('#model optgroup')].map((g) => ({ label: g.label, ids: [...g.querySelectorAll('option')].map((o) => o.value) })));
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
}

module.exports = { run };
