import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const { resetDevice, resetAndProbe, cmdReset, DEAD_AFTER } = require('../lib/e2e/reset.js')
const { parseE2eArgs, parseDeviceArgs } = require('../bin/cli.js')

// ROB-06: device reset and dead-host marking, against the fake Roku on ephemeral ports (127.0.0.1 only).
const PW = 'rokudev-test'
const stubs = []
async function boot(scenario, extra = {}) {
  const stub = createFakeRoku({ scenario, ...extra })
  const a = await stub.start()
  stubs.push(stub)
  return { stub, args: { host: a.host, password: PW, ecpPort: a.ecpPort, installerPort: a.installerPort, pollMs: 20, homeTimeoutMs: 1000, leaveTimeoutMs: 400 } }
}
afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.stop())) })

describe('resetDevice', () => {
  it('Deletes, presses Home, then polls active-app until Home (healthy, halted app, installer page)', async () => {
    for (const scenario of ['healthy', 'halted-app', 'installer-page']) {
      const { stub, args } = await boot(scenario)
      await resetDevice(args)
      const idx = (f) => stub.log.findIndex(f)
      const iDel = idx((e) => e.service === 'installer' && e.method === 'POST' && e.endpoint === '/plugin_install' && e.status === 200)
      const iHome = idx((e) => e.endpoint === '/keypress/Home')
      const iPoll = idx((e) => e.endpoint === '/query/active-app')
      expect(stub.state.deletes).toBe(1)
      expect(iDel).toBeGreaterThanOrEqual(0)
      expect(iHome).toBeGreaterThan(iDel)
      expect(iPoll).toBeGreaterThan(iHome)
      expect(stub.state.activeApp).toBe('roku')
    }
  })

  it('fails with RESET_DELETE_FAILED (and does not press Home) when the installer Delete fails', async () => {
    const { stub, args } = await boot('healthy', { deleteFails: true })
    await expect(resetDevice(args)).rejects.toMatchObject({ code: 'RESET_DELETE_FAILED' })
    expect(stub.keypresses).toHaveLength(0)
  })

  it('fails on a wrong dev password', async () => {
    const { args } = await boot('healthy')
    await expect(resetDevice({ ...args, password: 'nope' })).rejects.toMatchObject({ code: 'INSTALLER_AUTH' })
  })

  it('fails with RESET_NO_HOME when Home is never reported (bounded)', async () => {
    const { args } = await boot('healthy')
    const createDevice = (o) => ({ deleteApp: async () => ({ ok: true }), keypress: async () => {}, isHome: async () => false })
    await expect(resetDevice({ ...args, createDevice, homeTimeoutMs: 100, pollMs: 10 })).rejects.toMatchObject({ code: 'RESET_NO_HOME' })
  })
})

describe('resetAndProbe', () => {
  it('N is 2 consecutive failed attempts', () => { expect(DEAD_AFTER).toBe(2) })

  it('healthy device leaves Home on the first attempt', async () => {
    const { args } = await boot('healthy')
    expect(await resetAndProbe(args)).toEqual({ ok: true, attempts: 1, reason: null })
  })

  it('a device that never leaves Home is dead after 2 attempts', async () => {
    const { stub, args } = await boot('never-leaves-home')
    const r = await resetAndProbe(args)
    expect(r).toMatchObject({ ok: false, attempts: 2, reason: 'never left Home' })
    expect(stub.state.deletes).toBe(2)
  })

  it('a failing Delete counts as a failed attempt', async () => {
    const { args } = await boot('healthy', { deleteFails: true })
    const r = await resetAndProbe(args)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Delete failed/)
  })
})

describe('device reset command', () => {
  it('rc 0 on success and the lease is released; rc 1 on a failed reset and still released', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      for (const [extra, want] of [[{}, 0], [{ deleteFails: true }, 1]]) {
        const { args } = await boot('healthy', extra)
        const events = []
        const deps = {
          resolveTarget: () => ({ host: args.host, password: PW, ecpPort: args.ecpPort }),
          acquireForLane: async (a) => { events.push(`acquired hygiene=${a.hygiene}`); return { lease: { release: () => events.push('released') } } },
          installerPort: args.installerPort,
        }
        expect(await cmdReset({}, {}, deps)).toBe(want)
        expect(events).toEqual(['acquired hygiene=false', 'released'])
      }
    } finally { out.mockRestore(); err.mockRestore() }
  })

  it('passes the lease code through and needs a password', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const t = { resolveTarget: () => ({ host: '127.0.0.1', password: PW, ecpPort: 8060 }) }
      expect(await cmdReset({}, {}, { ...t, acquireForLane: async () => ({ code: 75 }) })).toBe(75)
      expect(await cmdReset({}, {}, { resolveTarget: () => ({ host: '127.0.0.1', password: null, ecpPort: 8060 }) })).toBe(2)
    } finally { err.mockRestore() }
  })
})

describe('arg parsing', () => {
  it('parses --reset-device and the device reset action', () => {
    expect(parseE2eArgs(['run', 'a.e2e.yaml', '--reset-device']).resetDevice).toBe(true)
    expect(parseE2eArgs(['run', 'a.e2e.yaml']).resetDevice).toBeFalsy()
    expect(parseDeviceArgs(['reset', '--host', '127.0.0.1']).deviceAction).toBe('reset')
  })
})

describe('e2e run --reset-device', () => {
  let dir, cfg, flow, seen
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-reset-'))
    cfg = loadConfig(dir, null)
    flow = path.join(dir, 'bad.e2e.yaml')
    fs.writeFileSync(flow, 'steps: [')
    seen = { info: [], out: '' }
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { seen.out += s; return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

  const createDevice = ({ host }) => ({ deviceInfo: async () => { seen.info.push(host); return { model: 'Stub', developerEnabled: true } } })
  const acquireForLane = async () => ({ lease: { release: () => {} } })

  it('drops a dead host with one summary line and runs all flows on the healthy host', async () => {
    const resetAndProbe = async ({ host }) => (host === '10.0.0.2' ? { ok: false, attempts: 2, reason: 'never left Home' } : { ok: true, attempts: 1 })
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flow, flow, flow], host: '10.0.0.1:pw,10.0.0.2:pw', screenshotsMode: 'off', resetDevice: true },
      { createDevice, acquireForLane, resetAndProbe })
    expect(code).toBe(1) // the flows are bad on purpose
    expect(seen.info).toEqual(['10.0.0.1'])
    const dead = seen.out.split('\n').filter((l) => /marked dead/.test(l))
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatch(/10\.0\.0\.2 marked dead after 2 reset attempt\(s\): never left Home/)
    expect(seen.out).toMatch(/3 run\(s\) · 1 device/)
  })

  it('without the flag nothing is reset', async () => {
    const resetAndProbe = vi.fn()
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1:pw', screenshotsMode: 'off' }, { createDevice, acquireForLane, resetAndProbe })
    expect(resetAndProbe).not.toHaveBeenCalled()
  })

  it('every host dead: exit 1, no flows run', async () => {
    const resetAndProbe = async () => ({ ok: false, attempts: 2, reason: 'never left Home' })
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1:pw', screenshotsMode: 'off', resetDevice: true }, { createDevice, acquireForLane, resetAndProbe })
    expect(code).toBe(1)
    expect(seen.info).toEqual([])
  })

  it('a lease failure keeps its exit code', async () => {
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1:pw', screenshotsMode: 'off', resetDevice: true },
      { createDevice, acquireForLane: async () => ({ code: 75 }), resetAndProbe: async () => ({ ok: true }) })
    expect(code).toBe(75)
  })
})
