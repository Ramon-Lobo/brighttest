import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import L from '../lib/device-lease.js';
import V from '../lib/device-lease-view.js';

// Fixture lease folders are written by hand under the OS temp dir (never the real lease dir) and read with the
// view. The clock, liveness and host name are injected, so nothing depends on this machine's processes.
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const HOST = 'test-host';
const LIVE_PID = 4242;
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-view-')); dirs.push(d); return d; };
const ID_A = L.keyFromIdentity('SERIAL-A');
const ID_B = L.keyFromIdentity('SERIAL-B');
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();

function holderRec({ key, host, port = 8060, leaseId, agent = 'dev#1', purpose = 'e2e run smoke', pid = LIVE_PID, heldMs = 60000, mode = 'command', deadlineMs = 3600000, hostname = HOST }) {
  return {
    schema: 'brighttest-lease/v1', leaseId, mode, device: { key, host, port, serialHash: 'abcdef123456' },
    holder: { agent, purpose, pid, pidStart: null, childPids: [], hostname, user: 'u', cwd: '/x', worktree: 'wt', branch: 'feat/x', command: ['secret', 'cmd'] },
    acquiredAt: ago(heldMs), heartbeatAt: ago(1000), expiresAt: null, idleMs: null, deadline: ahead(deadlineMs), expectMs: null,
  };
}
function putHolder(dir, key, rec) { fs.mkdirSync(path.join(dir, key, 'queue'), { recursive: true }); fs.writeFileSync(path.join(dir, key, 'holder.json'), JSON.stringify(rec)); }
function putTicket(dir, key, { leaseId, agent, purpose = 'with x', queuedMs, pid = LIVE_PID, waitUntilMs = 600000, mtimeAgoMs = 1000 }) {
  const q = path.join(dir, key, 'queue'); fs.mkdirSync(q, { recursive: true });
  const f = path.join(q, `${String(NOW - queuedMs).padStart(15, '0')}-${leaseId}.json`);
  fs.writeFileSync(f, JSON.stringify({ leaseId, agent, purpose, pid, pidStart: null, hostname: HOST, queuedAt: ago(queuedMs), waitUntil: ahead(waitUntilMs), mode: 'command' }));
  const t = new Date(NOW - mtimeAgoMs); fs.utimesSync(f, t, t);
}
const ev = (e, atMs, extra = {}) => JSON.stringify({ t: ago(atMs), ev: e, ...extra });
function putEvents(dir, key, lines, { rotated = false } = {}) {
  fs.mkdirSync(path.join(dir, key), { recursive: true });
  fs.writeFileSync(path.join(dir, key, rotated ? 'events.log.1' : 'events.log'), lines.join('\n') + '\n');
}
const view = (dir, extra = {}) => V.createView({
  dir, env: {}, now: () => NOW, hostname: HOST, machine: HOST, isAlive: (pid) => pid === LIVE_PID, pidStart: () => null, knownDevices: () => [], ...extra,
});
const tree = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n); const st = fs.statSync(p);
      if (st.isDirectory()) { out.push(`D ${path.relative(dir, p)} ${st.mtimeMs}`); walk(p); } else out.push(`F ${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir); return out;
};

// A fs whose every write-like call throws: proves the view only reads. openSync is allowed for reading only.
function trapFs() {
  const writers = /^(write|append|unlink|rm|rmdir|rename|mkdir|utimes|futimes|lutimes|link|symlink|copy|truncate|ftruncate|chmod|fchmod|chown|fchown|mkdtemp|cp)(File)?(Sync)?$/;
  return new Proxy(fs, {
    get(t, name) {
      const v = t[name];
      if (typeof v !== 'function') return v;
      if (name === 'openSync') return (p, flags = 'r', ...r) => { if (flags !== 'r') throw new Error(`write trap: open ${flags}`); return v.call(t, p, flags, ...r); };
      if (name === 'writeSync' || (typeof name === 'string' && writers.test(name))) return () => { throw new Error(`write trap: fs.${String(name)}`); };
      return v.bind(t);
    },
  });
}

describe('pure helpers exported from the lease', () => {
  const ctx = { now: NOW, hostname: HOST, alive: (p) => p === LIVE_PID, startOf: () => null, graceMs: 60000 };
  it('ticketState: expired waitUntil is dead; dead pid is dead only past the grace; foreign host is live', () => {
    expect(L.ticketState({ pid: LIVE_PID, mtimeMs: NOW }, ctx)).toBe('live');
    expect(L.ticketState({ pid: LIVE_PID, waitUntil: ago(1), mtimeMs: NOW }, ctx)).toBe('dead');
    expect(L.ticketState({ pid: 1, mtimeMs: NOW - 1000 }, ctx)).toBe('live');
    expect(L.ticketState({ pid: 1, mtimeMs: NOW - 61000 }, ctx)).toBe('dead');
    expect(L.ticketState({ pid: 1, hostname: 'other', mtimeMs: 0 }, ctx)).toBe('live');
  });
  it('ticketState: a reused pid (start time differs) is dead past the grace, and a cached mismatch is re-checked live', () => {
    const t = { pid: LIVE_PID, pidStart: 'Mon Nov 24 10:00:00 2026', mtimeMs: NOW - 61000 };
    expect(L.ticketState(t, { ...ctx, startOf: () => 'Tue Nov 25 09:00:00 2026' })).toBe('dead');
    expect(L.ticketState({ ...t, mtimeMs: NOW - 1000 }, { ...ctx, startOf: () => 'Tue Nov 25 09:00:00 2026' })).toBe('live');
    // the first (cached) read mismatches, the fresh read matches: still alive
    expect(L.ticketState(t, { ...ctx, startOf: (pid, o) => (o && o.fresh ? t.pidStart : 'stale cache') })).toBe('live');
  });
  it('computeEta: remaining hold of the holder plus the median of past holds per waiter', () => {
    const events = [{ ev: 'released', heldMs: 100, purpose: 'with x' }, { ev: 'released', heldMs: 300, purpose: 'with x' }];
    const holder = { acquiredAt: ago(50), expectMs: 150, holder: { purpose: 'a b' } };
    const r = L.computeEta(holder, [{ purpose: 'with x' }, { purpose: 'with x' }], events, NOW);
    expect(r.perTicket).toEqual([100, 300]);
    expect(r.etaMs).toBe(500);
    expect(L.computeEta(null, [], [], NOW)).toEqual({ etaMs: 0, perTicket: [] });
  });
});

describe('board from a fixture lease dir', () => {
  function fixture() {
    const dir = mk();
    const host = '192.0.2.10';
    // device A: identity key + address key, one holder (same lease on both), queue of 2 live + 1 dead
    for (const k of [ID_A, host]) putHolder(dir, k, holderRec({ key: k, host, leaseId: 'aaaaaaaa11112222', heldMs: 4 * 60000 }));
    putTicket(dir, ID_A, { leaseId: 'bbbbbbbb00000001', agent: 'dev#3', queuedMs: 62000, purpose: 'e2e run smoke' });
    putTicket(dir, host, { leaseId: 'bbbbbbbb00000001', agent: 'dev#3', queuedMs: 62000, purpose: 'e2e run smoke' });
    putTicket(dir, ID_A, { leaseId: 'cccccccc00000002', agent: 'device-qa#2', queuedMs: 20000 });
    putTicket(dir, ID_A, { leaseId: 'dddddddd00000003', agent: 'gone', queuedMs: 500000, pid: 1, mtimeAgoMs: 300000 });
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ [host]: ID_A, '127.0.0.1_p9100': ID_B }));
    const run = (id, atEnd, waited, held, extra = {}) => [
      ev('acquired', atEnd + held, { leaseId: id, agent: 'dev#1', purpose: 'e2e run smoke', waitedMs: waited, queued: waited > 0 }),
      ev(extra.end || 'released', atEnd, { leaseId: id, agent: 'dev#1', purpose: 'e2e run smoke', heldMs: held, ...(extra.more || {}) })];
    const lines = [...run('r1xxxxxxxxxxxx', 3600000, 0, 120000), ...run('r2xxxxxxxxxxxx', 1800000, 5000, 240000), ...run('r3xxxxxxxxxxxx', 900000, 0, 60000, { end: 'lost', more: { reason: 'deadline' } }),
      ev('queued', 100000, { leaseId: 'tttttttt00000009', agent: 'x', purpose: 'p' }), ev('timeout', 90000, { leaseId: 'tttttttt00000009', agent: 'x', purpose: 'p', waitedMs: 10000 }),
      ev('acquired', 240000, { leaseId: 'aaaaaaaa11112222', agent: 'dev#1', purpose: 'e2e run smoke', waitedMs: 0 })];
    putEvents(dir, ID_A, lines);
    putEvents(dir, host, lines); // dual-key writes: the same events on both keys
    // a loopback fake with history, and 50 more loopback key dirs
    putEvents(dir, '127.0.0.1_p9100', [ev('acquired', 1000, { leaseId: 'zz', waitedMs: 0 })]);
    for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(dir, `127.0.0.1_p${20000 + i}`, 'queue'), { recursive: true });
    // device C: a stale holder (dead pid) on an address key
    putHolder(dir, '192.0.2.20', holderRec({ key: '192.0.2.20', host: '192.0.2.20', leaseId: 'ssssssss00000005', pid: 1, agent: 'dev#9' }));
    // pool gate with one waiter
    putHolder(dir, 'pool-0123456789ab', holderRec({ key: 'pool-0123456789ab', host: 'pool', leaseId: 'pppppppp00000006', agent: 'picker' }));
    putTicket(dir, 'pool-0123456789ab', { leaseId: 'qqqqqqqq00000007', agent: 'waiter', queuedMs: 3000 });
    // an old idle non-loopback key
    const old = path.join(dir, '192.0.2.99'); fs.mkdirSync(path.join(old, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(old, 'events.log'), ev('acquired', 9 * 86400000, { leaseId: 'oo' }) + '\n');
    const t9 = new Date(NOW - 9 * 86400000); fs.utimesSync(path.join(old, 'events.log'), t9, t9);
    return { dir, host };
  }
  const devA = (b) => b.devices.find((d) => d.label === '192.0.2.10');

  it('merges identity+address into one device, shows the queue, a stale holder, the pool row, and hides noise', () => {
    const { dir, host } = fixture();
    const b = view(dir).snapshot();
    expect(b.schema).toBe('brighttest-lease-board/v1');
    expect(b.devices.map((d) => d.label).sort()).toEqual(['192.0.2.10', '192.0.2.20']);
    const a = devA(b);
    expect(a.keys).toEqual([ID_A, host]);
    expect(a.id).toBe(ID_A);
    expect(a.state).toBe('held');
    expect(a.holder).toMatchObject({ agent: 'dev#1', purpose: 'e2e run smoke', heldMs: 240000, foreign: false, staleReason: null, leaseId8: 'aaaaaaaa' });
    expect(a.queueLength).toBe(2); // the same waiter on both keys counts once; the dead ticket does not count
    const dead = a.queue.find((q) => q.dead);
    expect(dead).toMatchObject({ agent: 'gone', pos: null, etaMs: null });
    const live = a.queue.filter((q) => !q.dead);
    expect(live.map((q) => [q.pos, q.agent])).toEqual([[1, 'dev#3'], [2, 'device-qa#2']]);
    expect(live[0].waitingMs).toBe(62000);
    // the median of past "e2e run" holds is 180000 and the holder has already held longer: the first waiter is next
    expect(live.map((q) => q.etaMs)).toEqual([0, 180000]);
    expect(a.etaMs).toBeNull(); // the second waiter's verb has no history, so the whole line has no total
    const c = b.devices.find((d) => d.label === '192.0.2.20');
    expect(c.state).toBe('stale');
    expect(c.holder.staleReason).toBe('dead');
    expect(b.pools).toEqual([{ size: null, queueLength: 1, queue: [expect.objectContaining({ agent: 'waiter', pos: 1 })] }]);
    expect(b.devices.some((d) => d.keys.some((k) => /^pool-/.test(k)))).toBe(false);
    // 50 loopback dirs + the loopback fake's dir (its id key has no dir) + the old idle key
    expect(b.hidden.keys).toBe(50 + 1 + 1);
  });

  it('shows the exit code and queued-ahead count when present, nothing when absent (old lines)', () => {
    const dir = mk();
    const key = 'FAKE-DEVICE-A';
    putEvents(dir, key, [
      ev('acquired', 600000, { leaseId: 'newnewnew1', agent: 'a', purpose: 'with x', waitedMs: 1000, hostname: 'box', mode: 'command', queuedAhead: 2 }),
      ev('released', 500000, { leaseId: 'newnewnew1', agent: 'a', purpose: 'with x', heldMs: 100000, exitCode: 3 }),
      ev('acquired', 400000, { leaseId: 'oldoldold1', agent: 'a', purpose: 'with x', waitedMs: 0 }),
      ev('released', 300000, { leaseId: 'oldoldold1', agent: 'a', purpose: 'with x', heldMs: 100000 }),
    ]);
    const runs = view(dir).snapshot({ all: true }).devices.find((d) => d.keys.includes(key)).runs;
    expect(runs.find((r) => r.leaseId8 === 'newnewne')).toMatchObject({ exitCode: 3, queuedAhead: 2, hostname: 'box', mode: 'command' });
    expect(runs.find((r) => r.leaseId8 === 'oldoldol')).toMatchObject({ exitCode: null, queuedAhead: null });
  });

  it('a dual-key run keeps the largest queuedAhead across its legs', () => {
    const dir = mk();
    const idKey = ID_A;
    const adKey = '192.0.2.10';
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ [adKey]: ID_A }));
    const a = { leaseId: 'dualdual1', agent: 'a', purpose: 'with x' };
    putEvents(dir, idKey, [
      ev('queued', 700000, { ...a, queuedAhead: 2 }),
      ev('acquired', 600000, { ...a, waitedMs: 100000, queued: true, queuedAhead: 2 }),
      ev('released', 500000, { ...a, heldMs: 100000, exitCode: 0 }),
    ]);
    putEvents(dir, adKey, [
      ev('acquired', 599000, { ...a, waitedMs: 0, queuedAhead: 0 }),
      ev('released', 500000, { ...a, heldMs: 99000, exitCode: 0 }),
    ]);
    const runs = view(dir).snapshot({ all: true }).devices.flatMap((d) => d.runs).filter((r) => r.leaseId8 === 'dualdual');
    expect(runs.length).toBeGreaterThan(0);
    expect(Math.max(...runs.map((r) => r.queuedAhead))).toBe(2);
    expect(runs.every((r) => r.queuedAhead === 2)).toBe(true);
  });

  it('--all shows hidden keys; --host filters', () => {
    const { dir } = fixture();
    const all = view(dir).snapshot({ all: true });
    expect(all.devices.length).toBeGreaterThan(50);
    expect(all.hidden.keys).toBe(0);
    const one = view(dir).snapshot({ host: '192.0.2.20' });
    expect(one.devices.map((d) => d.label)).toEqual(['192.0.2.20']);
  });

  it('joins runs, counts a dual-key log once, computes stats', () => {
    const { dir } = fixture();
    const a = devA(view(dir).snapshot());
    expect(a.runs).toHaveLength(5); // 3 finished + running + timeout, each once
    expect(a.runs.find((r) => r.ended === 'running')).toMatchObject({ ended: 'running', leaseId8: 'aaaaaaaa', waitedMs: 0, heldMs: 240000, endedAt: null });
    expect(a.runs.find((r) => r.leaseId8 === 'r2xxxxxx')).toMatchObject({ ended: 'released', waitedMs: 5000, heldMs: 240000, agent: 'dev#1', exitCode: null });
    expect(a.runs.find((r) => r.leaseId8 === 'r3xxxxxx')).toMatchObject({ ended: 'lost', reason: 'deadline' });
    expect(a.runs.find((r) => r.ended === 'timeout')).toMatchObject({ waitedMs: 10000, heldMs: null });
    expect(a.stats).toMatchObject({ window: '24h', runs: 4, medianHoldMs: 120000, p90HoldMs: 240000, medianWaitMs: 0, timeouts: 1, maxQueue: 2 });
    expect(devA(view(dir).snapshot({ historyN: 2 })).runs).toHaveLength(2);
  });

  it('the JSON never carries a full lease id, a serial hash, or a command', () => {
    const { dir } = fixture();
    const text = JSON.stringify(view(dir).snapshot({ all: true }));
    for (const s of ['aaaaaaaa11112222', 'abcdef123456', 'secret', 'bbbbbbbb00000001', 'r1xxxxxxxxxxxx']) expect(text).not.toContain(s);
  });

  it('leaves the lease dir byte-identical and works through a write-trapping fs', () => {
    const { dir } = fixture();
    const before = tree(dir);
    const v = view(dir, { fs: trapFs() });
    for (let i = 0; i < 20; i++) expect(v.snapshot({ all: i % 2 === 0 }).devices.length).toBeGreaterThan(1);
    expect(tree(dir)).toEqual(before); // dead ticket and stale holder still there, no file created
  });

  it('the write trap really traps writes', () => {
    const t = trapFs();
    const d = mk();
    expect(() => t.writeFileSync(path.join(d, 'x'), '1')).toThrow(/write trap/);
    expect(() => t.mkdirSync(path.join(d, 'y'))).toThrow(/write trap/);
    expect(() => t.openSync(path.join(d, 'z'), 'a')).toThrow(/write trap/);
    expect(t.readdirSync(d)).toEqual([]);
  });

  it('a missing lease dir is an empty board and is not created', () => {
    const dir = path.join(mk(), 'nope');
    const b = view(dir, { fs: trapFs() }).snapshot();
    expect(b.devices).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('known devices without a lease dir appear as free; loopback known hosts stay hidden unless held', () => {
    const dir = mk();
    const b = view(dir, { knownDevices: () => [{ host: '192.0.2.50', name: 'lab-a' }, { host: '127.0.0.1', name: 'fake' }] }).snapshot();
    expect(b.devices).toHaveLength(1);
    expect(b.devices[0]).toMatchObject({ label: 'lab-a', state: 'free', holder: null, queueLength: 0 });
  });

  it('a known address that the identity cache maps to an id key is the same device as that key', () => {
    const dir = mk();
    putHolder(dir, ID_A, holderRec({ key: ID_A, host: '192.0.2.10', leaseId: 'iiiiiiii00000001' }));
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ '192.0.2.10': ID_A }));
    const b = view(dir, { knownDevices: () => [{ host: '192.0.2.10', name: 'lab-a' }] }).snapshot();
    expect(b.devices).toHaveLength(1);
    expect(b.devices[0]).toMatchObject({ label: 'lab-a', state: 'held' });
    expect(b.devices[0].keys).toEqual([ID_A, '192.0.2.10']);
  });

  it('an identity holder links to its address key through device.host and device.port', () => {
    const dir = mk();
    putHolder(dir, ID_A, holderRec({ key: ID_A, host: '127.0.0.1', port: 9101, leaseId: 'iiiiiiii00000002' }));
    putEvents(dir, '127.0.0.1_p9101', [ev('acquired', 1000, { leaseId: 'iiiiiiii00000002', waitedMs: 0 })]);
    const b = view(dir).snapshot();
    expect(b.devices).toHaveLength(1);
    expect(b.devices[0].keys).toEqual([ID_A, '127.0.0.1_p9101']);
  });

  it('a held loopback key is shown', () => {
    const dir = mk();
    putHolder(dir, '127.0.0.1_p9101', holderRec({ key: '127.0.0.1_p9101', host: '127.0.0.1', port: 9101, leaseId: 'llllllll00000001' }));
    expect(view(dir).snapshot().devices.map((d) => d.state)).toEqual(['held']);
  });

  it('a foreign holder host is flagged and never judged stale by pid', () => {
    const dir = mk();
    putHolder(dir, '192.0.2.30', holderRec({ key: '192.0.2.30', host: '192.0.2.30', leaseId: 'ffffffff00000001', pid: 1, hostname: 'other-box' }));
    const d = view(dir).snapshot().devices[0];
    expect(d.state).toBe('held');
    expect(d.holder).toMatchObject({ foreign: true, hostname: 'other-box' });
  });

  it('a corrupt holder file shows as corrupt', () => {
    const dir = mk();
    fs.mkdirSync(path.join(dir, '192.0.2.31', 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, '192.0.2.31', 'holder.json'), '{not json');
    expect(view(dir).snapshot().devices[0].state).toBe('corrupt');
  });

  it('a session hold past its idle time shows as stale (idle)', () => {
    const dir = mk();
    const rec = holderRec({ key: '192.0.2.32', host: '192.0.2.32', leaseId: 'sess0000aaaa0001', mode: 'session', pid: null });
    rec.expiresAt = ago(1000);
    putHolder(dir, '192.0.2.32', rec);
    const d = view(dir).snapshot().devices[0];
    expect(d.state).toBe('stale');
    expect(d.holder).toMatchObject({ mode: 'session', staleReason: 'idle' });
  });
});

describe('review fixes', () => {
  it('a device reached by host name is one device: dual-key runs join the keys, one run, no second row', () => {
    const dir = mk();
    const ID_X = L.keyFromIdentity('SERIAL-X');
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ 'roku-lab.local': ID_X }));
    const lines = [ev('acquired', 60000, { leaseId: 'dual1000000000aa', agent: 'a', purpose: 'p q', waitedMs: 0 }), ev('released', 10000, { leaseId: 'dual1000000000aa', agent: 'a', purpose: 'p q', heldMs: 50000 })];
    putEvents(dir, ID_X, lines);
    putEvents(dir, '192.0.2.7', lines);
    const b = view(dir, { knownDevices: () => [{ host: 'roku-lab.local', name: 'lab-x' }] }).snapshot();
    expect(b.devices).toHaveLength(1);
    expect(b.devices[0]).toMatchObject({ label: 'lab-x', state: 'free' });
    expect(b.devices[0].keys.sort()).toEqual([ID_X, '192.0.2.7', 'roku-lab.local'].sort());
    expect(b.devices[0].runs).toHaveLength(1);
    expect(b.devices[0].stats.runs).toBe(1);
  });

  it('crashed-test leftovers (stale holder, expired ticket) on loopback keys stay hidden and are counted', () => {
    const dir = mk();
    putHolder(dir, '127.0.0.1_p31000', holderRec({ key: '127.0.0.1_p31000', host: '127.0.0.1', port: 31000, leaseId: 'crash000000000001', pid: 1 }));
    putTicket(dir, '127.0.0.1_p31000', { leaseId: 'crash000000000002', agent: 'x', queuedMs: 900000, waitUntilMs: -1000 });
    putHolder(dir, '__ffff_127.0.0.1', holderRec({ key: '__ffff_127.0.0.1', host: '::ffff:127.0.0.1', leaseId: 'crash000000000003', pid: 1 }));
    putTicket(dir, '__1', { leaseId: 'crash000000000004', agent: 'x', queuedMs: 900000, waitUntilMs: -1000 });
    const b = view(dir).snapshot();
    expect(b.devices).toEqual([]);
    expect(b.hidden).toMatchObject({ keys: 3, staleLoopbackHolders: 2 });
    // a live loopback holder is still shown, and --all shows the leftovers
    putHolder(dir, '127.0.0.1_p31001', holderRec({ key: '127.0.0.1_p31001', host: '127.0.0.1', port: 31001, leaseId: 'live0000000000001' }));
    expect(view(dir).snapshot().devices.map((d) => d.state)).toEqual(['held']);
    expect(view(dir).snapshot({ all: true }).devices).toHaveLength(4);
  });

  it('an expired ticket alone does not make an idle old key busy', () => {
    const dir = mk();
    putTicket(dir, '192.0.2.60', { leaseId: 'dead0000000000001', agent: 'x', queuedMs: 900000, waitUntilMs: -1000 });
    const old = new Date(NOW - 9 * 86400000);
    fs.utimesSync(path.join(dir, '192.0.2.60', 'queue'), old, old);
    expect(view(dir).snapshot().devices).toEqual([]);
  });

  it('a dual-key run: hold from the later leg, wait from the earliest waiting start', () => {
    const dir = mk();
    const id = 'dualwait00000000a';
    putEvents(dir, ID_A, [ev('acquired', 100000, { leaseId: id, agent: 'a', purpose: 'p q', waitedMs: 30000 }), ev('released', 10000, { leaseId: id, agent: 'a', purpose: 'p q', heldMs: 90000 })]);
    putEvents(dir, '192.0.2.8', [ev('acquired', 95000, { leaseId: id, agent: 'a', purpose: 'p q', waitedMs: 2000 }), ev('released', 10000, { leaseId: id, agent: 'a', purpose: 'p q', heldMs: 85000 })]);
    putHolder(dir, ID_A, holderRec({ key: ID_A, host: '192.0.2.8', leaseId: 'other00000000000' }));
    const r = view(dir).snapshot().devices[0].runs.find((x) => x.leaseId8 === 'dualwait');
    expect(r).toMatchObject({ waitedMs: 35000, heldMs: 85000 });
  });

  it('a backwards clock step still pairs acquired and released (file order, not time order)', () => {
    const dir = mk();
    const id = 'backclock0000000a';
    putEvents(dir, '192.0.2.9', [ev('acquired', 50000, { leaseId: id, agent: 'a', purpose: 'p q', waitedMs: 0 }), ev('released', 80000, { leaseId: id, agent: 'a', purpose: 'p q', heldMs: 4000 })]);
    const r = view(dir, { knownDevices: () => [{ host: '192.0.2.9' }] }).snapshot().devices[0].runs[0];
    expect(r).toMatchObject({ ended: 'released', heldMs: 4000 });
  });

  it('a corrupt holder on one key does not hide the valid holder on the other key', () => {
    const dir = mk();
    putHolder(dir, ID_A, holderRec({ key: ID_A, host: '192.0.2.11', leaseId: 'valid00000000001' }));
    fs.mkdirSync(path.join(dir, '192.0.2.11', 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, '192.0.2.11', 'holder.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'identity-cache.json'), JSON.stringify({ '192.0.2.11': ID_A }));
    const d = view(dir).snapshot().devices[0];
    expect(d.state).toBe('held');
    expect(d.holder.leaseId8).toBe('valid000');
    expect(d.error).toMatch(/192\.0\.2\.11 is unreadable/);
  });

  it('values from lease files are bounded strings or numbers; worktree goes through the home shortener', () => {
    const dir = mk();
    const rec = holderRec({ key: '192.0.2.12', host: '192.0.2.12', leaseId: 'weird00000000001' });
    rec.holder.agent = { x: 1 }; rec.holder.purpose = 'p'.repeat(5000); rec.holder.branch = 12; rec.holder.worktree = path.join(os.homedir(), 'wt1');
    putHolder(dir, '192.0.2.12', rec);
    const d = view(dir).snapshot().devices[0];
    expect(d.holder.agent).toBeNull();
    expect(d.holder.purpose).toHaveLength(300);
    expect(d.holder.branch).toBe('12');
    expect(d.holder.worktree).toBe(path.join('~', 'wt1'));
    expect(JSON.stringify(d)).not.toContain('[object');
  });
});

describe('event reader', () => {
  const key = '192.0.2.40';
  const idOf = (i) => `run${i}`.padEnd(16, '0');
  const runLines = (n) => Array.from({ length: n }, (_, i) => [
    ev('acquired', 100000 - i * 10000, { leaseId: idOf(i), agent: 'a', purpose: 'p q', waitedMs: i }),
    ev('released', 90000 - i * 10000, { leaseId: idOf(i), agent: 'a', purpose: 'p q', heldMs: 5000 })]).flat();
  const mkv = (dir) => view(dir, { knownDevices: () => [{ host: key }] });
  const runsOf = (v) => v.snapshot({ historyN: 50 }).devices.find((d) => d.keys.includes(key)).runs;
  const prep = () => { const dir = mk(); fs.mkdirSync(path.join(dir, key, 'queue'), { recursive: true }); return dir; };

  it('skips a torn last line until its newline arrives, then picks it up', () => {
    const dir = prep();
    const log = path.join(dir, key, 'events.log');
    const lines = runLines(1);
    fs.writeFileSync(log, lines[0] + '\n' + lines[1].slice(0, 30));
    const v = mkv(dir);
    expect(runsOf(v)[0].ended).toBe('unknown');
    fs.appendFileSync(log, lines[1].slice(30) + '\n');
    expect(runsOf(v)[0]).toMatchObject({ ended: 'released', heldMs: 5000 });
  });

  it('reads only appended bytes: an incremental read equals a fresh read', () => {
    const dir = prep();
    const log = path.join(dir, key, 'events.log');
    const lines = runLines(3);
    fs.writeFileSync(log, lines.slice(0, 2).join('\n') + '\n');
    const v = mkv(dir);
    expect(runsOf(v)).toHaveLength(1);
    fs.appendFileSync(log, lines.slice(2).join('\n') + '\n');
    const inc = runsOf(v);
    expect(inc).toHaveLength(3);
    expect(runsOf(mkv(dir))).toEqual(inc);
  });

  it('works with only events.log.1 present', () => {
    const dir = prep();
    fs.writeFileSync(path.join(dir, key, 'events.log.1'), runLines(2).join('\n') + '\n');
    expect(runsOf(mkv(dir))).toHaveLength(2);
  });

  it('re-reads both files after a rotation', () => {
    const dir = prep();
    const log = path.join(dir, key, 'events.log');
    const lines = runLines(3);
    fs.writeFileSync(log, lines.slice(0, 4).join('\n') + '\n'); // runs 0 and 1
    const v = mkv(dir);
    expect(runsOf(v)).toHaveLength(2);
    // the writer rotates: the log moves to .1 and a new, shorter log starts with run 2
    fs.renameSync(log, log + '.1');
    fs.writeFileSync(log, lines.slice(4).join('\n') + '\n');
    expect(runsOf(v)).toHaveLength(3);
    expect(runsOf(v)).toEqual(runsOf(mkv(dir))); // incremental == fresh through the rotation
  });

  it('skips junk lines and still reads the rest', () => {
    const dir = prep();
    const lines = runLines(1);
    fs.writeFileSync(path.join(dir, key, 'events.log'), ['not json', lines[0], '{"torn":', lines[1]].join('\n') + '\n');
    expect(runsOf(mkv(dir))[0].ended).toBe('released');
  });
});

describe('performance smoke', () => {
  it('3,400 realistic loopback key dirs (queue/, dir.id, events.log): a steady snapshot is fast and hides them', () => {
    const dir = mk();
    for (let i = 0; i < 3400; i++) {
      const k = path.join(dir, `127.0.0.1_p${10000 + i}`);
      fs.mkdirSync(path.join(k, 'queue'), { recursive: true });
      fs.writeFileSync(path.join(k, 'dir.id'), 'abcdef0123456789');
      fs.writeFileSync(path.join(k, 'events.log'), ev('acquired', 1000, { leaseId: `x${i}`, waitedMs: 0 }) + '\n');
    }
    const v = view(dir);
    v.snapshot();
    let best = Infinity; let b;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      b = v.snapshot();
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    expect(b.hidden.keys).toBe(3400);
    expect(best).toBeLessThan(process.platform === 'win32' ? 1500 : 300); // best of 3, so one slow tick cannot fail it
  });
});
