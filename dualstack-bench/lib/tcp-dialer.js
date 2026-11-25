'use strict';

// Real TCP dialer against local loopback endpoints (127.0.0.1 / ::1).
// Reachability is real: an absent listener yields ECONNREFUSED, an open
// listener yields a genuine net.Socket. Latency / blackhole shaping needs
// root + iptables/tc, so those controls are disabled in real mode here;
// target-manager.js reports the capability honestly to the UI.

const net = require('node:net');

class TcpDialer {
  constructor(endpoints) {
    // endpoints: { ipv6: {host:'::1', port}, ipv4: {host:'127.0.0.1', port} }
    this.endpoints = endpoints;
  }

  dial(family, signal) {
    const ep = this.endpoints[family];
    if (!ep) return Promise.reject(Object.assign(new Error('no endpoint'), { code: 'EHOSTUNREACH' }));
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: ep.host, port: ep.port });
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        socket.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve({
          family,
          simulated: false,
          localEndpoint: `${family === 'ipv6' ? '[' + ep.host + ']' : ep.host}:${ep.port}`,
          connectedAt: Date.now(),
          socket,
          close() {
            socket.end();
            socket.destroy();
          },
        });
      });

      socket.once('error', (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }
}

module.exports = { TcpDialer };
