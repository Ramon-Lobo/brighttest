import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import L from '../lib/device-lease.js';
import ID from '../lib/device-identity.js';
import C from '../lib/device-command.js';
import H from '../lib/device-hook.js';

// A lane that knows the device identity holds the identity key AND the address key (one leaseId), so paths that
// only know an address (Studio, MCP, pool, status) still collide with it.
const SERIAL = 'X00DUALSERIAL01';
const lookup = async (h) => ({ address: h });
const servers = [];
const fake = (serial) => new Promise((resolve) => {
  const s = http.createServer((q, r) => r.end(`<device-info><serial-number>${serial}</serial-number></device-info>`));
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve(s.address().port));
});
const dirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dual-')); dirs.push(d); return d; };
const saved = { dir: process.env.BRIGHTTEST_LEASE_DIR, tok: process.env.BRIGHTTEST_LEASE };
beforeEach(() => { delete process.env.BRIGHTTEST_LEASE; });
afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (saved.dir === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = saved.dir;
  if (saved.tok === undefined) delete process.env.BRIGHTTEST_LEASE; else process.env.BRIGHTTEST_LEASE = saved.tok;
});
const quiet = async (fn) => { const o = process.stderr.write; process.stderr.write = () => true; try { return await fn(); } finally { process.stderr.write = o; } };
const logs = async (fn) => { const out = []; const o = console.log; console.log = (...a) => out.push(a.join(' ')); try { await quiet(fn); } finally { console.log = o; } return out.join('\n'); };
const events = (dir, key) => { try { return fs.readFileSync(path.join(dir, key, 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const lane = (dir, port, extra = {}, env = {}) => C.acquireForLane({
  cfg: {}, opts: { wait: '0', ...(extra.opts || {}) }, host: '127.0.0.1', ecpPort: port, password: 'pw', purpose: 'test', command: ['x'], mode: extra.mode,
  env: { BRIGHTTEST_LEASE_DIR: dir, PATH: process.env.PATH, ...env },
  deps: { readIdentity: (h, o) => ID.readIdentity(h, { ...o, cache: new Map(), timeoutMs: 300 }), ...(extra.deps || {}) },
});
const addrKey = (port) => `127.0.0.1_p${port}`;

describe('identity lane holds both keys', () => {
  it('a plain address acquire is blocked while an identity key is held, and the reverse', async () => {
    const dir = mk();
    const a = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, deviceId: SERIAL, waitMs: 0, timers: false });
    expect(a.key).toBe(L.keyFromIdentity(SERIAL));
    expect(a.keys).toEqual([L.keyFromIdentity(SERIAL), addrKey(9101)]);
    await expect(L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, waitMs: 0, timers: false })).rejects.toMatchObject({ code: 'BUSY' });
    a.release();
    const b = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, waitMs: 0, timers: false });
    await expect(L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, deviceId: SERIAL, waitMs: 0, timers: false })).rejects.toMatchObject({ code: 'BUSY' });
    // a failed second leg leaves nothing behind on the identity key
    expect(fs.existsSync(path.join(dir, L.keyFromIdentity(SERIAL), 'holder.json'))).toBe(false);
    b.release();
  });
  it('pool member and another identity lane at the same address are blocked too', async () => {
    const dir = mk();
    const a = await L.acquire({ dir, lookup, host: '127.0.0.1', deviceId: SERIAL, waitMs: 0, timers: false });
    await expect(L.acquirePool({ dir, lookup, hosts: ['127.0.0.1'], waitMs: 0, timers: false })).rejects.toMatchObject({ code: 'BUSY' });
    a.release();
  });
  it('two identity lanes via different ports collide on the identity key', async () => {
    const dir = mk();
    const a = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, deviceId: SERIAL, waitMs: 0, timers: false });
    await expect(L.acquire({ dir, lookup, host: '127.0.0.1', port: 9102, deviceId: SERIAL, waitMs: 0, timers: false })).rejects.toMatchObject({ code: 'BUSY' });
    a.release();
    expect(fs.existsSync(path.join(dir, addrKey(9101), 'holder.json'))).toBe(false);
  });
  it('re-entrancy: a token holding the identity key (or only the address key) is a no-op lease, with identity', async () => {
    const dir = mk();
    const a = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, deviceId: SERIAL, waitMs: 0, timers: false });
    const r = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, deviceId: SERIAL, token: a.leaseId, waitMs: 0, timers: false });
    expect(r.reentrant).toBe(true);
    const r2 = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9102, deviceId: SERIAL, token: a.leaseId, waitMs: 0, timers: false });
    expect(r2.reentrant).toBe(true); // other address, same device
    const r3 = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, token: a.leaseId, waitMs: 0, timers: false });
    expect(r3.reentrant).toBe(true); // address only
    r.release(); r2.release(); r3.release();
    expect(L.tokenValid(a.leaseId, { dir })).toBe(true);
    a.release();
    expect(L.tokenValid(a.leaseId, { dir })).toBe(false);
  });
  it('a session lock holds both keys under one token; unlock and renew cover both', async () => {
    const dir = mk();
    const s = await L.acquire({ dir, lookup, host: '127.0.0.1', port: 9101, deviceId: SERIAL, mode: 'session', waitMs: 0, timers: false });
    const store = L.createStore({ dir });
    expect(store.findTokenKeys(s.leaseId).sort()).toEqual([L.keyFromIdentity(SERIAL), addrKey(9101)].sort());
    expect(L.renew(s.leaseId, { dir }).leaseId).toBe(s.leaseId);
    L.unlock(s.leaseId, { dir });
    expect(store.findTokenKeys(s.leaseId)).toEqual([]);
  });
});

