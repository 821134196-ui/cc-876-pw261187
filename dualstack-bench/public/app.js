'use strict';

const REASON_LABELS = {
  'primary-won': '首选地址族直接胜出',
  'fallback-won': '等待超时，替代连接胜出',
  'primary-failed-fallback-won': '首选失败，替代连接提前胜出',
  'all-failed': '所有地址族均失败',
  'timeout': '连接超时',
  'user-cancelled': '用户取消',
  'superseded': '被新连接取代',
};
const STATUS_LABELS = { connected: '已连接', failed: '失败' };
const EVENT_LABELS = {
  'run-start': '运行开始',
  'run-end': '运行结束',
  'run-superseded': '被取代',
  'mode-changed': '模式切换',
  'attempt-start': '开始尝试',
  'attempt-connected': '连接建立',
  'attempt-failed': '尝试失败',
  'attempt-timeout': '尝试超时',
  'attempt-closed-race-lost': '落选后已取消',
  'attempt-cancelled': '尝试已取消',
  'fallback-trigger': '发起替代连接',
};
const FAMILY_LABELS = { ipv6: 'IPv6', ipv4: 'IPv4' };

const state = {
  mode: 'sim',
  links: {},
  runOpts: {},
  activeRunId: null,
  runs: new Map(), // runId -> {events: [], summary: null}
  order: ['ipv6', 'ipv4'],
};

const $ = (sel) => document.querySelector(sel);
const timelineEl = $('#timeline');
const tooltip = $('#tooltip');

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- state bootstrap + SSE ---------------------------------------------------

async function loadState() {
  const s = await (await fetch('/api/state')).json();
  state.mode = s.mode;
  state.links = s.links;
  state.runOpts = s.runOpts;
  state.order = s.runOpts.order;
  state.activeRunId = s.activeRunId;
  for (const summary of s.history) state.runs.set(summary.runId, { events: [], summary });
  syncControls(s);
  renderHistory();
  renderTimeline();
  updateActionState();
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    handleEvent(ev);
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}

function ensureRun(runId) {
  if (!state.runs.has(runId)) state.runs.set(runId, { events: [], summary: null });
  return state.runs.get(runId);
}

function handleEvent(ev) {
  if (ev.type === 'mode-changed') {
    state.mode = ev.mode;
    syncModeButtons();
    applyCapabilityLock();
    return;
  }
  if (!ev.runId) return;
  const run = ensureRun(ev.runId);
  run.events.push(ev);

  if (ev.type === 'run-start') {
    state.activeRunId = ev.runId;
    if (Array.isArray(ev.order)) state.order = ev.order;
  }
  if (ev.type === 'run-end') {
    run.summary = ev.summary;
    if (state.activeRunId === ev.runId) state.activeRunId = null;
  }
  if (ev.type === 'run-superseded') {
    const target = state.runs.get(ev.runId);
    if (target && target.summary) target.summary._superseded = true;
  }
  renderTimeline();
  renderEventTable();
  if (ev.type === 'run-end') {
    refreshHistoryFromServer();
    updateActionState();
  }
  updateActionState();
}

async function refreshHistoryFromServer() {
  const s = await (await fetch('/api/state')).json();
  for (const summary of s.history) {
    const run = ensureRun(summary.runId);
    run.summary = summary;
  }
  state.activeRunId = s.activeRunId;
  renderHistory();
}

// ---- controls ----------------------------------------------------------------

