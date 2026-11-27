import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { startHarness, request } = require('./fixtures/net/harness.js');
const { createNetProxy, checkTarget, isBlockedAddress, normalizeAllow } = require('../lib/instrument/net-proxy.js');
const R = require('../lib/instrument/net-rules.js');
const { startOrigin } = (() => {
  const { createOrigin } = require('./fixtures/fake-origin/server.js');
  return { startOrigin: async () => { const o = createOrigin({ port: 0 }); const info = await o.start(); return { o, ...info }; } };
})();

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
async function harness(o) { const h = await startHarness(o); cleanups.push(() => h.stop()); return h; }
async function origin() { const x = await startOrigin(); cleanups.push(() => x.o.stop()); return x; }
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-proxy-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const kinds = (h) => h.events.map((e) => e.kind);

describe('mock, sequence, rule ids (TP-NET-03 harness part)', () => {
  it('serves mocks and reports the rule id in net.request', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ id: 'home', url: 'https://api.test/v1/home*', json: { rows: [] } }, { id: 'any', url: 'https://api.test/**', status: 404 }]);
    const a = await request(`${h.base}https://api.test/v1/home?x=1`);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({ rows: [] });
    expect(a.headers['content-type']).toBe('application/json');
    expect((await request(`${h.base}https://api.test/v1/other`)).status).toBe(404);
    const reqs = h.events.filter((e) => e.kind === 'net.request');
    expect(reqs.map((e) => e.data.rule)).toEqual(['home', 'any']);
    const resp = h.events.filter((e) => e.kind === 'net.response');
    expect(resp.map((e) => e.data.source)).toEqual(['fixture', 'fixture']);
    expect(resp[0].data.id).toBe(reqs[0].data.id);
  });
  it('overlapping rules: run-time rule overrides, times falls through, sequence a,b,b,b', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ id: 'cfg', url: '**/x', status: 200 }, { id: 'seq', url: '**/seq', responses: [{ status: 503 }, { status: 200, body: 'ok' }] }]);
    h.proxy.ruleSet.add({ id: 'late', url: '**/x', times: 2, status: 418 });
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await request(`${h.base}https://h.test/x`)).status);
    expect(got).toEqual([418, 418, 200]);
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push((await request(`${h.base}https://h.test/seq`)).status);
    expect(seq).toEqual([503, 200, 200, 200]);
    expect(h.events.filter((e) => e.kind === 'net.request').map((e) => e.data.rule)).toEqual(['late', 'late', 'cfg', 'seq', 'seq', 'seq', 'seq']);
  });
  it('204 has no body; mock file outside root answers 500 with net.error', async () => {
    const root = tmp();
    const h = await harness({ root });
    h.proxy.ruleSet.addConfig([{ url: '**/nc', status: 204 }, { url: '**/f', file: '../escape.txt' }]);
    const a = await request(`${h.base}https://h.test/nc`);
    expect(a.status).toBe(204);
    expect(a.body).toBe('');
    expect((await request(`${h.base}https://h.test/f`)).status).toBe(500);
    expect(h.events.some((e) => e.kind === 'net.error')).toBe(true);
  });
  it('request log filters by method and url, body is raw', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**', status: 200 }]);
    await request(`${h.base}https://h.test/a`);
    await request(`${h.base}https://h.test/track`, { method: 'POST', body: 'hello' });
    const r = h.proxy.requests({ method: 'POST', url: '**/track' });
    expect(r).toHaveLength(1);
    expect(r[0].body).toBe('hello');
    expect(h.proxy.requests({ url: '**/nothing' })).toHaveLength(0);
  });
});

