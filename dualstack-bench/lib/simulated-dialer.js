'use strict';

// Simulated link dialer: deterministic reachability and latency control with
// zero privileges. The racing engine cannot tell it from a real socket — the
// same code path runs against the real TCP dialer.
//
// Link modes per family:
//   accept     — connects after `latencyMs`
//   refuse     — rejects after `latencyMs` with ECONNREFUSED (RST equivalent)
//   blackhole  — never answers; only the engine's connect timeout ends it
//
// Every pending timer is tracked so abort cancels cleanly (no leaked handles).

const MODES = ['accept', 'refuse', 'blackhole'];

class SimulatedDialer {
  constructor(links) {
    // links: { ipv6: {mode, latencyMs}, ipv4: {...} }
    this.links = links;
    this.pending = new Set(); // timeout handles of in-flight dials
  }

  setLink(family, patch) {
    this.links[family] = { ...this.links[family], ...patch };
  }

  describe() {
    return JSON.parse(JSON.stringify(this.links));
  }

  dial(family, signal) {
    const link = this.links[family];
    if (!link) return Promise.reject(Object.assign(new Error('no link'), { code: 'EHOSTUNREACH' }));
    if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));

    return new Promise((resolve, reject) => {
      let handle;
      const cleanup = () => {
        this.pending.delete(handle);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (handle) clearTimeout(handle);
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      if (link.mode === 'blackhole') {
        // Intentionally no timer: the engine's connect timeout (or an abort)
        // is the only thing that ends this attempt.
        return;
      }

      handle = setTimeout(() => {
        cleanup();
        if (link.mode === 'accept') {
          resolve({
            family,
            simulated: true,
            localEndpoint: family === 'ipv6' ? '[::1]:sim' : '127.0.0.1:sim',
            connectedAt: Date.now(),
            close() {
              this.closed = true;
            },
          });
        } else {
          reject(Object.assign(new Error(`simulated ${link.mode}`), { code: 'ECONNREFUSED' }));
        }
      }, Math.max(0, link.latencyMs | 0));
      this.pending.add(handle);
    });
  }

  hasPending() {
    return this.pending.size > 0;
  }
}

module.exports = { SimulatedDialer, MODES };
