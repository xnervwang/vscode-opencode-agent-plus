// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Reads the local image files a reply shows and returns each as a data: URL for the chat page, which loads images only
 * from there and its own folder. Using asWebviewUri for the file instead would mean adding its folder to the page's
 * localResourceRoots, and VS Code reloads a webview whose options change.
 *
 * Takes an absolute path or a file:// URL; a relative one is not resolved, since the page cannot tell which folder the
 * reply meant. Over Remote-SSH this runs on the remote machine, where the agent wrote the file.
 */
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const MAX_BYTES = 8 * 1024 * 1024;
const BY_EXTENSION = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' });
const NAMES = 'a PNG, JPEG, GIF, WebP or SVG image';
/* An SVG file has no fixed first bytes: an svg element at the start, after an optional XML declaration, doctype or
   comments. */
const SVG_START = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;

function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (SVG_START.test(buf.toString('utf8', 0, Math.min(buf.length, 4096)))) return 'image/svg+xml';
  return '';
}

function fileOf(src, platform = process.platform) {
  if (typeof src !== 'string' || !src) return null;
  if (/^file:\/\//i.test(src)) {
    try { return fileURLToPath(src); } catch (_) { return null; }
  }
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(src) ? src : null;
  return src.startsWith('/') ? src : null;
}

/* The page shows `reason` where the image would be. */
async function loadImage(src, { platform = process.platform } = {}) {
  const file = fileOf(src, platform);
  if (!file) return { ok: false, reason: 'Only an absolute path or a file:// address is shown as an image.' };
  if (!BY_EXTENSION[path.extname(file).toLowerCase()]) return { ok: false, reason: 'The file name does not end in .png, .jpg, .jpeg, .gif, .webp or .svg.' };
  let st;
  try { st = await fs.promises.stat(file); } catch (_) { return { ok: false, reason: 'There is no such file.' }; }
  if (!st.isFile()) return { ok: false, reason: 'This is not a file.' };
  if (st.size > MAX_BYTES) return { ok: false, reason: `The file is ${(st.size / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB limit for images.` };
  let buf;
  try { buf = await fs.promises.readFile(file); } catch (e) { return { ok: false, reason: `The file could not be read (${(e && e.code) || 'error'}).` }; }
  const type = sniff(buf);
  if (!type) return { ok: false, reason: `The file's contents are not ${NAMES}.` };
  return { ok: true, dataUrl: `data:${type};base64,${buf.toString('base64')}` };
}

module.exports = { loadImage, sniff, fileOf, MAX_BYTES };
