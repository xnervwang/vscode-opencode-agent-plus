// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The chat page. It draws the items and head that src/ui/chat-panel.js posts (shapes in src/ui/view-model.js) and
 * sends back what the user does. It keeps no conversation state of its own beyond the draft in the input, which
 * survives the page being unloaded while hidden.
 *
 * Messages in:  reset { items, head }, update { items, head }, models { models, current, error }; each carries the
 *               extension host's `now`.
 * Messages out: ready, send, abort, permission, viewDiff, setModel, reloadModels, copy, openLink.
 */
(function () {
  const api = acquireVsCodeApi();
  const md = typeof window.markdownit === 'function'
    ? window.markdownit({ html: false, linkify: true, breaks: false })
    : null;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const form = $('composer');
  const stopBtn = $('stop');
  const statusEl = $('status');
  const queuedEl = $('queued');
  const modelSel = $('model');
  const ring = $('ring');
  const titleEl = $('title');
  const ringFill = ring.querySelector('.fill');
  const ringLabel = el('span', 'ring-label');
  ring.appendChild(ringLabel);
  const RING = 2 * Math.PI * 6;

  const nodes = new Map();
  const toRender = new Set();
  let head = null;
  let skew = 0;
  let ticker = null;
  let frame = 0;
  let stick = true;

  const DECISION_WORDS = {
    allowOnce: 'Allowed once',
    allowSession: 'Allowed for this conversation',
    deny: 'Denied',
    cancelled: 'No answer needed: the turn ended',
  };
  const TOOL_STATE_WORDS = { running: 'Running…', done: '', error: 'Error', aborted: 'Stopped' };

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

  function create(item) {
    const entry = { item: null, text: null, rendered: null };
    switch (item.kind) {
      case 'user': {
        entry.el = el('div', 'msg user');
        const { meta, time } = metaRow();
        entry.time = time;
        entry.body = el('div', 'bubble');
        entry.el.append(meta, entry.body);
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
        entry.state = el('span', 'tool-state');
        top.append(entry.name, entry.summary, entry.state);
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
          button('allowSession', 'Allow for this conversation', 'secondary'),
          button('deny', 'Deny', 'secondary'),
        ];
        entry.diffBtn = el('button', 'secondary diff', 'View diff');
        entry.diffBtn.type = 'button';
        entry.actions.append(...entry.decide, entry.diffBtn);
        entry.result = el('div', 'perm-result');
        entry.el.append(meta, entry.heading, entry.detail, entry.path, entry.actions, entry.result);
        break;
      }
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
        break;
      }
      case 'permission': {
        const req = item.request || {};
        entry.time.textContent = stamp(item.at);
        entry.heading.replaceChildren(el('span', 'perm-label', 'Permission'), el('span', 'tool-name', req.tool || ''),
          el('span', 'perm-summary', req.summary || ''));
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
      case 'figures': {
        entry.el.textContent = item.text || '';
        const parts = [];
        if (item.turnCostUsd != null) parts.push(`This turn: $${item.turnCostUsd.toFixed(item.turnCostUsd < 0.01 ? 3 : 2)}`);
        if (item.costUsd != null) parts.push(`Conversation so far: $${item.costUsd.toFixed(item.costUsd < 0.01 ? 3 : 2)}`);
        if (item.contextUsed) parts.push(`Context: ${item.contextUsed.toLocaleString('en-US')} tokens` +
          (item.contextWindow ? ` of ${item.contextWindow.toLocaleString('en-US')}` : ''));
        if (item.modelId) parts.push(`Model: ${item.modelId}`);
        entry.el.title = parts.join('\n');
        break;
      }
      default:
        entry.el.className = `notice level-${item.level || 'info'}`;
        entry.el.textContent = item.text || '';
        break;
    }
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
      statusEl.textContent = 'Waiting for your answer to a permission request';
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
    api.postMessage({ type: 'send', text });
    input.value = '';
    saveDraft();
    autosize();
    stick = true;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    autosize();
    saveDraft();
  });
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
    const diff = target.closest('button.diff');
    if (diff) api.postMessage({ type: 'viewDiff', requestId: diff.dataset.request });
  });

  /* ---------- scrolling ---------- */

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  function scrollEnd() {
    log.scrollTop = log.scrollHeight;
  }
  log.addEventListener('scroll', () => { stick = atBottom(); });

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
    }
  });

  const saved = api.getState();
  if (saved && typeof saved.draft === 'string') {
    input.value = saved.draft;
    autosize();
  }
  input.focus();
  api.postMessage({ type: 'ready' });
})();
