// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page. It draws the items and head that src/ui/chat-panel.js posts (shapes in src/ui/view-model.js) and
 * sends back what the user does. It keeps no conversation state of its own beyond the draft in the input, which
 * survives the page being unloaded while hidden, and the attachments waiting for the next message (images,
 * selections, files picked with @), which do not.
 *
 * Messages in:  reset { items, head }, update { items, head }, models { models, current, error },
 *               options { options: [{ id, name, value, values: [{ value, name, description? }] }] },
 *               commands { commands: [{ name, description }] },
 *               caps { images, files, selection, rewind, info, replyImages },
 *               selection { label }, selectionAdded { item }, files { seq, query, items }, questionErrors
 *               { requestId, errors }, planBar { summary }, sound { shown, on }, info { rows, error? }, image { id, ok,
 *               dataUrl | reason }, draft { text }, conversations { rev, list, self }; each carries the extension
 *               host's `now`.
 * Messages out: ready { tz }, send { text, images?, files?, selections? }, abort, permission, question { requestId, action,
 *               values }, viewDiff, setModel, setOption, reloadModels, copy, openLink, findFiles { query, seq },
 *               addSelection, planBarOpen { part: 'plan' | 'answer' }, rewind { itemId }, info, setSound { on },
 *               image { id, src }, background, openConversation { sourceId, sessionId }.
 *
 * The layout is the Claude Code panel's: each row of a reply hangs on a line down the left side with a dot that shows
 * its state, a tool call is one row that opens to its input and result, and the message box carries its buttons in a
 * row under the text. An open permission request or question sits right above the message box until it is answered;
 * 1, 2 and 3 answer a permission request while the focus is not in a text field.
 *
 * Esc stops the turn when no list or box is open. A chime (Agent Plus's kit.js, the same three as Claude Code Plus)
 * sounds when a turn ends and when a permission request or a question arrives, unless the footer's button has muted
 * the chimes. A local image in a reply is read by the extension and comes back as a data: URL; one from the web is
 * shown as a link and never fetched, so an image URL in a reply cannot send data anywhere.
 *
 * Replies link the other conversations they mention by title or id (agentPlusKit's mentions); a click opens one.
 * The rail on the right edge moves between the user's messages, and its middle button opens a list of them and of the
 * compaction points; a click scrolls to one. The Subagents button hides what subagents did and folds their progress,
 * leaving a request of theirs that still waits. Both choices live in the page's state.
 */
(function () {
  const api = acquireVsCodeApi();
  const C = window.ChatComposer;
  const md = typeof window.markdownit === 'function'
    ? window.markdownit({ html: false, linkify: true, breaks: true })
    : null;
  /* markdown-it drops file: addresses; an image link may name a local file by one. Scripts stay out. */
  if (md) md.validateLink = (url) => !/^\s*(javascript|vbscript):/i.test(url) && (!/^\s*data:/i.test(url) || /^\s*data:image\/(gif|png|jpeg|webp);/i.test(url));
  const KIT = window.agentPlusKit || null;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const form = $('composer');
  const bottom = $('bottom');
  const dock = $('dock');
  const stopBtn = $('stop');
  const sendBtn = $('send');
  const statusEl = $('status');
  const queuedEl = $('queued');
  const menuEl = $('menu');
  const attachEl = $('attachments');
  const noteEl = $('note');
  const selBtn = $('addSelection');
  const attachBtn = $('attach');
  const attachFile = $('attachFile');
  const slashBtn = $('slashBtn');
  const modelSel = $('model');
  const infoBtn = $('infoBtn');
  const infoBox = $('infoBox');
  const bgEl = $('background');
  const bgSum = bgEl.querySelector('summary');
  const bgList = bgEl.querySelector('.bg-list');
  const soundBtn = $('sound');
  const navBtn = $('navBtn');
  const subBtn = $('subBtn');
  const rail = $('rail');
  const outlineEl = $('outline');
  const outlineList = outlineEl.querySelector('.outline-list');
  const outlineFilter = outlineEl.querySelector('.outline-filter');
  /* The settings shown next to the model, by the id the conversation's options() gives them. */
  const optionSels = { mode: $('mode'), effort: $('effort') };
  const ring = $('ring');
  const titleEl = $('title');
  const ringFill = ring.querySelector('.fill');
  const ringLabel = el('span', 'ring-label');
  ring.appendChild(ringLabel);
  const RING = 2 * Math.PI * 6;
  const MAX_IMAGES = 8;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const BASE_PLACEHOLDER = 'Ask OpenCode…';
  const BUSY_PLACEHOLDER = 'Queue another message…';

  const nodes = new Map();
  const toRender = new Set();
  let head = null;
  let skew = 0;
  let ticker = null;
  let frame = 0;
  let stick = true;

  /* Page features the extension turned on (caps). */
  let caps = { images: false, files: false, selection: false, rewind: false, info: false, replyImages: false };
  let sound = { shown: false, on: false };
  /* The last head's status and pending count, which the chimes compare against; null until the first reset. */
  let heard = null;
  let commands = [];
  let selectionLabel = '';
  const images = [];
  const selections = [];
  let picked = [];
  let attSeq = 0;
  /* The open list under the input: { kind: 'slash' | 'at', items, index, token, loading? }. */
  let menu = null;
  let fileSeq = 0;
  let fileTimer = 0;
  let noteTimer = 0;
  /* agentPlusKit's mention index, or null. */
  let convIx = null;
  let convRev = -1;
  /* The list of the user's messages and the subagent filter, as the user last left them in this page. */
  const kept = api.getState() || {};
  let outlineOpen = kept.outline === true;
  let hideSubs = kept.hideSubagents === true;
  let sideFrame = 0;

  const DECISION_WORDS = {
    allowOnce: 'Allowed once',
    allowSession: 'Allowed in this project',
    deny: 'Denied',
    cancelled: 'The turn ended before an answer',
    answered: 'Answered',
    dismissed: 'Dismissed',
  };
  const TOOL_STATE_WORDS = { running: 'Running…', done: '', error: 'Error', aborted: 'Stopped' };
  const CHILD_STATE_WORDS = { running: 'Running…', done: 'Done', stopped: 'Stopped', failed: 'Failed' };
  const KEYS = { allowOnce: '1', allowSession: '2', deny: '3' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name) {
    const i = el('i', `codicon codicon-${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function stamp(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }
  function clock(ms) {
    const d = new Date(ms);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }
  function seconds(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m${p2(s % 60)}s` : `${Math.floor(m / 60)}h${p2(m % 60)}m`;
  }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayOf(ms) {
    const d = new Date(ms);
    return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  const hostNow = () => Date.now() + skew;

  /* ---------- markdown ---------- */

  function renderMarkdown(target, text) {
    if (!md) {
      target.textContent = text;
      target.classList.add('plain');
      return;
    }
    target.innerHTML = md.render(C.driveSlashes(text));
    placeImages(target);
    linkConversations(target);
    for (const pre of target.querySelectorAll('pre')) {
      const wrap = el('div', 'code');
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      const btn = el('button', 'copy');
      btn.type = 'button';
      btn.title = 'Copy code';
      btn.setAttribute('aria-label', 'Copy code');
      btn.appendChild(icon('copy'));
      wrap.appendChild(btn);
    }
  }

  function scheduleRender(entry) {
    toRender.add(entry);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const e of toRender) {
        renderMarkdown(e.body, e.text);
        e.rendered = e.text;
      }
      toRender.clear();
      if (stick) scrollEnd();
    });
  }

  /* ---------- items ---------- */

  function metaRow(cls) {
    const meta = el('div', `meta${cls ? ` ${cls}` : ''}`);
    const time = el('span', 'time');
    meta.appendChild(time);
    return { meta, time };
  }

  /* When each turn's message was sent, for the time a row of its reply took to come. */
  const turnSent = new Map();
  function stampIn(target, item) {
    target.textContent = stamp(item.at);
    const sent = item.turn != null ? turnSent.get(item.turn) : 0;
    let after = target.nextElementSibling && target.nextElementSibling.classList.contains('elapsed') ? target.nextElementSibling : null;
    if (sent && item.at >= sent) {
      if (!after) { after = el('span', 'elapsed'); target.after(after); }
      after.textContent = seconds(item.at - sent);
    } else if (after) after.remove();
  }

  /* The tag on a request or tool that came from a subagent. */
  function fromSubagent(target, sub) {
    target.hidden = !sub;
    target.textContent = sub ? `from subagent ${sub.title || sub.childId}` : '';
    target.title = sub ? `Subagent session ${sub.childId}` : '';
  }

  /* A subagent's progress: its title and state, the last thing it did, and its steps on demand. */
  function childBox() {
    const c = { box: el('div', 'child') };
    const top = el('div', 'child-head');
    c.title = el('span', 'child-title');
    c.state = el('span', 'child-state');
    top.append(el('span', 'child-label', 'Subagent'), c.title, c.state);
    c.last = el('div', 'child-last');
    c.details = el('details', 'child-steps');
    c.sum = el('summary');
    c.list = el('div', 'child-list');
    c.details.append(c.sum, c.list);
    c.details.addEventListener('toggle', () => { if (c.details.open) childList(c); });
    c.box.append(top, c.last, c.details);
    return c;
  }
  function childList(c) {
    const child = c.child;
    if (!child) return;
    const rows = [];
    if (child.dropped) rows.push(el('div', 'child-more', `${child.dropped} earlier step${child.dropped === 1 ? '' : 's'} not shown`));
    for (const e of child.entries || []) {
      if (e.kind === 'tool') {
        const d = el('details', `child-tool state-${e.state}`);
        const s = el('summary');
        s.append(el('span', 'tool-name', e.name), el('span', 'tool-summary', e.summary || ''), el('span', 'tool-state', TOOL_STATE_WORDS[e.state] || ''));
        d.append(s);
        if (e.result) d.append(el('pre', null, e.result));
        rows.push(d);
      } else {
        rows.push(el('div', e.kind === 'reasoning' ? 'child-reasoning' : 'child-text', e.text));
      }
    }
    c.list.replaceChildren(...rows);
  }
  function fillChild(c, child) {
    c.child = child;
    c.box.className = `child state-${child.status}`;
    c.title.textContent = child.title || 'Subagent';
    c.state.textContent = `${CHILD_STATE_WORDS[child.status] || ''}${child.error ? `: ${child.error}` : ''}`;
    c.last.textContent = child.last || '';
    c.last.hidden = !child.last;
    const n = (child.entries || []).length + (child.dropped || 0);
    c.sum.textContent = `Its steps (${n})`;
    c.details.hidden = !n;
    if (c.details.open) childList(c);
  }

  /* The submitted values as one line for the settled card, such as "Color: Red; Notes: fine". */
  function answerText(item, values) {
    const parts = [];
    for (const f of (item && item.fields) || []) {
      const v = values[f.key];
      const label = (x) => ((f.options || []).find((o) => o.value === x) || { label: x }).label;
      let shown = Array.isArray(v) ? v.map(label) : f.type === 'boolean' ? [v ? 'Yes' : 'No'] : v ? [f.options ? label(v) : String(v)] : [];
      const other = f.otherKey && typeof values[f.otherKey] === 'string' ? values[f.otherKey].trim() : '';
      if (other) shown = f.type === 'multi' ? [...shown, other] : [other];
      if (shown.length) parts.push(`${f.title}: ${shown.join(', ')}`);
    }
    return parts.join('; ');
  }

  /* Builds a question's form, one fieldset per field; `values()` reads the answers back. */
  function questionForm(entry, item) {
    const inputs = [];
    const name = (k) => `${item.requestId}:${k}`;
    for (const f of item.fields || []) {
      const box = el('fieldset', 'q-field');
      box.append(el('legend', null, `${f.title}${f.required ? ' *' : ''}`));
      if (!inputs.length && item.message && item.message !== 'Questions') box.append(el('div', 'q-ask', item.message));
      if (f.description && f.description !== f.title && f.description !== item.message) box.append(el('div', 'q-desc', f.description));
      if (f.type === 'choice' || f.type === 'multi') {
        const defaults = Array.isArray(f.default) ? f.default.map(String) : f.default != null ? [String(f.default)] : [];
        for (const o of f.options) {
          const label = el('label', 'q-option');
          const i = el('input');
          i.type = f.type === 'choice' ? 'radio' : 'checkbox';
          i.name = name(f.key);
          i.value = o.value;
          i.checked = defaults.includes(o.value);
          label.append(i, el('span', null, o.label));
          if (o.description && o.description !== o.label) label.append(el('span', 'q-hint', o.description));
          box.append(label);
          inputs.push(i);
        }
        if (f.otherKey) {
          const other = el('input', 'q-other');
          other.type = 'text';
          other.name = name(f.otherKey);
          other.placeholder = f.otherLabel || 'Your own answer';
          box.append(other);
          inputs.push(other);
        }
      } else if (f.type === 'boolean') {
        const label = el('label', 'q-option');
        const i = el('input');
        i.type = 'checkbox';
        i.name = name(f.key);
        i.checked = f.default === true;
        label.append(i, el('span', null, 'Yes'));
        box.append(label);
        inputs.push(i);
      } else {
        const i = el('input', 'q-text');
        i.type = f.type === 'number' || f.type === 'integer' ? 'number' : 'text';
        if (f.type === 'integer') i.step = '1';
        if (f.type === 'number') i.step = 'any';
        if (typeof f.minimum === 'number') i.min = String(f.minimum);
        if (typeof f.maximum === 'number') i.max = String(f.maximum);
        if (f.maxLength) i.maxLength = f.maxLength;
        if (f.default != null) i.value = String(f.default);
        i.name = name(f.key);
        box.append(i);
        inputs.push(i);
      }
      entry.form.appendChild(box);
    }
    entry.inputs = inputs;
    entry.values = () => {
      const out = {};
      for (const f of item.fields || []) {
        const own = inputs.filter((i) => i.name === name(f.key));
        if (f.type === 'choice') out[f.key] = (own.find((i) => i.checked) || {}).value || '';
        else if (f.type === 'multi') out[f.key] = own.filter((i) => i.checked).map((i) => i.value);
        else if (f.type === 'boolean') out[f.key] = !!(own[0] && own[0].checked);
        else out[f.key] = own[0] ? own[0].value : '';
        if (f.otherKey) {
          const o = inputs.find((i) => i.name === name(f.otherKey));
          out[f.otherKey] = o ? o.value : '';
        }
      }
      return out;
    };
  }

  /* What a call went in with: a command as it reads, anything else as the JSON it came in. */
  function inputShown(text) {
    const raw = String(text || '');
    try {
      const v = JSON.parse(raw);
      if (v && typeof v.command === 'string') return v.command;
    } catch (_) { /* clipped or not JSON */ }
    return raw;
  }

  function toolRow(cls, label) {
    const row = el('div', `tool-row ${cls}`);
    const pre = el('pre');
    row.append(el('div', 'tool-row-label', label), pre);
    return { row, pre };
  }

  function create(item) {
    const entry = { item: null, text: null, rendered: null };
    switch (item.kind) {
      case 'user': {
        entry.el = el('div', 'msg user');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.rewindBtn = el('button', 'rewind');
        entry.rewindBtn.type = 'button';
        entry.rewindBtn.append(icon('discard'), el('span', null, 'Rewind to here'));
        entry.rewindBtn.title = 'Experimental: in Git repositories, clicking immediately restores files changed after this '
          + 'message; Cancel undoes the restore.';
        entry.rewindBtn.hidden = true;
        const box = el('div', 'user-box');
        entry.body = el('div', 'bubble');
        entry.att = el('div', 'user-att');
        box.append(meta, entry.body, entry.att);
        entry.el.append(box, entry.rewindBtn);
        break;
      }
      case 'text': {
        entry.el = el('div', 'msg reply tl');
        const { meta, time } = metaRow();
        entry.meta = meta;
        entry.time = time;
        entry.body = el('div', 'md');
        entry.el.append(meta, entry.body);
        break;
      }
      case 'reasoning': {
        entry.el = el('details', 'reasoning tl');
        const summary = el('summary');
        entry.time = el('span', 'time');
        summary.append(entry.time, el('span', 'label', 'Thinking'));
        entry.body = el('div', 'md');
        entry.el.append(summary, entry.body);
        break;
      }
      case 'tool': {
        entry.el = el('div', 'tool tl');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.head = el('div', 'tool-head');
        entry.head.setAttribute('role', 'button');
        entry.head.tabIndex = 0;
        entry.name = el('span', 'tool-name');
        entry.summary = el('span', 'tool-summary');
        entry.from = el('span', 'from-sub');
        entry.state = el('span', 'tool-state');
        entry.head.append(entry.name, entry.summary, entry.from, entry.state, el('span', 'chev'));
        entry.bodyBox = el('div', 'tool-body');
        const inRow = toolRow('tool-in', 'IN');
        const outRow = toolRow('tool-out', 'OUT');
        entry.inBox = inRow.row;
        entry.inPre = inRow.pre;
        entry.outBox = outRow.row;
        entry.outPre = outRow.pre;
        entry.bodyBox.append(entry.inBox, entry.outBox);
        entry.el.append(meta, entry.head, entry.bodyBox);
        break;
      }
      case 'permission': {
        entry.el = el('div', 'permission');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.heading = el('div', 'perm-title');
        entry.detail = el('pre', 'perm-detail');
        entry.path = el('div', 'perm-path');
        entry.actions = el('div', 'perm-actions');
        const button = (decision, label, cls) => {
          const b = el('button', cls, label);
          b.type = 'button';
          b.dataset.decision = decision;
          b.dataset.key = KEYS[decision];
          return b;
        };
        entry.decide = [
          button('allowOnce', 'Allow once', 'primary'),
          button('allowSession', 'Allow in this project', ''),
          button('deny', 'Deny', ''),
        ];
        entry.diffBtn = el('button', 'diff', 'View diff');
        entry.diffBtn.type = 'button';
        entry.actions.append(...entry.decide, entry.diffBtn);
        entry.hint = el('div', 'prompt-hint', 'Press 1, 2 or 3 to answer · Esc stops the turn');
        entry.result = el('div', 'perm-result');
        entry.el.append(meta, entry.heading, entry.detail, entry.path, entry.actions, entry.hint, entry.result);
        break;
      }
      case 'question': {
        entry.el = el('div', 'question');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.heading = el('div', 'perm-title');
        entry.form = el('form', 'q-form');
        entry.form.addEventListener('submit', (e) => e.preventDefault());
        entry.errors = el('div', 'q-errors');
        entry.actions = el('div', 'perm-actions');
        entry.submit = el('button', 'primary q-submit', 'Submit');
        entry.submit.type = 'button';
        entry.cancel = el('button', 'q-cancel', 'Cancel');
        entry.cancel.type = 'button';
        entry.cancel.title = 'Stops the turn without answering';
        entry.actions.append(entry.submit, entry.cancel);
        entry.hint = el('div', 'prompt-hint', 'Esc stops the turn');
        entry.result = el('div', 'perm-result');
        entry.el.append(meta, entry.heading, entry.form, entry.errors, entry.actions, entry.hint, entry.result);
        break;
      }
      case 'compaction': {
        entry.el = el('div', 'compaction');
        entry.label = el('span', 'compaction-label');
        const line = el('div', 'compaction-line');
        line.append(entry.label);
        entry.details = el('details', 'compaction-summary');
        entry.body = el('div', 'md');
        entry.details.append(el('summary', null, 'Summary'), entry.body);
        entry.el.append(line, entry.details);
        break;
      }
      case 'subagent':
        entry.el = el('div', 'tool subagent tl');
        entry.childC = childBox();
        entry.el.appendChild(entry.childC.box);
        break;
      case 'figures':
        entry.el = el('span', 'figures');
        break;
      default:
        entry.el = el('div', 'notice');
        break;
    }
    entry.el.dataset.id = item.id;
    return entry;
  }

  /* The reply's last row of text in the same turn, which carries the turn's figures after its time; null when the turn
     ended with something else. */
  function figuresHost(item) {
    let last = null;
    for (const e of nodes.values()) {
      if (!e.item || e.item.kind === 'figures' || e.item.turn !== item.turn || e.item.kind === 'user') continue;
      last = e;
    }
    return last && last.item.kind === 'text' && last.meta ? last : null;
  }
  function placeFigures(entry, item) {
    const host = figuresHost(item);
    if (host) {
      host.meta.classList.add('with-figures');
      if (entry.el.parentElement !== host.meta) host.meta.appendChild(entry.el);
      if (entry.row) { entry.row.remove(); entry.row = null; }
      return;
    }
    if (!entry.row) {
      entry.row = el('div', 'figures-row');
      entry.row.dataset.id = `${item.id}-row`;
    }
    if (entry.el.parentElement !== entry.row) entry.row.appendChild(entry.el);
    if (!entry.row.parentElement) log.appendChild(entry.row);
  }

  function setOpen(entry, open) {
    entry.open = open;
    entry.el.classList.toggle('open', open);
    entry.head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function fill(entry, item) {
    const prev = entry.item;
    entry.item = item;
    switch (item.kind) {
      case 'user':
        entry.time.textContent = stamp(item.at);
        if (item.turn != null && item.at) turnSent.set(item.turn, item.at);
        showRewind(entry);
        entry.body.textContent = item.text;
        entry.att.replaceChildren(...(item.attachments || []).map((a) => el('span', `att att-${a.kind}`, a.kind === 'image' ? 'Image' : a.kind === 'selection' ? `Selection ${a.name}` : a.name)));
        entry.att.hidden = !(item.attachments && item.attachments.length);
        break;
      case 'text':
      case 'reasoning':
        stampIn(entry.time, item);
        if (item.text !== entry.text) {
          entry.text = item.text;
          scheduleRender(entry);
        }
        break;
      case 'tool': {
        entry.el.className = `tool tl state-${item.state}${entry.open ? ' open' : ''}`;
        stampIn(entry.time, item);
        if (item.doneAt) entry.time.textContent = `${stamp(item.at)}→${clock(item.doneAt)}`;
        entry.name.textContent = item.name;
        entry.summary.textContent = item.summary || '';
        entry.summary.title = item.summary || '';
        fromSubagent(entry.from, item.subagent);
        const result = item.result || '';
        const lines = result ? result.split('\n').length : 0;
        const label = item.display && typeof item.display.summary === 'string' ? item.display.summary : '';
        entry.state.textContent = TOOL_STATE_WORDS[item.state] || (result ? label || `${lines} line${lines === 1 ? '' : 's'}` : '');
        entry.inPre.textContent = inputShown(item.input);
        entry.inBox.hidden = !item.input || item.input === '{}';
        entry.outBox.hidden = !result;
        entry.outPre.textContent = result;
        entry.head.title = entry.open ? 'Hide the input and result' : 'Show the input and result';
        if (item.state === 'error' && (!prev || prev.state !== 'error')) setOpen(entry, true);
        else entry.head.setAttribute('aria-expanded', entry.open ? 'true' : 'false');
        if (item.child) {
          if (!entry.childC) { entry.childC = childBox(); entry.el.appendChild(entry.childC.box); }
          entry.childC.box.hidden = false;
          fillChild(entry.childC, item.child);
        } else if (entry.childC) {
          entry.childC.box.hidden = true;
        }
        break;
      }
      case 'subagent':
        entry.el.className = `tool subagent tl state-${item.status === 'running' ? 'running' : item.status === 'done' ? 'done' : 'error'}`;
        fillChild(entry.childC, item);
        break;
      case 'permission': {
        const req = item.request || {};
        const decided = !!item.decision;
        entry.time.textContent = stamp(item.at);
        const from = el('span', 'from-sub');
        fromSubagent(from, item.subagent);
        entry.heading.replaceChildren(el('span', 'perm-label', decided ? 'Permission' : 'Allow'), el('span', 'tool-name', decided ? req.tool || '' : `${req.tool || 'this'}?`),
          el('span', 'perm-summary', req.summary || ''), from);
        const detail = req.command || req.detail || '';
        entry.detail.textContent = detail;
        entry.detail.hidden = !detail || detail === req.summary;
        entry.path.textContent = req.path || '';
        entry.path.hidden = !req.path || (req.summary || '').includes(req.path);
        for (const b of entry.decide) {
          b.hidden = decided;
          if (!decided && !entry.sent) b.disabled = false;
        }
        entry.diffBtn.hidden = !req.hasDiff;
        entry.diffBtn.dataset.request = item.requestId;
        for (const b of entry.decide) b.dataset.request = item.requestId;
        entry.result.textContent = decided ? DECISION_WORDS[item.decision] || item.decision : '';
        entry.result.className = `perm-result decision-${item.decision || 'none'}`;
        entry.el.className = `permission${decided ? ` settled tl decision-${item.decision}` : ''}`;
        break;
      }
      case 'question': {
        entry.time.textContent = stamp(item.at);
        if (!entry.inputs) {
          const from = el('span', 'from-sub');
          fromSubagent(from, item.subagent);
          entry.heading.replaceChildren(el('span', 'perm-label', 'Question'), el('span', 'perm-summary', item.message && item.message !== 'Questions' ? item.message : 'OpenCode asks'), from);
          questionForm(entry, item);
          entry.submit.dataset.request = item.requestId;
          entry.cancel.dataset.request = item.requestId;
        }
        /* Inert rather than disabled: a disabled radio is drawn grey, checked or not. */
        const decided = !!item.decision;
        entry.form.inert = decided;
        entry.actions.hidden = decided;
        if (decided) entry.errors.textContent = '';
        const words = decided ? DECISION_WORDS[item.decision] || item.decision : '';
        entry.result.textContent = item.decision === 'answered' && entry.answerText ? `${words}: ${entry.answerText}` : words;
        entry.result.className = `perm-result decision-${item.decision || 'none'}`;
        entry.el.className = `question${decided ? ` settled tl decision-${item.decision}` : ''}`;
        break;
      }
      case 'compaction': {
        entry.el.className = `compaction status-${item.status}`;
        entry.label.textContent = item.status === 'running' ? 'Compacting the conversation…'
          : item.status === 'completed' ? 'Conversation compacted'
            : item.status === 'failed' ? `Compacting failed${item.error ? `: ${item.error}` : ''}` : 'Compacting was cancelled';
        entry.details.hidden = !item.summary;
        if (item.summary && item.summary !== entry.text) {
          entry.text = item.summary;
          scheduleRender(entry);
        }
        break;
      }
      case 'figures': {
        entry.el.textContent = item.text || '';
        const parts = [];
        if (item.turnCostUsd != null) parts.push(`This turn: $${item.turnCostUsd.toFixed(item.turnCostUsd < 0.01 ? 3 : 2)}`);
        if (item.costUsd != null) parts.push(`Conversation so far: $${item.costUsd.toFixed(item.costUsd < 0.01 ? 3 : 2)}`);
        if (item.contextUsed) parts.push(`Context: ${item.contextUsed.toLocaleString('en-US')} tokens` +
          (item.contextWindow ? ` of ${item.contextWindow.toLocaleString('en-US')}` : ''));
        if (item.modelId) parts.push(`Model: ${item.modelId}`);
        if (item.effort) parts.push(`Effort: ${item.effort}`);
        entry.el.title = parts.join('\n');
        placeFigures(entry, item);
        break;
      }
      default:
        entry.el.className = `notice level-${item.level || 'info'}`;
        entry.el.textContent = item.text || '';
        break;
    }
    if (item.hidden === true) entry.el.hidden = true;
    const share = C.subagentShare(item);
    entry.share = share;
    entry.el.classList.toggle('sub-hide', share === 'hide');
    entry.el.classList.toggle('sub-fold', share === 'fold');
    scheduleSide();
  }

  /* Shows Rewind on a user message only while the conversation is idle. */
  function showRewind(entry) {
    if (entry.rewindBtn) entry.rewindBtn.hidden = !(caps.rewind && head && head.status === 'idle');
  }

  /* ---------- images in replies ---------- */

  const IMG_DATA = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;
  const IMG_WEB = /^https?:\/\//i;
  /* src -> { state: 'loading' | 'ok' | 'error', url?, reason? }, the newest kept. */
  const imageCache = new Map();
  const imageWaiting = new Map();
  let imageSeq = 0;
  function drawImage(img, src) {
    const got = imageCache.get(src);
    img.classList.toggle('loading', !got || got.state === 'loading');
    if (got && got.state === 'ok') { img.src = got.url; img.title = src; }
    if (got && got.state === 'error') {
      const box = el('span', 'image-missing', `${img.alt ? `${img.alt}: ` : ''}${got.reason} (${src})`);
      img.replaceWith(box);
    }
  }
  function placeImages(target) {
    for (const img of [...target.querySelectorAll('img')]) {
      const raw = img.getAttribute('src') || '';
      let src = raw;
      try { src = decodeURI(raw); } catch (_) { /* as written */ }
      /* Decoded first: markdown-it writes a Windows path's backslashes as %5C. */
      const kind = C.imageKind(src, caps.replyImages);
      if (kind === 'data') continue;
      if (kind === 'link') {
        const a = el('a', 'image-link', img.alt || raw);
        a.setAttribute('href', raw);
        a.title = IMG_WEB.test(raw) ? 'Web images are not loaded here. Click to open in the browser.' : raw;
        img.replaceWith(a);
        continue;
      }
      img.removeAttribute('src');
      img.classList.add('reply-image');
      img.dataset.src = src;
      if (!imageCache.has(src)) {
        const id = `img${++imageSeq}`;
        imageCache.set(src, { state: 'loading' });
        while (imageCache.size > 80) imageCache.delete(imageCache.keys().next().value);
        imageWaiting.set(id, src);
        api.postMessage({ type: 'image', id, src });
      }
      drawImage(img, src);
    }
  }

  function upsert(item) {
    let entry = nodes.get(item.id);
    if (!entry) {
      entry = create(item);
      nodes.set(item.id, entry);
      if (item.kind !== 'figures') log.appendChild(entry.el);
    }
    fill(entry, item);
  }

  /* ---------- links to other conversations ---------- */

  function convLink(r, text) {
    const a = el('a', 'conv-link', text);
    a.setAttribute('href', '#');
    a.dataset.source = r.sourceId;
    a.dataset.session = r.sessionId;
    let tip = '';
    try { tip = KIT && typeof KIT.mentionTip === 'function' ? KIT.mentionTip(r, hostNow()) : ''; } catch (_) { tip = ''; }
    a.title = tip || r.title || r.sessionId;
    if (KIT && KIT.MENTION_ATTR) a.setAttribute(KIT.MENTION_ATTR, `${r.sourceId}:${r.sessionId}`);
    return a;
  }
  function linkConversations(target) {
    if (!convIx) return;
    if (KIT && typeof KIT.linkMentions === 'function') {
      try { KIT.linkMentions(target, convIx, (r, text) => convLink(r, text)); } catch (_) { /* the reply as written */ }
    }
  }
  function applyConversations(m) {
    const rev = Number(m.rev) || 0;
    const list = Array.isArray(m.list) ? m.list : [];
    const self = m.self && typeof m.self === 'object' ? m.self : {};
    const key = `${rev}\n${self.sessionId || ''}`;
    if (key === convRev) return;
    convRev = key;
    convIx = KIT && typeof KIT.mentionIndex === 'function' && list.length ? KIT.mentionIndex(list, { sourceId: self.sourceId, sessionId: self.sessionId, title: head ? head.title : '' }) : null;
    if (convIx && !convIx.size) convIx = null;
    for (const e of nodes.values()) if (e.item && (e.item.kind === 'text' || e.item.kind === 'reasoning') && e.text) scheduleRender(e);
  }

  /* ---------- the rail, the list of your messages and the subagent filter ---------- */

  function keep(patch) { api.setState({ ...(api.getState() || {}), ...patch }); }
  function scheduleSide() {
    if (sideFrame) return;
    sideFrame = requestAnimationFrame(() => { sideFrame = 0; renderSide(); });
  }
  /* The date line goes on the first message of each day. */
  function markDays(entries) {
    let last = '';
    for (const e of entries) {
      if (!e.item || e.item.kind !== 'user' || !e.item.at) continue;
      const day = dayOf(e.item.at);
      if (day !== last) e.el.dataset.day = day;
      else delete e.el.dataset.day;
      last = day;
    }
  }
  function renderSide() {
    const entries = [...nodes.values()];
    markDays(entries);
    const rows = C.outlineRows(entries.map((e) => e.item).filter(Boolean));
    const users = rows.filter((r) => r.kind === 'user').length;
    rail.hidden = !users;
    navBtn.hidden = !rows.length;
    navBtn.setAttribute('aria-pressed', outlineOpen ? 'true' : 'false');
    navBtn.title = outlineOpen ? 'Hide the list of your messages' : 'Show a list of your messages';
    outlineEl.hidden = !(outlineOpen && rows.length);
    const q = outlineFilter.value.trim().toLowerCase();
    const shown = q ? rows.filter((r) => {
      const full = r.kind === 'user' ? (nodes.get(r.id) && nodes.get(r.id).item.text) || r.label : r.label;
      return String(full).toLowerCase().includes(q);
    }) : rows;
    outlineList.replaceChildren(...shown.map((r) => {
      const row = el('button', `outline-row outline-${r.kind}`);
      row.type = 'button';
      row.dataset.item = r.id;
      if (r.kind === 'user') row.append(el('span', 'outline-n', r.at ? stamp(r.at) : `${r.n}`), el('span', 'outline-text', r.label));
      else row.append(el('span', 'outline-text', r.label));
      row.title = `${r.at ? `${stamp(r.at)}  ` : ''}${r.kind === 'user' ? (nodes.get(r.id) && nodes.get(r.id).item.text) || r.label : r.label}`;
      return row;
    }));
    if (!shown.length && rows.length) outlineList.appendChild(el('div', 'outline-none', 'No message matches'));
    const subs = entries.filter((e) => e.share).length;
    subBtn.hidden = !subs;
    subBtn.textContent = hideSubs ? `Subagents hidden (${subs})` : 'Subagents';
    subBtn.setAttribute('aria-pressed', hideSubs ? 'true' : 'false');
    subBtn.title = hideSubs ? 'Show what the subagents did' : 'Hide what the subagents did';
    document.body.classList.toggle('hide-subagents', hideSubs);
  }
  /* Scrolls the log, and only the log, so that `el` is at its top (8px below it) or, with `center`, in its middle:
     scrollIntoView would also scroll the page by the few pixels it is taller than its frame. */
  function scrollLogTo(el, center) {
    const l = log.getBoundingClientRect(), r = el.getBoundingClientRect();
    log.scrollTop += center ? (r.top + r.height / 2) - (l.top + l.height / 2) : r.top - l.top - 8;
  }
  function jumpTo(entry) {
    if (!entry) return;
    scrollLogTo(entry.el, false);
    entry.el.classList.add('flash');
    setTimeout(() => entry.el.classList.remove('flash'), 1200);
  }
  /* The user's message before (`dir` -1) or after (1) the one at the top of the log; before the first is the first,
     after the last is the end. */
  function stepTo(dir) {
    const top = log.getBoundingClientRect().top;
    const users = [...nodes.values()].filter((e) => e.item && e.item.kind === 'user' && !e.el.hidden);
    const off = (e) => e.el.getBoundingClientRect().top - top - 8;
    const target = dir < 0 ? users.filter((e) => off(e) < -4).pop() || users[0] : users.find((e) => off(e) > 4);
    if (target) jumpTo(target);
    else scrollEnd();
  }
  navBtn.addEventListener('click', () => { outlineOpen = !outlineOpen; keep({ outline: outlineOpen }); renderSide(); if (outlineOpen) outlineFilter.focus(); });
  $('railTop').addEventListener('click', () => { log.scrollTop = 0; });
  $('railBottom').addEventListener('click', () => { scrollEnd(); stick = true; });
  $('railPrev').addEventListener('click', () => stepTo(-1));
  $('railNext').addEventListener('click', () => stepTo(1));
  outlineFilter.addEventListener('input', () => renderSide());
  subBtn.addEventListener('click', () => { hideSubs = !hideSubs; keep({ hideSubagents: hideSubs }); renderSide(); });
  outlineList.addEventListener('click', (e) => {
    const row = e.target.closest('.outline-row');
    if (row) jumpTo(nodes.get(row.dataset.item));
  });

  /* ---------- head ---------- */

  function paintSend() {
    const busy = !!head && head.status !== 'idle';
    const typed = !!input.value.trim();
    stopBtn.hidden = !busy;
    sendBtn.hidden = busy && !typed;
    sendBtn.classList.toggle('empty', !typed);
  }

  function applyHead(h) {
    head = h;
    titleEl.textContent = h.title || 'New conversation';
    titleEl.title = h.title || '';
    document.body.dataset.status = h.status;
    paintSend();
    placeholder();

    const pct = typeof h.contextPct === 'number' ? Math.max(0, Math.min(100, h.contextPct)) : null;
    ringFill.setAttribute('stroke-dasharray', `${pct == null ? 0 : (pct / 100) * RING} ${RING}`);
    ring.classList.toggle('high', pct != null && pct >= 85);
    /* An outline once 15% of the window or less is left, as Claude Code Plus draws its meter. */
    ring.classList.toggle('low', C.ringLow(pct));
    ring.classList.toggle('empty', pct == null);
    ringLabel.textContent = pct == null ? '' : `${pct}%`;
    const costLine = h.costText ? `\nCost so far: ${h.costText}` : '';
    ring.title = pct != null
      ? `${pct}% of the context window used (${h.contextText})${costLine}`
      : `${h.contextText || 'Context usage shows after the first reply'}${costLine}`;

    if (h.model && modelSel.dataset.current !== h.model.id) {
      modelSel.dataset.current = h.model.id;
      if ([...modelSel.options].some((o) => o.value === h.model.id)) modelSel.value = h.model.id;
    }

    queuedEl.replaceChildren(...(h.queued || []).map((q) => {
      const row = el('div', 'chip');
      const text = el('span', 'chip-text', q.text);
      text.title = q.text;
      row.append(el('span', 'chip-label', 'Queued'), text);
      return row;
    }));

    for (const entry of nodes.values()) showRewind(entry);
    renderBackground(h.background);
    chimeFor(h);
    renderStatus();
    if (h.status !== 'idle' && !ticker) ticker = setInterval(renderStatus, 1000);
    if (h.status === 'idle' && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /* ---------- chimes ---------- */

  function chimeFor(h) {
    const now = { status: h.status, pending: h.pending || 0, waitingFor: h.waitingFor };
    const was = heard;
    heard = now;
    const kind = C.chimeKind(was, now);
    if (!kind || !sound.on || !KIT || typeof KIT.chime !== 'function') return;
    try { KIT.chime(kind); } catch (_) { /* no audio here */ }
  }
  if (KIT && typeof KIT.unlockAudio === 'function') {
    document.addEventListener('pointerdown', KIT.unlockAudio, true);
    document.addEventListener('keydown', KIT.unlockAudio, true);
  }
  function paintSound() {
    soundBtn.hidden = !sound.shown;
    soundBtn.textContent = '♪';
    soundBtn.classList.toggle('muted', !sound.on);
    soundBtn.title = sound.on ? 'Chimes when a turn ends or OpenCode waits for you. Click to mute.'
      : 'Chimes are muted. Click to turn them on.';
    soundBtn.setAttribute('aria-pressed', sound.on ? 'true' : 'false');
  }
  soundBtn.addEventListener('click', () => {
    sound = { ...sound, on: !sound.on };
    paintSound();
    api.postMessage({ type: 'setSound', on: sound.on });
    if (sound.on && KIT && typeof KIT.chime === 'function') { try { KIT.chime('done'); } catch (_) { /* no audio */ } }
  });

  /* ---------- background work ---------- */

  const KIND_WORDS = { subagent: 'Subagent', shell: 'Command' };
  function renderBackground(list) {
    const items = Array.isArray(list) ? list : [];
    bgEl.hidden = !items.length;
    if (!items.length) { bgList.replaceChildren(); bgEl.open = false; return; }
    bgSum.textContent = C.backgroundSummary(items);
    bgSum.title = 'Show what runs in the background';
    bgList.replaceChildren(...items.map((b) => {
      const row = el('div', `bg-row bg-${b.kind}`);
      row.dataset.item = b.itemId || '';
      row.title = b.itemId ? 'Show it in the conversation' : '';
      row.append(el('span', 'bg-kind', KIND_WORDS[b.kind] || b.kind), el('span', 'bg-title', b.title),
        el('span', 'bg-detail', [b.detail, b.since ? `since ${stamp(b.since)}` : ''].filter(Boolean).join(' · ')));
      return row;
    }));
  }
  bgEl.addEventListener('toggle', () => { if (bgEl.open) api.postMessage({ type: 'background' }); });
  bgList.addEventListener('click', (e) => {
    const row = e.target.closest('.bg-row');
    const entry = row && row.dataset.item ? nodes.get(row.dataset.item) : null;
    if (!entry) return;
    if (hideSubs && entry.share) { hideSubs = false; keep({ hideSubagents: false }); renderSide(); }
    bgEl.open = false;
    scrollLogTo(entry.el, true);
    if (entry.childC && entry.childC.details) entry.childC.details.open = true;
    entry.el.classList.add('flash');
    setTimeout(() => entry.el.classList.remove('flash'), 1200);
  });

  /* ---------- the info box ---------- */

  function closeInfo() { infoBox.hidden = true; infoBox.replaceChildren(); }
  function showInfo(m) {
    const rows = Array.isArray(m.rows) ? m.rows : [];
    const box = [el('div', 'info-title', 'About this conversation')];
    if (m.error) box.push(el('div', 'info-error', m.error));
    for (const r of rows) {
      const row = el('button', 'info-row');
      row.type = 'button';
      row.title = 'Click to copy';
      row.dataset.copy = r.value;
      row.append(el('span', 'info-label', r.label), el('span', 'info-value', r.value || '-'));
      box.push(row);
    }
    const all = el('button', 'secondary info-all', 'Copy all');
    all.type = 'button';
    all.dataset.copy = rows.map((r) => `${r.label}: ${r.value}`).join('\n');
    box.push(all);
    infoBox.replaceChildren(...box);
    infoBox.hidden = false;
  }
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!infoBox.hidden) { closeInfo(); return; }
    api.postMessage({ type: 'info' });
  });
  infoBox.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    api.postMessage({ type: 'copy', text: b.dataset.copy });
    const was = b.classList.contains('info-all') ? b.textContent : null;
    b.classList.add('copied');
    if (was) b.textContent = 'Copied';
    setTimeout(() => { b.classList.remove('copied'); if (was) b.textContent = was; }, 1200);
  });
  document.addEventListener('click', (e) => {
    if (!infoBox.hidden) closeInfo();
    if (bgEl.open && !bgEl.contains(e.target)) bgEl.open = false;
  });

  /* The open permission request the number keys answer: the oldest one still waiting, if any. */
  function openPermission() {
    for (const e of nodes.values()) {
      if (e.item && e.item.kind === 'permission' && !e.item.decision && !e.sent && !e.el.hidden) return e;
    }
    return null;
  }
  function answer(entry, decision) {
    entry.sent = true;
    for (const b of entry.decide) b.disabled = true;
    api.postMessage({ type: 'permission', requestId: entry.item.requestId, decision });
  }

  /* Esc closes the open box or list, and otherwise stops the turn; 1, 2 and 3 answer a permission request. */
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Escape') {
      const act = C.escapeAction({ box: !infoBox.hidden || bgEl.open, menu: !!menu, status: head ? head.status : 'idle' });
      if (act === 'closeBox') { e.preventDefault(); closeInfo(); bgEl.open = false; }
      else if (act === 'closeMenu') { e.preventDefault(); closeMenu(); }
      else if (act === 'abort') { e.preventDefault(); api.postMessage({ type: 'abort' }); }
      return;
    }
    if (/^[123]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {
      const entry = openPermission();
      const decision = Object.keys(KEYS).find((k) => KEYS[k] === e.key);
      if (entry && decision) { e.preventDefault(); answer(entry, decision); }
    }
  });

  function renderStatus() {
    if (!head || head.status === 'idle') {
      statusEl.hidden = true;
      return;
    }
    const r = head.retry;
    statusEl.hidden = head.status === 'waiting' && !r;
    if (r) {
      const left = Math.ceil((r.at + r.waitMs - hostNow()) / 1000);
      statusEl.className = 'retry';
      statusEl.textContent = `Retrying, attempt ${r.attempt}${left > 0 ? ` in ${left}s` : ''} · ${r.error}`;
    } else if (head.status === 'waiting') {
      statusEl.className = 'waiting';
      statusEl.textContent = head.waitingFor === 'question' ? 'Waiting for your answer' : 'Waiting for you to allow or deny a request';
    } else {
      statusEl.className = 'working';
      statusEl.textContent = head.turnStartedAt ? `Working · ${seconds(hostNow() - head.turnStartedAt)}` : 'Working';
    }
  }

  /* ---------- models ---------- */

  function option(value, label) {
    const o = el('option', null, label);
    o.value = value;
    return o;
  }

  function applyModels(m) {
    const current = (head && head.model && head.model.id) || m.current || '';
    const list = Array.isArray(m.models) ? m.models : [];
    modelSel.replaceChildren();
    if (m.error) modelSel.appendChild(option('', `Couldn't list models: ${m.error}`));
    const byVendor = new Map();
    for (const model of list) {
      const vendor = model.vendor || 'Other';
      if (!byVendor.has(vendor)) byVendor.set(vendor, []);
      byVendor.get(vendor).push(model);
    }
    for (const [vendor, models] of [...byVendor].sort((a, b) => a[0].localeCompare(b[0]))) {
      const group = el('optgroup');
      group.label = vendor;
      for (const model of models) group.appendChild(option(model.id, model.name || model.id));
      modelSel.appendChild(group);
    }
    if (current && !list.some((x) => x.id === current)) modelSel.insertBefore(option(current, current), modelSel.firstChild);
    if (!current && !m.error) modelSel.insertBefore(option('', 'Choose a model'), modelSel.firstChild);
    modelSel.appendChild(option('__reload', 'Reload the model list'));
    modelSel.value = current;
    modelSel.dataset.current = current;
    modelSel.title = current ? `Model: ${current}` : 'Model';
  }

  modelSel.addEventListener('change', () => {
    const value = modelSel.value;
    const current = modelSel.dataset.current || '';
    if (value === '__reload') {
      modelSel.replaceChildren(option(current, 'Loading models…'));
      modelSel.value = current;
      api.postMessage({ type: 'reloadModels' });
    } else if (value && value !== current) {
      api.postMessage({ type: 'setModel', id: value });
    }
  });

  /* ---------- mode and effort ---------- */

  function applyOptions(list) {
    const byId = new Map((Array.isArray(list) ? list : []).map((o) => [o.id, o]));
    for (const [id, sel] of Object.entries(optionSels)) {
      const o = byId.get(id);
      const values = o && Array.isArray(o.values) ? o.values : [];
      sel.hidden = !values.length;
      if (!values.length) { sel.replaceChildren(); continue; }
      sel.replaceChildren(...values.map((v) => {
        const opt = option(v.value, v.name || v.value);
        if (v.description) opt.title = v.description;
        return opt;
      }));
      sel.value = o.value;
      sel.dataset.current = o.value;
      const shown = values.find((v) => v.value === o.value);
      sel.title = `${o.name || id}: ${shown ? shown.name : o.value}`;
    }
  }

  for (const [id, sel] of Object.entries(optionSels)) {
    sel.addEventListener('change', () => {
      if (sel.value && sel.value !== sel.dataset.current) api.postMessage({ type: 'setOption', id, value: sel.value });
    });
  }

  /* ---------- attachments ---------- */

  /* A narrow box cuts off a long placeholder, so the full list of hints goes in the tooltip. */
  function placeholder() {
    const hints = [];
    if (commands.length) hints.push('/ for commands');
    if (caps.files) hints.push('@ for files');
    const busy = !!head && head.status !== 'idle';
    input.placeholder = busy ? BUSY_PLACEHOLDER : hints.length ? `Ask OpenCode. ${hints.join(', ')}` : BASE_PLACEHOLDER;
    const more = [];
    if (commands.length) more.push('/ for commands');
    if (caps.files) more.push('@ for workspace files');
    if (caps.images) more.push('paste or drop images');
    input.title = ['Enter to send, Shift+Enter for a new line', ...more].join('; ');
    attachBtn.hidden = !caps.images;
    slashBtn.hidden = !commands.length;
  }

  function showNote(text) {
    noteEl.textContent = text;
    noteEl.hidden = !text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => { noteEl.hidden = true; }, 8000);
  }

  function renderAttachments() {
    const chips = [];
    for (const img of images) {
      const chip = el('span', 'att-chip att-image');
      const thumb = el('img');
      thumb.src = img.url;
      thumb.alt = img.name;
      const x = el('button', 'att-remove', '×');
      x.type = 'button';
      x.title = 'Remove this image';
      x.dataset.remove = `img:${img.id}`;
      chip.append(thumb, el('span', 'att-name', img.name), x);
      chips.push(chip);
    }
    for (const sel of selections) {
      const chip = el('span', 'att-chip att-selection');
      const x = el('button', 'att-remove', '×');
      x.type = 'button';
      x.title = 'Remove this selection';
      x.dataset.remove = `sel:${sel.id}`;
      chip.title = sel.path;
      chip.append(el('span', 'chip-label', 'Selection'), el('span', 'att-name', sel.label), x);
      chips.push(chip);
    }
    attachEl.replaceChildren(...chips);
  }

  function addImageFile(file) {
    if (!caps.images) { showNote('This agent does not accept images.'); return; }
    if (images.length >= MAX_IMAGES) { showNote(`A message can have at most ${MAX_IMAGES} images.`); return; }
    if (file.size > MAX_IMAGE_BYTES) { showNote(`${file.name || 'The image'} is larger than 5 MB and was not added.`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = C.imageOfDataUrl(reader.result);
      if (!img) { showNote(`${file.name || 'That file'} could not be read as an image.`); return; }
      images.push({ id: ++attSeq, mediaType: img.mediaType, data: img.data, name: file.name || 'image', url: reader.result });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }

  attachEl.addEventListener('click', (e) => {
    const x = e.target.closest('button[data-remove]');
    if (!x) return;
    const [kind, id] = x.dataset.remove.split(':');
    const list = kind === 'img' ? images : selections;
    const i = list.findIndex((a) => String(a.id) === id);
    if (i >= 0) list.splice(i, 1);
    renderAttachments();
    input.focus();
  });
  attachBtn.addEventListener('click', () => attachFile.click());
  attachFile.addEventListener('change', () => {
    [...(attachFile.files || [])].filter((f) => /^image\//.test(f.type)).forEach(addImageFile);
    attachFile.value = '';
    input.focus();
  });

  input.addEventListener('paste', (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const files = items.filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    files.forEach(addImageFile);
  });
  bottom.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
  });
  bottom.addEventListener('drop', (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImageFile);
  });

  function applySelection(label) {
    selectionLabel = label || '';
    selBtn.hidden = !(caps.selection && selectionLabel);
    selBtn.textContent = selectionLabel;
    selBtn.title = `Attach ${selectionLabel} to the message`;
  }
  selBtn.addEventListener('click', () => api.postMessage({ type: 'addSelection' }));

  /* ---------- the / and @ lists ---------- */

  function closeMenu() {
    menu = null;
    clearTimeout(fileTimer);
    menuEl.hidden = true;
    menuEl.replaceChildren();
  }

  function renderMenu() {
    if (!menu) { closeMenu(); return; }
    const rows = menu.items.map((it, i) => {
      const row = el('div', `menu-item ${menu.kind}${i === menu.index ? ' active' : ''}`);
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      if (menu.kind === 'slash') row.append(el('span', 'menu-name', `/${it.name}`), el('span', 'menu-desc', it.description || ''));
      else row.append(icon('file'), el('span', 'menu-name', it.name), el('span', 'menu-desc', it.rel === it.name ? '' : it.rel));
      return row;
    });
    if (!rows.length && menu.kind === 'at') rows.push(el('div', 'menu-empty', menu.loading ? 'Looking for files…' : 'No file matches'));
    if (!rows.length) { closeMenu(); return; }
    menuEl.hidden = false;
    menuEl.replaceChildren(...rows);
    /* Only the list scrolls: scrollIntoView would move the page too. */
    const active = menuEl.querySelector('.menu-item.active');
    if (active) {
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < menuEl.scrollTop) menuEl.scrollTop = top;
      else if (bottom > menuEl.scrollTop + menuEl.clientHeight) menuEl.scrollTop = bottom - menuEl.clientHeight;
    }
  }

  function updateMenu() {
    const caret = input.selectionStart;
    const text = input.value;
    const slash = commands.length ? C.slashToken(text, caret) : null;
    if (slash) {
      const items = C.filterCommands(commands, slash.query);
      if (!items.length) { closeMenu(); return; }
      const keep = menu && menu.kind === 'slash' && menu.items[menu.index];
      const index = keep ? Math.max(0, items.indexOf(items.find((x) => x.name === keep.name))) : 0;
      menu = { kind: 'slash', items, index, token: slash };
      renderMenu();
      return;
    }
    const at = caps.files ? C.atToken(text, caret) : null;
    if (at) {
      if (!menu || menu.kind !== 'at') menu = { kind: 'at', items: [], index: 0, token: at, loading: true };
      else { menu.token = at; menu.loading = true; }
      clearTimeout(fileTimer);
      const seq = ++fileSeq;
      fileTimer = setTimeout(() => api.postMessage({ type: 'findFiles', query: at.query, seq }), 120);
      renderMenu();
      return;
    }
    closeMenu();
  }

  function accept(i) {
    const it = menu && menu.items[i];
    if (!it) return;
    let r;
    if (menu.kind === 'slash') r = C.insertToken(input.value, menu.token, `/${it.name}`);
    else {
      r = C.insertToken(input.value, menu.token, `@${it.rel}`);
      if (!picked.some((p) => p.path === it.path)) picked.push({ path: it.path, rel: it.rel, name: it.name });
    }
    input.value = r.text;
    input.setSelectionRange(r.caret, r.caret);
    closeMenu();
    autosize();
    saveDraft();
    paintSend();
    input.focus();
  }

  menuEl.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.menu-item');
    if (!row) return;
    e.preventDefault();
    accept(Number(row.dataset.index));
  });
  slashBtn.addEventListener('mousedown', (e) => e.preventDefault());
  slashBtn.addEventListener('click', () => {
    if (!input.value) input.value = '/';
    input.focus();
    if (input.value.startsWith('/')) input.setSelectionRange(input.value.length, input.value.length);
    autosize();
    saveDraft();
    paintSend();
    updateMenu();
  });

  /* ---------- composer ---------- */

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  function saveDraft() {
    api.setState({ ...(api.getState() || {}), draft: input.value });
  }

  function submit() {
    const text = input.value;
    if (!text.trim()) return;
    const msg = { type: 'send', text };
    const files = C.filesInText(text, picked).map((f) => ({ path: f.path, name: f.name }));
    if (images.length) msg.images = images.map((i) => ({ mediaType: i.mediaType, data: i.data, name: i.name }));
    if (files.length) msg.files = files;
    if (selections.length) msg.selections = selections.map((s) => ({ path: s.path, name: s.name, text: s.text, startLine: s.startLine, endLine: s.endLine }));
    api.postMessage(msg);
    input.value = '';
    images.length = 0;
    selections.length = 0;
    picked = [];
    renderAttachments();
    closeMenu();
    saveDraft();
    autosize();
    paintSend();
    stick = true;
  }

  input.addEventListener('keydown', (e) => {
    const composing = e.isComposing || e.keyCode === 229;
    if (menu && menu.items.length && !composing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = menu.items.length;
        menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderMenu();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        accept(menu.index);
        return;
      }
    }
    if (menu && e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    autosize();
    saveDraft();
    paintSend();
    updateMenu();
  });
  input.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMenu();
  });
  input.addEventListener('click', () => updateMenu());
  input.addEventListener('blur', () => closeMenu());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  stopBtn.addEventListener('click', () => api.postMessage({ type: 'abort' }));

  /* ---------- clicks in the log ---------- */

  log.addEventListener('click', (e) => {
    const target = e.target;
    const conv = target.closest('a.conv-link');
    if (conv) {
      e.preventDefault();
      api.postMessage({ type: 'openConversation', sourceId: conv.dataset.source || '', sessionId: conv.dataset.session || '' });
      return;
    }
    const link = target.closest('a[href]');
    if (link) {
      e.preventDefault();
      api.postMessage({ type: 'openLink', href: link.getAttribute('href') });
      return;
    }
    const copy = target.closest('button.copy');
    if (copy) {
      const pre = copy.parentElement.querySelector('pre');
      api.postMessage({ type: 'copy', text: pre ? pre.textContent : '' });
      copy.classList.add('copied');
      copy.replaceChildren(icon('check'));
      copy.title = 'Copied';
      setTimeout(() => { copy.classList.remove('copied'); copy.replaceChildren(icon('copy')); copy.title = 'Copy code'; }, 1500);
      return;
    }
    const decision = target.closest('button[data-decision]');
    if (decision) {
      const entry = nodes.get(decision.closest('[data-id]').dataset.id);
      if (entry) answer(entry, decision.dataset.decision);
      return;
    }
    const answerBtn = target.closest('button.q-submit, button.q-cancel');
    if (answerBtn) {
      const entry = nodes.get(answerBtn.closest('[data-id]').dataset.id);
      if (!entry || !entry.values) return;
      const accepting = answerBtn.classList.contains('q-submit');
      entry.submit.disabled = true;
      entry.cancel.disabled = true;
      const values = accepting ? entry.values() : {};
      if (accepting) entry.answerText = answerText(entry.item, values);
      api.postMessage({ type: 'question', requestId: answerBtn.dataset.request, action: accepting ? 'accept' : 'cancel', values });
      return;
    }
    const diff = target.closest('button.diff');
    if (diff) { api.postMessage({ type: 'viewDiff', requestId: diff.dataset.request }); return; }
    const rewind = target.closest('button.rewind');
    if (rewind) {
      const holder = rewind.closest('[data-id]');
      if (holder) api.postMessage({ type: 'rewind', itemId: holder.dataset.id });
      return;
    }
    const toolHead = target.closest('.tool-head');
    if (toolHead) {
      const entry = nodes.get(toolHead.closest('[data-id]').dataset.id);
      if (entry && entry.head === toolHead) { setOpen(entry, !entry.open); fill(entry, entry.item); }
    }
  });
  log.addEventListener('keydown', (e) => {
    const toolHead = e.target.closest && e.target.closest('.tool-head');
    if (!toolHead || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toolHead.click();
  });

  /* ---------- scrolling ---------- */

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  function scrollEnd() {
    log.scrollTop = log.scrollHeight;
  }
  log.addEventListener('scroll', () => { stick = atBottom(); });
  /* The scrollbar's width, which the rail and an open request allow for. */
  const gutter = () => document.body.style.setProperty('--sb', `${Math.max(0, log.offsetWidth - log.clientWidth)}px`);
  gutter();
  /* When the bottom bar grows (a list, attachments, a status line), a log scrolled to its end stays there. */
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { gutter(); if (stick) scrollEnd(); }).observe(log);

  /* ---------- the plan bar ---------- */

  /* Agent Plus's fragment (media/plan-bar.js) draws the summary of this conversation's work plan right above the
     message box, as wide as it. A null summary hides it. The bar goes above the / and @ lists so that those stay next to
     the box. */
  const PB = window.agentPlusPlanBar;
  let planBar = null;
  function applyPlanBar(summary) {
    if (!PB || typeof PB.create !== 'function') return;
    if (!planBar) {
      if (!summary) return;
      planBar = PB.create(document, {
        onOpen: () => api.postMessage({ type: 'planBarOpen', part: 'plan' }),
        onAnswer: () => api.postMessage({ type: 'planBarOpen', part: 'answer' }),
      });
      dock.insertBefore(planBar.el, menuEl);
    }
    planBar.update(summary || null);
  }

  /* ---------- messages from the extension ---------- */

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (typeof m.now === 'number') skew = m.now - Date.now();
    if (m.type === 'reset') {
      heard = null;
      nodes.clear();
      turnSent.clear();
      toRender.clear();
      log.replaceChildren();
      scheduleSide();
      for (const item of m.items || []) upsert(item);
      if (m.head) applyHead(m.head);
      stick = true;
      scrollEnd();
    } else if (m.type === 'update') {
      const wasAtBottom = stick;
      for (const item of m.items || []) upsert(item);
      if (m.head) applyHead(m.head);
      if (wasAtBottom) scrollEnd();
    } else if (m.type === 'models') {
      applyModels(m);
    } else if (m.type === 'conversations') {
      applyConversations(m);
    } else if (m.type === 'planBar') {
      const wasAtBottom = stick;
      applyPlanBar(m.summary && typeof m.summary === 'object' ? m.summary : null);
      if (wasAtBottom) scrollEnd();
    } else if (m.type === 'options') {
      applyOptions(m.options);
    } else if (m.type === 'commands') {
      commands = Array.isArray(m.commands) ? m.commands : [];
      placeholder();
      if (document.activeElement === input) updateMenu();
    } else if (m.type === 'caps') {
      caps = { images: m.images === true, files: m.files === true, selection: m.selection === true, rewind: m.rewind === true, info: m.info === true, replyImages: m.replyImages === true };
      infoBtn.hidden = !caps.info;
      placeholder();
      applySelection(selectionLabel);
      for (const entry of nodes.values()) showRewind(entry);
    } else if (m.type === 'sound') {
      sound = { shown: m.shown === true, on: m.on === true };
      paintSound();
    } else if (m.type === 'info') {
      showInfo(m);
    } else if (m.type === 'image') {
      const src = imageWaiting.get(m.id);
      if (!src) return;
      imageWaiting.delete(m.id);
      imageCache.set(src, m.ok === true && typeof m.dataUrl === 'string' && IMG_DATA.test(m.dataUrl) ? { state: 'ok', url: m.dataUrl }
        : { state: 'error', reason: typeof m.reason === 'string' && m.reason ? m.reason : 'The image could not be read.' });
      const wasAtBottom = stick;
      for (const img of [...log.querySelectorAll('img.reply-image')]) if (img.dataset.src === src) drawImage(img, src);
      if (wasAtBottom) scrollEnd();
    } else if (m.type === 'draft') {
      if (!input.value.trim() && typeof m.text === 'string') {
        input.value = m.text;
        autosize();
        saveDraft();
        paintSend();
      }
      input.focus();
    } else if (m.type === 'selection') {
      applySelection(m.label);
    } else if (m.type === 'selectionAdded' && m.item) {
      const it = m.item;
      if (!selections.some((s) => s.path === it.path && s.startLine === it.startLine && s.endLine === it.endLine)) {
        selections.push({ ...it, id: ++attSeq });
        renderAttachments();
      }
      input.focus();
    } else if (m.type === 'files') {
      if (!menu || menu.kind !== 'at' || m.seq !== fileSeq) return;
      const at = C.atToken(input.value, input.selectionStart);
      if (!at) { closeMenu(); return; }
      menu = { kind: 'at', items: Array.isArray(m.items) ? m.items : [], index: 0, token: at, loading: false };
      renderMenu();
    } else if (m.type === 'questionErrors') {
      for (const entry of nodes.values()) {
        if (!entry.item || entry.item.kind !== 'question' || entry.item.requestId !== m.requestId) continue;
        entry.errors.textContent = (m.errors || []).join(' ');
        entry.submit.disabled = false;
        entry.cancel.disabled = false;
      }
    }
  });

  const saved = api.getState();
  if (saved && typeof saved.draft === 'string') {
    input.value = saved.draft;
    autosize();
  }
  paintSend();
  input.focus();
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { tz = ''; }
  api.postMessage({ type: 'ready', tz });
})();