function syncControls(s) {
  for (const family of ['ipv6', 'ipv4']) {
    const link = s.links[family];
    const sel = document.querySelector(`.mode-select[data-family="${family}"]`);
    const lat = document.querySelector(`.lat-input[data-family="${family}"]`);
    const latVal = document.querySelector(`.lat-val[data-family="${family}"]`);
    sel.value = link.mode;
    lat.value = link.latencyMs;
    latVal.textContent = link.latencyMs;
  }
  $('#order-select').value = s.runOpts.order.join(',');
  $('#delay-input').value = s.runOpts.delayMs;
  $('#delay-val').textContent = s.runOpts.delayMs;
  $('#timeout-input').value = s.runOpts.connectTimeoutMs;
  $('#timeout-val').textContent = s.runOpts.connectTimeoutMs;
  $('#ep-ipv6').textContent = s.real.endpoints.ipv6
    ? `[::1]:${s.real.endpoints.ipv6.port}`
    : '::1';
  $('#ep-ipv4').textContent = s.real.endpoints.ipv4
    ? `127.0.0.1:${s.real.endpoints.ipv4.port}`
    : '127.0.0.1';
  syncModeButtons();
  applyCapabilityLock(s.real);
}

function syncModeButtons() {
  document.querySelectorAll('.mode-switch .seg').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  });
}

function applyCapabilityLock(real) {
  const note = $('#cap-note');
  const isReal = state.mode === 'real';
  document.querySelectorAll('.lat-input').forEach((input) => { input.disabled = isReal; });
  document.querySelectorAll('.mode-select').forEach((sel) => {
    sel.querySelectorAll('option[value="blackhole"]').forEach((o) => {
      o.disabled = isReal;
      if (isReal && sel.value === 'blackhole') sel.value = 'accept';
    });
  });
  if (isReal && real) {
    note.hidden = false;
    note.textContent = real.note;
  } else {
    note.hidden = true;
  }
}

function updateActionState() {
  const running = Boolean(state.activeRunId);
  $('#btn-start').disabled = running;
  $('#btn-cancel').disabled = !running;
  $('#btn-burst').disabled = running;
  $('#active-badge').hidden = !running;
}

document.querySelectorAll('.mode-select').forEach((sel) => {
  sel.addEventListener('change', async () => {
    await api('/api/links', { [sel.dataset.family]: { mode: sel.value } });
    state.links[sel.dataset.family].mode = sel.value;
  });
});
document.querySelectorAll('.lat-input').forEach((input) => {
  input.addEventListener('input', () => {
    document.querySelector(`.lat-val[data-family="${input.dataset.family}"]`).textContent = input.value;
  });
  input.addEventListener('change', async () => {
    const latencyMs = Number(input.value);
    await api('/api/links', { [input.dataset.family]: { latencyMs } });
    state.links[input.dataset.family].latencyMs = latencyMs;
  });
});
$('#order-select').addEventListener('change', async (e) => {
  const order = e.target.value.split(',');
  await api('/api/run-opts', { order });
  state.runOpts.order = order;
});
$('#delay-input').addEventListener('input', (e) => { $('#delay-val').textContent = e.target.value; });
$('#delay-input').addEventListener('change', async (e) => {
  await api('/api/run-opts', { delayMs: Number(e.target.value) });
});
$('#timeout-input').addEventListener('input', (e) => { $('#timeout-val').textContent = e.target.value; });
$('#timeout-input').addEventListener('change', async (e) => {
  await api('/api/run-opts', { connectTimeoutMs: Number(e.target.value) });
});

document.querySelectorAll('.mode-switch .seg').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await api('/api/mode', { mode: btn.dataset.mode });
      state.mode = btn.dataset.mode;
      syncModeButtons();
      const s = await (await fetch('/api/state')).json();
      applyCapabilityLock(s.real);
    } catch (err) {
      alert(err.message);
    }
  });
});

$('#btn-start').addEventListener('click', async () => {
  try { await api('/api/runs/start', {}); }
  catch (err) { alert(err.message); }
});
$('#btn-cancel').addEventListener('click', async () => {
  try { await api('/api/runs/cancel', {}); }
  catch (err) { alert(err.message); }
});
$('#btn-burst').addEventListener('click', async () => {
  try { await api('/api/runs/burst', { count: 3, gapMs: 120 }); }
  catch (err) { alert(err.message); }
});
$('#btn-clear').addEventListener('click', () => {
  state.runs.clear();
  renderTimeline();
  renderHistory();
  renderEventTable();
});

