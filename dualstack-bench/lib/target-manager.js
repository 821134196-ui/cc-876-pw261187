'use strict';

// Manages the two real local TCP endpoints used in "real" mode:
//   IPv6 -> ::1:<port>     IPv4 -> 127.0.0.1:<port>
// A family in `accept` mode has a listening server; `refuse` mode stops the
// listener so new connections get a genuine ECONNREFUSED. Re-enabling
// `accept` re-listens on the SAME port, so the dialer's endpoint never goes
// stale. Blackhole/latency shaping needs root-owned iptables/tc and is
// reported as unsupported in this unprivileged sandbox.

const net = require('node:net');

class TargetManager {
  constructor() {
    this.servers = { ipv6: null, ipv4: null };
    this.hosts = { ipv6: '::1', ipv4: '127.0.0.1' };
    this.ports = { ipv6: null, ipv4: null };
    this.modes = { ipv6: 'accept', ipv4: 'accept' };
  }

  async start() {
    await this._listen('ipv6');
    await this._listen('ipv4');
  }

  _listen(family) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        sock.on('error', () => {});
        sock.end('ok\n');
      });
      server.on('error', reject);
      const port = this.ports[family] || 0;
      server.listen(port, this.hosts[family], () => {
        this.servers[family] = server;
        this.ports[family] = server.address().port; // fixed from now on
        resolve();
      });
    });
  }

  setMode(family, mode) {
    if (!['accept', 'refuse'].includes(mode)) {
      throw new Error(`real mode supports accept|refuse, got ${mode}`);
    }
    this.modes[family] = mode;
    const server = this.servers[family];
    if (!server) return;
    if (mode === 'accept' && !server.listening) {
      server.listen(this.ports[family], this.hosts[family]);
    } else if (mode === 'refuse' && server.listening) {
      // Existing sockets finish; new SYNs to this port are refused by the kernel.
      server.close();
    }
  }

  endpoints() {
    return {
      ipv6: { host: this.hosts.ipv6, port: this.ports.ipv6 },
      ipv4: { host: this.hosts.ipv4, port: this.ports.ipv4 },
    };
  }

  capabilities() {
    return {
      mode: 'real',
      supportsModes: ['accept', 'refuse'],
      supportsLatency: false,
      supportsBlackhole: false,
      note: '真实回环端点；无 root 权限，延迟/黑洞（iptables/tc）不可用，refuse 为真实 ECONNREFUSED。',
      endpoints: this.endpoints(),
      modes: { ...this.modes },
    };
  }

  async stop() {
    await Promise.all(
      Object.values(this.servers).map(
        (s) =>
          new Promise((resolve) => {
            if (!s) return resolve();
            if (s.listening) s.close(() => resolve());
            else resolve();
          })
      )
    );
  }
}

module.exports = { TargetManager };
