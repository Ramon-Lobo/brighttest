import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const studio = require('../lib/studio/server.js');

// Studio request guard (REL-02): loopback Host only, same-origin only, JSON-only mutating requests.
// No device is connected; /api/flow (writes a file under <root>/flows) is the observable side effect.
let server, port, root;
const FLOW = JSON.stringify({ file: 'x.e2e.yaml', text: 'appId: dev\nsteps:\n  - launch\n' });

function req(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const post = (headers, body = FLOW) => req('POST', '/api/flow', { headers: { 'Content-Type': 'application/json', ...headers }, body });
const written = () => fs.existsSync(path.join(root, 'flows', 'x.e2e.yaml'));
const clean = () => fs.rmSync(path.join(root, 'flows'), { recursive: true, force: true });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-guard-'));
  server = await studio.start({ port: 0, rootDir: root });
  port = server.address().port;
});
afterAll(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('studio Host guard', () => {
  it.each(['rebind.example:1', 'rebind.example', '10.0.0.5:8700', 'localhost.evil.example', '127.0.0.1.evil.example'])('rejects Host %s on every kind of route', async (h) => {
    for (const p of ['/api/device', '/', '/api/tree', '/api/flows']) expect((await req('GET', p, { headers: { Host: h } })).status).toBe(403);
    expect((await post({ Host: h })).status).toBe(403);
    expect(written()).toBe(false);
  });
  it.each([`127.0.0.1:PORT`, 'localhost:PORT', '[::1]:PORT', 'LOCALHOST:PORT', 'localhost.:PORT', 'localhost'])('allows Host %s', async (h) => {
    expect((await req('GET', '/api/device', { headers: { Host: h.replace('PORT', port) } })).status).toBe(200);
  });
});

describe('studio Origin / Sec-Fetch-Site guard', () => {
  const sameOrigin = () => `http://127.0.0.1:${port}`;
  it.each([
    ['cross-site Origin', () => ({ Origin: 'https://evil.example' })],
    ['Origin: null', () => ({ Origin: 'null' })],
    ['other local port', () => ({ Origin: 'http://localhost:9999' })],
    ['Sec-Fetch-Site: cross-site', () => ({ 'Sec-Fetch-Site': 'cross-site' })],
    ['Sec-Fetch-Site: same-site', () => ({ 'Sec-Fetch-Site': 'same-site' })],
  ])('rejects %s with 403 and no side effect', async (_n, h) => {
    expect((await post(h())).status).toBe(403);
    expect(written()).toBe(false);
  });
  it('rejects a cross-site GET too', async () => {
    expect((await req('GET', '/api/device', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });
  it.each([
    ['same-origin Origin', () => ({ Origin: sameOrigin() })],
    ['localhost same-origin Origin', () => ({ Origin: `http://localhost:${port}` })],
    ['Sec-Fetch-Site: same-origin, no Origin', () => ({ 'Sec-Fetch-Site': 'same-origin' })],
    ['no Origin headers (curl)', () => ({})],
  ])('allows %s', async (_n, h) => {
    clean();
    expect((await post(h())).status).toBe(200);
    expect(written()).toBe(true);
    clean();
  });
});

describe('studio JSON-only mutating requests', () => {
  const routes = ['/api/connect', '/api/flow', '/api/keypress', '/api/perf/start', '/api/perf/stop', '/api/perf/marker', '/api/perf/console', '/api/launch', '/api/perf/perfetto/start'];
  const types = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null];
  for (const route of routes) {
    it(`${route} rejects non-JSON content types with 415`, async () => {
      for (const t of types) {
        const headers = t ? { 'Content-Type': t } : {};
        expect((await req('POST', route, { headers, body: FLOW })).status).toBe(415);
      }
    });
  }
  it('does not write a flow for a text/plain POST', async () => {
    clean();
    expect((await req('POST', '/api/flow', { headers: { 'Content-Type': 'text/plain' }, body: FLOW })).status).toBe(415);
    expect(written()).toBe(false);
  });
  it('accepts application/json with a charset', async () => {
    clean();
    expect((await post({ 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200);
    clean();
  });
  it('still lets the .bsprof import send application/octet-stream (past the guard)', async () => {
    const r = await req('POST', '/api/perf/bsprof', { headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' });
    expect(r.status).not.toBe(415);
    expect(r.status).not.toBe(403);
  });
  it('does not allow octet-stream on other routes', async () => {
    expect((await req('POST', '/api/flow', { headers: { 'Content-Type': 'application/octet-stream' }, body: FLOW })).status).toBe(415);
  });
});