describe('device lane wiring', () => {
  it('identity read fallback is written to the lease event log, without the serial', async () => {
    const dir = mk();
    const p = 9111;
    const r = await quiet(() => lane(dir, p, { deps: { readIdentity: async () => ({ reason: 'device-info timed out after 1500 ms' }) } }));
    expect(r.lease.key).toBe(addrKey(p));
    const notes = events(dir, addrKey(p)).filter((e) => e.ev === 'note').map((e) => e.note);
    expect(notes.some((n) => /identity not read \(device-info timed out after 1500 ms\); leasing by address 127\.0\.0\.1:9111/.test(n))).toBe(true);
    expect(JSON.stringify(events(dir, addrKey(p)))).not.toContain(SERIAL);
    r.lease.release();
  });
  it('a failed read uses the remembered identity key, so a lane holding the device by identity is still met', async () => {
    const dir = mk();
    const p1 = await fake(SERIAL);
    const a = await lane(dir, p1);
    expect(a.lease.key).toBe(L.keyFromIdentity(SERIAL));
    // the same device now answers on another port and its read fails; the identity key was remembered for it
    const p2 = 9112;
    ID.rememberKey(dir, '127.0.0.1', L.keyFromIdentity(SERIAL), p2);
    const failing = { readIdentity: async () => ({ reason: 'device-info timed out after 1500 ms' }) };
    const b = await quiet(() => lane(dir, p2, { deps: failing }));
    expect(b.code).toBe(75);
    a.lease.release();
    const c = await quiet(() => lane(dir, p2, { deps: failing }));
    expect(c.lease.keys).toEqual([L.keyFromIdentity(SERIAL), addrKey(p2)]);
    const notes = events(dir, addrKey(p2)).filter((e) => e.ev === 'note').map((e) => e.note).join('\n');
    expect(notes).toContain(`remembered identity key ${L.keyFromIdentity(SERIAL)}`);
    c.lease.release();
  });
  it('under BRIGHTTEST_LEASE the held key is reused and the network is not read', async () => {
    const dir = mk();
    const p = await fake(SERIAL);
    const a = await lane(dir, p, { mode: 'session' });
    let reads = 0;
    const spy = { readIdentity: async () => { reads++; return { reason: 'should not be called' }; } };
    const inner = await lane(dir, p, { deps: spy }, { BRIGHTTEST_LEASE: a.lease.leaseId });
    expect(reads).toBe(0);
    expect(inner.lease.reentrant).toBe(true);
    expect(inner.lease.leaseId).toBe(a.lease.leaseId);
    inner.lease.release();
    // a token that holds another device does not short-cut this one
    const other = await fake('X00OTHERSERIAL');
    const b = await lane(dir, other, {}, { BRIGHTTEST_LEASE: a.lease.leaseId });
    expect(b.lease.reentrant).toBeFalsy();
    expect(b.lease.key).toBe(L.keyFromIdentity('X00OTHERSERIAL'));
    b.lease.release();
    L.unlock(a.lease.leaseId, { dir });
  });
  it('status, log and unlock --force by host see an identity-keyed holder; lock detects its own session', async () => {
    const dir = mk();
    const p = await fake(SERIAL);
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    const a = await lane(dir, p, { mode: 'session' });
    const idKey = L.keyFromIdentity(SERIAL);
    const st = JSON.parse(await logs(() => C.run({ deviceAction: 'status', host: '127.0.0.1', ecpPort: p, json: true }, {})));
    expect(st.filter((s) => s.holder).map((s) => s.key).sort()).toEqual([idKey, addrKey(p)].sort());
    expect(await logs(() => C.run({ deviceAction: 'log', host: '127.0.0.1', ecpPort: p, tail: 10 }, {}))).toContain(idKey);
    // lock with the token already held on this device: refused (2) instead of queueing behind itself
    process.env.BRIGHTTEST_LEASE = a.lease.leaseId;
    expect(await quiet(() => C.run({ deviceAction: 'lock', host: '127.0.0.1', ecpPort: p }, {}))).toBe(2);
    delete process.env.BRIGHTTEST_LEASE;
    const code = await logs(() => C.run({ deviceAction: 'unlock', force: true, reason: 'test', host: '127.0.0.1', ecpPort: p }, {}));
    expect(code).toContain(`released ${idKey}`);
    expect(L.createStore({ dir }).findTokenKeys(a.lease.leaseId)).toEqual([]);
  });
});