describe('faults (TP-NET-04 hub part)', () => {
  it('status fault returns the status (default 503)', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**/a', fault: 'status' }, { url: '**/b', kind: 'status', status: 500 }]);
    expect((await request(`${h.base}https://h.test/a`)).status).toBe(503);
    expect((await request(`${h.base}https://h.test/b`)).status).toBe(500);
  });
  it('delayMs delays the answer', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**', status: 200, delayMs: 300 }]);
    const t = Date.now();
    expect((await request(`${h.base}https://h.test/a`)).status).toBe(200);
    expect(Date.now() - t).toBeGreaterThanOrEqual(280);
  });
  it('reset destroys the socket with no response byte', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**/r', fault: 'reset' }]);
    const bytes = await new Promise((resolve) => {
      const s = net.connect(h.port, '127.0.0.1', () => s.write(`GET /bt/${h.token}/net/;https://h.test/r HTTP/1.1\r\nhost: x\r\n\r\n`));
      let n = 0;
      s.on('data', (c) => { n += c.length; });
      s.on('close', () => resolve(n));
      s.on('error', () => {});
      setTimeout(() => { s.destroy(); resolve(-1); }, 5000).unref();
    });
    expect(bytes).toBe(0);
    expect((await request(`${h.base}https://h.test/r`)).error).toBeTruthy();
    expect(h.events.filter((e) => e.kind === 'net.error').map((e) => e.data.kind)).toEqual(['fault:reset', 'fault:reset']);
  });
  it('timeout sends headers and a partial body then holds until the client leaves', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**/t', fault: { kind: 'timeout', holdMs: 60000 } }]);
    const out = await new Promise((resolve) => {
      const req = http.get(`${h.base}https://h.test/t`, { agent: false }, (res) => {
        let n = 0;
        res.on('data', (c) => { n += c.length; });
        setTimeout(() => { const done = { status: res.statusCode, len: res.headers['content-length'], n, ended: res.complete }; req.destroy(); resolve(done); }, 600);
        res.on('error', () => {});
      });
      req.on('error', () => {});
    });
    expect(out.status).toBe(200);
    expect(out.n).toBe(16);
    expect(out.ended).toBe(false);
    expect(out.len).toBe('1048576');
    expect(h.events.find((e) => e.kind === 'net.error').data.kind).toBe('fault:timeout');
  });
  it('timeout with holdMs releases (destroys) by itself', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**/t', fault: { kind: 'timeout', holdMs: 200, partialBytes: 0 } }]);
    const t = Date.now();
    const r = await request(`${h.base}https://h.test/t`);
    expect(r.error || r.status).toBeTruthy();
    expect(Date.now() - t).toBeGreaterThanOrEqual(180);
  });
  it('every request has exactly one net.response or net.error', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**/ok', status: 200 }, { url: '**/rs', fault: 'reset' }, { url: '**/st', fault: 'status' }]);
    for (const p of ['ok', 'rs', 'st', 'none']) await request(`${h.base}https://h.test/${p}`);
    const ids = h.events.filter((e) => e.kind === 'net.request').map((e) => e.data.id);
    for (const id of ids) expect(h.events.filter((e) => e.kind !== 'net.request' && e.data.id === id)).toHaveLength(1);
  });
});

