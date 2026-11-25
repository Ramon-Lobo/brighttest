import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import L from '../lib/device-lease.js';

const lookup = async (h) => ({ address: h });

describe('lease keying', () => {
  it('keeps two identities at two addresses independent', async () => {
    const a = await L.normalizeKey('192.168.0.210', { lookup, deviceId: 'SERIAL-A' });
    const b = await L.normalizeKey('192.168.2.210', { lookup, deviceId: 'SERIAL-B' });
    expect(a).not.toBe(b);
  });

  it('shares one lease for the same identity at two addresses and ports', async () => {
    const a = await L.normalizeKey('192.168.0.210', { lookup, deviceId: 'SERIAL-A' });
    const b = await L.normalizeKey('10.0.0.5', { lookup, deviceId: ' SERIAL-A ', port: 9000 });
    expect(a).toBe(b);
    expect(a).not.toContain('SERIAL');
  });

  it('falls back to the address key when identity is unknown', async () => {
    for (const deviceId of [undefined, null, '', '  ']) {
      expect(await L.normalizeKey('192.168.2.210', { lookup, deviceId })).toBe('192.168.2.210');
    }
    expect(await L.normalizeKey('192.168.2.210', { lookup, port: 9000 })).toBe('192.168.2.210_p9000');
  });

  it('acquire keys by identity when given, by address otherwise', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-key-'));
    try {
      const mk = async (o) => { const l = await L.acquire({ dir, lookup, waitMs: 0, timers: false, ...o }); const k = l.key; await l.release(); return k; };
      const k1 = await mk({ host: '192.168.0.210', deviceId: 'S1' });
      const k2 = await mk({ host: '192.168.2.210', deviceId: 'S1' });
      const k3 = await mk({ host: '192.168.2.210' });
      expect(k1).toBe(k2);
      expect(k3).toBe('192.168.2.210');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