// ---- timeline rendering ------------------------------------------------------

function attemptState(rec) {
  if (rec.status === 'connected') return 'connected';
  if (rec.error === 'TIMEOUT') return 'timeout';
  if (rec.error === 'RACE_LOST' || rec.error === 'USER_CANCELLED' ||
      rec.error === 'SUPERSEDED' || rec.error === 'ABORTED') return 'cancelled';
  return 'failed';
}

function renderTimeline() {
  timelineEl.innerHTML = '';
  const entries = [...state.runs.entries()].slice(-8);
  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '尚未发起连接。点击「发起连接」开始。';
    timelineEl.appendChild(p);
    return;
  }

  for (const [runId, run] of entries) {
    timelineEl.appendChild(renderRunBlock(runId, run));
  }
}

function renderRunBlock(runId, run) {
  const block = document.createElement('div');
  block.className = 'run-block';
  const summary = run.summary;
  if (summary && (summary.reason === 'superseded' || summary._superseded)) block.classList.add('superseded');

  const meta = document.createElement('div');
  meta.className = 'run-meta';
  const idEl = document.createElement('span');
  idEl.className = 'run-id';
  idEl.textContent = runId + (summary ? '' : ' · 运行中');
  meta.appendChild(idEl);

  const reasonEl = document.createElement('span');
  const reason = summary ? summary.reason : 'running';
  reasonEl.className = `run-reason ${reasonClass(reason)}`;
  reasonEl.textContent = summary ? REASON_LABELS[summary.reason] || summary.reason : '运行中';
  meta.appendChild(reasonEl);
  block.appendChild(meta);

  // time scale
  const maxMs = computeMaxMs(run, summary);
  const lanes = document.createElement('div');
  lanes.className = 'lanes';
  lanes.appendChild(renderAxis(maxMs));

  for (const family of ['ipv6', 'ipv4']) {
    lanes.appendChild(renderLane(run, family, maxMs));
  }
  // fallback markers overlay on the first lane's track area
  const markers = run.events.filter((e) => e.type === 'fallback-trigger');
  if (markers.length) {
    const markerRow = document.createElement('div');
    markerRow.style.cssText = 'position:relative;margin-left:56px;height:18px;margin-top:-2px;';
    for (const m of markers) {
      const line = document.createElement('div');
      line.className = 'marker';
      line.style.left = pct(m.at, maxMs);
      const tag = document.createElement('span');
      tag.className = 'marker-tag';
      tag.textContent = `替代连接 @${m.at}ms`;
      line.appendChild(tag);
      markerRow.appendChild(line);
    }
    lanes.appendChild(markerRow);
  }
  block.appendChild(lanes);
  return block;
}

function reasonClass(reason) {
  if (reason === 'running') return '';
  if (reason === 'primary-won' || reason === 'fallback-won' || reason === 'primary-failed-fallback-won') return 'connected';
  if (reason === 'user-cancelled' || reason === 'superseded') return reason === 'superseded' ? 'superseded' : 'cancelled';
  if (reason === 'timeout') return 'timeout';
  return 'failed';
}

function computeMaxMs(run, summary) {
  let max = 500;
  for (const ev of run.events) if (typeof ev.at === 'number') max = Math.max(max, ev.at);
  if (summary && summary.durationMs) max = Math.max(max, summary.durationMs);
  // Still-running blackhole: extend to the latest event so the dashed bar grows.
  return Math.ceil(max * 1.15 / 100) * 100;
}