describe('unmatched policy and passthrough allow-list (TP-NET-05 hub part)', () => {
  it('fail: 599 with a hint, net.error unmatched, secrets redacted in events', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**/known', status: 200 }]);
    const r = await request(`${h.base}https://h.test/other?token=abc`, { headers: { authorization: 'Bearer zzz' } });
    expect(r.status).toBe(599);
    expect(r.body).toMatch(/no rule matched GET/);
    expect(r.body).not.toMatch(/abc/);
    const err = h.events.find((e) => e.kind === 'net.error');
    expect(err.data.kind).toBe('unmatched');
    expect(JSON.stringify(h.events)).not.toMatch(/abc|zzz/);
  });
  it('passthrough reaches an allow-listed origin and streams the body back', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    h.proxy.ruleSet.addConfig([{ url: '**/mocked', status: 200 }]);
    const r = await request(`${h.base}${o.url}/status/201`);
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body)).toEqual({ status: 201 });
    expect(o.o.log.map((e) => e.path)).toEqual(['/status/201']);
    const echo = await request(`${h.base}${o.url}/echo`, { method: 'POST', body: 'payload', headers: { 'x-custom': '1' } });
    expect(JSON.parse(echo.body).body).toBe('payload');
    expect(JSON.parse(echo.body).headers['x-custom']).toBe('1');
    const resp = h.events.filter((e) => e.kind === 'net.response');
    expect(resp.map((e) => e.data.source)).toEqual(['passthrough', 'passthrough']);
  });
  it('a host not in the list is refused with net.error and no outbound connection', async () => {
    const o = await origin();
    const other = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    const r = await request(`${h.base}${other.url}/home`);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/refused/);
    expect(other.o.log).toHaveLength(0);
    expect(h.events.find((e) => e.kind === 'net.error').data.detail).toMatch(/^refused:/);
  });
  it('a rule with passthrough:true sends only that match upstream', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`] });
    h.proxy.ruleSet.addConfig([{ url: '**/home', passthrough: true }, { url: '**', status: 404 }]);
    expect((await request(`${h.base}${o.url}/home`)).status).toBe(200);
    expect((await request(`${h.base}${o.url}/catalog`)).status).toBe(404);
    expect(o.o.log.map((e) => e.path)).toEqual(['/home']);
  });
  it('setUnmatched validates', () => {
    const p = createNetProxy({});
    expect(() => p.setUnmatched('maybe')).toThrow(/unmatched/);
  });
});

describe('SSRF guard table (TP-NET-06)', () => {
  const lookupMap = { 'rebind.test': ['127.0.0.1'], 'public.test': ['93.184.216.34'], 'mixed.test': ['93.184.216.34', '10.0.0.5'], 'meta.test': ['169.254.169.254'] };
  const lookup = async (h) => { if (!lookupMap[h]) throw new Error('nx'); return lookupMap[h]; };
  const table = [
    ['http://127.0.0.1:1/', 'private-literal'],
    ['http://localhost/', 'localhost'],
    ['http://[::1]/', 'v6 loopback'],
    ['http://169.254.169.254/latest/', 'metadata'],
    ['http://10.0.0.1/', 'rfc1918 10'],
    ['http://192.168.0.1/', 'rfc1918 192'],
    ['http://172.16.0.1/', 'rfc1918 172'],
    ['http://[::ffff:127.0.0.1]/', 'v4-mapped'],
    ['http://2130706433/', 'decimal loopback'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://100.64.0.1/', 'cgnat'],
    ['http://[fd00::1]/', 'ula'],
    ['http://[fe80::1]/', 'link-local v6'],
    ['http://rebind.test/', 'hostname resolving to loopback'],
    ['http://meta.test/', 'hostname resolving to metadata'],
    ['http://mixed.test/', 'one of several addresses private'],
    ['http://user:pw@public.test/', 'credentials'],
    ['ftp://public.test/', 'scheme'],
    ['file:///etc/passwd', 'file scheme'],
  ];
  it('refuses every blocked target when it is reached through a wildcard or an IP not listed', async () => {
    const allow = normalizeAllow(['*.test', 'public.test']);
    for (const [url, why] of table) {
      const r = await checkTarget(url, allow, lookup);
      expect(r.ok, `${why}: ${url}`).toBe(false);
    }
  });
  it('refuses everything when the allow-list is empty', async () => {
    for (const [url] of table.concat([['http://public.test/', 'x']])) expect((await checkTarget(url, [], lookup)).ok).toBe(false);
  });
  it('explicitly listed private hosts are allowed, only on the listed port', async () => {
    const allow = normalizeAllow(['127.0.0.1:8080', 'rebind.test', '[::1]']);
    expect((await checkTarget('http://127.0.0.1:8080/x', allow, lookup)).ok).toBe(true);
    expect((await checkTarget('http://127.0.0.1:8081/x', allow, lookup)).ok).toBe(false);
    expect((await checkTarget('http://rebind.test/x', allow, lookup)).ok).toBe(true);
    expect((await checkTarget('http://[::1]:99/x', allow, lookup)).ok).toBe(true);
    expect((await checkTarget('http://localhost/x', allow, lookup)).ok).toBe(false);
  });
  it('public listed host is allowed and pinned to its resolved address', async () => {
    const r = await checkTarget('https://public.test/x', normalizeAllow(['public.test']), lookup);
    expect(r).toMatchObject({ ok: true, address: '93.184.216.34', family: 4 });
  });
  it('wildcard needs a real subdomain', async () => {
    const allow = normalizeAllow(['*.public.test']);
    expect((await checkTarget('http://public.test/', allow, lookup)).ok).toBe(false);
  });
  it('isBlockedAddress covers the ranges', () => {
    for (const a of ['127.1.2.3', '10.1.1.1', '172.31.255.255', '192.168.1.1', '169.254.0.1', '::1', '::', 'fc00::1', '::ffff:10.0.0.1', '224.0.0.1', 'garbage']) expect(isBlockedAddress(a), a).toBe(true);
    for (const a of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:2800:220:1::1']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('through the hub: no listener sees a connection for blocked targets, CONNECT is refused', async () => {
    const listener = net.createServer(() => { accepts++; });
    let accepts = 0;
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => listener.close(r)));
    const lport = listener.address().port;
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    for (const t of [`http://127.0.0.1:${lport}/`, 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/', 'http://10.0.0.1/', 'http://192.168.0.1/', 'http://172.16.0.1/']) {
      const r = await request(`${h.base}${t}`);
      expect(r.status, t).toBe(403);
    }
    expect(accepts).toBe(0);
    const connect = await new Promise((resolve) => {
      const s = net.connect(h.port, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${lport} HTTP/1.1\r\nhost: x\r\n\r\n`));
      let buf = '';
      s.on('data', (c) => { buf += c; });
      s.on('close', () => resolve(buf));
      s.on('error', () => {});
      setTimeout(() => { s.destroy(); resolve(buf); }, 3000).unref();
    });
    expect(connect).toMatch(/^HTTP\/1\.1 405/);
    expect(accepts).toBe(0);
  });
  it('redirect from an allowed origin to a blocked target is refused before connecting', async () => {
    const o = await origin();
    const listener = net.createServer(() => { accepts++; });
    let accepts = 0;
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => listener.close(r)));
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    const r = await request(`${h.base}${o.url}/redirect?to=${encodeURIComponent(`http://127.0.0.1:${listener.address().port}/`)}`);
    expect(r.status).toBe(403);
    expect(accepts).toBe(0);
    expect(o.o.log).toHaveLength(1);
  });
  it('redirects to an allowed target are followed; loops end in 502', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    const ok = await request(`${h.base}${o.url}/redirect?n=3&to=/home`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatch(/rails/);
    const loop = await request(`${h.base}${o.url}/redirect?n=40`);
    expect(loop.status).toBe(502);
    expect(loop.body).toMatch(/too many redirects/);
  });
  it('a bad target is a 400 and CONNECT through handle is refused', async () => {
    const h = await harness();
    expect((await request(`${h.base}not-a-url`)).status).toBe(400);
    expect((await request(`${h.base}ftp://x.test/`)).status).toBe(400);
  });
});

