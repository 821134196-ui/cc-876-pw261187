'use strict';

// RFC 8305 Happy Eyeballs racing engine, transport-agnostic.
// A dialer only needs: dial(family, signal) -> Promise<conn>, conn.close()
//
// Cancellation model: one root AbortController per run. Every attempt derives
// its signal from it, so user-cancel / supersede / race-loss all reach the
// dialer through a single channel.

const DEFAULT_OPTS = {
  delayMs: 250, // RFC 8305 recommended attachment delay before the fallback
  connectTimeoutMs: 4000, // per-attempt timeout; 0 disables
  order: ['ipv6', 'ipv4'], // preferred address order
};

const REASONS = {
  PRIMARY_WON: 'primary-won',
  FALLBACK_WON: 'fallback-won',
  PRIMARY_FAILED_FALLBACK_WON: 'primary-failed-fallback-won',
  ALL_FAILED: 'all-failed',
  TIMEOUT: 'timeout',
  USER_CANCELLED: 'user-cancelled',
  SUPERSEDED: 'superseded',
};

class DialAbortError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DialAbortError';
    this.code = code;
  }
}

function abortReason(reason, fallbackCode) {
  if (reason instanceof Error) return reason;
  if (reason && reason.code) return reason;
  return new DialAbortError(fallbackCode);
}

/**
 * Start one racing run.
 * @returns {{runId:string, cancel:Function, promise:Promise<object>}
 */