function renderAxis(maxMs) {
  const axis = document.createElement('div');
  axis.className = 'axis';
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${(i / steps) * 100}%`;
    tick.textContent = `${Math.round((maxMs * i) / steps)}`;
    axis.appendChild(tick);
  }
  return axis;
}

function renderLane(run, family, maxMs) {
  const lane = document.createElement('div');
  lane.className = 'lane';
  const label = document.createElement('span');
  label.className = 'lane-label';
  const dot = document.createElement('span');
  dot.className = `swatch swatch-${family}`;
  label.appendChild(dot);
  label.appendChild(document.createTextNode(FAMILY_LABELS[family]));
  lane.appendChild(label);

  const track = document.createElement('div');
  track.className = 'lane-track';

  const rec = run.summary
    ? run.summary.attempts.find((a) => a.family === family)
    : liveAttempt(run, family);

  if (rec) {
    const start = rec.startedAt ?? 0;
    const end = rec.endedAt != null ? rec.endedAt : Math.max(maxMs * 0.9, lastEventAt(run));
    const bar = document.createElement('div');
    const st = rec.status === 'connecting' ? 'connecting' : attemptState(rec);
    bar.className = `bar ${family} ${st}`;
    bar.style.left = pct(start, maxMs);
    bar.style.width = `calc(${pct(Math.max(1, end - start), maxMs)} - 2px)`;
    if (st === 'connected' || st === 'timeout' || st === 'failed') {
      const d = document.createElement('span');
      d.className = 'end-dot';
      bar.appendChild(d);
    }
    const barLabel = document.createElement('span');
    barLabel.className = 'bar-label';
    barLabel.textContent = rec.endedAt != null
      ? `${rec.endedAt - rec.startedAt}ms · ${barStateText(rec, st)}`
      : `连接中… ${barStateText(rec, st)}`;
    bar.appendChild(barLabel);
    attachTooltip(bar, family, rec, st);
    track.appendChild(bar);
  }
  lane.appendChild(track);
  return lane;
}

function liveAttempt(run, family) {
  const startEv = run.events.find((e) => e.type === 'attempt-start' && e.family === family);
  if (!startEv) return null;
  const connected = run.events.find((e) => e.type === 'attempt-connected' && e.family === family);
  const terminal = run.events.findLast(
    (e) => ['attempt-failed', 'attempt-timeout', 'attempt-cancelled', 'attempt-closed-race-lost'].includes(e.type) && e.family === family
  );
  const endEv = terminal || connected;
  const status = !endEv
    ? 'connecting'
    : terminal
      ? terminal.type === 'attempt-failed' || terminal.type === 'attempt-timeout' ? 'failed' : 'cancelled'
      : 'connected';
  return {
    family,
    status,
    startedAt: startEv.at,
    endedAt: endEv ? endEv.at : null,
    error: terminal ? (terminal.type === 'attempt-timeout' ? 'TIMEOUT' : terminal.error || 'ABORTED') : null,
  };
}

function lastEventAt(run) {
  return run.events.reduce((m, e) => Math.max(m, typeof e.at === 'number' ? e.at : m), 0);
}

function barStateText(rec, st) {
  if (st === 'connected') return '已建立';
  if (st === 'timeout') return '超时';
  if (st === 'cancelled') return '已取消';
  if (st === 'failed') return rec.error || '失败';
  return '连接中';
}

function pct(v, max) {
  return `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
}

function attachTooltip(el, family, rec, st) {
  el.tabIndex = 0;
  const show = (x, y) => {
    tooltip.hidden = false;
    tooltip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'tt-title';
    const sw = document.createElement('span');
    sw.className = `swatch swatch-${family}`;
    title.appendChild(sw);
    title.appendChild(document.createTextNode(`${FAMILY_LABELS[family]} · ${barStateText(rec, st)}`));
    tooltip.appendChild(title);
    const rows = [
      ['开始', `${rec.startedAt}ms`],
      ['结束', rec.endedAt != null ? `${rec.endedAt}ms` : '—'],
      ['耗时', rec.elapsedMs != null ? `${rec.elapsedMs}ms` : '—'],
      ['错误', rec.error || '—'],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const kEl = document.createElement('span');
      kEl.textContent = k;
      const vEl = document.createElement('strong');
      vEl.textContent = v;
      row.append(kEl, vEl);
      tooltip.appendChild(row);
    }
    tooltip.style.left = `${Math.min(x + 14, window.innerWidth - 280)}px`;
    tooltip.style.top = `${Math.min(y + 14, window.innerHeight - 140)}px`;
  };
  el.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  el.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    show(r.left, r.bottom);
  });
  el.addEventListener('blur', () => { tooltip.hidden = true; });
}

