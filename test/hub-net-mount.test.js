import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import net from 'net';

const require = createRequire(import.meta.url);
const { startHub } = require('../lib/instrument/hub.js');
const { createNetProxy } = require('../lib/instrument/net-proxy.js');
const { request } = require('./fixtures/net/harness.js');
const { createOrigin } = require('./fixtures/fake-origin/server.js');

const TOKEN = 'tok-mount-0123456789';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function setup({ proxyOpts = {}, lease, hubOpts = {}, withProxy = true } = {}) {
  const o = createOrigin({ port: 0 });
  const info = await o.start();
  cleanups.push(() => o.stop());
  const events = [];
  const proxy = createNetProxy({ emit: (kind, data) => events.push({ kind, data }), upstreamHosts: [`127.0.0.1:${info.port}`], unmatched: 'passthrough', ...proxyOpts });
  cleanups.push(() => proxy.close());
  const l = lease || { held: () => true, onLost() {}, leaseId: 'l1' };
  const hub = await startHub({ lease: l, tokens: [TOKEN], ...(withProxy ? { netProxy: proxy } : {}), ...hubOpts });
  cleanups.push(() => hub.stop());
  return { hub, proxy, events, origin: `http://127.0.0.1:${info.port}`, base: `http://127.0.0.1:${hub.port}/bt/${TOKEN}/net/;` };
}

describe('hub mounts net-proxy at /bt/<token>/net/;<url>', () => {
  it('proxies a GET to the fake origin (query kept) and records net events', async () => {
    const s = await setup();
    const r = await request(`${s.base}${s.origin}/home?x=1`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).rails).toBeTruthy();
    expect(s.events.map((e) => e.kind)).toContain('net.request');
  });
  it('serves a mock rule through the hub (TP-NET-03 hub part)', async () => {
    const s = await setup();
    s.proxy.ruleSet.addConfig([{ id: 'm', url: 'https://api.test/v1/*', json: { ok: true } }]);
    const r = await request(`${s.base}https://api.test/v1/a`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(s.events.find((e) => e.kind === 'net.request').data.rule).toBe('m');
  });
  it('POST bodies pass through', async () => {
    const s = await setup();
    const r = await request(`${s.base}${s.origin}/echo`, { method: 'POST', body: 'hi' });
    expect(JSON.parse(r.body).body).toBe('hi');
  });
  it('wrong token and wrong peer get the same bare 404', async () => {
    const s = await setup();
    const bad = await request(`http://127.0.0.1:${s.hub.port}/bt/nope/net/;${s.origin}/home`);
    expect(bad.status).toBe(404);
    expect(bad.body).toBe('');
    const off = await setup({ hubOpts: { peerOf: () => '10.9.9.9' } });
    expect((await request(`${off.base}${off.origin}/home`)).status).toBe(404);
    expect(s.events.length).toBe(0);
  });
  it('only the documented form is accepted', async () => {
    const s = await setup();
    const root = `http://127.0.0.1:${s.hub.port}/bt/${TOKEN}`;
    for (const p of ['/net', '/net/', '/net/;', `/net/${s.origin}/home`, '/netx/;http://a/b', '/net/x/;http://a/b']) {
      const r = await request(`${root}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.body).toBe('');
    }
    expect(s.events.length).toBe(0);
  });
  it('without a netProxy the route answers 404', async () => {
    const s = await setup({ withProxy: false });
    expect((await request(`${s.base}${s.origin}/home`)).status).toBe(404);
  });
  it('a lost lease answers 423 and does not reach the proxy', async () => {
    let held = true;
    const s = await setup({ lease: { held: () => held, onLost() {}, leaseId: 'l2' } });
    held = false;
    expect((await request(`${s.base}${s.origin}/home`)).status).toBe(423);
    expect(s.events.length).toBe(0);
  });
  it('existing routes still work with the proxy mounted', async () => {
    const s = await setup();
    const r = await request(`http://127.0.0.1:${s.hub.port}/bt/${TOKEN}/hello`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).netBase).toBe(`/bt/${TOKEN}/net/;`);
  });
  it('SSRF: a private or loopback target not on the allow-list is refused through the hub', async () => {
    const s = await setup({ proxyOpts: { upstreamHosts: ['api.test'] } });
    const hits = [];
    const srv = net.createServer((c) => { hits.push(1); c.destroy(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => srv.close(r)));
    const port = srv.address().port;
    for (const t of [`http://127.0.0.1:${port}/x`, `http://localhost:${port}/x`, 'http://169.254.169.254/latest', 'http://[::1]/x', 'http://10.0.0.5/x']) {
      const r = await request(`${s.base}${t}`);
      expect(r.status, t).toBeGreaterThanOrEqual(400);
      expect(r.status, t).not.toBe(200);
    }
    expect(hits.length).toBe(0);
    expect(s.events.some((e) => e.kind === 'net.error')).toBe(true);
  });
  it('CONNECT is refused with 405 when mounted', async () => {
    const s = await setup();
    const out = await new Promise((resolve) => {
      const c = net.connect(s.hub.port, '127.0.0.1', () => c.write('CONNECT example.test:443 HTTP/1.1\r\nhost: example.test:443\r\n\r\n'));
      let buf = ''; c.on('data', (d) => { buf += d; }); c.on('close', () => resolve(buf)); c.on('error', () => resolve(buf));
      setTimeout(() => { c.destroy(); }, 3000);
    });
    expect(out).toMatch(/405/);
  });
});
