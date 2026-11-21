import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const headless = require('../lib/headless.js');
const hubMod = require('../lib/instrument/hub.js');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, len: res.headers['content-length'] }));
    }).on('error', reject);
  });
}
const down = (port) => get(port, '/bt/x/hello').then(() => false, () => true);

function spyDeps() {
  const seen = { opts: null, hub: null, leases: 0 };
  const startHub = async (o) => {
    seen.opts = o;
    const hub = await hubMod.startHub(o);
    const stop = hub.stop; let stops = 0;
    hub.stop = () => { stops++; seen.stops = stops; return stop(); };
    seen.hub = hub;
    return hub;
  };
  return { seen, deps: { startHub, localLease: () => { seen.leases++; return hubMod.localLease(); } } };
}

describe('headless lane starts the instrument hub', () => {
  it('starts the hub with localLease() before the run and stops it after success', async () => {
    const { seen, deps } = spyDeps();
    let port;
    const r = await headless.withHub(async (hub) => {
      expect(hub).toBeTruthy();
      port = hub.port;
      return 7;
    }, deps);
    expect(r).toBe(7);
    expect(seen.opts.mode).toBe('headless');
    expect(seen.opts.lease.leaseId).toBe('local');
    expect(seen.opts.lease.held()).toBe(true);
    expect(seen.leases).toBeGreaterThan(0);
    expect(await down(port)).toBe(true);
  });

  it('stops the hub when the run reports failure', async () => {
    const { seen, deps } = spyDeps();
    const r = await headless.withHub(async () => 1, deps);
    expect(r).toBe(1);
    expect(seen.stops).toBe(1);
    expect(await down(seen.hub.port)).toBe(true);
  });

  it('stops the hub when the run throws, and rethrows', async () => {
    const { seen, deps } = spyDeps();
    await expect(headless.withHub(async () => { throw new Error('boom'); }, deps)).rejects.toThrow('boom');
    expect(seen.stops).toBe(1);
    expect(await down(seen.hub.port)).toBe(true);
  });

  it('is listening during the run and still refuses a wrong token with 404 and no body', async () => {
    const { deps } = spyDeps();
    await headless.withHub(async (hub) => {
      const bad = await get(hub.port, '/bt/not-the-token/hello');
      expect(bad.status).toBe(404);
      expect(bad.body).toBe('');
      expect(bad.len).toBe('0');
    }, deps);
  });

  it('refuses a non-loopback peer (peer mismatch) with 404 and no body', async () => {
    const hub = await hubMod.startHub({ mode: 'headless', lease: hubMod.localLease(), tokens: ['tok'], peerOf: () => '10.0.0.5' });
    try {
      const r = await get(hub.port, '/bt/tok/hello');
      expect(r.status).toBe(404);
      expect(r.body).toBe('');
    } finally { await hub.stop(); }
  });

  it('a hub that cannot start does not change the run result', async () => {
    const errs = []; const orig = console.error; console.error = (m) => errs.push(m);
    try {
      const r = await headless.withHub(async (hub) => (hub === null ? 'ran' : 'hub'), {
        startHub: async () => { throw new Error('no listener'); }, localLease: hubMod.localLease,
      });
      expect(r).toBe('ran');
    } finally { console.error = orig; }
    expect(errs.join('\n')).toMatch(/instrument hub not started: no listener/);
  });
});
