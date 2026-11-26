import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import L from '../lib/device-lease.js';
import V from '../lib/device-lease-view.js';
import W from '../lib/device-watch.js';
import C from '../lib/device-command.js';

const xml = (serial) => `<?xml version="1.0"?><device-info><serial-number>${serial}</serial-number><device-id>X</device-id></device-info>`;
const okFetch = (serial = 'FAKE-DEVICE-A') => vi.fn(async () => ({ ok: true, status: 200, text: async () => xml(serial) }));
const dirs = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-probe-')); dirs.push(d); return d; };

describe('createProber', () => {
  it('up when device-info answers, with the identity key', async () => {
    const f = okFetch();
    const p = V.createProber({ fetchImpl: f });
    expect(p.get('fake-a')).toEqual({ state: 'unknown', at: null });
    p.want(['fake-a']);
    await p.settle();
    const r = p.get('fake-a');
    expect(r.state).toBe('up');
    expect(r.identityKey).toBe(L.keyFromIdentity('FAKE-DEVICE-A'));
    expect(f.mock.calls[0][0]).toBe('http://fake-a:8060/query/device-info');
    p.stop();
  });

  it('reject is unreachable, never throws', async () => {
    const p = V.createProber({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    p.want(['fake-a']);
    await p.settle();
    expect(p.get('fake-a').state).toBe('unreachable');
    expect(p.get('fake-a').at).toEqual(expect.any(Number));
    p.stop();
  });

  it('a hang is unreachable at the 1 s bound (fake timers), even if the fetch ignores the signal', async () => {
    vi.useFakeTimers();
    const p = V.createProber({ fetchImpl: () => new Promise(() => {}) });
    p.want(['fake-a']);
    await vi.advanceTimersByTimeAsync(999);
    expect(p.get('fake-a').state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(2);
    expect(p.get('fake-a').state).toBe('unreachable');
    expect(p.get('fake-a').error).toMatch(/timed out/);
    p.stop();
  });

  it('at most one request per device per 30 s over 2 minutes at a 500 ms board interval', async () => {
    vi.useFakeTimers();
    const f = okFetch();
    const p = V.createProber({ fetchImpl: f });
    for (let i = 0; i < 240; i++) { p.want(['fake-a', 'fake-b']); await vi.advanceTimersByTimeAsync(500); }
    const per = (h) => f.mock.calls.filter((c) => c[0].includes(`//${h}:`)).length;
    expect(per('fake-a')).toBeLessThanOrEqual(4);
    expect(per('fake-a')).toBeGreaterThanOrEqual(4);
    expect(per('fake-b')).toBe(per('fake-a'));
    p.stop();
  });

  it('stop aborts in-flight requests, clears timers and starts nothing after', async () => {
    vi.useFakeTimers();
    let signal;
    const f = vi.fn((u, o) => { signal = o.signal; return new Promise(() => {}); });
    const p = V.createProber({ fetchImpl: f });
    p.want(['fake-a']);
    expect(vi.getTimerCount()).toBe(1);
    p.stop();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    p.want(['fake-b']);
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('view and watch', () => {
  const NOW = Date.parse('2026-11-25T12:00:00.000Z');
  const mkView = (dir, extra) => V.createView({ dir, env: {}, now: () => NOW, hostname: 'h', knownDevices: () => [{ host: 'fake-a.test', name: 'FAKE-DEVICE-A' }], ...extra });

  it('fills reach from the prober; mismatch against identity-cache sets the note', async () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ 'fake-a.test': L.keyFromIdentity('SOMEONE-ELSE') }));
    const prober = V.createProber({ fetchImpl: okFetch('FAKE-DEVICE-A'), now: () => NOW });
    const view = mkView(dir, { prober });
    expect(view.snapshot().devices[0].reach.state).toBe('unknown');
    await view.settle();
    const reach = view.snapshot().devices[0].reach;
    expect(reach.state).toBe('up');
    expect(reach.note).toBe('address now points at a different device');
    view.close();
  });

  it('matching identity has no note', async () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ 'fake-a.test': L.keyFromIdentity('FAKE-DEVICE-A') }));
    const view = mkView(dir, { prober: V.createProber({ fetchImpl: okFetch('FAKE-DEVICE-A'), now: () => NOW }) });
    view.snapshot(); await view.settle();
    expect(view.snapshot().devices[0].reach.note).toBeUndefined();
    view.close();
  });

  it('--json runs one probe pass and shows the real state; view.close stops the prober', async () => {
    const dir = mkdir();
    const prober = V.createProber({ fetchImpl: okFetch(), now: () => NOW });
    const stop = vi.spyOn(prober, 'stop');
    const view = mkView(dir, { prober });
    const out = []; 
    await W.runWatch({ view, flags: { json: true }, io: { stdout: { write: (s) => out.push(s) }, env: {} } });
    expect(JSON.parse(out.join('')).devices[0].reach.state).toBe('up');
    view.close();
    expect(stop).toHaveBeenCalled();
  });

  it('--no-probe makes zero fetch calls', async () => {
    const f = okFetch();
    const created = vi.fn(() => V.createProber({ fetchImpl: f }));
    let given;
    const view = { snapshot: () => ({ schema: 's', at: '', dir: '', machine: '', devices: [], pools: [], hidden: { keys: 0, staleLoopbackHolders: 0 } }), close() {}, settle: vi.fn() };
    const out = [];
    const io = { stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, env: {} };
    await C.cmdWatch({ noProbe: true, json: true }, { createProber: created, createView: (a) => { given = a; return view; }, io });
    expect(created).not.toHaveBeenCalled();
    expect(given.prober).toBeNull();
    expect(view.settle).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('cmdWatch builds a prober by default', async () => {
    let given;
    const view = { snapshot: () => ({ schema: 's', at: '', dir: '', machine: '', devices: [], pools: [], hidden: { keys: 0, staleLoopbackHolders: 0 } }), close() {}, settle: async () => {} };
    await C.cmdWatch({ json: true }, { createView: (a) => { given = a; return view; }, io: { stdout: { write() {} }, stderr: { write() {} }, env: {} } });
    expect(typeof given.prober.want).toBe('function');
    given.prober.stop();
  });
});

describe('fake ECP on loopback', () => {
  let server; let port;
  beforeAll(async () => {
    server = http.createServer((req, res) => { res.setHeader('content-type', 'text/xml'); res.end(req.url === '/query/device-info' ? xml('FAKE-DEVICE-A') : ''); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  it('up against the fake, unreachable on a closed port, board shows both', async () => {
    const p = V.createProber();
    p.want([`127.0.0.1:${port}`]);
    await p.settle();
    expect(p.get(`127.0.0.1:${port}`).state).toBe('up');
    const closed = http.createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const cp = closed.address().port; await new Promise((r) => closed.close(r));
    p.want([`127.0.0.1:${cp}`]);
    await p.settle();
    expect(p.get(`127.0.0.1:${cp}`).state).toBe('unreachable');
    p.stop();
  });

  it('a non-default port in a holder record is probed', async () => {
    const dir = mkdir();
    const key = L.keyFromAddress('127.0.0.1', port);
    fs.mkdirSync(path.join(dir, key, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, key, 'holder.json'), JSON.stringify({
      schema: 'brighttest-lease/v1', leaseId: 'abcdef12-0000', mode: 'command', device: { key, host: '127.0.0.1', port, serialHash: 'x' },
      holder: { agent: 'a', purpose: 'p', pid: process.pid, hostname: os.hostname(), childPids: [] },
      acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: null, idleMs: null, deadline: new Date(Date.now() + 3600000).toISOString(),
    }));
    const view = V.createView({ dir, env: {}, knownDevices: () => [], prober: V.createProber() });
    view.snapshot(); await view.settle();
    const d = view.snapshot().devices.find((x) => x.hosts.includes('127.0.0.1'));
    expect(d.reach.state).toBe('up');
    view.close();
  });
});

describe('probe scope (stale history is not probed)', () => {
  const NOW = Date.parse('2026-11-25T12:00:00.000Z');
  const DAY = 24 * 3600 * 1000;

  it('shouldProbe: held, queued, configured, recent history, stale history, --no-probe', () => {
    const base = { held: false, configured: false, newest: 0, now: NOW, noProbe: false };
    expect(V.shouldProbe({ ...base, held: true })).toBe(true); // held or queued (busy)
    expect(V.shouldProbe({ ...base, configured: true })).toBe(true);
    expect(V.shouldProbe({ ...base, newest: NOW - DAY + 1000 })).toBe(true);
    expect(V.shouldProbe({ ...base, newest: NOW - DAY - 1000 })).toBe(false);
    expect(V.shouldProbe(base)).toBe(false);
    expect(V.shouldProbe({ ...base, newest: NaN })).toBe(false);
    expect(V.shouldProbe({ ...base, held: true, configured: true, noProbe: true })).toBe(false);
  });

  const stale = (dir, key, ageMs) => {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    const f = path.join(dir, key, 'events.log');
    fs.writeFileSync(f, JSON.stringify({ ev: 'released', ts: new Date(NOW - ageMs).toISOString() }) + '\n');
    const t = new Date(NOW - ageMs);
    fs.utimesSync(f, t, t);
  };

  it('a stale-only key is listed as idle, not probed, with no fetch; a configured one is probed', async () => {
    const dir = mkdir();
    stale(dir, '203.0.113.9', 3 * DAY);
    stale(dir, '203.0.113.8', 3 * DAY);
    const f = okFetch();
    const view = V.createView({ dir, env: {}, now: () => NOW, hostname: 'h', knownDevices: () => [{ host: '203.0.113.8', name: 'cfg' }],
      prober: V.createProber({ fetchImpl: f, now: () => NOW }) });
    const snap = view.snapshot({ all: true });
    await view.settle();
    const byHost = Object.fromEntries(snap.devices.map((d) => [d.hosts[0], d]));
    expect(byHost['203.0.113.9']).toBeTruthy();
    expect(byHost['203.0.113.9'].reach).toEqual({ state: 'unknown', at: null, idle: true });
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('203.0.113.9'))).toBe(false);
    expect(urls.some((u) => u.includes('203.0.113.8'))).toBe(true);
    view.close();
  });

  it('an explicit --host is probed, malformed keys do not crash', async () => {
    const dir = mkdir();
    stale(dir, '203.0.113.9', 3 * DAY);
    fs.mkdirSync(path.join(dir, 'not a key!!'), { recursive: true });
    const f = okFetch();
    const view = V.createView({ dir, env: {}, now: () => NOW, hostname: 'h', knownDevices: () => [],
      prober: V.createProber({ fetchImpl: f, now: () => NOW }) });
    expect(() => view.snapshot({ all: true })).not.toThrow();
    view.snapshot({ host: '203.0.113.9' }); await view.settle();
    expect(f.mock.calls.some((c) => c[0].includes('203.0.113.9'))).toBe(true);
    view.close();
  });
});
