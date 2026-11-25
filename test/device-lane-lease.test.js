import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import device from '../lib/device.js'
import crossCheck from '../lib/cross-check.js'
import deviceCommand from '../lib/device-command.js'
import { loadConfig } from '../lib/config.js'

// Lane wiring without a device: stub the lease and the Rooibos child process, and assert ordering.
let dir, cfg, log
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lane-'))
  cfg = loadConfig(dir, null)
  log = []
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

function fakeChild({ out = '', err = '', code = 0, delay = 5, fail = false } = {}) {
  const c = new EventEmitter()
  c.pid = 4242
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
  c.kill = () => { log.push('kill'); setTimeout(() => c.emit('close', null, 'SIGKILL'), 1) }
  setTimeout(() => {
    if (fail) { c.emit('error', new Error('ENOENT')); return }
    if (out) c.stdout.emit('data', Buffer.from(out))
    if (err) c.stderr.emit('data', Buffer.from(err))
    if (code !== 'hang') c.emit('close', code)
  }, delay)
  return c
}
const stubLease = () => ({
  leaseId: 'x', reentrant: false,
  addChild: (pid) => log.push(`addChild ${pid}`),
  release: () => log.push('release'),
})
const acquireOk = (lease = stubLease()) => async (o) => { log.push(`acquire ${o.host}`); return { lease } }
const opts = { host: '127.0.0.1', password: 'pw' }

