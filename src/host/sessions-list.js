// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the Conversations view lists and does: the backend's sessions, with the state this
 * window knows better for those open here. Deleting a conversation closes its tab first; one that another window has
 * open is not deleted.
 */

/*
 * deps:
 *   backend              src/host/backend.js
 *   manager              src/host/session-manager.js
 *   holder(id)           the pid of another window that has it open, or 0
 *   closeTabs(id)        closes its tabs in this window
 */
function createSessionsList(deps) {
  async function list() {
    const infos = await deps.backend.listSessions();
    deps.manager.update(infos);
    return infos.map((s) => {
      const here = deps.manager.snapshot(s.id);
      return { ...s, title: (here && here.title) || s.title, status: here ? statusOfActivity(here.activity) : s.status };
    });
  }

  const statusOfActivity = (a) => (a === 'working' || a === 'waiting' ? a : 'idle');
  const statusOf = (meta) => (meta && meta.status === 'working') || (meta && meta.status === 'waiting') ? meta.status : 'idle';

  async function rename(id, title) {
    await deps.backend.renameSession(id, title);
    const e = deps.manager.get(id);
    if (e) deps.manager.update([{ id, title }]);
  }

  async function remove(id) {
    if (deps.holder(id)) throw new Error('it is open in another window; close it there first');
    await deps.closeTabs(id);
    deps.manager.close(id, { abort: true });
    await deps.backend.deleteSession(id);
  }

  return { list, statusOf, rename, remove };
}

module.exports = { createSessionsList };
