// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Rewinding a conversation to before one of the user's messages (OpenCode 2's /api, which OpenCode calls
 * experimental): which message OpenCode means, and what the confirmation says. The steps themselves are the backend's
 * (src/opencode/index.js): staging puts the files back and lists them, then the user confirms (commit) or not (clear).
 */

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/*
 * The id of the message the page's `target` ({ messageId, text, ordinal }: its place among the user's own messages) is
 * in OpenCode's list `users` ([{ id, text }], oldest first). A replayed message names its id; a live one is found at its
 * place, and only when the text there is the same (OpenCode may have added a selection's text after it), so a list
 * that has moved on rewinds nothing rather than the wrong message. '' when it cannot be told.
 */
function messageOf(target, users) {
  if (target && typeof target.messageId === 'string' && target.messageId) return target.messageId;
  const list = Array.isArray(users) ? users : [];
  const want = norm(target && target.text);
  if (!want) return '';
  const same = (u) => u && typeof u.id === 'string' && norm(u.text).startsWith(want);
  const at = Number(target && target.ordinal);
  if (Number.isInteger(at) && at >= 0 && same(list[at])) return list[at].id;
  const matches = list.filter(same);
  return matches.length === 1 ? matches[0].id : '';
}

/* What staging does to each file, by the status it reports. */
const STATUS = Object.freeze({ deleted: 'removed', added: 'restored', modified: 'changed back' });

/* The confirmation for what staging returned ({ tracked, files }): { message, detail }. */
function confirmation(staged) {
  const files = staged && Array.isArray(staged.files) ? staged.files : [];
  const lines = ['This message and every message after it leave the conversation.'];
  if (staged && staged.tracked === false) {
    lines.push('', 'Only the conversation goes back: OpenCode keeps no snapshots of files in this folder (it is not a git repository), so the files stay as they are now.');
  } else if (!files.length) {
    lines.push('', 'No file was changed after it, so no file changes.');
  } else {
    lines.push('', `These files go back to how they were before it (OpenCode has already put them back; Cancel undoes that):`);
    for (const f of files.slice(0, 20)) {
      const counts = [f.additions ? `+${f.additions}` : '', f.deletions ? `-${f.deletions}` : ''].filter(Boolean).join(' ');
      lines.push(`  ${f.file}: ${STATUS[f.status] || f.status}${counts ? ` (${counts})` : ''}`);
    }
    if (files.length > 20) lines.push(`  and ${files.length - 20} more`);
  }
  lines.push('', 'Rewinding is experimental in OpenCode.');
  return { message: 'Rewind the conversation to before this message?', detail: lines.join('\n') };
}

module.exports = { messageOf, confirmation };
