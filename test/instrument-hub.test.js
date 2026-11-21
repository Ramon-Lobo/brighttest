import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { startHub, localLease } = require('../lib/instrument/hub.js');
const { createEventLog, redact, validateCommand, validateEvent } = require('../lib/instrument/events.js');

const TOKEN = 'tok-abcdef0123456789';
const hubs = [];
const dirs = [];
afterEach(async () => {
  while (hubs.length) await hubs.pop().stop();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hub-')); dirs.push(d); return d; }
function fakeLease() {
  const l = { _held: true, _cb: null, leaseId: 'lease-1', held: () => l._held, onLost: (cb) => { l._cb = cb; } };
  return l;
}
async function start(o = {}) {
  const hub = await startHub({ host: '127.0.0.1', port: 0, mode: 'headless', lease: fakeLease(), tokens: [TOKEN], ...o });
  hubs.push(hub);
  return hub;
}
function req(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: hub.port, method, path: p }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

describe('hub token, route and refusal rules', () => {
  it('wrong token on every route is 404 with an empty body and no echo', async () => {
    const hub = await start();
    for (const [m, p] of [['GET', '/bt/nope/hello'], ['GET', '/bt/nope/cmd'], ['POST', '/bt/nope/events'], ['GET', '/other'], ['GET', `/bt/${TOKEN}/zzz`]]) {
      const r = await req(hub, m, p, m === 'POST' ? '{}' : undefined);
      expect(r.status).toBe(404);
      expect(r.body).toBe('');
      expect(r.headers['content-length']).toBe('0');
    }
  });

  it('right token: hello registers the session', async () => {
    const hub = await start();
    const r = await req(hub, 'GET', `/bt/${TOKEN}/hello`);
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.session).toBe(hub.sessionId);
    expect(j.session).toMatch(/^[a-z2-7]{16}$/);
    expect(j.active).toBe(true);
    expect((await req(hub, 'POST', `/bt/${TOKEN}/hello`, '{}')).status).toBe(200);
  });

  it('accepts any of several tokens', async () => {
    const hub = await start({ tokens: ['a-1', 'b-2'] });
    expect((await req(hub, 'GET', '/bt/b-2/hello')).status).toBe(200);
    expect((await req(hub, 'GET', '/bt/c-3/hello')).status).toBe(404);
  });

  it('rejects bad options', async () => {
    await expect(startHub({ lease: fakeLease(), tokens: [] })).rejects.toThrow(/tokens/);
    await expect(startHub({ tokens: [TOKEN] })).rejects.toThrow(/lease/);
    await expect(startHub({ lease: fakeLease(), tokens: [TOKEN], mode: 'device' })).rejects.toThrow(/devicePeer/);
  });
});

describe('hub peer rules', () => {
  it('headless accepts loopback only', async () => {
    let peer = '127.0.0.1';
    const hub = await start({ peerOf: () => peer });
    expect((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(200);
    peer = '::ffff:127.0.0.1';
    expect((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(200);
    for (const bad of ['192.168.1.20', '8.8.8.8']) {
      peer = bad;
      const r = await req(hub, 'GET', `/bt/${TOKEN}/hello`);
      expect(r.status).toBe(404);
      expect(r.body).toBe('');
    }
  });

  it('device mode accepts only the leased device IP, and only if RFC1918', async () => {
    let peer = '192.168.1.50';
    const hub = await start({ mode: 'device', devicePeer: '192.168.1.50', peerOf: () => peer });
    expect((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(200);
    peer = '192.168.1.51';
    expect((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(404);
    peer = '127.0.0.1';
    expect((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(404);
    // a public address is refused even if it equals the configured device peer
    const pub = await start({ mode: 'device', devicePeer: '8.8.8.8', peerOf: () => '8.8.8.8' });
    expect((await req(pub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(404);
  });
});

describe('hub lease rules', () => {
  it('startHub throws when the lease is not held', async () => {
    const lease = fakeLease(); lease._held = false;
    await expect(startHub({ lease, tokens: [TOKEN] })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('markLeaseLost makes cmd and events 423 and releases a pending long-poll', async () => {
    const hub = await start();
    const pending = req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`);
    await new Promise((r) => setTimeout(r, 50));
    hub.markLeaseLost();
    expect((await pending).status).toBe(423);
    expect((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`)).status).toBe(423);
    expect((await req(hub, 'POST', `/bt/${TOKEN}/events`, '{"kind":"x"}')).status).toBe(423);
    // refusals before the lease check stay 404
    expect((await req(hub, 'GET', '/bt/bad/cmd')).status).toBe(404);
  });

  it('the lease onLost callback and held() going false both lose the lease', async () => {
    const lease = fakeLease();
    const hub = await start({ lease });
    lease._cb('gone');
    expect((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`)).status).toBe(423);
    const l2 = fakeLease();
    const h2 = await start({ lease: l2 });
    l2._held = false;
    expect((await req(h2, 'POST', `/bt/${TOKEN}/events`, '{"kind":"x"}')).status).toBe(423);
  });

  it('localLease is always held', async () => {
    const hub = await start({ lease: localLease() });
    expect((await req(hub, 'GET', `/bt/${TOKEN}/hello`)).status).toBe(200);
  });

  it('the session id is derived from the lease id', async () => {
    const a = fakeLease(); const b = fakeLease(); b.leaseId = 'lease-2';
    const h1 = await start({ lease: a });
    const h2 = await start({ lease: b });
    const h3 = await start({ lease: fakeLease() });
    expect(h1.sessionId).not.toBe(h2.sessionId);
    expect(h1.sessionId).toBe(h3.sessionId);
  });
});

describe('hub commands', () => {
  it('long-poll returns 204 after longPollMs when idle', async () => {
    const hub = await start({ longPollMs: 150 });
    const t0 = Date.now();
    const r = await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`);
    expect(r.status).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });

  it('push wakes a waiter and commands are ordered by seq', async () => {
    const hub = await start({ longPollMs: 5000 });
    const pending = req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0&session=${hub.sessionId}`);
    await new Promise((r) => setTimeout(r, 30));
    hub.push({ op: 'ping' });
    const r = await pending;
    expect(r.status).toBe(200);
    const list = JSON.parse(r.body);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ v: 1, seq: 1, op: 'ping', session: hub.sessionId });
    hub.push({ op: 'get', args: { layer: 'global' } });
    const r2 = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=1`)).body);
    expect(r2.map((c) => c.seq)).toEqual([2]);
  });

  it('wrong session is 409 with resync', async () => {
    const hub = await start();
    const r = await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0&session=old`);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).resync).toBe(true);
  });

  it('push refuses ops outside the allow-list', async () => {
    const hub = await start();
    expect(() => hub.push({ op: 'eval' })).toThrow(/not allowed/);
    expect(validateCommand({ op: 'set', args: [] })).toMatch(/args/);
  });

  it('stop answers pending polls and closes', async () => {
    const hub = await start({ longPollMs: 5000 });
    const pending = req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`);
    await new Promise((r) => setTimeout(r, 30));
    await hub.stop();
    expect((await pending).status).toBe(204);
    await expect(req(hub, 'GET', `/bt/${TOKEN}/hello`)).rejects.toBeTruthy();
  });
});

describe('hub events, ring buffer and NDJSON', () => {
  it('accepts NDJSON, counts rejects, emits events and writes redacted events.ndjson', async () => {
    const sessionDir = tmp();
    const hub = await start({ sessionDir });
    const seen = [];
    hub.events.on('event', (e) => seen.push(e));
    const body = [
      JSON.stringify({ kind: 'log', data: { level: 'info', msg: 'hi', authToken: 'x' } }),
      'not json',
      JSON.stringify({ nokind: true }),
      JSON.stringify({ kind: 'agent.hello', session: 'stale', data: {} }),
      '',
    ].join('\n');
    const r = await req(hub, 'POST', `/bt/${TOKEN}/events`, body);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ accepted: 1, rejected: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0].data.authToken).toBe('x'); // live view is raw
    const file = path.join(sessionDir, hub.sessionId, 'events.ndjson');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].data.authToken).toBe('<redacted:authToken>');
    expect(lines[0].data.msg).toBe('hi');
    expect(lines[0].session).toBe(hub.sessionId);
  });

  it('all-stale events batch is 409', async () => {
    const hub = await start();
    const r = await req(hub, 'POST', `/bt/${TOKEN}/events`, JSON.stringify({ kind: 'x', session: 'old' }));
    expect(r.status).toBe(409);
    const q = await req(hub, 'POST', `/bt/${TOKEN}/events?session=old`, JSON.stringify({ kind: 'x' }));
    expect(q.status).toBe(409);
  });

  it('413 for an oversized body', async () => {
    const hub = await start();
    const r = await req(hub, 'POST', `/bt/${TOKEN}/events`, 'x'.repeat(1024 * 1024 + 10)).catch((e) => ({ status: e.code }));
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(r.status);
  });

  it('ring buffer keeps the last 2000 events', () => {
    const log = createEventLog({ sessionId: 'abc' });
    for (let i = 1; i <= 2050; i++) log.push({ kind: 'log', data: { i } });
    expect(log.size).toBe(2000);
    const all = log.since(0);
    expect(all[0].data.i).toBe(51);
    expect(all[all.length - 1].data.i).toBe(2050);
    expect(log.since(2049)).toHaveLength(1);
  });

  it('redaction: built-in keys, path masks, wildcards, envelope session untouched', () => {
    const out = redact({ layers: { global: { user: { token: 't', name: 'n', tier: 'p' }, list: [{ cookie: 'c' }] } }, ok: 1 }, ['global.user.tier']);
    expect(out.layers.global.user).toEqual({ token: '<redacted:token>', name: 'n', tier: '<redacted:tier>' });
    expect(out.layers.global.list[0].cookie).toBe('<redacted:cookie>');
    expect(redact({ a: { b: 1 }, c: { b: 2 } }, ['*.b'])).toEqual({ a: { b: '<redacted:b>' }, c: { b: '<redacted:b>' } });
    const log = createEventLog({ sessionId: 'abc' });
    expect(log.push({ kind: 'x' }).session).toBe('abc');
  });

  it('validators and session id safety', () => {
    expect(validateEvent({ kind: 'log' })).toBeNull();
    expect(validateEvent({ kind: '' })).toMatch(/kind/);
    expect(validateEvent({ kind: 'x', src: 'device' })).toMatch(/src/);
    expect(() => createEventLog({ sessionId: '../x', sessionDir: '/tmp' })).toThrow(/sessionId/);
  });
});
