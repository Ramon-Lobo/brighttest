import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import lease from '../lib/device-lease.js'
import { loadConfig, parseLeasePool } from '../lib/config.js'
import cli from '../bin/cli.js'
const { LeaseError } = lease

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


describe('acquirePool details', () => {
  it('releases the gate when the wait times out (a later pick still works)', async () => {
    const l1 = await pool({ agent: 'a' })
    const l2 = await pool({ agent: 'b', pid: 1002 })
    await expect(pool({ agent: 'c', pid: 1003, waitMs: 3000 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    const gate = fs.readdirSync(dir).find((n) => n.startsWith('pool-'))
    expect(fs.existsSync(path.join(dir, gate, 'holder.json'))).toBe(false)
    l1.release()
    const l3 = await pool({ agent: 'd', pid: 1004 })
    expect(l3.poolHost).toBe(A)
    l2.release(); l3.release()
  })

  it('--wait 0 with free devices does not fail on the gate (two concurrent picks)', async () => {
    const [x, y] = await Promise.all([pool({ agent: 'a', waitMs: 0 }), pool({ agent: 'b', pid: 1002, waitMs: 0 })])
    expect(new Set([x.poolHost, y.poolHost])).toEqual(new Set([A, B]))
    x.release(); y.release()
  })

  it('--wait 0 fails (BUSY) only when every member is busy', async () => {
    const l1 = await pool({ agent: 'a' }); const l2 = await pool({ agent: 'b', pid: 1002 })
    await expect(pool({ agent: 'c', pid: 1003, waitMs: 0 })).rejects.toMatchObject({ code: 'BUSY' })
    l1.release(); l2.release()
  })

  it('computes the pid start once, not per poll under the gate', async () => {
    let polls = 0; let hook = null
    const store = createStore(seams({ sleep: async (ms) => { clock.t += ms; polls++; if (hook) hook() } }))
    const spy = vi.spyOn(store, 'startOf')
    const l1 = await pool({ agent: 'a', store, pidStartValue: undefined })
    const l2 = await pool({ agent: 'b', pid: 1002, store, pidStartValue: undefined })
    polls = 0; hook = () => { if (polls === 4) l1.release() }
    const l3 = await pool({ agent: 'c', pid: 1003, store, pidStartValue: undefined })
    expect(polls).toBeGreaterThanOrEqual(4)
    expect(spy).toHaveBeenCalledTimes(3) // once per acquirePool call
    l2.release(); l3.release()
  })

  it('quietBusy suppresses only the member busy event', async () => {
    const x = await acquire({ host: A, key: A, waitMs: 0, ...seams() })
    const busy = (extra) => acquire({ host: A, key: A, waitMs: 0, ...seams({ pid: 1002 }), ...extra }).catch((e) => e)
    const count = () => createStore({ dir }).readEvents({ key: A }).filter((e) => e.ev === 'timeout').length
    expect((await busy({ quietBusy: true })).code).toBe('BUSY')
    expect(count()).toBe(0)
    expect((await busy({})).code).toBe('BUSY')
    expect(count()).toBe(1)
    x.release()
  })

  it('a token that holds nothing is LEASE_LOST; a token held on another key still picks normally', async () => {
    await expect(pool({ token: 'deadbeef00000000' })).rejects.toMatchObject({ code: 'LEASE_LOST' })
    const other = await acquire({ host: '127.0.0.9', key: '127.0.0.9', waitMs: 0, ...seams() })
    const l = await pool({ token: other.leaseId, pid: 1002 })
    expect(l.poolHost).toBe(A)
    l.release(); other.release()
  })

  it('a token holding a member is re-used with no gate', async () => {
    const l1 = await pool({ agent: 'a' })
    const re = await pool({ token: l1.leaseId })
    expect(re.reentrant).toBe(true)
    expect(re.poolHost).toBe(A)
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('pool-')).length).toBe(1)
    l1.release()
  })
})

describe('re-entrant lease delegates children to the held lease', () => {
  it('a nested acquire with the token records the child in childPids, and cleanup kills it', async () => {
    const l = await pool({ agent: 'a', env: {} })
    const nested = await acquire({ host: A, key: A, token: l.leaseId, ...seams() })
    expect(nested.reentrant).toBe(true)
    const child = nested.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' })
    try {
      const holder = JSON.parse(fs.readFileSync(path.join(dir, A, 'holder.json'), 'utf8'))
      expect(holder.holder.childPids).toContain(child.pid)
      const died = new Promise((r) => child.on('exit', r))
      await nested.killChildren(100)
      await Promise.race([died, new Promise((_, rej) => setTimeout(() => rej(new Error('child survived')), 5000))])
    } finally { try { child.kill('SIGKILL') } catch { /* gone */ } }
    l.release()
  })
})

describe('deviceLease.pool config', () => {
  it('accepts a list, normalizes case, and rejects bad shapes without echoing the entry', () => {
    expect(parseLeasePool(['10.0.0.1', 'Roku-B.local'])).toEqual(['10.0.0.1', 'roku-b.local'])
    expect(() => parseLeasePool([])).toThrow(/empty/)
    expect(() => parseLeasePool('10.0.0.1')).toThrow(/list/)
    expect(() => parseLeasePool(['10.0.0.1', '10.0.0.1'])).toThrow(/entry 2 duplicates entry 1/)
    expect(() => parseLeasePool(['10.0.0.1', 'A', 'a'])).toThrow(/duplicates/)
    expect(() => parseLeasePool([''])).toThrow(/entry 1 must be a non-empty/)
    for (const bad of ['10.0.0.1:hunter2', 'a,b', '::1', '[::1]', 'x y']) {
      let msg = ''
      try { parseLeasePool(['10.0.0.9', bad]) } catch (e) { msg = e.message }
      expect(msg).toMatch(/entry 2 must be a bare IPv4 address or host name/)
      expect(msg).not.toContain('hunter2')
      expect(msg).not.toContain(bad)
    }
  })

  it('loadConfig reads deviceLease.pool, keeps defaults, and fails on a bad pool', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-poolcfg-'))
    fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify({ deviceLease: { pool: [A, B] } }))
    const cfg = loadConfig(d, null)
    expect(cfg.deviceLease.pool).toEqual([A, B])
    expect(cfg.deviceLease.wait).toBe('30m')
    fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify({ deviceLease: { pool: [A, A] } }))
    expect(() => loadConfig(d, null)).toThrow(/duplicates/)
    fs.rmSync(d, { recursive: true, force: true })
  })
})

describe('--device any parsing', () => {
  it('parses --device any and -d any; plain --device is unchanged; host stays', () => {
    expect(cli.parseArgs(['--device', 'any'])).toMatchObject({ device: true, devicePool: true })
    expect(cli.parseArgs(['-d', 'any'])).toMatchObject({ device: true, devicePool: true })
    expect(cli.parseArgs(['--device', '--host', '1.2.3.4']).devicePool).toBeUndefined()
    expect(cli.parseArgs(['--cross-check', '--device', 'any', '--host', '1.2.3.4'])).toMatchObject({ crossCheck: true, devicePool: true, host: '1.2.3.4' })
    expect(cli.parseDeviceArgs(['with', '--device', 'any', '--', 'x'])).toMatchObject({ devicePool: true, cmd: ['x'], unknown: [] })
    expect(cli.parseDeviceArgs(['with', '-d', 'any', '--', 'x']).devicePool).toBe(true)
  })
})
