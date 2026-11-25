'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { startRun, REASONS } = require('./lib/happy-eyeballs');
const { SimulatedDialer } = require('./lib/simulated-dialer');
const { TcpDialer } = require('./lib/tcp-dialer');
const { TargetManager } = require('./lib/target-manager');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);

const DEFAULT_LINKS = {
  ipv6: { mode: 'accept', latencyMs: 600 },
  ipv4: { mode: 'accept', latencyMs: 120 },
};
const DEFAULT_RUN_OPTS = { delayMs: 250, connectTimeoutMs: 4000, order: ['ipv6', 'ipv4'] };

// ---- runtime state ----------------------------------------------------------

const simDialer = new SimulatedDialer(structuredClone(DEFAULT_LINKS));
const targetManager = new TargetManager();
let activeMode = 'sim'; // 'sim' | 'real'
let runOpts = { ...DEFAULT_RUN_OPTS };

const runs = new Map(); // runId -> {summary, events}
const runHistory = []; // newest-first summaries, capped
const HISTORY_CAP = 50;
let runSeq = 0;
let activeRun = null; // {runId, ac, handle}

const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function recordEvent(rec, event) {
  const stamped = { ...event, wallAt: Date.now() };
  rec.events.push(stamped);
  broadcast(stamped);
}

function currentDialer() {
  if (activeMode === 'real') return new TcpDialer(targetManager.endpoints());
  return simDialer;
}

// ---- run lifecycle ----------------------------------------------------------

async function beginRun({ trigger = 'manual', signal, supersede = false } = {}) {
  if (activeRun && supersede) {
    const prev = activeRun;
    activeRun = null;
    prev.ac.abort(Object.assign(new Error('superseded'), { code: 'SUPERSEDED' }));
    broadcast({
      type: 'run-superseded',
      runId: prev.runId,
      at: Date.now(),
      by: trigger,
    });
  }

  const runId = `run-${++runSeq}`;
  const ac = new AbortController();
  if (signal) signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });

  const rec = { runId, events: [], summary: null };
  runs.set(runId, rec);
  const handle = startRun({
    runId,
    dialer: currentDialer(),
    opts: runOpts,
    signal: ac.signal,
    onEvent: (event) => recordEvent(rec, event),
  });
  activeRun = { runId, ac, handle };

  const summary = await handle.promise;
  rec.summary = summary;
  runHistory.unshift(summary);
  if (runHistory.length > HISTORY_CAP) runHistory.length = HISTORY_CAP;
  if (activeRun && activeRun.runId === runId) activeRun = null;
  return summary;
}

// ---- HTTP helpers -----------------------------------------------------------

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        mode: activeMode,
        links: simDialer.describe(),
        runOpts,
        activeRunId: activeRun ? activeRun.runId : null,
        history: runHistory,
        real: targetManager.capabilities(),
        reasons: REASONS,
      });
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/runs' && url.searchParams.has('id')) {
      const rec = runs.get(url.searchParams.get('id'));
      if (!rec) return sendJson(res, 404, { error: 'unknown run' });
      return sendJson(res, 200, { summary: rec.summary, events: rec.events });
    }

    if (req.method === 'POST' && p === '/api/links') {
      const body = await readJson(req);
      for (const family of ['ipv6', 'ipv4']) {
        const patch = body[family];
        if (!patch) continue;
        if (activeMode === 'sim') {
          if (patch.mode && !['accept', 'refuse', 'blackhole'].includes(patch.mode)) {
            return sendJson(res, 400, { error: `bad mode ${patch.mode}` });
          }
          simDialer.setLink(family, patch);
        } else {
          targetManager.setMode(family, patch.mode || 'accept');
        }
      }
      return sendJson(res, 200, {
        links: simDialer.describe(),
        real: targetManager.capabilities(),
      });
    }

    if (req.method === 'POST' && p === '/api/run-opts') {
      const body = await readJson(req);
      if (Number.isFinite(body.delayMs) && body.delayMs >= 0 && body.delayMs <= 10000) {
        runOpts.delayMs = body.delayMs;
      }
      if (Number.isFinite(body.connectTimeoutMs) && body.connectTimeoutMs >= 200) {
        runOpts.connectTimeoutMs = body.connectTimeoutMs;
      }
      if (Array.isArray(body.order) && body.order.length === 2 &&
          body.order.includes('ipv6') && body.order.includes('ipv4')) {
        runOpts.order = body.order;
      }
      return sendJson(res, 200, { runOpts });
    }

    if (req.method === 'POST' && p === '/api/runs/start') {
      const body = await readJson(req).catch(() => ({}));
      const supersede = body.supersede === true;
      if (activeRun && !supersede) {
        return sendJson(res, 409, { error: '已有运行中的连接；如需取代请用 supersede 或 /burst' });
      }
      const summary = await beginRun({ trigger: 'manual', supersede });
      return sendJson(res, 200, summary);
    }

    // Rapid-fire scenario: N runs in quick succession, each superseding the
    // previous one. Only the last should survive; all earlier ones get a
    // `superseded` completion reason on the timeline.
    if (req.method === 'POST' && p === '/api/runs/burst') {
      const body = await readJson(req).catch(() => ({}));
      const count = Math.min(Math.max(1, body.count | 0 || 3), 6);
      const gapMs = Math.min(Math.max(0, body.gapMs | 0), 2000);
      const ids = [];
      for (let i = 0; i < count; i++) {
        const p_ = beginRun({ trigger: `burst#${i + 1}`, supersede: true });
        ids.push(p_);
        if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
      }
      const summaries = await Promise.all(ids);
      return sendJson(res, 200, { summaries });
    }

    if (req.method === 'POST' && p === '/api/runs/cancel') {
      if (!activeRun) return sendJson(res, 409, { error: 'no active run' });
      activeRun.ac.abort(Object.assign(new Error('user cancelled'), { code: 'USER_CANCELLED' }));
      return sendJson(res, 202, { cancelling: activeRun.runId });
    }

    if (req.method === 'POST' && p === '/api/mode') {
      const body = await readJson(req);
      if (!['sim', 'real'].includes(body.mode)) return sendJson(res, 400, { error: 'bad mode' });
      if (activeRun) {
        return sendJson(res, 409, { error: 'stop the active run before switching mode' });
      }
      activeMode = body.mode;
      broadcast({ type: 'mode-changed', mode: activeMode, at: Date.now() });
      return sendJson(res, 200, { mode: activeMode, real: targetManager.capabilities() });
    }

    if (req.method === 'POST' && p === '/api/reset') {
      simDialer.links = structuredClone(DEFAULT_LINKS);
      runOpts = { ...DEFAULT_RUN_OPTS };
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

(async () => {
  await targetManager.start();
  server.listen(PORT, () => {
    console.log(`dualstack bench: http://localhost:${PORT}`);
    console.log('real endpoints:', targetManager.endpoints());
  });
})();

async function shutdown() {
  await targetManager.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