describe('identity cache', () => {
  it('is created private (0700 dir, 0600 file)', () => {
    if (process.platform === 'win32') return;
    const dir = path.join(mk(), 'fresh');
    ID.rememberKey(dir, '127.0.0.1', L.keyFromIdentity(SERIAL));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'identity-cache.json')).mode & 0o777).toBe(0o600);
  });
  it('hook host list includes hosts known only through the identity cache or an identity holder', () => {
    const dir = mk();
    ID.rememberKey(dir, '192.0.2.77', L.keyFromIdentity('S77'));
    ID.rememberKey(dir, '192.0.2.78', L.keyFromIdentity('S78'), 9333);
    const idKey = L.keyFromIdentity('S99');
    fs.mkdirSync(path.join(dir, idKey), { recursive: true });
    fs.writeFileSync(path.join(dir, idKey, 'holder.json'), JSON.stringify({ leaseId: 'abc', mode: 'command', device: { key: idKey, host: '192.0.2.99' }, holder: { pid: process.pid } }));
    const env = { BRIGHTTEST_LEASE_DIR: dir, HOME: dir, USERPROFILE: dir };
    const st = H.evaluate({ tool_name: 'Read', tool_input: {} }, env).state;
    expect(st.hosts).toEqual(expect.arrayContaining(['192.0.2.77', '192.0.2.78', '192.0.2.99']));
    const r = H.evaluate({ tool_name: 'Bash', tool_input: { command: 'nc 192.0.2.99 8060' } }, env);
    expect(r.decision).toBe('deny');
  });
});

describe('session renewal and stale cache', () => {
  it('nested re-entrant use renews both keys of a session (fake clock)', async () => {
    const dir = mk();
    let t = Date.parse('2026-01-01T00:00:00Z');
    const seam = { dir, lookup, now: () => t, timers: false, pidStart: () => null };
    const s = await L.acquire({ ...seam, host: '127.0.0.1', port: 9101, deviceId: SERIAL, mode: 'session', idleMs: 60000, waitMs: 0 });
    for (let i = 0; i < 6; i++) {
      t += 30000;
      const r = await L.acquire({ ...seam, host: '127.0.0.1', port: 9101, deviceId: SERIAL, token: s.leaseId, waitMs: 0 });
      expect(r.reentrant).toBe(true);
    }
    expect(L.tokenValid(s.leaseId, seam)).toBe(true);
    const store = L.createStore(seam);
    for (const k of [L.keyFromIdentity(SERIAL), addrKey(9101)]) expect(store.staleReason(store.readHolder(k))).toBeFalsy();
    await expect(L.acquire({ ...seam, host: '127.0.0.1', port: 9102, deviceId: SERIAL, waitMs: 0 })).rejects.toMatchObject({ code: 'BUSY' });
  });
  it('a stale identity-cache entry never lets unlock --force or status touch another device', async () => {
    const dir = mk();
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    const idKey = L.keyFromIdentity('D1');
    ID.rememberKey(dir, '10.0.0.5', idKey); // stale: 10.0.0.5 once was D1
    const a = await L.acquire({ dir, lookup, host: '10.0.0.9', deviceId: 'D1', waitMs: 0, timers: false });
    const st = JSON.parse(await logs(() => C.run({ deviceAction: 'status', host: '10.0.0.5', json: true }, {})));
    expect(st.filter((x) => x.holder)).toEqual([]);
    const out = await logs(() => C.run({ deviceAction: 'unlock', force: true, reason: 't', kill: true, host: '10.0.0.5' }, {}));
    expect(out).not.toContain('released id-');
    expect(L.createStore({ dir }).findTokenKeys(a.leaseId)).toHaveLength(2);
    a.release();
  });
  it('unlock --force still releases the identity key when the address key has no directory', async () => {
    const dir = mk();
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    const a = await L.acquire({ dir, lookup, host: '10.0.0.9', deviceId: 'D2', waitMs: 0, timers: false });
    ID.rememberKey(dir, '10.0.0.9', L.keyFromIdentity('D2'));
    a.secondary.release(); fs.rmSync(path.join(dir, '10.0.0.9'), { recursive: true, force: true });
    const out = await logs(() => C.run({ deviceAction: 'unlock', force: true, reason: 't', host: '10.0.0.9' }, {}));
    expect(out).toContain(`released ${L.keyFromIdentity('D2')}`);
    expect(fs.existsSync(path.join(dir, L.keyFromIdentity('D2'), 'holder.json'))).toBe(false);
  });
});

