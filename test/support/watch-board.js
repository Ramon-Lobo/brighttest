'use strict';
// A fixed Board (brighttest-lease-board/v1) used by the device-watch tests: one held device with a line and a
// run history, one free device that is unreachable, one stale device, a pool line and hidden keys. Times are
// fixed so frames never change from run to run.
const NOW = Date.parse('2026-11-25T10:41:03.000Z');
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(NOW - ms);
const MIN = 60000;

function run(i, o) {
  return { leaseId8: 'a1b2c3d' + i, agent: 'device-qa#1', purpose: 'e2e run smoke', mode: 'command', startedAt: ago(o.startMin * MIN),
    endedAt: o.running ? null : ago((o.startMin - (o.holdMs || 0) / MIN) * MIN), waitedMs: o.waitedMs || 0, heldMs: o.running ? null : (o.holdMs || 0),
    ended: o.ended || 'released', reason: null, exitCode: o.exitCode === undefined ? null : o.exitCode, hostname: 'test-host', ...(o.rest || {}) };
}

function makeBoard() {
  const runsA = [
    run(1, { startMin: 4, running: true, ended: 'running', waitedMs: 0 }),
    run(2, { startMin: 10, holdMs: 370000, waitedMs: 0, exitCode: 0 }),
    run(3, { startMin: 19, holdMs: 125000, waitedMs: 120000, rest: { agent: 'dev#3', purpose: 'with npx rooibos' } }),
    run(4, { startMin: 26, holdMs: 61000, ended: 'lost', rest: { agent: 'device-qa#2', purpose: 'with e2e.sh' } }),
    run(5, { startMin: 33, holdMs: 90000, waitedMs: 30000, exitCode: 1 }),
    run(6, { startMin: 40, holdMs: 45000, ended: 'reclaimed' }),
    run(7, { startMin: 47, holdMs: 300000, waitedMs: 5000, exitCode: 0 }),
    run(8, { startMin: 55, ended: 'timeout', waitedMs: 600000, rest: { heldMs: null } }),
    run(9, { startMin: 61, holdMs: 15000, waitedMs: 0 }),
    run(0, { startMin: 70, holdMs: 200000, waitedMs: 1000, exitCode: 0 }),
  ];
  return {
    schema: 'brighttest-lease-board/v1', at: iso(NOW), dir: '~/.brighttest/leases', machine: 'test-host',
    devices: [
      { id: 'id-aaaaaaaaaaaaaaaa', label: 'lab-a', hosts: ['192.0.2.10'], keys: ['id-aaaaaaaaaaaaaaaa'], state: 'held',
        holder: { agent: 'device-qa#1', purpose: 'e2e run smoke', mode: 'command', since: ago(4 * MIN + 12000), heldMs: 4 * MIN + 12000,
          deadline: iso(NOW + 17 * MIN), expiresAt: null, worktree: '~/wt/a', branch: 'feat/x', hostname: 'test-host', foreign: false, staleReason: null, leaseId8: 'a1b2c3d4' },
        queue: [
          { pos: 1, agent: 'dev#3', purpose: 'with npx rooibos', since: ago(62000), waitingMs: 62000, etaMs: 180000, dead: false },
          { pos: 2, agent: 'device-qa#2', purpose: 'with e2e.sh', since: ago(20000), waitingMs: 20000, etaMs: 300000, dead: false },
          { pos: null, agent: 'gone', purpose: 'x', since: ago(900000), waitingMs: 900000, etaMs: null, dead: true },
        ],
        queueLength: 2, etaMs: 180000, reach: { state: 'up', at: ago(12000) }, runs: runsA,
        stats: { window: '24h', runs: 31, medianHoldMs: 160000, p90HoldMs: 420000, medianWaitMs: 12000, maxQueue: 3, timeouts: 1 } },
      { id: 'id-bbbbbbbbbbbbbbbb', label: 'lab-b', hosts: ['192.0.2.11'], keys: ['id-bbbbbbbbbbbbbbbb'], state: 'free', holder: null,
        queue: [], queueLength: 0, etaMs: null, reach: { state: 'unreachable', at: ago(30000), note: 'address now points at a different device' },
        runs: [run(1, { startMin: 120, holdMs: 60000, exitCode: 0 })],
        stats: { window: '24h', runs: 4, medianHoldMs: 60000, p90HoldMs: 90000, medianWaitMs: 0, maxQueue: 1, timeouts: 0 } },
      { id: '192_0_2_12', label: 'lab-c', hosts: ['192.0.2.12'], keys: ['192_0_2_12'], state: 'stale',
        holder: { agent: 'dev#9', purpose: 'with old.sh', mode: 'command', since: ago(50 * MIN), heldMs: 50 * MIN, deadline: iso(NOW - MIN), expiresAt: null,
          worktree: null, branch: null, hostname: 'test-host', foreign: false, staleReason: 'dead', leaseId8: 'ffeeddcc' },
        queue: [], queueLength: 0, etaMs: null, reach: { state: 'unknown', at: null }, runs: [],
        stats: { window: '24h', runs: 0, medianHoldMs: null, p90HoldMs: null, medianWaitMs: null, maxQueue: 0, timeouts: 0 } },
    ],
    pools: [{ size: 2, queueLength: 1, queue: [] }],
    hidden: { keys: 50, staleLoopbackHolders: 0, why: 'loopback or idle > 7d; --all to show' },
  };
}
module.exports = { NOW, makeBoard };