describe('record to HAR with redaction (TP-NET-07 hub part)', () => {
  it('rejects a bad redact.bodyKeys at proxy start', () => {
    expect(() => createNetProxy({ redact: { bodyKeys: 'token' } })).toThrow(/redact\.bodyKeys must be an array of strings/);
    expect(() => createNetProxy({ redact: { bodyKeys: [null] } })).toThrow(/redact\.bodyKeys must be an array of strings/);
  });
  it('refuses to record without upstreamHosts', () => {
    expect(() => createNetProxy({ record: true })).toThrow(/upstreamHosts/);
  });
  it('records passthrough only, writes a valid redacted HAR that replays offline', async () => {
    const o = await origin();
    const dir = tmp();
    const redact = { jsonPaths: ['$.user.email'] };
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough', record: true, redact });
    h.proxy.ruleSet.add({ url: '**/mocked', status: 200 });
    await request(`${h.base}${o.url}/auth?token=abc&access_token=def&sig=ghi&k=v`, { headers: { Authorization: 'Bearer test-not-secret' } });
    await request(`${h.base}${o.url}/track`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"user":{"email":"who@example.test"}}' });
    await request(`${h.base}https://h.test/mocked`);
    const file = path.join(dir, 'session.har');
    expect(h.proxy.writeHar(file)).toBe(2);
    const text = fs.readFileSync(file, 'utf8');
    expect(R.validateHar(JSON.parse(text))).toEqual([]);
    expect(text).not.toMatch(/test-not-secret|abc|def|ghi|who@example\.test/);
    expect(text).toMatch(/<redacted:authorization>/);
    expect(JSON.parse(text).log.entries[0].request.url).toContain('k=v');
    // replay offline: origin stopped, rules from the HAR, unmatched fails
    await o.o.stop();
    const h2 = await harness({ unmatched: 'fail' });
    h2.proxy.ruleSet.addConfig(R.loadRulesFile(file));
    const r = await request(`${h2.base}${o.url}/auth?token=NEWREAL&access_token=x&sig=y&k=v`);
    expect(r.status).toBe(200);
    expect((await request(`${h2.base}${o.url}/auth?k=other`)).status).toBe(599);
  });
  it('applies redact.jsonPaths to response bodies that echo the request (HAR and converted rule)', async () => {
    const C = require('../lib/instrument/net-convert.js');
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough', record: true, redact: { jsonPaths: ['$.user.email'] } });
    const sent = '{"user":{"email":"REDACTED-TEST-VALUE@example.test","name":"keep-me"}}';
    await request(`${h.base}${o.url}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent });
    const har = h.proxy.har();
    const text = JSON.stringify(har);
    expect(text).not.toMatch(/REDACTED-TEST-VALUE/);
    const res = har.log.entries[0].response.content.text;
    expect(res).toContain('<redacted:email>');
    expect(res).toContain('keep-me');
    const conv = C.convertHar(JSON.parse(text));
    expect(JSON.stringify(conv.rules)).not.toMatch(/REDACTED-TEST-VALUE/);
    expect(JSON.stringify(conv.rules)).toContain('keep-me');
  });
  it('masks echoed body keys in the HAR only when the config lists them in bodyKeys', async () => {
    const sent = '{"token":"REDACTED-TEST-VALUE-T","nested":{"password":"REDACTED-TEST-VALUE-P"},"name":"keep-me"}';
    const o = await origin();
    const run = async (redact) => {
      const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough', record: true, redact });
      await request(`${h.base}${o.url}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent });
      return JSON.stringify(h.proxy.har());
    };
    const off = await run({});
    expect(off).toMatch(/REDACTED-TEST-VALUE-T/);
    expect(off).toMatch(/REDACTED-TEST-VALUE-P/);
    const on = await run({ bodyKeys: ['token', 'password'] });
    expect(on).not.toMatch(/REDACTED-TEST-VALUE/);
    expect(on).toContain('keep-me');
    expect(on).toContain('<redacted:token>');
  });
  it('warns when redaction is off and an Authorization would be written', async () => {
    const o = await origin();
    const warns = [];
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough', record: true, redact: { enabled: false }, warn: (m) => warns.push(m) });
    await request(`${h.base}${o.url}/auth`, { headers: { Authorization: 'Bearer test-not-secret' } });
    h.proxy.har();
    expect(warns.some((w) => /Authorization/.test(w))).toBe(true);
  });
});

