import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import W from '../lib/device-watch.js';
import C from '../lib/device-command.js';
import { makeBoard } from './support/watch-board.js';

// A fake clock: sleep advances it, so no real waiting.
const rig = (extra = {}) => {
  let t = 1_000_000; const out = []; const err = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdoutIsTTY: false, stdinIsTTY: false, env: {}, platform: 'linux',
    now: () => t, sleep: async (ms) => { t += ms; }, ...extra };
  return { io, out, err, view: { snapshot: () => makeBoard() } };
};

describe('parseFor', () => {
  it('accepts the duration syntax and rejects bad values', () => {
    expect(W.parseFor('90s')).toBe(90000); expect(W.parseFor('10m')).toBe(600000); expect(W.parseFor('1h')).toBe(3600000); expect(W.parseFor('250')).toBe(250);
    for (const bad of ['', 'abc', '-5s', '0', '25h', '1d']) expect(() => W.parseFor(bad)).toThrow(RangeError);
  });
});

describe('plain loop bounds', () => {
  it('--for stops the plain loop after the duration, with no notice', async () => {
    const { io, out, err, view } = rig();
    expect(await W.runWatch({ view, flags: { plain: true, intervalMs: 1000, forMs: 3500 }, io })).toBe(0);
    expect(out).toHaveLength(4); // blocks at 0s, 1s, 2s, 3s; ends at the 3.5s deadline
    expect(err).toEqual([]);
  });
  it('off a terminal without --for or --plain it stops after 10 minutes with one notice line', async () => {
    const { io, out, err, view } = rig();
    expect(await W.runWatch({ view, flags: { intervalMs: 60000 }, io })).toBe(0);
    expect(out).toHaveLength(10);
    expect(err).toHaveLength(1); expect(err[0]).toMatch(/stopped after 10 minutes/); expect(err[0].trim().split('\n')).toHaveLength(1);
  });
  it('an explicit --plain without --for keeps running until aborted', async () => {
    const { io, out, err, view } = rig(); const ac = new AbortController(); let n = 0;
    const sleep = io.sleep; io.sleep = async (ms) => { await sleep(ms); if (++n >= 50) ac.abort(); };
    await W.runWatch({ view, flags: { plain: true, intervalMs: 60000 }, io, signal: ac.signal });
    expect(out).toHaveLength(50); expect(err).toEqual([]);
  });
});

describe('cmdWatch bounds', () => {
  const mk = (extra = {}) => {
    const out = []; const stdout = Object.assign(new EventEmitter(), { write: (s) => { out.push(s); return true; } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-watch-'));
    const io = { stdout, stderr: { write() {} }, stdoutIsTTY: false, stdinIsTTY: false, env: { BRIGHTTEST_LEASE_DIR: dir }, platform: 'linux' };
    const view = { snapshot: () => makeBoard(), close() {} };
    return { out, stdout, io, deps: { env: io.env, io, createView: () => view, ...extra } };
  };
  it('rejects a bad or missing --for with exit 2', async () => {
    for (const bad of ['abc', '', '0']) expect(await C.cmdWatch({ for: bad, plain: true }, mk().deps)).toBe(2);
  });
  it('--for ends a plain loop with real timers', async () => {
    const { deps, out } = mk();
    expect(await C.cmdWatch({ for: '120ms', plain: true, interval: '500ms', noProbe: true }, deps)).toBe(0);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
  it('exits cleanly when stdout reports EPIPE', async () => {
    const { deps, stdout } = mk();
    const p = C.cmdWatch({ plain: true, interval: '500ms', noProbe: true }, deps);
    setTimeout(() => stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 50);
    expect(await p).toBe(0);
  });
  it('exits when the parent pid changes', async () => {
    let pid = 4242; const { deps } = mk({ ppid: () => pid, parentCheckMs: 20 });
    const p = C.cmdWatch({ plain: true, interval: '500ms', noProbe: true }, deps);
    setTimeout(() => { pid = 1; }, 60);
    expect(await p).toBe(0);
  });
});
