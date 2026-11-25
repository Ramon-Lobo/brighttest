import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import L from '../lib/device-lease.js';
import ID from '../lib/device-identity.js';
import C from '../lib/device-command.js';
import H from '../lib/device-hook.js';

const SERIAL = 'X00SECRETSERIAL1';
const servers = [];
function fake(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}
const info = (serial) => (req, res) => { res.end(`<device-info><serial-number>${serial}</serial-number></device-info>`); };
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

describe('identity read', () => {
  it('reads the serial', async () => {
    const port = await fake(info(SERIAL));
    expect(await ID.readIdentity('127.0.0.1', { port, cache: new Map() })).toEqual({ id: SERIAL, hash: L.hashSerial(SERIAL) });
  });
  it('falls back to device-id', async () => {
    const port = await fake((q, r) => r.end('<device-info><device-id>DEVID9</device-id></device-info>'));
    expect((await ID.readIdentity('127.0.0.1', { port, cache: new Map() })).id).toBe('DEVID9');
  });
  it('times out within the bound', async () => {
    const port = await fake(() => { /* never answers */ });
    const t = Date.now();
    const r = await ID.readIdentity('127.0.0.1', { port, timeoutMs: 200, cache: new Map() });
    expect(r.id).toBeUndefined();
    expect(r.reason).toMatch(/timed out/);
    expect(Date.now() - t).toBeLessThan(1500);
  });
  it('fails on HTTP error, empty identity and refused connection', async () => {
    const p1 = await fake((q, r) => { r.statusCode = 500; r.end('x'); });
    expect((await ID.readIdentity('127.0.0.1', { port: p1, cache: new Map() })).reason).toMatch(/HTTP 500/);
    const p2 = await fake((q, r) => r.end('<device-info></device-info>'));
    expect((await ID.readIdentity('127.0.0.1', { port: p2, cache: new Map() })).reason).toMatch(/no serial/);
    const p3 = await fake(info('x'));
    servers.pop().close();
    expect((await ID.readIdentity('127.0.0.1', { port: p3, cache: new Map() })).reason).toMatch(/unreachable/);
  });
  it('caches per process', async () => {
    let n = 0;
    const port = await fake((q, r) => { n++; info(SERIAL)(q, r); });
    const cache = new Map();
    await ID.readIdentity('127.0.0.1', { port, cache });
    await ID.readIdentity('127.0.0.1', { port, cache });
    expect(n).toBe(1);
  });
});

describe('acquireForLane wiring', () => {
  const dirs = [];
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-wire-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const lane = (dir, port, extra = {}) => C.acquireForLane({
    cfg: {}, opts: { wait: '0' }, host: '127.0.0.1', ecpPort: port, password: 'pw', purpose: 'test', command: ['x'], env: { BRIGHTTEST_LEASE_DIR: dir, PATH: process.env.PATH },
    deps: { readIdentity: (h, o) => ID.readIdentity(h, { ...o, cache: new Map(), timeoutMs: 300 }), ...extra },
  });
  const captureErr = () => { const out = []; const o = process.stderr.write; process.stderr.write = (m) => { out.push(String(m)); return true; }; return { out, restore: () => { process.stderr.write = o; } }; };

  it('two addresses and ports of one device share a lease; the key hides the serial', async () => {
    const dir = mk();
    const p1 = await fake(info(SERIAL)); const p2 = await fake(info(SERIAL));
    const a = await lane(dir, p1);
    expect(a.lease.key).toBe(L.keyFromIdentity(SERIAL));
    expect(a.lease.key).not.toContain(SERIAL);
    const e = captureErr();
    let b;
    try { b = await lane(dir, p2); } finally { e.restore(); }
    expect(b.code).toBe(75); // second address of the same device is busy
    a.lease.release();
  });
  it('different devices do not share a lease', async () => {
    const dir = mk();
    const p1 = await fake(info('SER-ONE')); const p2 = await fake(info('SER-TWO'));
    const a = await lane(dir, p1); const b = await lane(dir, p2);
    expect(a.lease.key).not.toBe(b.lease.key);
    a.lease.release(); b.lease.release();
  });
  it('timeout falls back to the address key and logs it every time without the serial', async () => {
    const dir = mk();
    const port = await fake(() => {});
    const e = captureErr();
    let a; let b;
    try {
      a = await lane(dir, port); a.lease.release();
      b = await lane(dir, port); b.lease.release();
    } finally { e.restore(); }
    expect(a.lease.key).toBe(`127.0.0.1_p${port}`);
    expect(e.out.filter((l) => /identity not read/.test(l))).toHaveLength(2);
    expect(e.out.join('\n')).not.toContain(SERIAL);
  });
  it('hook log key follows the identity key a lane recorded', async () => {
    const dir = mk();
    const port = await fake(info(SERIAL));
    const a = await lane(dir, port); a.lease.release();
    const env = { BRIGHTTEST_LEASE_DIR: dir, ROKU_HOST: '127.0.0.1', HOME: dir };
    expect(H.evaluate({ tool_name: 'Read', tool_input: {} }, env).state.logKey).toBe(L.keyFromIdentity(SERIAL));
    expect(H.evaluate({ tool_name: 'Read', tool_input: {} }, { ...env, BRIGHTTEST_LEASE_DIR: mk() }).state.logKey).toBe('127.0.0.1');
  });
});