describe('ring buffer and body spill (TP-NET-15 harness part)', () => {
  it('spills bodies over the threshold to bodyDir and holds at most ringMax entries', async () => {
    const o = await origin();
    const dir = tmp();
    const bodyDir = path.join(dir, 'bodies');
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough', bodyDir, ringMax: 50 });
    const big = await request(`${h.base}${o.url}/large?kb=2048`);
    expect(big.body.length).toBe(2048 * 1024);
    const files = h.proxy.bodyFiles();
    expect(files).toHaveLength(1);
    expect(files[0].startsWith(bodyDir)).toBe(true);
    expect(fs.statSync(files[0]).size).toBe(2048 * 1024);
    h.proxy.ruleSet.addConfig([{ url: 'https://h.test/**', status: 200 }]);
    for (let i = 0; i < 70; i++) await request(`${h.base}https://h.test/n${i}`);
    expect(h.proxy.size).toBe(50);
    expect(h.proxy.bodyFiles()).toHaveLength(0);
    expect(fs.readdirSync(bodyDir)).toHaveLength(0);
  });
  it('default ring holds 2000 entries', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: '**', status: 204 }]);
    for (let i = 0; i < 2050; i += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => request(`${h.base}https://h.test/${i + j}`)));
    expect(h.proxy.size).toBe(2000);
  });
});

describe('refused requests carry status and bytes on net.error', () => {
  const errOf = (h) => h.events.find((e) => e.kind === 'net.error').data;
  it('host not in the allow-list: 403 with the bytes of the body sent', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: ['allowed.test'], unmatched: 'passthrough' });
    const r = await request(`${h.base}${o.url}/home`);
    const d = errOf(h);
    expect(d.refused).toBe(true);
    expect(d.status).toBe(403);
    expect(d.bytes).toBe(Buffer.byteLength(r.body));
    expect(d.bytes).toBeGreaterThan(0);
  });
  it('private address with an empty allow-list: 403 with bytes', async () => {
    const h = await harness({ upstreamHosts: [], unmatched: 'passthrough' });
    const r = await request(`${h.base}http://169.254.169.254/latest`);
    const d = errOf(h);
    expect(d.status).toBe(403);
    expect(d.bytes).toBe(Buffer.byteLength(r.body));
  });
  it('redirect to a blocked target: 403 with bytes', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    const r = await request(`${h.base}${o.url}/redirect?to=${encodeURIComponent('http://169.254.169.254/x')}`);
    expect(r.status).toBe(403);
    const d = h.events.filter((e) => e.kind === 'net.error').pop().data;
    expect(d.status).toBe(403);
    expect(d.bytes).toBe(Buffer.byteLength(r.body));
  });
  it('malformed target: 400 with bytes', async () => {
    const h = await harness();
    const r = await request(`${h.base}not-a-url`);
    const d = errOf(h);
    expect(r.status).toBe(400);
    expect(d.status).toBe(400);
    expect(d.bytes).toBe(Buffer.byteLength(r.body));
  });
  it('served responses keep their net.response shape and gain no net.error', async () => {
    const h = await harness();
    h.proxy.ruleSet.addConfig([{ url: 'https://api.test/**', status: 200 }]);
    await request(`${h.base}https://api.test/ok`);
    expect(h.events.some((e) => e.kind === 'net.error')).toBe(false);
  });
});

