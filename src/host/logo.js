// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The logo Agent Plus draws beside this extension's conversations. It is read as an SVG file, where currentColor has
 * no theme to follow, so the OpenCode mark (images/sidebar.svg) is copied into the extension's storage twice, once
 * in each default theme's icon colour, and rewritten only when the icon changes.
 *
 * A chat tab's icon (tabIcons) is the same logo with a dot for the conversation's state, in the colours Claude Code
 * Plus and Codex Plus use for their tabs: green while a turn runs, red while it waits for the user, none once it has
 * stopped. The logo is cut away round the dot so the dot reads at tab size. File names carry a hash of the
 * drawing: VS Code keeps an image it has loaded for as long as its URL stays the same.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COLORS = { light: '#424242', dark: '#c5c5c5' };
/* A string is a filled dot; { ring } a ring of that colour, for the background state. */
const DOTS = { working: '#22c55e', waiting: '#ef4444', background: { ring: '#22c55e' } };
const TAB_STATES = ['stopped', 'working', 'waiting', 'background'];

function keep(file, body) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) { /* not written yet */ }
  if (old === body) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/* The 24-unit logo in `color`; with `dot` set, a dot or ring (DOTS) sits at its top right. */
function withDot(svg, color, dot) {
  const body = svg.replace(/currentColor/g, color);
  if (!dot) return body;
  const open = body.indexOf('>', body.indexOf('<svg')) + 1;
  const close = body.lastIndexOf('</svg>');
  if (open <= 0 || close < open) return body;
  return `${body.slice(0, open)}
  <defs><mask id="cut"><rect width="24" height="24" fill="white" stroke="none"/><circle cx="19" cy="5" r="6" fill="black" stroke="none"/></mask></defs>
  <g mask="url(#cut)">${body.slice(open, close)}</g>
  ${typeof dot === 'string' ? `<circle cx="19" cy="5" r="4.5" fill="${dot}" stroke="none"/>` : `<circle cx="19" cy="5" r="3.5" fill="none" stroke="${dot.ring}" stroke-width="2"/>`}
${body.slice(close)}`;
}

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

/* { stopped, working, waiting, background }, each { light, dark } file paths; null on the same failures as logoFiles. */
function tabIcons(extensionPath, storageDir) {
  let svg;
  try { svg = fs.readFileSync(path.join(extensionPath, 'images', 'sidebar.svg'), 'utf8'); } catch (_) { return null; }
  const out = {};
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    for (const state of TAB_STATES) {
      out[state] = {};
      for (const [theme, color] of Object.entries(COLORS)) {
        const body = withDot(svg, color, DOTS[state]);
        const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 10);
        const file = path.join(storageDir, `tab-${state}-${theme}-${hash}.svg`);
        keep(file, body);
        out[state][theme] = file;
      }
    }
  } catch (_) { return null; }
  return out;
}

module.exports = { logoFiles, tabIcons, withDot, COLORS, DOTS, TAB_STATES };
