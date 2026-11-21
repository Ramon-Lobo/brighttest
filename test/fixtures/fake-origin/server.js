#!/usr/bin/env node
'use strict';
// FX-ORIGIN: zero-dependency fake HTTP origin for brighttest tests and packs.
//   node test/fixtures/fake-origin/server.js [--host 127.0.0.1] [--port 8787] [--log requests.ndjson]
// Binds to loopback by default; a LAN bind needs an explicit --host. Port 0 picks a free port.
const http = require('http');
const fs = require('fs');

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const CATALOG = [
  { id: 'a1', title: 'Item One', year: 2001 },
  { id: 'b2', title: 'Item Two', year: 2002 },
  { id: 'c3', title: 'Item Three', year: 2003 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createOrigin({ host = '127.0.0.1', port = 8787, logFile } = {}) {
  const log = [];
  const sockets = new Set();

  function record(req, bodySize) {
    const headers = { ...req.headers };
    if (headers.authorization !== undefined) headers.authorization = '[redacted]';
    const entry = { time: new Date().toISOString(), method: req.method, path: req.url, headers, bodySize };
    log.push(entry);
    if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }

  function send(res, status, body, type = 'application/json', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...extra });
    res.end(buf);
  }

  async function route(req, res, url, body) {
    const p = url.pathname;
    const q = url.searchParams;
    const m = req.method;
    if (m === 'GET' && p === '/home') return send(res, 200, { rails: [{ id: 'r1', title: 'Featured', items: CATALOG.map((c) => c.id) }] });
    if (m === 'GET' && p === '/catalog') return send(res, 200, { items: CATALOG });
    let mm = p.match(/^\/catalog\/([^/]+)$/);
    if (m === 'GET' && mm) {
      const item = CATALOG.find((c) => c.id === mm[1]);
      return item ? send(res, 200, item) : send(res, 404, { error: 'not found' });
    }
    if (m === 'GET' && p === '/search') {
      const term = (q.get('q') || '').toLowerCase();
      return send(res, 200, { q: q.get('q') || '', results: CATALOG.filter((c) => c.title.toLowerCase().includes(term)) });
    }
    if (m === 'POST' && p === '/echo') return send(res, 200, { method: m, path: p, headers: req.headers, body: body.toString('utf8') });
    if (m === 'POST' && p === '/track') return send(res, 204, '');
    if (m === 'GET' && p === '/auth') {
      return req.headers.authorization ? send(res, 200, { ok: true }) : send(res, 401, { error: 'missing Authorization' }, 'application/json', { 'WWW-Authenticate': 'Bearer' });
    }
    if (m === 'GET' && p === '/image.png') return send(res, 200, PNG, 'image/png');
    if (p === '/slow') { await sleep(Number(q.get('ms')) || 1000); return send(res, 200, { slow: true }); }
    if (p === '/stall') return; // accept, never answer
    if (p === '/reset') return req.socket.destroy();
    if (p === '/redirect') {
      const n = Number(q.get('n')) || 1;
      const to = q.get('to') || '/home';
      const next = n > 1 ? `/redirect?to=${encodeURIComponent(to)}&n=${n - 1}` : to;
      return send(res, 302, '', 'text/plain', { Location: next });
    }
    mm = p.match(/^\/status\/(\d{3})$/);
    if (mm) {
      const code = Number(mm[1]);
      const noBody = code === 204 || code === 304 || code < 200;
      return send(res, code, noBody ? '' : { status: code });
    }
    if (p === '/large') return send(res, 200, Buffer.alloc((Number(q.get('kb')) || 1) * 1024, 0x61), 'application/octet-stream');
    if (p === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const count = Number(q.get('n')) || 3;
      for (let i = 1; i <= count; i++) res.write(`id: ${i}\nevent: tick\ndata: {"n":${i}}\n\n`);
      return res.end();
    }
    mm = p.match(/^\/file\/([^/]+)$/);
    if (m === 'GET' && mm) {
      const name = decodeURIComponent(mm[1]);
      const data = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) data[i] = i;
      return send(res, 200, data, 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"` });
    }
    return send(res, 404, { error: 'no route', path: p });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      record(req, body.length);
      let url;
      try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'bad url' }); }
      Promise.resolve(route(req, res, url, body)).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }); });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return {
    server,
    log,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const a = server.address();
          resolve({ host: a.address, port: a.port, url: `http://${a.address}:${a.port}` });
        });
      });
    },
    stop() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') o.host = argv[++i];
    else if (argv[i] === '--port') o.port = Number(argv[++i]);
    else if (argv[i] === '--log') o.logFile = argv[++i];
  }
  return o;
}

if (require.main === module) {
  const origin = createOrigin(parseArgs(process.argv.slice(2)));
  origin.start().then((a) => console.log(`fake-origin listening on ${a.url}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => origin.stop().then(() => process.exit(0)));
}

module.exports = { createOrigin, parseArgs };
