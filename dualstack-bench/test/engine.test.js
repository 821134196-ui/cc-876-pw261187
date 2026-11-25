'use strict';

// Zero-dependency tests for the Happy Eyeballs engine and dialers.
// Run: node test/engine.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { startRun, REASONS } = require('../lib/happy-eyeballs');
const { SimulatedDialer } = require('../lib/simulated-dialer');

let seq = 0;
function run(dialer, opts, signal) {
  return startRun({
    runId: `t-${++seq}`,
    dialer,
    opts: { delayMs: 250, connectTimeoutMs: 4000, ...opts },
    signal,
    onEvent: () => {},
  });
}

const links = (v6, v4) =>
  new SimulatedDialer({
    ipv6: { mode: v6[0], latencyMs: v6[1] },
    ipv4: { mode: v4[0], latencyMs: v4[1] },
  });

test('首选 IPv6 快速成功 → primary-won，不发起替代连接', async () => {
  const d = links(['accept', 30], ['accept', 120]);
  const events = [];
  const h = startRun({
    runId: 'r1', dialer: d,
    opts: { delayMs: 250, connectTimeoutMs: 4000 },
    onEvent: (e) => events.push(e),
  });
  const s = await h.promise;
  assert.equal(s.status, 'connected');
  assert.equal(s.reason, REASONS.PRIMARY_WON);
  assert.equal(s.winner, 'ipv6');
  assert.equal(events.filter((e) => e.type === 'attempt-start').length, 1);
  assert.ok(!events.some((e) => e.type === 'fallback-trigger'));
});

test('首选慢、延迟到期 → 替代连接胜出（fallback-won）', async () => {
  const d = links(['accept', 800], ['accept', 60]);
  const s = await run(d, { delayMs: 200 }).promise;
  assert.equal(s.reason, REASONS.FALLBACK_WON);
  assert.equal(s.winner, 'ipv4');
  // IPv6 仍在挂起时必须被引擎取消，且无定时器残留
  assert.equal(d.hasPending(), false);
});

test('首选立即失败 → 提前拉起替代连接并胜出', async () => {
  const d = links(['refuse', 10], ['accept', 80]);
  const s = await run(d, { delayMs: 500 }).promise;
  assert.equal(s.reason, REASONS.PRIMARY_FAILED_FALLBACK_WON);
  assert.equal(s.winner, 'ipv4');
});

test('两路都失败 → all-failed', async () => {
  const d = links(['refuse', 10], ['refuse', 20]);
  const s = await run(d).promise;
  assert.equal(s.status, 'failed');
  assert.equal(s.reason, REASONS.ALL_FAILED);
});

test('黑洞 → 连接超时 reason=timeout', async () => {
  const d = links(['blackhole', 0], ['blackhole', 0]);
  const s = await run(d, { delayMs: 100, connectTimeoutMs: 400 }).promise;
  assert.equal(s.reason, REASONS.TIMEOUT);
  assert.equal(d.hasPending(), false);
});

test('用户取消 → user-cancelled，挂起尝试全部中止', async () => {
  const d = links(['accept', 2000], ['accept', 2000]);
  const h = run(d, { delayMs: 300 });
  setTimeout(() => h.cancel(), 100);
  const s = await h.promise;
  assert.equal(s.reason, REASONS.USER_CANCELLED);
  assert.equal(s.status, 'failed');
  assert.equal(d.hasPending(), false);
  const stillConnecting = s.attempts.filter((a) => a.status === 'connecting');
  assert.equal(stillConnecting.length, 0);
});

test('外部 AbortSignal（SUPERSEDED）→ superseded', async () => {
  const d = links(['accept', 2000], ['accept', 2000]);
  const ac = new AbortController();
  const h = run(d, {}, ac.signal);
  setTimeout(() => ac.abort(Object.assign(new Error('superseded'), { code: 'SUPERSEDED' })), 50);
  const s = await h.promise;
  assert.equal(s.reason, REASONS.SUPERSEDED);
  assert.equal(d.hasPending(), false);
});

test('胜出后落选的已建立连接被 close（race-lost 路径）', async () => {
  // 两路在同一个微任务批次内都已建立：先 settle 的赢，另一条已建立的
  // 连接必须被引擎 close（而不是泄漏）。
  const closed = [];
  const conn = (family) => ({
    family,
    close() { closed.push(family); },
  });
  const dialer = {
    dial: (family) => Promise.resolve(conn(family)),
  };
  const h = startRun({
    runId: 'r-close', dialer,
    opts: { delayMs: 0, connectTimeoutMs: 4000, order: ['ipv6', 'ipv4'] },
    onEvent: () => {},
  });
  const s = await h.promise;
  assert.equal(s.winner, 'ipv6');
  assert.ok(closed.includes('ipv4'), '落选的 IPv4 连接必须被取消');
  const v4 = s.attempts.find((a) => a.family === 'ipv4');
  assert.equal(v4.status, 'cancelled');
  assert.equal(v4.error, 'RACE_LOST');
});

test('delayMs=0 → 两路并行发起', async () => {
  const d = links(['accept', 300], ['accept', 50]);
  const events = [];
  const h = startRun({
    runId: 'r-parallel', dialer: d,
    opts: { delayMs: 0, connectTimeoutMs: 4000 },
    onEvent: (e) => events.push(e),
  });
  const s = await h.promise;
  assert.equal(s.winner, 'ipv4');
  const starts = events.filter((e) => e.type === 'attempt-start');
  assert.equal(starts.length, 2);
  assert.ok(Math.abs(starts[1].at - starts[0].at) < 5);
});

test('IPv4 优先顺序生效', async () => {
  const d = links(['accept', 300], ['accept', 20]);
  const s = await run(d, { order: ['ipv4', 'ipv6'] }).promise;
  assert.equal(s.winner, 'ipv4');
  assert.equal(s.reason, REASONS.PRIMARY_WON);
});

test('快速连续取代：仅最后一次存活，其余全部 superseded', async () => {
  const d = links(['accept', 2000], ['accept', 2000]);
  const handles = [];
  const summaries = [];
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController();
    const h = run(d, {}, ac.signal);
    handles.push({ h, ac });
    summaries.push(h.promise.then((s) => s));
    await new Promise((r) => setTimeout(r, 40));
    if (i < 2) handles[i].ac.abort(Object.assign(new Error('superseded'), { code: 'SUPERSEDED' }));
  }
  handles[2].h.cancel();
  const results = await Promise.all(summaries);
  assert.equal(results[0].reason, REASONS.SUPERSEDED);
  assert.equal(results[1].reason, REASONS.SUPERSEDED);
  assert.equal(results[2].reason, REASONS.USER_CANCELLED);
  assert.equal(d.hasPending(), false);
});

test('取消一个已结束的 run 是幂等 no-op', async () => {
  const d = links(['accept', 10], ['refuse', 10]);
  const h = run(d);
  const s = await h.promise;
  h.cancel();
  assert.equal(s.reason, REASONS.PRIMARY_WON);
});
