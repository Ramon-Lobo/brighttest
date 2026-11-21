'use strict';
// Loopback-only harness for net-proxy tests and the TP-NET hub-side cases: a bare http server that mounts
// createNetProxy at /bt/<token>/net/;<url> (the hub does the same once it mounts the route). Close it in teardown.
const http = require('http');
const { createNetProxy, targetFromPath, refuseConnect } = require('../../../lib/instrument/net-proxy.js');

async function startHarness(opts = {}) {
  const events = [];
  const proxy = createNetProxy({ emit: (kind, data) => events.push({ kind, data }), ...opts });
  const token = 'tok-harness';
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const target = req.url.startsWith(`/bt/${token}/`) ? targetFromPath(req.url) : null;
    if (target === null) { res.writeHead(404); res.end(); return; }
    proxy.handle(req, res, target).catch(() => res.destroy());
  });
  server.on('connect', refuseConnect);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    proxy, events, port, token,
    base: `http://127.0.0.1:${port}/bt/${token}/net/;`,
    async stop() {
      proxy.close();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

// Plain http GET/POST returning {status, headers, body} or {error} (socket closed with no response).
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ error: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(body);
  });
}

module.exports = { startHarness, request };