// ---- history + event tables --------------------------------------------------

function renderHistory() {
  const tbody = document.querySelector('#history-table tbody');
  tbody.innerHTML = '';
  const all = [...state.runs.values()].filter((r) => r.summary).map((r) => r.summary);
  all.sort((a, b) => b.startedAt - a.startedAt);
  for (const s of all.slice(0, 50)) {
    const tr = document.createElement('tr');
    tr.append(
      td(s.runId),
      pillCell(STATUS_LABELS[s.status] || s.status, `pill ${s.status}`),
      td(REASON_LABELS[s.reason] || s.reason),
      famCell(s.winner),
      td(s.durationMs != null ? `${s.durationMs}ms` : '—'),
      td(s.attempts.map((a) => `${FAMILY_LABELS[a.family]}:${a.status}`).join(' / '))
    );
    tbody.appendChild(tr);
  }
}

function renderEventTable() {
  const tbody = document.querySelector('#event-table tbody');
  tbody.innerHTML = '';
  const all = [];
  for (const [runId, run] of state.runs) {
    for (const ev of run.events) all.push({ runId, ...ev });
  }
  all.sort((a, b) => (a.wallAt || 0) - (b.wallAt || 0));
  for (const ev of all.slice(-200)) {
    const tr = document.createElement('tr');
    const detail = eventDetail(ev);
    tr.append(
      td(ev.runId),
      td(`${ev.at}ms`),
      td(EVENT_LABELS[ev.type] || ev.type),
      detail
    );
    tbody.appendChild(tr);
  }
}

function eventDetail(ev) {
  const cell = document.createElement('td');
  if (ev.family) {
    const span = document.createElement('span');
    span.className = `fam-${ev.family}`;
    span.textContent = FAMILY_LABELS[ev.family];
    cell.appendChild(span);
    const extra = ev.error ? ` · ${ev.error}` : ev.trigger ? ` · ${ev.trigger}${ev.delayMs ? ` (${ev.delayMs}ms)` : ''}` : '';
    if (extra) cell.appendChild(document.createTextNode(extra));
  } else if (ev.reason) {
    cell.textContent = REASON_LABELS[ev.reason] || ev.reason;
  } else if (ev.mode) {
    cell.textContent = ev.mode === 'sim' ? '模拟链路' : '真实本地 TCP';
  } else {
    cell.textContent = '—';
  }
  return cell;
}

function td(text) {
  const el = document.createElement('td');
  el.textContent = text;
  return el;
}
function pillCell(text, cls) {
  const el = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = cls;
  pill.textContent = text;
  el.appendChild(pill);
  return el;
}
function famCell(family) {
  const el = document.createElement('td');
  if (!family) { el.textContent = '—'; return el; }
  const span = document.createElement('span');
  span.className = `fam-${family}`;
  span.textContent = FAMILY_LABELS[family];
  el.appendChild(span);
  return el;
}

loadState().then(connectSSE).catch((err) => {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = `初始化失败：${err.message}`;
  timelineEl.appendChild(p);
});

// While a run is active, re-render periodically so the "connecting" bar keeps
// growing even in gaps between events (e.g. a blackholed attempt).
setInterval(() => {
  if (state.activeRunId) {
    renderTimeline();
    updateActionState();
  }
}, 200);