describe('port-safe key recall and missing key directories', () => {
  const holdInChild = (dir, port, serial) => {
    const { spawn } = require('node:child_process');
    const script = `const L=require(${JSON.stringify(path.resolve('lib/device-lease.js'))});` +
      `L.acquire({dir:${JSON.stringify(dir)},host:'127.0.0.1',port:${port},deviceId:${JSON.stringify(serial)},waitMs:0}).then(()=>{console.log('held');setTimeout(()=>process.exit(0),20000);});`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child did not acquire')); }, 15000);
      child.stdout.on('data', () => { clearTimeout(t); resolve(child); });
      child.on('error', reject);
    });
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('status and unlock --force --kill by the default-port host leave a lane on another port alone', async () => {
    const dir = mk();
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    delete process.env.ROKU_ECP_PORT;
    const idB = L.keyFromIdentity('DEV-B');
    const child = await holdInChild(dir, 9201, 'DEV-B');
    try {
      ID.rememberKey(dir, '127.0.0.1', idB, 9201); // also writes the bare-host alias
      const st = JSON.parse(await logs(() => C.run({ deviceAction: 'status', host: '127.0.0.1', json: true }, {})));
      expect(st.filter((x) => x.holder)).toEqual([]);
      const code = await quiet(() => C.run({ deviceAction: 'unlock', force: true, reason: 't', kill: true, host: '127.0.0.1' }, {}));
      expect(code).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(child.pid)).toBe(true);
      expect(fs.existsSync(path.join(dir, idB, 'holder.json'))).toBe(true);
    } finally { child.kill('SIGKILL'); }
  });
  it('a lane reached by hostname-like address is still found by the other address through the shared hold', async () => {
    const dir = mk();
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    delete process.env.ROKU_ECP_PORT;
    // lane holds (identity, 127.0.0.1); the host recorded in the record differs from the unlock target only by form
    const a = await L.acquire({ dir, lookup, host: '127.0.0.1', deviceId: 'DEV-C', waitMs: 0, timers: false });
    ID.rememberKey(dir, '127.0.0.1', L.keyFromIdentity('DEV-C'));
    // rewrite the identity holder's recorded host so only the shared lease id (sameHold) can link the keys
    const hp = path.join(dir, L.keyFromIdentity('DEV-C'), 'holder.json');
    const rec = JSON.parse(fs.readFileSync(hp, 'utf8'));
    rec.device.host = 'roku.local';
    fs.writeFileSync(hp, JSON.stringify(rec));
    const st = JSON.parse(await logs(() => C.run({ deviceAction: 'status', host: '127.0.0.1', json: true }, {})));
    expect(st.filter((x) => x.holder).map((x) => x.key)).toContain(L.keyFromIdentity('DEV-C'));
    const out = await logs(() => C.run({ deviceAction: 'unlock', force: true, reason: 't', host: '127.0.0.1' }, {}));
    expect(out).toContain(`released ${L.keyFromIdentity('DEV-C')}`);
    expect(L.createStore({ dir }).findTokenKeys(a.leaseId)).toEqual([]);
  });
  it('unlock --force exit codes: missing address dir, never-leased host, live lease without a reason', async () => {
    const dir = mk();
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    delete process.env.ROKU_ECP_PORT;
    const idKey = L.keyFromIdentity('DEV-D');
    const a = await L.acquire({ dir, lookup, host: '127.0.0.1', deviceId: 'DEV-D', waitMs: 0, timers: false });
    ID.rememberKey(dir, '127.0.0.1', idKey);
    // live lease, no --reason: usage error with both keys held
    expect(await quiet(() => C.run({ deviceAction: 'unlock', force: true, host: '127.0.0.1' }, {}))).toBe(2);
    expect(L.createStore({ dir }).findTokenKeys(a.leaseId)).toHaveLength(2);
    // identity dir held, address dir missing: released, exit 0
    a.secondary.release();
    fs.rmSync(path.join(dir, '127.0.0.1'), { recursive: true, force: true });
    let code;
    const out = await logs(async () => { code = await C.run({ deviceAction: 'unlock', force: true, reason: 't', host: '127.0.0.1' }, {}); });
    expect(code).toBe(0);
    expect(out).toContain(`released ${idKey}`);
    // never-leased host: not held, exit 0
    const out2 = await logs(async () => { code = await C.run({ deviceAction: 'unlock', force: true, reason: 't', host: '127.0.0.9' }, {}); });
    expect(code).toBe(0);
    expect(out2).toContain('was not held');
    a.release();
  });
});
