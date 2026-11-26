import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

// e2e lane wiring under the lease with a stub device: one lease per host around its units, sharded hosts
// independent, Home hygiene only for `run`, release on errors, lease exit codes win over the lane's 1.
let dir, cfg, log, flow
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-lease-'))
  cfg = loadConfig(dir, null)
  log = []
  // A flow that fails to parse: the unit fails without driving the (stub) device, enough to test wiring.
  flow = path.join(dir, 'bad.e2e.yaml')
  fs.writeFileSync(flow, 'steps: [')
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const createDevice = ({ host }) => ({
  deviceInfo: async () => { log.push(`info ${host}`); if (host === 'down') throw new Error('unreachable'); return { model: 'Stub', developerEnabled: true } },
})
const releaseArgs = []
function acquireForLane(busy = []) {
  return async ({ host, hygiene }) => {
    log.push(`acquire ${host} hygiene=${hygiene}`)
    if (busy.includes(host)) return { code: 75 }
    return { lease: { release: (...a) => { log.push(`release ${host}`); releaseArgs.push(a) } } }
  }
}

describe('e2e run under the lease', () => {
  it('takes one lease per host around its units, with hygiene, and releases it', async () => {
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flow, flow], host: '10.0.0.1' }, { createDevice, acquireForLane: acquireForLane() })
    expect(code).toBe(1) // the flow is bad; the lease wiring is what we check
    expect(log).toEqual(['acquire 10.0.0.1 hygiene=true', 'info 10.0.0.1', 'release 10.0.0.1'])
  })

  it('releases with exit code 1 when a unit failed on the host', async () => {
    releaseArgs.length = 0
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1' }, { createDevice, acquireForLane: acquireForLane() })
    expect(releaseArgs).toEqual([[undefined, { exitCode: 1 }]])
  })

  it('sharded hosts are independent: a busy host does not block the other; exit 75 wins', async () => {
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flow, flow], host: '10.0.0.1,10.0.0.2', screenshotsMode: 'off' },
      { createDevice, acquireForLane: acquireForLane(['10.0.0.2']) })
    expect(code).toBe(75)
    expect(log).toContain('info 10.0.0.1')
    expect(log).toContain('release 10.0.0.1')
    expect(log).not.toContain('info 10.0.0.2')
    expect(log).not.toContain('release 10.0.0.2')
  })

  it('releases when the device fails mid-run', async () => {
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: 'down' }, { createDevice, acquireForLane: acquireForLane() })
    expect(log).toEqual(['acquire down hygiene=true', 'info down', 'release down'])
  })

  it('inspect and record hold the lease for the call, without hygiene', async () => {
    for (const action of ['inspect', 'record']) {
      log = []
      await e2e.run(cfg, { e2eAction: action, flows: [], host: 'down' }, { createDevice, acquireForLane: acquireForLane() })
      expect(log).toEqual(['acquire down hygiene=false', 'info down', 'release down'])
    }
    const code = await e2e.run(cfg, { e2eAction: 'inspect', flows: [], host: '10.0.0.9' }, { createDevice, acquireForLane: acquireForLane(['10.0.0.9']) })
    expect(code).toBe(75)
  })

  it('starts the LAN hub inside the lease (when asked) and stops it before the release; no hub by default', async () => {
    const startLanHub = async ({ deviceHost, lease }) => {
      log.push(`hub start ${deviceHost} leaseHeld=${!!lease}`)
      return { stop: async () => { log.push(`hub stop ${deviceHost}`) } }
    }
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1', lanHub: true }, { createDevice, acquireForLane: acquireForLane(), startLanHub })
    expect(log).toEqual(['acquire 10.0.0.1 hygiene=true', 'hub start 10.0.0.1 leaseHeld=true', 'info 10.0.0.1', 'hub stop 10.0.0.1', 'release 10.0.0.1'])
    log.length = 0
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1' }, { createDevice, acquireForLane: acquireForLane(), startLanHub })
    expect(log.some((l) => l.startsWith('hub'))).toBe(false)
  })

  it('a hub that fails to start is reported and the run goes on; the lease is still released', async () => {
    const startLanHub = async () => { throw new Error('boom') }
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.1', lanHub: true }, { createDevice, acquireForLane: acquireForLane(), startLanHub })
    expect(log).toEqual(['acquire 10.0.0.1 hygiene=true', 'info 10.0.0.1', 'release 10.0.0.1'])
  })

  it('a busy lease starts no hub', async () => {
    const startLanHub = vi.fn()
    await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '10.0.0.2', lanHub: true }, { createDevice, acquireForLane: acquireForLane(['10.0.0.2']), startLanHub })
    expect(startLanHub).not.toHaveBeenCalled()
  })
})

describe('e2e run: Home hygiene under a session (re-entrant) lease', () => {
  const stateFlow = () => {
    const f = path.join(dir, 'st.e2e.yaml')
    fs.writeFileSync(f, 'name: st\nsteps:\n  - waitForAgent: { timeout: 0.1 }\n')
    return f
  }
  const lane = (reentrant) => async () => ({ lease: { reentrant, release: () => {} } })
  const hubStub = async () => ({ stop: async () => {}, hellos: 0 })
  const run = (reentrant, extra = {}, flows) => e2e.run(cfg, { e2eAction: 'run', flows: flows || [stateFlow()], host: '10.0.0.1', lanHub: true, logs: false, ...extra },
    { createDevice, acquireForLane: lane(reentrant), startLanHub: hubStub, homeHygiene: async () => { log.push('home'); return null } })

  it('presses Home once when the lease is re-entrant and a hub is started', async () => {
    await run(true)
    expect(log.filter((l) => l === 'home')).toHaveLength(1)
  })
  it('adds nothing under a per-command lease (acquireForLane already did it) or with --no-hygiene', async () => {
    await run(false)
    await run(true, { noHygiene: true })
    expect(log).not.toContain('home')
  })
  it('adds nothing with deviceLease hygiene none and no flag', async () => {
    cfg.deviceLease = { ...(cfg.deviceLease || {}), hygiene: 'none' }
    await run(true)
    expect(log).not.toContain('home')
  })
  it('warns and continues when the Home press fails', async () => {
    let out = ''
    process.stdout.write.mockImplementation((x) => { out += x; return true })
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [stateFlow()], host: '10.0.0.1', lanHub: true, logs: false },
      { createDevice, acquireForLane: lane(true), startLanHub: hubStub, homeHygiene: async () => new Error('ecp down') })
    expect(out).toContain('Home hygiene failed (ecp down); continuing')
    expect(out).toContain('device: Stub') // the run went on to the units
    expect(code).toBe(1)
  })
  it('adds nothing when no hub is started', async () => {
    await run(true, { lanHub: false }, [flow])
    expect(log).not.toContain('home')
  })
})
