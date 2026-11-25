// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Downloading OpenCode from this window (src/opencode/download.js): the command, and the notification with a button
 * that the first notFound error in a window brings up. Nothing is fetched until the user picks one of them.
 *
 * A download runs once at a time in a window. Once it is in place, done(result) lets the extension find OpenCode again and redraw the list; nothing needs a reload, since the
 * backend looks for OpenCode again every time it is not running (src/opencode/index.js ensure()).
 */
const brand = require('../brand');
const { single } = require('../shared/python-offer');

const COMMAND = `${brand.prefix}.downloadOpenCode`;
const BUTTON = 'Download OpenCode';

const mb = (bytes) => Math.round(bytes / (1024 * 1024));

/*
 * deps:
 *   vscode
 *   done(result)    after a download that put OpenCode in place: { path, already }
 *   ask(text, ...buttons)   shows a message with buttons; resolves with the one picked
 *   tell(text)      shows a message
 *   log(line)       optional
 *   lib             src/opencode/download.js, replaceable in tests
 */
function createOpenCodeDownload({ vscode, done = () => {}, ask, tell = () => {}, log = () => {}, lib = require('../opencode/download') }) {
  const askUser = ask || ((text, ...buttons) => vscode.window.showInformationMessage(text, ...buttons));
  let offered = false;

  const get = single(() => {
    const a = lib.asset();
    if (!a) {
      tell(`OpenCode ${lib.VERSION} is not published for this machine (${process.platform} ${process.arch}). Install OpenCode yourself.`);
      return false;
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
      title: `Downloading OpenCode ${lib.VERSION} from GitHub (${mb(a.size)} MB)` }, async (progress, token) => {
      const stop = new AbortController();
      const off = token && typeof token.onCancellationRequested === 'function' ? token.onCancellationRequested(() => stop.abort()) : null;
      let shown = 0;
      try {
        const r = await lib.download({
          signal: stop.signal,
          userAgent: brand.packageName,
          onProgress: (bytes, total) => {
            const pct = Math.min(100, Math.floor((bytes * 100) / total));
            if (pct <= shown) return;
            progress.report({ increment: pct - shown, message: `${pct}%` });
            shown = pct;
          },
          onStep: (step) => progress.report({ message: step }),
        });
        log(`OpenCode download: ${r.said}`);
        if (r.cancelled) { tell(r.said); return false; }
        if (!r.ok) {
          Promise.resolve(vscode.window.showErrorMessage(`${brand.displayName}: downloading OpenCode failed. ${r.said}`)).catch(() => {});
          return false;
        }
        await Promise.resolve().then(() => done(r)).catch((e) => log(`handling the finished OpenCode download failed: ${(e && e.message) || e}`));
        return true;
      } finally {
        if (off) { try { off.dispose(); } catch (_) { /* gone */ } }
      }
    });
  });

  return {
    COMMAND,
    run: () => get(),
    /* Gets every error the backend rejects with. Resolves to whether OpenCode was downloaded. */
    offer(e) {
      if (offered || !e || e.code !== 'notFound' || !lib.available()) return Promise.resolve(false);
      offered = true;
      const a = lib.asset();
      const size = a ? ` (${mb(a.size)} MB)` : '';
      return Promise.resolve(askUser(
        `OpenCode was not found. Download OpenCode ${lib.VERSION} from GitHub${size}? If you install OpenCode yourself, that one is used instead.`, BUTTON))
        .then((pick) => (pick === BUTTON ? get() : false))
        .catch((err) => { log(`offering the OpenCode download failed: ${(err && err.message) || err}`); return false; });
    },
    get offered() { return offered; },
  };
}

module.exports = { createOpenCodeDownload, COMMAND, BUTTON };
