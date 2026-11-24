// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page. It draws the items and head that src/ui/chat-panel.js posts (shapes in src/ui/view-model.js) and
 * sends back what the user does. It keeps no conversation state of its own beyond the draft in the input, which
 * survives the page being unloaded while hidden, and what waits to go with the next message (images, a selection,
 * files picked with @), which does not.
 *
 * Messages in:  reset { items, head }, update { items, head }, models { models, current, error },
 *               options { options: [{ id, name, value, values: [{ value, name, description? }] }] },
 *               commands { commands: [{ name, description }] }, caps { images, files, selection },
 *               selection { label }, selectionAdded { item }, files { seq, query, items }, questionErrors
 *               { requestId, errors }, planBar { summary }; each carries the extension host's `now`.
 * Messages out: ready { tz }, send { text, images?, files?, selections? }, abort, permission, question { requestId, action,
 *               values }, viewDiff, setModel, setOption, reloadModels, copy, openLink, findFiles { query, seq },
 *               addSelection, planBarOpen { part: 'plan' | 'answer' }.
 */
(function () {
  const api = acquireVsCodeApi();
  const C = window.ChatComposer;
  const md = typeof window.markdownit === 'function'
    ? window.markdownit({ html: false, linkify: true, breaks: true })
    : null;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const form = $('composer');
  const bottom = $('bottom');
  const stopBtn = $('stop');
  const statusEl = $('status');
  const queuedEl = $('queued');
  const menuEl = $('menu');
  const attachEl = $('attachments');
  const noteEl = $('note');
  const selBtn = $('addSelection');
  const modelSel = $('model');
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
  const BASE_PLACEHOLDER = 'Ask anything. Enter to send, Shift+Enter for a new line';

  const nodes = new Map();
  const toRender = new Set();
  let head = null;
  let skew = 0;
  let ticker = null;
  let frame = 0;
  let stick = true;

  /* What the next message may carry, and what waits to go with it. */
  let caps = { images: false, files: false, selection: false };
  let commands = [];
  let selectionLabel = '';
  const images = [];
  const selections = [];
  let picked = [];
  let attSeq = 0;
  /* The open list under the input: { kind: 'slash' | 'at', items, index, token, loading?, empty? }. */
  let menu = null;
  let fileSeq = 0;
  let fileTimer = 0;
  let noteTimer = 0;

  const DECISION_WORDS = {
    allowOnce: 'Allowed once',
    allowSession: 'Allowed in this project',
    deny: 'Denied',
    cancelled: 'No answer needed: the turn ended',
    answered: 'Answered',
    dismissed: 'Dismissed',
  };
  const TOOL_STATE_WORDS = { running: 'Running…', done: '', error: 'Error', aborted: 'Stopped' };
  const CHILD_STATE_WORDS = { running: 'Running…', done: 'Done', stopped: 'Stopped', failed: 'Failed' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
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
  const hostNow = () => Date.now() + skew;

  /* ---------- markdown ---------- */

  function renderMarkdown(target, text) {
    if (!md) {
      target.textContent = text;
      target.classList.add('plain');
      return;
    }
    target.innerHTML = md.render(text);
    for (const pre of target.querySelectorAll('pre')) {
      const wrap = el('div', 'code');
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      const btn = el('button', 'copy secondary', 'Copy');
      btn.type = 'button';
      btn.title = 'Copy code';
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

  /* The label of a request or tool that came from a subagent. */
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

  /* What was answered, in words, for the card once settled. */
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

  /* One input per field of a question; `values()` reads them back. */
  function questionForm(entry, item) {
    const inputs = [];
    const name = (k) => `${item.requestId}:${k}`;
    for (const f of item.fields || []) {
      const box = el('fieldset', 'q-field');
      box.append(el('legend', null, `${f.title}${f.required ? ' *' : ''}`));
      if (f.description && f.description !== f.title) box.append(el('div', 'q-desc', f.description));
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

  function create(item) {
    const entry = { item: null, text: null, rendered: null };
    switch (item.kind) {
      case 'user': {
        entry.el = el('div', 'msg user');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.body = el('div', 'bubble');
        entry.att = el('div', 'user-att');
        entry.el.append(meta, entry.body, entry.att);
        break;
      }
      case 'text': {
        entry.el = el('div', 'msg reply');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.body = el('div', 'md');
        entry.el.append(meta, entry.body);
        break;
      }
      case 'reasoning': {
        entry.el = el('details', 'reasoning');
        const summary = el('summary');
        entry.time = el('span', 'time');
        summary.append(entry.time, el('span', 'label', 'Thinking'));
        entry.body = el('div', 'md');
        entry.el.append(summary, entry.body);
        break;
      }
      case 'tool': {
        entry.el = el('div', 'tool');
        const { meta, time } = metaRow();
        entry.time = time;
        const top = el('div', 'tool-head');
        entry.name = el('span', 'tool-name');
        entry.summary = el('span', 'tool-summary');
        entry.from = el('span', 'from-sub');
        entry.state = el('span', 'tool-state');
        top.append(entry.name, entry.summary, entry.from, entry.state);
        entry.inBox = el('details', 'tool-in');
        entry.inBox.append(el('summary', null, 'Input'), (entry.inPre = el('pre')));
        entry.outBox = el('details', 'tool-out');
        entry.outBox.append((entry.outLabel = el('summary')), (entry.outPre = el('pre')));
        entry.el.append(meta, top, entry.inBox, entry.outBox);
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
          return b;
        };
        entry.decide = [
          button('allowOnce', 'Allow once', 'primary'),
          button('allowSession', 'Allow in this project', 'secondary'),
          button('deny', 'Deny', 'secondary'),
        ];
        entry.diffBtn = el('button', 'secondary diff', 'View diff');
        entry.diffBtn.type = 'button';
        entry.actions.append(...entry.decide, entry.diffBtn);
        entry.result = el('div', 'perm-result');
        entry.el.append(meta, entry.heading, entry.detail, entry.path, entry.actions, entry.result);
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
        entry.cancel = el('button', 'secondary q-cancel', 'Cancel');
        entry.cancel.type = 'button';
        entry.cancel.title = 'Answers nothing; OpenCode then stops the turn';
        entry.actions.append(entry.submit, entry.cancel);
        entry.result = el('div', 'perm-result');
        entry.el.append(meta, entry.heading, entry.form, entry.errors, entry.actions, entry.result);
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
        entry.el = el('div', 'tool subagent');
        entry.childC = childBox();
        entry.el.appendChild(entry.childC.box);
        break;
      case 'figures':
        entry.el = el('div', 'figures');
        break;
      default:
        entry.el = el('div', 'notice');
        break;
    }
    entry.el.dataset.id = item.id;
    return entry;
  }

  function fill(entry, item) {
    const prev = entry.item;
    entry.item = item;
    switch (item.kind) {
      case 'user':
        entry.time.textContent = stamp(item.at);
        entry.body.textContent = item.text;
        entry.att.replaceChildren(...(item.attachments || []).map((a) => el('span', `att att-${a.kind}`, a.kind === 'image' ? 'Image' : a.kind === 'selection' ? `Selection ${a.name}` : a.name)));
        entry.att.hidden = !(item.attachments && item.attachments.length);
        break;
      case 'text':
      case 'reasoning':
        entry.time.textContent = stamp(item.at);
        if (item.text !== entry.text) {
          entry.text = item.text;
          scheduleRender(entry);
        }
        break;
      case 'tool': {
        entry.el.className = `tool state-${item.state}`;
        entry.time.textContent = item.doneAt ? `${stamp(item.at)}→${clock(item.doneAt)}` : stamp(item.at);
        entry.name.textContent = item.name;
        entry.summary.textContent = item.summary || '';
        entry.summary.title = item.summary || '';
        fromSubagent(entry.from, item.subagent);
        entry.state.textContent = TOOL_STATE_WORDS[item.state] || '';
        entry.inPre.textContent = item.input || '';
        entry.inBox.hidden = !item.input || item.input === '{}';
        const result = item.result || '';
        entry.outBox.hidden = !result;
        entry.outPre.textContent = result;
        const lines = result ? result.split('\n').length : 0;
        const label = item.display && typeof item.display.summary === 'string' ? item.display.summary : '';
        entry.outLabel.textContent = `${item.state === 'error' ? 'Error' : 'Result'} · ${label || `${lines} line${lines === 1 ? '' : 's'}`}`;
        if (item.state === 'error' && (!prev || prev.state !== 'error')) entry.outBox.open = true;
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
        fillChild(entry.childC, item);
        break;
      case 'permission': {
        const req = item.request || {};
        entry.time.textContent = stamp(item.at);
        const from = el('span', 'from-sub');
        fromSubagent(from, item.subagent);
        entry.heading.replaceChildren(el('span', 'perm-label', 'Permission'), el('span', 'tool-name', req.tool || ''),
          el('span', 'perm-summary', req.summary || ''), from);
        const detail = req.command || req.detail || '';
        entry.detail.textContent = detail;
        entry.detail.hidden = !detail || detail === req.summary;
        entry.path.textContent = req.path || '';
        entry.path.hidden = !req.path || (req.summary || '').includes(req.path);
        const decided = !!item.decision;
        for (const b of entry.decide) {
          b.hidden = decided;
          if (!decided && !entry.sent) b.disabled = false;
        }
        entry.diffBtn.hidden = !req.hasDiff;
        entry.diffBtn.dataset.request = item.requestId;
        for (const b of entry.decide) b.dataset.request = item.requestId;
        entry.result.textContent = decided ? DECISION_WORDS[item.decision] || item.decision : '';
        entry.result.className = `perm-result decision-${item.decision || 'none'}`;
        entry.el.classList.toggle('settled', decided);
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
        entry.el.classList.toggle('settled', decided);
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
        break;
      }
      default:
        entry.el.className = `notice level-${item.level || 'info'}`;
        entry.el.textContent = item.text || '';
        break;
    }
    if (item.hidden === true) entry.el.hidden = true;
  }

  function upsert(item) {
    let entry = nodes.get(item.id);
    if (!entry) {
      entry = create(item);
      nodes.set(item.id, entry);
      log.appendChild(entry.el);
    }
    fill(entry, item);
  }

  /* ---------- head ---------- */

  function applyHead(h) {
    head = h;
    titleEl.textContent = h.title || 'New conversation';
    titleEl.title = h.title || '';
    document.body.dataset.status = h.status;
    stopBtn.hidden = h.status === 'idle';

    const pct = typeof h.contextPct === 'number' ? Math.max(0, Math.min(100, h.contextPct)) : null;
    ringFill.setAttribute('stroke-dasharray', `${pct == null ? 0 : (pct / 100) * RING} ${RING}`);
    ring.classList.toggle('high', pct != null && pct >= 85);
    ring.classList.toggle('empty', pct == null);
    ringLabel.textContent = pct == null ? '' : `${pct}%`;
    const costLine = h.costText ? `\nCost so far: ${h.costText}` : '';
    ring.title = pct != null
      ? `${pct}% of the context window used (${h.contextText})${costLine}`
      : `${h.contextText || 'Context use appears after the first reply'}${costLine}`;

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

    renderStatus();
    if (h.status !== 'idle' && !ticker) ticker = setInterval(renderStatus, 1000);
    if (h.status === 'idle' && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function renderStatus() {
    if (!head || head.status === 'idle') {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    const r = head.retry;
    if (r) {
      const left = Math.ceil((r.at + r.waitMs - hostNow()) / 1000);
      statusEl.className = 'retry';
      statusEl.textContent = `Retrying, attempt ${r.attempt}${left > 0 ? ` in ${left}s` : ''} · ${r.error}`;
    } else if (head.status === 'waiting') {
      statusEl.className = 'waiting';
      statusEl.textContent = head.waitingFor === 'question' ? 'Waiting for your answer to a question' : 'Waiting for your answer to a permission request';
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

  /* ---------- what goes with the next message ---------- */

  /* The placeholder stays short, since a narrow box cuts it off; the whole of it is the box's tooltip. */
  function placeholder() {
    const hints = [];
    if (commands.length) hints.push('/ for commands');
    if (caps.files) hints.push('@ for files');
    input.placeholder = hints.length ? `Ask anything. ${hints.join(', ')}` : BASE_PLACEHOLDER;
    const more = [];
    if (commands.length) more.push('/ lists the commands');
    if (caps.files) more.push('@ lists the files of the workspace');
    if (caps.images) more.push('paste or drop an image to send it along');
    input.title = ['Enter to send, Shift+Enter for a new line', ...more].join('; ');
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
    if (!caps.images) { showNote('Images cannot go with a message to this agent.'); return; }
    if (images.length >= MAX_IMAGES) { showNote(`At most ${MAX_IMAGES} images go with one message.`); return; }
    if (file.size > MAX_IMAGE_BYTES) { showNote(`${file.name || 'The image'} is larger than 5 MB and was not added.`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = C.imageOfDataUrl(reader.result);
      if (!img) { showNote(`${file.name || 'That file'} is not an image this page can read.`); return; }
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
    selBtn.textContent = `+ ${selectionLabel}`;
    selBtn.title = `Send the selection in ${selectionLabel} with the message`;
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
      const row = el('div', `menu-item${i === menu.index ? ' active' : ''}`);
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      if (menu.kind === 'slash') row.append(el('span', 'menu-name', `/${it.name}`), el('span', 'menu-desc', it.description || ''));
      else row.append(el('span', 'menu-name', it.name), el('span', 'menu-desc', it.rel));
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
    input.focus();
  }

  menuEl.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.menu-item');
    if (!row) return;
    e.preventDefault();
    accept(Number(row.dataset.index));
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
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      return;
    }
    const decision = target.closest('button[data-decision]');
    if (decision) {
      const entry = nodes.get(decision.closest('[data-id]').dataset.id);
      if (entry) {
        entry.sent = true;
        for (const b of entry.decide) b.disabled = true;
      }
      api.postMessage({ type: 'permission', requestId: decision.dataset.request, decision: decision.dataset.decision });
      return;
    }
    const answer = target.closest('button.q-submit, button.q-cancel');
    if (answer) {
      const entry = nodes.get(answer.closest('[data-id]').dataset.id);
      if (!entry || !entry.values) return;
      const accepting = answer.classList.contains('q-submit');
      entry.submit.disabled = true;
      entry.cancel.disabled = true;
      const values = accepting ? entry.values() : {};
      if (accepting) entry.answerText = answerText(entry.item, values);
      api.postMessage({ type: 'question', requestId: answer.dataset.request, action: accepting ? 'accept' : 'cancel', values });
      return;
    }
    const diff = target.closest('button.diff');
    if (diff) api.postMessage({ type: 'viewDiff', requestId: diff.dataset.request });
  });

  /* ---------- scrolling ---------- */

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  function scrollEnd() {
    log.scrollTop = log.scrollHeight;
  }
  log.addEventListener('scroll', () => { stick = atBottom(); });
  /* The bottom bar grows with a list, attachments or a status line; the log keeps to its end if it was there. */
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (stick) scrollEnd(); }).observe(log);

  /* ---------- the plan bar ---------- */

  /* Agent Plus's fragment (media/plan-bar.js) draws the summary of this conversation's work plan above the input box; a
     click opens Agent Plus's Work plan view at it, one on the red part its Answer view. A null summary hides it. It goes
     above the / and @ lists and what goes with the next message, which belong to the box, so they stay next to it. */
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
      bottom.insertBefore(planBar.el, menuEl);
    }
    planBar.update(summary || null);
  }

  /* ---------- messages from the extension ---------- */

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (typeof m.now === 'number') skew = m.now - Date.now();
    if (m.type === 'reset') {
      nodes.clear();
      toRender.clear();
      log.replaceChildren();
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
      caps = { images: m.images === true, files: m.files === true, selection: m.selection === true };
      placeholder();
      applySelection(selectionLabel);
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
  input.focus();
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { tz = ''; }
  api.postMessage({ type: 'ready', tz });
})();
