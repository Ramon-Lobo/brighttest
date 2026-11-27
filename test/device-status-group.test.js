import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import L from '../lib/device-lease.js';
import C from '../lib/device-command.js';

// Hand-written lease folders (never the real lease dir): a lane that holds the identity key and the address key
// writes one lease id to both. `device status` shows that device as one block; `device log` folds the pair.
const ID = L.keyFromIdentity('SERIAL-GROUP');
const ADDR = '10.9.8.7';
const dirs = [];
const saved = process.env.BRIGHTTEST_LEASE_DIR;
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = saved;
});
const iso = (ms) => new Date(Date.now() + ms).toISOString();
function rec(key, leaseId, agent) {
  return {
    schema: 'brighttest-lease/v1', leaseId, mode: 'command', device: { key, host: ADDR, port: 8060 },
    holder: { agent, purpose: 'group check', verb: 'with', pid: process.pid, pidStart: null, childPids: [], hostname: os.hostname(), user: 'u', cwd: '/x', worktree: 'wt', branch: 'feat/x' },
    acquiredAt: iso(-60000), heartbeatAt: iso(-1000), expiresAt: null, idleMs: null, deadline: iso(3600000), expectMs: null,
  };
}
function put(dir, key, r, events) {
  fs.mkdirSync(path.join(dir, key, 'queue'), { recursive: true });
  if (r) fs.writeFileSync(path.join(dir, key, 'holder.json'), JSON.stringify(r));
  if (events) fs.writeFileSync(path.join(dir, key, 'events.log'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
async function run(action, extra = {}) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await C.run({ deviceAction: action, ...extra }, {}); } finally { console.log = orig; }
  return lines.join('\n');
}
function setup(sameLease) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sg-')); dirs.push(dir);
  process.env.BRIGHTTEST_LEASE_DIR = dir;
  const t = (ms) => iso(ms);
  put(dir, ID, rec(ID, 'lease-aaaa-1111', 'agent-one'), [{ t: t(-60000), ev: 'acquired', key: ID, leaseId: 'lease-aaaa-1111', agent: 'agent-one', purpose: 'group check' }, { t: t(-1000), ev: 'released', key: ID, leaseId: 'lease-aaaa-1111', agent: 'agent-one', purpose: 'group check' }]);
  put(dir, ADDR, rec(ADDR, sameLease ? 'lease-aaaa-1111' : 'lease-bbbb-2222', sameLease ? 'agent-one' : 'agent-two'), [{ t: t(-59999), ev: 'acquired', key: ADDR, leaseId: 'lease-aaaa-1111', agent: 'agent-one', purpose: 'group check' }, { t: t(-999), ev: 'released', key: ADDR, leaseId: 'lease-aaaa-1111', agent: 'agent-one', purpose: 'group check' }]);
}

describe('device status groups one device', () => {
  it('prints one block and one holder line when both keys share a lease id', async () => {
    setup(true);
    const out = await run('status');
    expect(out).toContain(`[keys: ${ID}, ${ADDR}]`);
    expect(out.match(/held by/g)).toHaveLength(1);
    expect(out).not.toContain('address key only');
  });
  it('prints both holders, the address-only one marked, when the leases differ', async () => {
    setup(false);
    const out = await run('status');
    expect(out.match(/held by/g)).toHaveLength(2);
    expect(out).toContain(`${ADDR} (address key only)`);
  });
  it('--json keeps the per-key array and names the device on each entry', async () => {
    setup(true);
    const arr = JSON.parse(await run('status', { json: true }));
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.map((s) => s.key).sort()).toEqual([ID, ADDR].sort());
    for (const s of arr) expect(s.device.keys.sort()).toEqual([ID, ADDR].sort());
  });
  it('device log folds the second-key pair of one lease id; --json is unchanged', async () => {
    setup(true);
    const out = await run('log');
    expect(out.match(/ acquired /g)).toHaveLength(1);
    expect(out.match(/ released /g)).toHaveLength(1);
    expect(out).toContain(`${ID} + ${ADDR}`);
    expect(JSON.parse(await run('log', { json: true }))).toHaveLength(4);
  });
});
