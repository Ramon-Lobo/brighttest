import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import lease from '../lib/device-lease.js'
import { loadConfig, parseLeasePool } from '../lib/config.js'
import cli from '../bin/cli.js'

const { acquirePool, acquire, createStore } = lease
const A = '127.0.0.1'
const B = '127.0.0.2'

let dir, clock
function seams(extra = {}) {
  return {
    dir, env: {}, timers: false, hostname: 'this-host', identity: { worktree: '/w', branch: 'b' },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms },
    isAlive: () => true,
    pidStart: () => 'start',
    random: () => 0.5,
    pid: 1001, pidStartValue: 'start',
    ...extra,
  }
}
const pool = (extra = {}) => acquirePool({ hosts: [A, B], waitMs: 60000, ...seams(extra), ...extra })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pool-'))
  clock = { t: Date.now() }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('acquirePool', () => {
  it('takes the first free device, then the second, and releases the gate', async () => {
    const l1 = await pool({ agent: 'a' })
    expect(l1.poolHost).toBe(A)
    const l2 = await pool({ agent: 'b', pid: 1002 })
    expect(l2.poolHost).toBe(B)
    const gates = fs.readdirSync(dir).filter((n) => n.startsWith('pool-'))
    expect(gates).toHaveLength(1)
    expect(fs.existsSync(path.join(dir, gates[0], 'holder.json'))).toBe(false)
    l1.release(); l2.release()
  })

  it('never overlaps two holders on one device', async () => {
    const l1 = await pool({ agent: 'a' })
    const l2 = await pool({ agent: 'b', pid: 1002 })
    expect(l1.key).not.toBe(l2.key)
    await expect(pool({ agent: 'c', pid: 1003, waitMs: 0 })).rejects.toMatchObject({ code: 'BUSY' })
    l1.release(); l2.release()
  })

  it('reuses a freed device (a freed first device is picked again)', async () => {
    const l1 = await pool({ agent: 'a' })
    const l2 = await pool({ agent: 'b', pid: 1002 })
    l1.release()
    const l3 = await pool({ agent: 'c', pid: 1003 })
    expect(l3.poolHost).toBe(A)
    l2.release(); l3.release()
  })

  it('times out with a TIMEOUT when the whole pool stays busy', async () => {
    const l1 = await pool({ agent: 'a' })
    const l2 = await pool({ agent: 'b', pid: 1002 })
    await expect(pool({ agent: 'c', pid: 1003, waitMs: 5000 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    l1.release(); l2.release()
  })

  it('a waiter gets a device when one frees while it polls', async () => {
    const l1 = await pool({ agent: 'a' })
    const l2 = await pool({ agent: 'b', pid: 1002 })
    let polls = 0
    const sleep = async (ms) => { clock.t += ms; if (++polls === 3) l2.release() }
    const l3 = await pool({ agent: 'c', pid: 1003, sleep })
    expect(l3.poolHost).toBe(B)
    l1.release(); l3.release()
  })

  it('serves waiters in FIFO order across the pool (oldest waiter gets the next free device)', async () => {
    const l1 = await pool({ agent: 'a' })
    const l2 = await pool({ agent: 'b', pid: 1002 })
    // Real clock and sleep so the two waiters interleave; short poll.
    const real = (extra) => acquirePool({ hosts: [A, B], waitMs: 20000, dir, env: {}, timers: false, hostname: 'this-host', identity: { worktree: '/w', branch: 'b' }, isAlive: () => true, pidStart: () => 'start', pidStartValue: 'start', pollMs: 20, settleMs: 0, ...extra })
    const order = []
    const w1 = real({ agent: 'w1', pid: 2001 }).then((l) => { order.push('w1:' + l.poolHost); return l })
    await new Promise((r) => setTimeout(r, 150))
    const w2 = real({ agent: 'w2', pid: 2002 }).then((l) => { order.push('w2:' + l.poolHost); return l })
    await new Promise((r) => setTimeout(r, 150))
    l2.release()
    const g1 = await w1
    expect(order).toEqual(['w1:' + B])
    g1.release()
    l1.release()
    const g2 = await w2
    expect(order[1]).toMatch(/^w2:/)
    g2.release()
  })

  it('rejects an empty pool and writes no lease files', async () => {
    await expect(acquirePool({ hosts: [], ...seams() })).rejects.toMatchObject({ code: 'USAGE' })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('an explicit-host acquire on a pool member excludes the pool from it', async () => {
    const x = await acquire({ host: A, key: A, waitMs: 0, ...seams() })
    const l = await pool({ agent: 'p' })
    expect(l.poolHost).toBe(B)
    x.release(); l.release()
  })
})

describe('deviceLease.pool config', () => {
  it('accepts a list, normalizes case, and rejects bad shapes with clear messages', () => {
    expect(parseLeasePool(['10.0.0.1', '10.0.0.2'])).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(() => parseLeasePool([])).toThrow(/empty/)
    expect(() => parseLeasePool('10.0.0.1')).toThrow(/list/)
    expect(() => parseLeasePool(['10.0.0.1', '10.0.0.1'])).toThrow(/duplicate/)
    expect(() => parseLeasePool(['10.0.0.1', 'HOST'.toLowerCase(), 'host'])).toThrow(/duplicate/)
    expect(() => parseLeasePool(['10.0.0.1:secret'])).toThrow(/bare host/)
    expect(() => parseLeasePool(['10.0.0.1:secret'])).not.toThrow(/secret/)
    expect(() => parseLeasePool([''])).toThrow(/non-empty/)
  })

  it('loadConfig reads deviceLease.pool and keeps the other defaults', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-poolcfg-'))
    fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify({ deviceLease: { pool: [A, B] } }))
    const cfg = loadConfig(d, null)
    expect(cfg.deviceLease.pool).toEqual([A, B])
    expect(cfg.deviceLease.wait).toBe('30m')
    fs.rmSync(d, { recursive: true, force: true })
  })
})

describe('--device any', () => {
  it('parses --device any and leaves plain --device alone', () => {
    expect(cli.parseArgs(['--device', 'any'])).toMatchObject({ device: true, devicePool: true })
    expect(cli.parseArgs(['--device', '--host', '1.2.3.4']).devicePool).toBeUndefined()
    expect(cli.parseArgs(['--device', 'any', '--host', '1.2.3.4'])).toMatchObject({ devicePool: true, host: '1.2.3.4' })
  })

  it('an explicit --host wins: no pool pick, no lease taken', async () => {
    const L = { acquirePool: vi.fn() }
    const r = await cli.pickPoolDevice({ deviceLease: { pool: [A, B] } }, { host: '9.9.9.9' }, { lease: L, deviceCommand: {} })
    expect(r).toEqual({ host: null, lease: null })
    expect(L.acquirePool).not.toHaveBeenCalled()
  })

  it('fails with usage (2) when no pool is configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await cli.pickPoolDevice({ deviceLease: {} }, {}, { lease: {}, deviceCommand: {} })
    expect(r.code).toBe(2)
    vi.restoreAllMocks()
  })

  it('takes the pool lease and exports its token for the lane', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {}
    const fake = { leaseId: 'tok', poolHost: B }
    const L = { resolveSettings: () => ({ enabled: true, waitMs: 0, maxHoldMs: 1000 }), acquirePool: vi.fn(async () => fake) }
    const r = await cli.pickPoolDevice({ deviceLease: { pool: [A, B] } }, {}, { lease: L, deviceCommand: { printWait() {} }, env })
    expect(r).toEqual({ host: B, lease: fake })
    expect(env.BRIGHTTEST_LEASE).toBe('tok')
    expect(L.acquirePool.mock.calls[0][0].hosts).toEqual([A, B])
    vi.restoreAllMocks()
  })
})
