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

  it('counts hellos and records the last-seen time', async () => {
    const hub = await start();
    expect(hub.hellos).toBe(0);
    expect(hub.lastHelloAt).toBeNull();
    await req(hub, 'GET', '/bt/nope/hello');
    expect(hub.hellos).toBe(0);
    expect(hub.lastHelloAt).toBeNull();
    const t0 = Date.now();
    await req(hub, 'GET', `/bt/${TOKEN}/hello`);
    expect(hub.hellos).toBe(1);
    expect(hub.lastHelloAt).toBeGreaterThanOrEqual(t0);
    expect(hub.lastHelloAt).toBeLessThanOrEqual(Date.now());
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

  it('redaction: path masks ignore case and accept [n] index syntax', () => {
    const v = { layers: { global: { User: { Email: 'e' }, list: [{ a: 1 }, { a: 2 }] } } };
    expect(redact(v, ['global.user.email']).layers.global.User.Email).toBe('<redacted:Email>');
    const out = redact(v, ['global.list[1]']).layers.global.list;
    expect(out[0]).toEqual({ a: 1 });
    expect(out[1]).toBe('<redacted:1>');
    expect(redact(v, ['Global.LIST[0].a']).layers.global.list[0].a).toBe('<redacted:a>');
  });

  it('redaction: .n on an element, list.* on an array, [*] and literal bracket keys', () => {
    const v = { layers: { global: { list: [{ a: 1 }, { a: 2 }], 'k[1]': 'lit' } } };
    expect(redact(v, ['global.list.1']).layers.global.list).toEqual([{ a: 1 }, '<redacted:1>']);
    expect(redact(v, ['global.list.*']).layers.global.list).toEqual(['<redacted:0>', '<redacted:1>']);
    expect(redact(v, ['global.list[*]']).layers.global.list).toEqual(['<redacted:0>', '<redacted:1>']);
    expect(redact(v, ['global.list[*].a']).layers.global.list).toEqual([{ a: '<redacted:a>' }, { a: '<redacted:a>' }]);
    expect(redact({ a: { 'list[1]': 's', b: 1 } }, ['a.list[1]'])).toEqual({ a: { 'list[1]': '<redacted:list[1]>', b: 1 } });
    expect(redact(v, ['global.k[1]']).layers.global['k[1]']).toBe('<redacted:k[1]>');
  });

  it('redaction: a 50k element array with many masks stays fast', () => {
    const list = Array.from({ length: 50000 }, (_, i) => ({ id: i }));
    const masks = Array.from({ length: 20 }, (_, i) => `global.list[${i}].id`);
    const t = Date.now();
    const out = redact({ layers: { global: { list } } }, masks).layers.global.list;
    expect(out[3].id).toBe('<redacted:id>');
    expect(out[30].id).toBe(30);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('validators and session id safety', () => {
    expect(validateEvent({ kind: 'log' })).toBeNull();
    expect(validateEvent({ kind: '' })).toMatch(/kind/);
    expect(validateEvent({ kind: 'x', src: 'device' })).toMatch(/src/);
    expect(() => createEventLog({ sessionId: '../x', sessionDir: '/tmp' })).toThrow(/sessionId/);
  });
});

describe('hub state routes (STA-S-T5)', () => {
  const post = (hub, body, q = '') => req(hub, 'POST', `/bt/${TOKEN}/state${q}`, typeof body === 'string' ? body : JSON.stringify(body));
  const ackLine = (hub, c, phase, more = {}) => JSON.stringify({ kind: 'cmd.ack', session: hub.sessionId, data: { id: c.id, seq: c.seq, phase, ok: true, ...more } }) + '\n';

  it('wrong token, wrong route method and wrong peer are bare 404', async () => {
    const hub = await start();
    for (const [m, p] of [['GET', '/bt/nope/state'], ['POST', '/bt/nope/state'], ['DELETE', `/bt/${TOKEN}/state`]]) {
      const r = await req(hub, m, p, m === 'POST' ? '{}' : undefined);
      expect(r.status).toBe(404);
      expect(r.body).toBe('');
    }
    const peerHub = await start({ mode: 'device', devicePeer: '192.168.1.50' });
    const r = await post(peerHub, { op: 'ping' });
    expect(r.status).toBe(404);
    expect(r.body).toBe('');
    expect(peerHub.stateOps.list()).toEqual([]);
  });

  it('device peer allowed through peerOf: state writes work for the leased device only', async () => {
    const hub = await start({ mode: 'device', devicePeer: '192.168.1.50', peerOf: () => '192.168.1.50' });
    const r = await post(hub, { op: 'ping' });
    expect(r.status).toBe(202);
  });

  it('lease lost answers 423 on both methods and queues nothing', async () => {
    const lease = fakeLease();
    const hub = await start({ lease });
    lease._held = false;
    expect((await post(hub, { op: 'ping' })).status).toBe(423);
    expect((await req(hub, 'GET', `/bt/${TOKEN}/state`)).status).toBe(423);
    expect(hub.stateOps.list()).toEqual([]);
  });

  it('POST queues a command the agent long-polls; acks over events complete it; GET reads it back', async () => {
    const hub = await start();
    const r = await post(hub, { op: 'set', args: { layer: 'global', path: 'user.tier', value: 'premium' } });
    expect(r.status).toBe(202);
    const q = JSON.parse(r.body);
    expect(q).toMatchObject({ id: 'c-1', seq: 1, session: hub.sessionId });
    const polled = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`)).body);
    expect(polled[0]).toMatchObject({ op: 'set', seq: 1 });
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ackLine(hub, q, 'received') + ackLine(hub, q, 'applied', { result: 'ok' }));
    const g = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/state?id=c-1`)).body);
    expect(g.command).toMatchObject({ status: 'done', phase: 'applied', result: 'ok' });
    const all = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/state`)).body);
    expect(all.commands.length).toBe(1);
    expect((await req(hub, 'GET', `/bt/${TOKEN}/state?id=zzz`)).status).toBe(404);
  });

  it('rejects an op that is not allowed and malformed bodies as typed 400s', async () => {
    const hub = await start();
    const r = await post(hub, { op: 'eval' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toBe('BAD_COMMAND');
    expect((await post(hub, 'not json')).status).toBe(400);
    expect((await post(hub, { op: 'set', ack: 'later' })).status).toBe(400);
    expect(hub.stateOps.list()).toEqual([]);
  });

  it('a body over 64 KB is a typed 413, never truncated, and queues nothing', async () => {
    const hub = await start();
    const r = await post(hub, { op: 'set', args: { layer: 'global', path: 'a', value: 'x'.repeat(70000) } });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'STATE_TOO_LARGE', limit: 65536 });
    expect(hub.stateOps.list()).toEqual([]);
    // just under the cap passes (args cap is on the serialized args)
    const ok = await post(hub, { op: 'set', args: { layer: 'global', path: 'a', value: 'x'.repeat(60000) } });
    expect(ok.status).toBe(202);
  });

  it('a session mismatch answers 409 resync and queues nothing', async () => {
    const hub = await start();
    const r = await post(hub, { op: 'ping' }, '?session=other');
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ resync: true, session: hub.sessionId });
    expect((await req(hub, 'GET', `/bt/${TOKEN}/state?session=other`)).status).toBe(409);
    expect(hub.stateOps.list()).toEqual([]);
  });

  it('GET times out open commands lazily', async () => {
    const hub = await start();
    await post(hub, { op: 'ping' });
    hub.stateOps.tick(Date.now() + 60000);
    const g = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/state?id=c-1`)).body);
    expect(g.command.status).toBe('timeout');
  });

  it('exposes the last state.snapshot, redacted', async () => {
    const hub = await start({ redactPaths: ['global.user.email'] });
    const snap = { kind: 'state.snapshot', data: { layers: { global: { user: { email: 'dummy@example.test', tier: 'free' }, authToken: 'dummy-tok' } } } };
    await req(hub, 'POST', `/bt/${TOKEN}/events`, JSON.stringify(snap) + '\n');
    const all = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/state`)).body);
    expect(JSON.stringify(all.snapshot)).not.toMatch(/dummy/);
    expect(all.snapshot.layers.global.user.tier).toBe('free');
  });

  it('persisted events.ndjson never holds dummy secrets, from agent snapshots or host writes (TP-STA-04 persisted part)', async () => {
    const dir = tmp();
    const hub = await start({ sessionDir: dir, redactPaths: ['global.user.email'] });
    const snap = { kind: 'state.snapshot', data: { layers: { global: { authToken: 'dummy-tok-1', sessionId: 'dummy-sid-2', password: 'dummy-pw-3', user: { email: 'dummy-mail-4@example.test', tier: 'free' } } } } };
    await req(hub, 'POST', `/bt/${TOKEN}/events`, JSON.stringify(snap) + '\n');
    await post(hub, { op: 'set', args: { layer: 'global', path: 'user.authToken', value: 'dummy-tok-5' } });
    await post(hub, { op: 'set', args: { layer: 'global', path: 'user.email', value: 'dummy-mail-6@example.test' } });
    const text = fs.readFileSync(hub.log.file, 'utf8');
    expect(text).not.toMatch(/dummy/);
    for (const k of ['authToken', 'sessionId', 'password']) expect(text).toContain(`"<redacted:${k}>"`);
    expect(text).toContain('"<redacted:email>"');
    expect(text).toContain('"tier":"free"');
  });
});

describe('hub write path relay (STA-S-T6)', () => {
  const post = (hub, body) => req(hub, 'POST', `/bt/${TOKEN}/state`, JSON.stringify(body));
  const ack = (hub, c, phase, more = {}) => JSON.stringify({ kind: 'cmd.ack', session: hub.sessionId, data: { id: c.id, seq: c.seq, phase, ok: true, ...more } }) + '\n';
  const queue = async (hub, body) => JSON.parse((await post(hub, body)).body);

  it('relays the requested ack phase to the agent on the command', async () => {
    const hub = await start();
    await queue(hub, { op: 'set', args: { path: 'a', value: 1 }, ack: 'reflected' });
    await queue(hub, { op: 'ping' });
    const polled = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`)).body);
    expect(polled.map((c) => [c.seq, c.ack])).toEqual([[1, 'reflected'], [2, 'applied']]);
    expect(JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=1`)).body).map((c) => c.seq)).toEqual([2]);
  });

  it('reflected completes a reflected command; a duplicate ack changes nothing and is counted', async () => {
    const hub = await start();
    const q = await queue(hub, { op: 'set', args: { path: 'a', value: 1 }, ack: 'reflected' });
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, q, 'received') + ack(hub, q, 'applied') + ack(hub, q, 'applied'));
    expect(hub.stateOps.get(q.id)).toMatchObject({ phase: 'applied', status: 'pending' });
    expect(hub.stateOps.counters.duplicates).toBe(1);
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, q, 'reflected'));
    expect(hub.stateOps.get(q.id)).toMatchObject({ phase: 'reflected', status: 'done' });
  });

  it('an applied ack with ok:false fails the command with its error', async () => {
    const hub = await start();
    const q = await queue(hub, { op: 'set', args: { path: 'a', value: 'x' } });
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, q, 'received') + ack(hub, q, 'applied', { ok: false, error: 'TYPE_MISMATCH: no' }));
    expect(hub.stateOps.get(q.id)).toMatchObject({ status: 'failed', ok: false, error: 'TYPE_MISMATCH: no' });
  });

  it('records out-of-order applied acks as gaps', async () => {
    const hub = await start();
    const a = await queue(hub, { op: 'ping' });
    const b = await queue(hub, { op: 'ping' });
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, b, 'applied') + ack(hub, a, 'applied'));
    const g = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/state`)).body);
    expect(g.gaps).toEqual([1]);
  });

  it('times out an open command on the hub timer and logs cmd.timeout', async () => {
    const hub = await start({ tickMs: 10, stateTimeouts: { received: 30 } });
    const q = await queue(hub, { op: 'ping' });
    const t0 = Date.now();
    while (hub.log.since(0).every((e) => e.kind !== 'cmd.timeout') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    const ev = hub.log.since(0).find((e) => e.kind === 'cmd.timeout');
    expect(ev.data).toMatchObject({ id: q.id, seq: q.seq, op: 'ping' });
    expect(hub.stateOps.get(q.id).status).toBe('timeout');
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, q, 'received') + ack(hub, q, 'applied'));
    expect(hub.stateOps.get(q.id)).toMatchObject({ status: 'done', ok: true }); // a late ack revives it
  });

  it('an ack for another session is stale: 409 resync and the command stays open', async () => {
    const hub = await start();
    const q = await queue(hub, { op: 'ping' });
    const line = JSON.stringify({ kind: 'cmd.ack', session: 'othersession', data: { id: q.id, seq: q.seq, phase: 'applied', ok: true } }) + '\n';
    const r = await req(hub, 'POST', `/bt/${TOKEN}/events`, line);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toMatchObject({ resync: true, session: hub.sessionId });
    expect(hub.stateOps.get(q.id).status).toBe('pending');
    expect((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0&session=othersession`)).status).toBe(409);
  });

  it('an ack result over 64 KB becomes a typed STATE_TOO_LARGE failure, never truncated', async () => {
    const hub = await start();
    const q = await queue(hub, { op: 'get', args: { path: 'big' } });
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, q, 'received') + ack(hub, q, 'applied', { result: { value: 'x'.repeat(70000) } }));
    const c = hub.stateOps.get(q.id);
    expect(c).toMatchObject({ status: 'failed', ok: false });
    expect(c.error).toMatch(/^STATE_TOO_LARGE/);
    expect(c.result).toBeUndefined();
  });

  it('stores an applied snapshot ack under its name and expands restore {name} to its layers', async () => {
    const hub = await start();
    const s = await queue(hub, { op: 'snapshot', args: { name: 'S1' } });
    const layers = { global: { user: { tier: 'free' } } };
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, s, 'received') + ack(hub, s, 'applied', { result: { layers, truncated: [] } }));
    expect(hub.stateOps.getSnapshot('S1')).toEqual(layers);
    const r = await queue(hub, { op: 'restore', args: { name: 'S1' } });
    const polled = JSON.parse((await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=${s.seq}`)).body);
    expect(polled[0]).toMatchObject({ id: r.id, op: 'restore', args: { name: 'S1', layers } });
    const miss = await post(hub, { op: 'restore', args: { name: 'nope' } });
    expect(miss.status).toBe(404);
    expect(JSON.parse(miss.body).error).toBe('NOT_FOUND');
  });

  it('a failed snapshot ack stores nothing', async () => {
    const hub = await start();
    const s = await queue(hub, { op: 'snapshot', args: { name: 'S2' } });
    await req(hub, 'POST', `/bt/${TOKEN}/events`, ack(hub, s, 'applied', { ok: false, error: 'STATE_TOO_LARGE: x' }));
    expect(hub.stateOps.getSnapshot('S2')).toBeNull();
  });

  it('counts long-polls and event posts, and peaks at one waiter with one polling agent', async () => {
    const hub = await start({ longPollMs: 30 });
    for (let i = 0; i < 3; i++) await req(hub, 'GET', `/bt/${TOKEN}/cmd?after=0`);
    await req(hub, 'POST', `/bt/${TOKEN}/events`, '');
    expect(hub.stats).toMatchObject({ cmdPolls: 3, eventPosts: 1, peakWaiters: 1, waiters: 0 });
  });
});
