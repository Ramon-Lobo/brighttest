import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const L = require('../lib/device-lease.js');
const V = require('../lib/device-lease-view.js');
const studio = require('../lib/studio/server.js');
const { createFakeRoku } = require('./fixtures/fake-roku/server.js');

// GET /api/lease/board: the lease board for the Devices page. A fixture lease dir has a device `lab-a` held by
// another process (this test process, so the holder is alive). Studio does not hold anything and never takes the lease.
const HOST = os.hostname();
const NOW = Date.now(); // real time: the CLI run below reads the same dir with its own clock
const ago = (ms) => new Date(NOW - ms).toISOString();

describe('Studio lease board route', () => {
  let dir, fake, server, port, prevPort;
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    }).on('error', reject);
  });
  const strip = (b) => JSON.parse(JSON.stringify(b, (k, v) => (k === 'at' || k === 'heldMs' || k === 'waitingMs' || k === 'etaMs' || k === 'expiresAt' ? undefined : v)));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-board-'));
    const key = L.keyFromAddress('lab-a');
    fs.mkdirSync(path.join(dir, key, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, key, 'holder.json'), JSON.stringify({
      schema: 'brighttest-lease/v1', leaseId: 'aaaaaaaa-1111-2222-3333-444444444444', mode: 'command', device: { key, host: 'lab-a', port: 8060, serialHash: 'abcdef123456' },
      holder: { agent: 'fixture-agent', purpose: 'e2e smoke', pid: process.pid, pidStart: null, childPids: [], hostname: HOST, user: 'u', cwd: '/x', worktree: 'wt', branch: 'feat/x', command: ['x'] },
      acquiredAt: ago(60000), heartbeatAt: ago(1000), expiresAt: null, idleMs: null, deadline: new Date(NOW + 3600000).toISOString(), expectMs: null,
    }));
    fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 });
    const a = await fake.start();
    prevPort = process.env.ROKU_ECP_PORT; process.env.ROKU_ECP_PORT = String(a.ecpPort);
    process.env.BRIGHTTEST_LEASE_DIR = dir;
    process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json');
    server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg: null, leaseOpts: { tickMs: 50 } });
    port = server.address().port;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r)); await fake.stop();
    if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort;
    delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers while another process holds the device, and takes no lease', async () => {
    const before = fs.readdirSync(dir).sort();
    const r = await get('/api/lease/board');
    expect(r.status).toBe(200);
    const lab = r.json.devices.find((d) => d.label === 'lab-a');
    expect(lab).toMatchObject({ state: 'held', holder: { agent: 'fixture-agent', purpose: 'e2e smoke' } });
    // no lease was taken for the request: the only holder file is the fixture's, the same one
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(dir, L.keyFromAddress('lab-a'), 'holder.json'), 'utf8')).holder.agent).toBe('fixture-agent');
    expect(r.json.devices.every((d) => !d.holder || d.holder.agent !== 'studio')).toBe(true);
  });

  it('equals the view snapshot of the same dir (same clock)', async () => {
    const view = V.createView({ dir, env: process.env, prober: null });
    try {
      const expected = view.snapshot({});
      const r = await get('/api/lease/board');
      const got = r.json;
      for (const d of got.devices) d.reach = { state: 'unknown', at: null }; // the live probe is background and may land
      for (const d of expected.devices) d.reach = { state: 'unknown', at: null };
      expect(strip(got)).toEqual(strip(expected));
    } finally { view.close(); }
  });

  it('matches `device watch --json` for the same fixture dir (ignoring times)', async () => {
    const r = await get('/api/lease/board');
    const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'cli.js'), 'device', 'watch', '--json', '--no-probe'], {
      env: { ...process.env, BRIGHTTEST_LEASE_DIR: dir, BRIGHTTEST_CACHE: path.join(dir, 'devices.json') }, encoding: 'utf8', timeout: 20000,
    });
    expect(cli.status).toBe(0);
    const want = JSON.parse(cli.stdout);
    for (const d of r.json.devices) d.reach = { state: 'unknown', at: null };
    const a = strip(r.json); const b = strip(want);
    delete a.dir; delete b.dir;
    expect(a).toEqual(b);
  }, 30000);
});
