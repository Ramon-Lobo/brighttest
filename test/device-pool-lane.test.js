import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import device from '../lib/device.js'
import crossCheck from '../lib/cross-check.js'
import deviceCommand from '../lib/device-command.js'
import { loadConfig } from '../lib/config.js'

// `--device any` in the lanes, no device: the lease is stubbed, the pool is picked where the lane takes its lease.
const A = '127.0.0.1'
const B = '127.0.0.2'
let dir, cfg, log, savedEnv
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-poollane-'))
  fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ deviceLease: { pool: [A, B] } }))
  cfg = loadConfig(dir, null)
  log = []
  savedEnv = { ...process.env }
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'cache.json')
  process.env.ROKU_PASSWORD = 'pw'
  delete process.env.ROKU_HOST
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); process.env = savedEnv; fs.rmSync(dir, { recursive: true, force: true }) })

function fakeChild() {
  const c = new EventEmitter()
  c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}
  setTimeout(() => { c.stdout.emit('data', Buffer.from('[Rooibos Result]\n')); c.emit('close', 0) }, 5)
  return c
}
const stubLease = () => ({ leaseId: 'x', reentrant: false, addChild() {}, release: () => log.push('release') })
const acquirePoolOk = (host = B) => async (a) => { log.push(`acquire pool=${(a.pool || []).join('+')} host=${a.host}`); return { lease: stubLease(), host } }
const opts = { devicePool: true, device: true }

describe('device lane with --device any', () => {
  it('picks the pool at the lane lease and runs the rooibos child on the chosen host', async () => {
    const spawned = []
    const code = await device.run(cfg, opts, {
      homeBeforeDeploy: async () => null, acquireForLane: acquirePoolOk(B),
      spawn: (...a) => { spawned.push(a); return fakeChild() },
    })
    expect(code).toBe(0)
    expect(log).toEqual([`acquire pool=${A}+${B} host=undefined`, 'release'])
    expect(JSON.stringify(spawned[0])).toContain(`--host=${B}`)
  })

  it('an explicit --host wins: no pool is passed to the lease', async () => {
    await device.run(cfg, { ...opts, host: B }, { homeBeforeDeploy: async () => null, acquireForLane: acquirePoolOk(B), spawn: () => fakeChild() })
    expect(log[0]).toBe(`acquire pool= host=${B}`)
  })

  it('no pool configured: exit 2, no lease', async () => {
    const code = await device.run({ ...cfg, deviceLease: {} }, opts, { acquireForLane: acquirePoolOk() })
    expect(code).toBe(2)
    expect(log).toEqual([])
  })

  it('a pool device without a password fails fast (exit 2) before any lease', async () => {
    delete process.env.ROKU_PASSWORD
    const code = await device.run(cfg, opts, { acquireForLane: acquirePoolOk() })
    expect(code).toBe(2)
    expect(log).toEqual([])
    expect(console.error.mock.calls.flat().join('')).toMatch(/no dev password for pool device 127\.0\.0\.1/)
  })

  it('a busy pool returns the lease exit code', async () => {
    expect(await device.run(cfg, opts, { acquireForLane: async () => ({ code: 75 }) })).toBe(75)
  })
})

describe('cross-check with --device any', () => {
  const PASS = '> SUITE: S\nDescribe: G\n<<<< END It: t (PASS)\n'
  it('the pool is picked after the headless leg, so no device is held during it', async () => {
    let seen
    const deps = {
      headless: async () => { log.push('headless'); return { built: true, output: PASS } },
      acquireForLane: acquirePoolOk(B),
      buildAndRun: async (c, o) => { seen = o.host; log.push('device'); return { output: PASS, status: 0, timedOut: false } },
    }
    expect(await crossCheck.run(cfg, opts, deps)).toBe(0)
    expect(log).toEqual(['headless', `acquire pool=${A}+${B} host=undefined`, 'device', 'release'])
    expect(seen).toBe(B)
  })
})

describe('acquireForLane with a pool', () => {
  const leaseDir = () => path.join(dir, 'leases')
  const env = (extra = {}) => ({ BRIGHTTEST_LEASE_DIR: leaseDir(), ...extra })

  it('takes the first free member and reports the chosen host', async () => {
    const r = await deviceCommand.acquireForLane({ cfg, opts: { as: 'dev#1' }, pool: [A, B], env: env() })
    expect(r.host).toBe(A)
    expect(r.lease.poolHost).toBe(A)
    r.lease.release()
  })

  it('--no-lease uses the first pool host, warns, and records a bypass event', async () => {
    const r = await deviceCommand.acquireForLane({ cfg, opts: { noLease: true }, pool: [A, B], env: env() })
    expect(r).toEqual({ lease: null, host: A })
    expect(process.stderr.write.mock.calls.flat().join('')).toMatch(/WITHOUT the device lease/)
    expect(JSON.parse(fs.readFileSync(path.join(leaseDir(), A, 'events.log'), 'utf8'))).toMatchObject({ ev: 'bypass' })
  })

  it('an explicit host wins over a pool', async () => {
    const r = await deviceCommand.acquireForLane({ cfg, opts: {}, host: B, pool: [A, B], env: env() })
    expect(r.lease.key).toBe(B)
    expect(r.lease.poolHost).toBeUndefined()
    r.lease.release()
  })

  it('member lease purpose defaults to the command line', async () => {
    const r = await deviceCommand.acquireForLane({ cfg, opts: {}, pool: [A, B], command: ['brighttest', '--device', 'any'], env: env() })
    expect(r.lease.record.holder.purpose).toBe('brighttest --device any')
    r.lease.release()
  })
})