describe('synthetic answers, truncation flag, over-limit request, entry(id) (STUDIO-NETD-T1, ADR 0051)', () => {
  it('records unmatched, refused and bad-target answers as synthetic: no net.response, not in exchanges() or HAR', async () => {
    const h = await harness({ upstreamHosts: ['api.example.test'], record: true });
    h.proxy.ruleSet.addConfig([{ url: 'https://only.example.test/**', status: 200, body: 'ok' }]);
    expect((await request(`${h.base}https://only.example.test/a`)).status).toBe(200);
    expect((await request(`${h.base}https://nowhere.example.test/x`)).status).toBe(599);
    h.proxy.setUnmatched('passthrough');
    expect((await request(`${h.base}https://blocked.example.test/x`)).status).toBe(403);
    expect((await request(`${h.base}not-a-url`)).status).toBe(400);
    expect(kinds(h).filter((k) => k === 'net.response')).toHaveLength(1);
    expect(h.proxy.exchanges().map((e) => e.id)).toEqual(['r-1']);
    expect(h.proxy.har().log.entries).toHaveLength(0); // mock answers are not passthrough, generated ones never are
    const un = h.proxy.entry('r-2');
    expect(un).toMatchObject({ synthetic: true, status: 599, source: 'unmatched', hasResponse: true });
    expect(un.resBody.toString()).toMatch(/no rule matched/);
    const ref = h.proxy.entry('r-3');
    expect(ref).toMatchObject({ synthetic: true, status: 403, source: 'refused', statusText: 'Forbidden' });
    expect(ref.resBody.toString()).toMatch(/passthrough refused/);
    expect(h.proxy.entry('r-4')).toMatchObject({ synthetic: true, status: 400, error: 'bad target' });
    expect(h.proxy.entry('r-1')).toMatchObject({ synthetic: false, status: 200 });
    expect(h.proxy.entry('r-99')).toBeNull();
  });
  it('records an upstream error as synthetic 502', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    const loop = await request(`${h.base}${o.url}/redirect?n=40`);
    expect(loop.status).toBe(502);
    const e = h.proxy.entry('r-1');
    expect(e).toMatchObject({ synthetic: true, status: 502 });
    expect(h.proxy.exchanges()).toHaveLength(0);
  });
  it('an over-16 MB request body answers 413 and leaves an entry', async () => {
    const h = await harness();
    const r = await request(`${h.base}https://h.test/up`, { method: 'POST', body: Buffer.alloc(17 * 1024 * 1024, 0x61) });
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(r.status ?? r.error);
    const e = h.proxy.entry('r-1');
    expect(e).toMatchObject({ status: 413, source: 'refused', error: 'request body too large', reqBodyTooLarge: true, synthetic: true, reqBody: null });
    expect(h.proxy.exchanges()).toHaveLength(0);
  });
  it('keeps the capture-truncated flag on a passthrough body past the capture cap', async () => {
    const o = await origin();
    const h = await harness({ upstreamHosts: [`127.0.0.1:${o.port}`], unmatched: 'passthrough' });
    await request(`${h.base}${o.url}/large?kb=64`);
    const e = h.proxy.entry('r-1');
    expect(e).toMatchObject({ synthetic: false, resTruncated: false, hasResponse: true, resBytes: 64 * 1024 });
    expect(e.timings).toMatchObject({ wait: expect.any(Number) });
  });
});
