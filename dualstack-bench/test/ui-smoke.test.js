'use strict';

// Smoke test: execute public/app.js against a minimal DOM stub fed with the
// real SSE event sequence produced by the engine, then assert the timeline
// and tables render the expected terminal states. No browser required.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function makeEl(tag) {
  const el = {
    tag, children: [], attributes: {}, style: { cssText: '' }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _text: '',
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set innerHTML(v) { if (v === '') this.children = []; },
    get innerHTML() { return this._text; },
    hidden: false, disabled: false, tabIndex: 0,
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    setAttribute(k, v) { this.attributes[k] = v; },
    getBoundingClientRect() { return { left: 0, bottom: 0, width: 0, height: 0 }; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
  };
  return el;
}

const ids = {};
const documentStub = {
  createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ text: t }),
  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return (ids[id] ||= makeEl('div'));
    }
    return makeEl('div');
  },
  querySelectorAll() { return []; },
};

const listeners = {};
const fetched = {
  '/api/state': {
    mode: 'sim',
    links: { ipv6: { mode: 'accept', latencyMs: 600 }, ipv4: { mode: 'accept', latencyMs: 120 } },
    runOpts: { delayMs: 250, connectTimeoutMs: 4000, order: ['ipv6', 'ipv4'] },
    activeRunId: null,
    history: [],
    real: { endpoints: { ipv6: { port: 1 }, ipv4: { port: 2 } }, note: '' },
  },
};

globalThis.document = documentStub;
globalThis.window = { innerWidth: 1200, innerHeight: 800 };
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => fetched[url] || {},
});
globalThis.EventSource = class {
  constructor(url) { this.url = url; }
  set onmessage(fn) { listeners.sse = fn; }
  set onerror(fn) {}
};
globalThis.setInterval = () => 0;

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// loadState() is async and chained; evaluate then pump microtasks.
eval(appSrc);

(async () => {
  await new Promise((r) => setTimeout(r, 10));

  // Feed a realistic fallback-won event sequence (mirrors engine output).
  const seq = [
    { type: 'run-start', runId: 'run-1', at: 0, order: ['ipv6', 'ipv4'], delayMs: 250 },
    { type: 'attempt-start', runId: 'run-1', at: 0, family: 'ipv6', phase: 'primary' },
    { type: 'fallback-trigger', runId: 'run-1', at: 250, trigger: 'delay-elapsed', delayMs: 250 },
    { type: 'attempt-start', runId: 'run-1', at: 250, family: 'ipv4', phase: 'fallback' },
    { type: 'attempt-connected', runId: 'run-1', at: 370, family: 'ipv4', elapsedMs: 120 },
    { type: 'attempt-cancelled', runId: 'run-1', at: 370, family: 'ipv6', error: 'RACE_LOST' },
    {
      type: 'run-end', runId: 'run-1', at: 370, reason: 'fallback-won', winner: 'ipv4',
      summary: {
        runId: 'run-1', status: 'connected', reason: 'fallback-won', winner: 'ipv4',
        durationMs: 370,
        attempts: [
          { family: 'ipv6', phase: 'primary', startedAt: 0, endedAt: 370, elapsedMs: 370, status: 'cancelled', error: 'RACE_LOST' },
          { family: 'ipv4', phase: 'fallback', startedAt: 250, endedAt: 370, elapsedMs: 120, status: 'connected', error: null },
        ],
      },
    },
  ];
  for (const ev of seq) listeners.sse({ data: JSON.stringify(ev) });
  await new Promise((r) => setTimeout(r, 10));

  const timeline = ids['timeline'];
  assert.ok(timeline.children.length >= 1, '时间线至少渲染一个运行块');
  const block = timeline.children[0];
  const text = JSON.stringify(block).replace(/\\"/g, '"');
  assert.ok(text.includes('run-1'), '运行块包含 runId');
  assert.ok(text.includes('替代连接胜出') || text.includes('fallback-won'), '渲染完成原因');
  assert.ok(text.includes('ipv4') || text.includes('IPv4'), '渲染 IPv4 泳道');
  assert.ok(text.includes('ipv6') || text.includes('IPv6'), '渲染 IPv6 泳道');
  assert.ok(text.includes('已取消'), '落选取消状态进入时间线');
  assert.ok(text.includes('370ms') || text.includes('120ms'), '泳道标注耗时');

  const histBody = documentStub.querySelector('#history-table tbody');
  assert.ok(histBody, '历史表已渲染');
  console.log('smoke OK: 时间线与终态（含 RACE_LOST 取消）正确渲染');
})().catch((e) => { console.error('smoke FAIL:', e.message); process.exit(1); });