describe('device lane under the lease', () => {
  it('acquires before spawning, registers the child, releases after it exits', async () => {
    const spawn = (...a) => { log.push('spawn'); return fakeChild({ out: '[Rooibos Result]\n' }) }
    await device.run(cfg, opts, { homeBeforeDeploy: async () => null, acquireForLane: acquireOk(), spawn })
    expect(log).toEqual(['acquire 127.0.0.1', 'spawn', 'addChild 4242', 'release'])
  })

  it('releases when the child fails to start', async () => {
    const code = await device.run(cfg, opts, { homeBeforeDeploy: async () => null, acquireForLane: acquireOk(), spawn: () => fakeChild({ fail: true }) })
    expect(code).toBe(1)
    expect(log.at(-1)).toBe('release')
  })

  it('returns the lease exit code (75) and never spawns when the device is busy', async () => {
    const spawn = vi.fn()
    const code = await device.run(cfg, opts, { acquireForLane: async () => ({ code: 75 }), spawn })
    expect(code).toBe(75)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('--no-lease (lease null) still runs', async () => {
    const code = await device.run(cfg, opts, { homeBeforeDeploy: async () => null, acquireForLane: async () => ({ lease: null }), spawn: () => fakeChild({ out: '[Rooibos Result]\n' }) })
    expect(code).toBe(0)
  })
})

describe('buildAndRun (async, same contract)', () => {
  it('returns { output: stdout + stderr, status, timedOut }', async () => {
    const r = await device.buildAndRun(cfg, opts, { lease: stubLease(), spawn: () => fakeChild({ out: 'A', err: 'B', code: 3 }) })
    expect(r).toEqual({ output: 'AB', status: 3, timedOut: false })
    expect(log).toEqual(['addChild 4242'])
  })

  it('times out: kills the child and reports timedOut', async () => {
    const r = await device.buildAndRun(cfg, { ...opts, timeout: 0.05 }, { spawn: () => fakeChild({ code: 'hang' }) })
    expect(r.timedOut).toBe(true)
    expect(r.status).toBeNull()
    expect(log).toContain('kill')
  })

  it('has no spawnSync left on leased paths (TP-LSE-35)', () => {
    for (const f of ['lib/device.js', 'lib/cross-check.js']) {
      expect(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).not.toMatch(/spawnSync\(/)
    }
  })
})

describe('cross-check under the lease', () => {
  const PASS = '> SUITE: S\nDescribe: G\n<<<< END It: t (PASS)\n'
  it('headless phase first (no lease), lease only around the device phase, released before the report', async () => {
    const deps = {
      headless: async () => { log.push('headless'); return { built: true, output: PASS } },
      acquireForLane: acquireOk(),
      buildAndRun: async (c, o, d) => { log.push(`device lease=${d.lease.leaseId}`); return { output: PASS, status: 0, timedOut: false } },
    }
    console.log.mockImplementation((s) => { if (String(s).includes('Cross-check')) log.push('report') })
    const code = await crossCheck.run(cfg, opts, deps)
    expect(code).toBe(0)
    expect(log).toEqual(['headless', 'acquire 127.0.0.1', 'device lease=x', 'release', 'report'])
  })

  it('releases when the device phase throws', async () => {
    const deps = {
      headless: async () => ({ built: true, output: PASS }),
      acquireForLane: acquireOk(),
      buildAndRun: async () => { throw new Error('boom') },
    }
    await expect(crossCheck.run(cfg, opts, deps)).rejects.toThrow('boom')
    expect(log.at(-1)).toBe('release')
  })
})

describe('acquireForLane', () => {
  let leaseDir
  beforeEach(() => { leaseDir = path.join(dir, 'leases') })
  const env = () => ({ BRIGHTTEST_LEASE_DIR: leaseDir })

  it('--no-lease warns loudly and records a bypass event', async () => {
    const r = await deviceCommand.acquireForLane({ cfg, opts: { noLease: true }, host: '127.0.0.1', env: env() })
    expect(r).toEqual({ lease: null })
    expect(process.stderr.write.mock.calls.flat().join('')).toMatch(/WITHOUT the device lease \(--no-lease\)/)
    const ev = fs.readFileSync(path.join(leaseDir, '127.0.0.1', 'events.log'), 'utf8')
    expect(JSON.parse(ev)).toMatchObject({ ev: 'bypass', reason: '--no-lease' })
  })

  it('BRIGHTTEST_NO_LEASE=1 and deviceLease.enabled=false bypass too', async () => {
    expect(await deviceCommand.acquireForLane({ cfg, host: '127.0.0.1', env: { ...env(), BRIGHTTEST_NO_LEASE: '1' } })).toEqual({ lease: null })
    expect(await deviceCommand.acquireForLane({ cfg: { ...cfg, deviceLease: { enabled: false } }, host: '127.0.0.1', env: env() })).toEqual({ lease: null })
  })

  it('acquires a real lease; a hygiene failure is a warning, not an error (F13)', async () => {
    const r = await deviceCommand.acquireForLane({
      cfg, opts: { as: 'dev#1' }, host: '127.0.0.1', hygiene: true, env: env(),
      deps: { homeHygiene: async () => new Error('keypress Home failed (HTTP 500)') },
    })
    expect(r.lease.key).toBe('127.0.0.1')
    expect(process.stderr.write.mock.calls.flat().join('')).toMatch(/Home hygiene failed/)
    r.lease.release()
    const evs = fs.readFileSync(path.join(leaseDir, '127.0.0.1', 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).ev)
    expect(evs).toEqual(['note', 'acquired', 'hygiene-failed', 'released']) // the note: identity not read, leased by address
  })

  it('maps a busy device to exit 75', async () => {
    const a = await deviceCommand.acquireForLane({ cfg, host: '127.0.0.1', env: env() })
    const b = await deviceCommand.acquireForLane({ cfg, opts: { wait: '0' }, host: '127.0.0.1', env: env() })
    expect(b).toEqual({ code: 75 })
    a.lease.release()
  })
})

describe('device with: the child command is not written to the lease', () => {
  it('stores a short label, not the arguments, in holder.json and the audit log', async () => {
    const prev = process.env.BRIGHTTEST_LEASE_DIR
    process.env.BRIGHTTEST_LEASE_DIR = path.join(dir, 'leases')
    const copy = path.join(dir, 'holder-copy.json')
    const script = `const fs=require('fs'),p=require('path');const d=process.env.BRIGHTTEST_LEASE_DIR;` +
      `const k=fs.readdirSync(d).find((n)=>fs.existsSync(p.join(d,n,'holder.json')));` +
      `fs.copyFileSync(p.join(d,k,'holder.json'),${JSON.stringify(copy)})`
    try {
      const code = await deviceCommand.run({
        deviceAction: 'with', host: '127.0.0.1', noHygiene: true, wait: '0',
        cmd: [process.execPath, '-e', script, '--', 'Tr0ub4dor&3-argument', '--token=opaqueSecretValue'],
      }, cfg)
      expect(code).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = prev
    }
    const text = fs.readFileSync(copy, 'utf8')
    const rec = JSON.parse(text)
    expect(rec.holder.purpose).toBe(`with ${path.basename(process.execPath)}`)
    expect(text).not.toMatch(/Tr0ub4dor|opaqueSecretValue/)
    const events = fs.readdirSync(path.join(dir, 'leases')).flatMap((k) => fs.readFileSync(path.join(dir, 'leases', k, 'events.log'), 'utf8'))
    expect(events.join('')).not.toMatch(/Tr0ub4dor|opaqueSecretValue/)
  })
})
