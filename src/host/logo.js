// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The logo Agent Plus draws beside this extension's conversations. Agent Plus reads it as an SVG file, where
 * currentColor has no theme to follow, so the activity bar icon (images/sidebar.svg) is copied into the extension's
 * storage twice, once in each default theme's icon colour, and rewritten only when the icon changes.
 */
const fs = require('fs');
const path = require('path');

const COLORS = { light: '#424242', dark: '#c5c5c5' };

/* { light, dark } file paths, or null when the icon cannot be read or the copies cannot be written. */
function logoFiles(extensionPath, storageDir) {
  let svg;
  try { svg = fs.readFileSync(path.join(extensionPath, 'images', 'sidebar.svg'), 'utf8'); } catch (_) { return null; }
  const out = {};
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    for (const [theme, color] of Object.entries(COLORS)) {
      const file = path.join(storageDir, `logo-${theme}.svg`);
      const body = svg.replace(/currentColor/g, color);
      let old = null;
      try { old = fs.readFileSync(file, 'utf8'); } catch (_) { /* not written yet */ }
      if (old !== body) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, file);
      }
      out[theme] = file;
    }
  } catch (_) { return null; }
  return out;
}

module.exports = { logoFiles, COLORS };