function startRun({ runId, dialer, opts = {}, signal, onEvent }) {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const [primaryFamily, fallbackFamily] = cfg.order;
  const root = new AbortController();
  const startedAt = Date.now();
  const t0 = () => Date.now() - startedAt;

  const state = {
    settled: false,
    winner: null,
    reason: null,
    attempts: new Map(), // family -> record
    timers: new Set(),
    fallbackStarted: false,
    sawTimeout: false,
  };

  const emit = (event) => onEvent({ ...event, runId, at: t0() });

  const later = (fn, ms) => {
    const handle = setTimeout(() => {
      state.timers.delete(handle);
      fn();
    }, ms);
    state.timers.add(handle);
    return handle;
  };

  const clearAllTimers = () => {
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
  };

  const summary = () => ({
    runId,
    status: state.winner ? 'connected' : 'failed',
    reason: state.reason,
    winner: state.winner,
    startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    attempts: [...state.attempts.values()].map((r) => ({
      family: r.family,
      phase: r.phase,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      elapsedMs: r.endedAt != null ? r.endedAt - r.startedAt : null,
      status: r.status,
      error: r.error || null,
    })),
  });

  function finish(reason) {
    if (state.settled) return;
    state.settled = true;
    state.reason = reason;
    clearAllTimers();
    if (signal) signal.removeEventListener('abort', onExternalAbort);

    for (const [family, rec] of state.attempts) {
      if (family === state.winner) continue;
      // Cancel every still-pending attempt; their rejections become no-ops.
      if (rec.status === 'connecting') {
        rec.ac.abort(new DialAbortError('RACE_LOST'));
      }
    }
    emit({ type: 'run-end', reason, winner: state.winner, summary: summary() });
  }

  function onExternalAbort() {
    const code = signal.reason && signal.reason.code;
    const reason = code === 'SUPERSEDED' ? REASONS.SUPERSEDED : REASONS.USER_CANCELLED;
    if (!state.settled) {
      finish(reason);
      root.abort(abortReason(signal.reason, code || 'USER_CANCELLED'));
    }
  }
  if (signal) {
    if (signal.aborted) queueMicrotask(onExternalAbort);
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  function winReason(family, rec) {
    if (family === fallbackFamily) {
      const primary = state.attempts.get(primaryFamily);
      if (primary && primary.status === 'failed') return REASONS.PRIMARY_FAILED_FALLBACK_WON;
      return REASONS.FALLBACK_WON;
    }
    return REASONS.PRIMARY_WON;
  }

  function startAttempt(family, phase) {
    // Each attempt gets its own controller so a per-attempt timeout does not
    // tear down the other attempt; it is linked to the run's root controller.
    const attemptAc = new AbortController();
    const onRootAbort = () => attemptAc.abort(root.signal.reason);
    if (root.signal.aborted) onRootAbort();
    else root.signal.addEventListener('abort', onRootAbort, { once: true });

    const rec = {
      family,
      phase,
      ac: attemptAc,
      status: 'connecting',
      startedAt: t0(),
      endedAt: null,
      error: null,
    };
    state.attempts.set(family, rec);
    emit({ type: 'attempt-start', family, phase });

    if (cfg.connectTimeoutMs > 0) {
      later(() => {
        if (rec.status !== 'connecting' || state.settled) return;
        state.sawTimeout = true;
        rec.error = 'TIMEOUT';
        emit({ type: 'attempt-timeout', family });
        attemptAc.abort(new DialAbortError('TIMEOUT'));
      }, cfg.connectTimeoutMs);
    }

    Promise.resolve()
      .then(() => dialer.dial(family, attemptAc.signal))
      .then(
        (conn) => {
          if (rec.status !== 'connecting') return; // timeout/abort already handled
          rec.status = 'connected';
          rec.endedAt = t0();
          emit({
            type: 'attempt-connected',
            family,
            elapsedMs: rec.endedAt - rec.startedAt,
          });
          if (state.settled) {
            // Lost the race before the promise resolved: engine cancels it.
            rec.status = 'cancelled';
            rec.endedAt = t0();
            rec.error = 'RACE_LOST';
            if (conn && typeof conn.close === 'function') conn.close();
            emit({ type: 'attempt-closed-race-lost', family });
            return;
          }
          state.winner = family;
          finish(winReason(family, rec));
        },
        (err) => {
          if (rec.status !== 'connecting') return; // per-attempt timeout already handled
          rec.endedAt = t0();
          if (state.settled) {
            // Root abort after the run ended (user cancel / supersede / race
            // loss): record the terminal state so the summary and timeline
            // never leave an attempt stuck at "connecting".
            rec.status = 'cancelled';
            rec.error = (err && err.code) || 'ABORTED';
            emit({ type: 'attempt-cancelled', family, error: rec.error });
            return;
          }
          rec.status = 'failed';
          rec.error = (err && err.code) || 'ERROR';
          emit({ type: 'attempt-failed', family, error: rec.error });

          if (phase === 'primary' && !state.fallbackStarted) {
            // Primary dead: bring the fallback forward instead of waiting.
            clearFallbackTimer();
            state.fallbackStarted = true;
            emit({ type: 'fallback-trigger', trigger: 'primary-failed' });
            startAttempt(fallbackFamily, 'fallback');
            return;
          }
          const primary = state.attempts.get(primaryFamily);
          const primaryDone = !primary || primary.status !== 'connecting';
          const fallback = state.attempts.get(fallbackFamily);
          const fallbackDone = !fallback || fallback.status !== 'connecting';
          if (primaryDone && fallbackDone) {
            finish(state.sawTimeout ? REASONS.TIMEOUT : REASONS.ALL_FAILED);
          }
        }
      );
  }

  let fallbackTimer = null;
  function clearFallbackTimer() {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      state.timers.delete(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function scheduleFallback() {
    if (cfg.delayMs <= 0) {
      state.fallbackStarted = true;
      emit({ type: 'fallback-trigger', trigger: 'no-delay' });
      startAttempt(fallbackFamily, 'fallback');
      return;
    }
    fallbackTimer = later(() => {
      fallbackTimer = null;
      if (state.settled || state.fallbackStarted) return;
      state.fallbackStarted = true;
      emit({ type: 'fallback-trigger', trigger: 'delay-elapsed', delayMs: cfg.delayMs });
      startAttempt(fallbackFamily, 'fallback');
    }, cfg.delayMs);
  }

  emit({
    type: 'run-start',
    order: cfg.order,
    delayMs: cfg.delayMs,
    connectTimeoutMs: cfg.connectTimeoutMs,
  });
  startAttempt(primaryFamily, 'primary');
  scheduleFallback();

  // Resolves once the run has settled (never rejects).
  const promise = new Promise((resolve) => {
    const tick = () => {
      if (state.settled) resolve(summary());
      else setImmediate(tick);
    };
    tick();
  });

  return {
    runId,
    cancel() {
      if (state.settled) return;
      finish(REASONS.USER_CANCELLED);
      root.abort(new DialAbortError('USER_CANCELLED'));
    },
    promise,
  };
}

module.exports = { startRun, REASONS, DEFAULT_OPTS, DialAbortError };
