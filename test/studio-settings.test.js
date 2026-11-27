import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const studio = require('../lib/studio/server.js');
const { buildSettings } = require('../lib/studio/settings.js');
const { createFakeRoku } = require('./fixtures/fake-roku/server.js');

// GET /api/settings (STUDIO-SET-T1): read-only, masked, no lease. POST /api/settings/check: device info only.
const PW = 'canary-pw-7f3a';
const TOKEN = 'abcdef0123456789abcdef0123456789';
const KEYS = ['ROKU_HOST', 'ROKU_PASSWORD', 'ROKU_ECP_PORT', 'BRIGHTTEST_HUB_TOKEN', 'BRIGHTTEST_LEASE_WAIT', 'BRIGHTTEST_LEASE_DIR', 'BRIGHTTEST_CACHE'];

describe('Studio settings route', () => {
  let dir, fake, server, port, saved;
  const call = (method, p) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    r.on('error', reject); if (method === 'POST') r.write('{}'); r.end();
  });
  const startWith = async (o = {}) => { server = await studio.start({ port: 0, rootDir: dir, ...o }); port = server.address().port; };
  beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-settings-'));
    process.env.BRIGHTTEST_LEASE_DIR = path.join(dir, 'lease'); process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json');
    fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 });
    const a = await fake.start(); process.env.ROKU_ECP_PORT = String(a.ecpPort);
  });
  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r)); server = null; await fake.stop();
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('device target: source flag, password known from flag, no secret or lease id in the body', async () => {
    process.env.BRIGHTTEST_HUB_TOKEN = TOKEN;
    fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ deviceLease: { wait: '5m' }, instrument: { state: { redact: { paths: ['user.token'] } } } }));
    await startWith({ host: '127.0.0.1', password: PW, cfg: require('../lib/config').loadConfig(dir, null) });
    const r = await call('GET', '/api/settings');
    expect(r.status).toBe(200);
    expect(r.json.device).toMatchObject({ target: 'device', host: '127.0.0.1', source: 'flag' });
    expect(r.json.password).toEqual({ known: true, source: 'flag' });
    expect(r.json.lease.wait).toMatchObject({ value: '5m', ms: 300000, source: 'brighttest.json' });
    expect(r.json.lease.maxHold.source).toBe('default');
    expect(r.json.hubToken).toBe('set');
    expect(r.json.redaction.statePaths).toEqual(['user.token']);
    expect(r.json.project.configFile).toBe(path.join(dir, 'brighttest.json'));
    expect(r.json.about.version).toMatch(/^\d/);
    expect(r.text).not.toContain(PW); expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toMatch(/leaseId|serial/i);
  });

  it('takes no lease and answers while the device is held by nobody else', async () => {
    await startWith({ host: '127.0.0.1', password: PW });
    const before = fs.existsSync(process.env.BRIGHTTEST_LEASE_DIR) ? fs.readdirSync(process.env.BRIGHTTEST_LEASE_DIR).sort() : [];
    expect((await call('GET', '/api/settings')).json.lease.holding).toBe(false);
    expect((await call('POST', '/api/settings/check')).status).toBe(200);
    expect(fs.existsSync(process.env.BRIGHTTEST_LEASE_DIR) ? fs.readdirSync(process.env.BRIGHTTEST_LEASE_DIR).sort() : []).toEqual(before);
  });

  it('host from ROKU_HOST in .env is reported as dotenv with the project default', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ROKU_HOST=127.0.0.1\nROKU_PASSWORD=' + PW + '\n');
    const prevCwd = process.cwd(); process.chdir(dir); // the lane resolver reads the project .env of the cwd
    try { await startWith({}); } finally { process.chdir(prevCwd); }
    const r = await call('GET', '/api/settings');
    expect(r.json.device).toMatchObject({ host: '127.0.0.1', source: 'dotenv', projectDefault: '127.0.0.1' });
    expect(r.json.password).toEqual({ known: true, source: 'dotenv' });
    expect(r.text).not.toContain(PW);
  });

  it('hub down: token unset, then malformed, each with its reason', async () => {
    await startWith({ host: '127.0.0.1', password: PW });
    let j = (await call('GET', '/api/settings')).json;
    expect(j.hubToken).toBe('unset'); expect(j.hub.up).toBe(false); expect(j.hub.reason).toMatch(/BRIGHTTEST_HUB_TOKEN is not set/);
    process.env.BRIGHTTEST_HUB_TOKEN = 'not-hex-' + PW;
    const r = await call('GET', '/api/settings'); j = r.json;
    expect(j.hubToken).toBe('malformed'); expect(j.hub.reason).toMatch(/32 lowercase hex/);
    expect(r.text).not.toContain(PW);
  });

  it('device-less: no host, source none; Test connection answers 409', async () => {
    await startWith({});
    const j = (await call('GET', '/api/settings')).json;
    expect(j.device).toMatchObject({ target: 'none', host: null, source: 'none' });
    expect(j.password.known).toBe(false);
    const c = await call('POST', '/api/settings/check');
    expect(c.status).toBe(409); expect(c.json.code).toBe('NO_DEVICE');
  });

  it('Test connection reports device info and drops the serial; an unreachable address is a clean failure', async () => {
    await startWith({ host: '127.0.0.1', password: PW });
    const ok = await call('POST', '/api/settings/check');
    expect(ok.status).toBe(200);
    expect(ok.json.reachable).toBe(true); expect(ok.json).not.toHaveProperty('serial');
    expect(ok.text).not.toContain(PW);
  });

  it('the Devices page connect changes the reported source to connect', async () => {
    await startWith({});
    const c = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/connect', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject); r.end(JSON.stringify({ host: '127.0.0.1', password: PW }));
    });
    expect(c).toBe(200);
    const r = await call('GET', '/api/settings');
    expect(r.json.device).toMatchObject({ host: '127.0.0.1', source: 'connect' });
    expect(r.json.password).toEqual({ known: true, source: 'connect' });
    expect(r.text).not.toContain(PW);
  });

  it('rejects a cross-origin POST to the check route', async () => {
    await startWith({ host: '127.0.0.1', password: PW });
    const s = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/settings/check', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject); r.end('{}');
    });
    expect(s).toBe(403);
  });
});

describe('buildSettings', () => {
  it('pool and simulator targets', () => {
    const base = { rootDir: os.tmpdir(), flowsRoot: os.tmpdir(), cfg: null, port: 1, env: {} };
    const pool = buildSettings({ ...base, pool: ['10.0.0.1', '10.0.0.2'], poolHosts: ['10.0.0.1', '10.0.0.2'], host: null });
    expect(pool.device.source).toBe('pool'); expect(pool.hub.reason).toMatch(/pool mode/);
    const sim = buildSettings({ ...base, sim: { net: {} }, host: null });
    expect(sim.device.target).toBe('simulator'); expect(sim.hub.up).toBe(true); expect(sim.password.source).toBe('n/a');
  });
});
