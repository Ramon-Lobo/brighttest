import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import device from '../lib/device.js'
import crossCheck from '../lib/cross-check.js'
import deviceCommand from '../lib/device-command.js'
import { rememberDevice } from '../lib/devices.js'
import { loadConfig } from '../lib/config.js'

// --device / --cross-check resolve host+password like the other lanes: flag > ROKU_HOST/ROKU_PASSWORD >
// cached device. No device is touched: the lease and the Rooibos child are stubbed.
let dir, cfg, errors, prevCwd
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hostenv-'))
  prevCwd = process.cwd()
  process.chdir(dir) // no project .env here
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD
  cfg = loadConfig(dir, null)
  errors = []
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })
})
afterEach(() => {
  process.chdir(prevCwd)
  vi.restoreAllMocks()
  delete process.env.BRIGHTTEST_CACHE; delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD
  fs.rmSync(dir, { recursive: true, force: true })
})

function fakeChild() {
  const c = new EventEmitter()
  c.pid = 1; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}
  setTimeout(() => { c.stdout.emit('data', Buffer.from('[Rooibos Result]\n')); c.emit('close', 0) }, 5)
  return c
}
// Runs the device lane and returns the host/password the lease and the Rooibos CLI were given.
async function runDevice(opts) {
  const seen = {}
  const code = await device.run(cfg, opts, {
    acquireForLane: async (o) => { seen.leaseHost = o.host; seen.leasePw = o.password; return { lease: null } },
    spawn: (_node, args) => { seen.args = args; return fakeChild() },
  })
  return { code, seen }
}
const argOf = (args, name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3)

describe('--device host/password resolution', () => {
  it('flag wins over ROKU_HOST / ROKU_PASSWORD', async () => {
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    const { code, seen } = await runDevice({ host: '10.0.0.1', password: 'flagpw' })
    expect(code).toBe(0)
    expect(seen.leaseHost).toBe('10.0.0.1')
    expect(argOf(seen.args, 'host')).toBe('10.0.0.1')
    expect(argOf(seen.args, 'password')).toBe('flagpw')
  })

  it('falls back to ROKU_HOST and ROKU_PASSWORD when no flags are given', async () => {
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    const { code, seen } = await runDevice({})
    expect(code).toBe(0)
    expect(seen.leaseHost).toBe('10.0.0.9')
    expect(seen.leasePw).toBe('envpw')
    expect(argOf(seen.args, 'host')).toBe('10.0.0.9')
    expect(argOf(seen.args, 'password')).toBe('envpw')
  })

  it('an explicit --host with the password from the environment', async () => {
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    const { seen } = await runDevice({ host: '10.0.0.1' })
    expect(argOf(seen.args, 'host')).toBe('10.0.0.1')
    expect(argOf(seen.args, 'password')).toBe('envpw')
  })

  it('ROKU_HOST is not overridden by a cached device', async () => {
    rememberDevice('10.0.0.5', 'cachepw')
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    const { seen } = await runDevice({})
    expect(argOf(seen.args, 'host')).toBe('10.0.0.9')
  })

  it('uses the cached device (and its password) when neither flag nor env is set', async () => {
    rememberDevice('10.0.0.5', 'cachepw')
    const { code, seen } = await runDevice({})
    expect(code).toBe(0)
    expect(argOf(seen.args, 'host')).toBe('10.0.0.5')
    expect(argOf(seen.args, 'password')).toBe('cachepw')
  })

  it('supports the ip:pw host form: bare ip goes to the lease and Rooibos', async () => {
    const { seen } = await runDevice({ host: '10.0.0.1:inlinepw' })
    expect(seen.leaseHost).toBe('10.0.0.1')
    expect(argOf(seen.args, 'host')).toBe('10.0.0.1')
    expect(argOf(seen.args, 'password')).toBe('inlinepw')
  })

  it('--password beats the inline ip:pw password', async () => {
    const { seen } = await runDevice({ host: '10.0.0.1:inlinepw', password: 'flagpw' })
    expect(argOf(seen.args, 'password')).toBe('flagpw')
  })

  it('keeps the error (exit 2) when nothing resolves, and never prints a password', async () => {
    const spawn = vi.fn()
    const code = await device.run(cfg, {}, { acquireForLane: vi.fn(), spawn })
    expect(code).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain('--device requires --host <ip> and --password <dev-password>')
  })

  it('errors when a host resolves but no password does, without echoing the host password', async () => {
    const code = await device.run(cfg, { host: '10.0.0.1' }, { acquireForLane: vi.fn(), spawn: vi.fn() })
    expect(code).toBe(2)
  })
})

describe('--cross-check host/password resolution', () => {
  const PASS = '> SUITE: S\nDescribe: G\n<<<< END It: t (PASS)\n'
  async function runCross(opts) {
    const seen = {}
    const code = await crossCheck.run(cfg, opts, {
      headless: async () => ({ built: true, output: PASS }),
      acquireForLane: async (o) => { seen.leaseHost = o.host; seen.leasePw = o.password; return { lease: null } },
      buildAndRun: async (c, o) => { seen.host = o.host; seen.password = o.password; return { output: PASS, status: 0, timedOut: false } },
    })
    return { code, seen }
  }

  it('flag wins over the environment', async () => {
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    const { code, seen } = await runCross({ host: '10.0.0.1', password: 'flagpw' })
    expect(code).toBe(0)
    expect(seen).toMatchObject({ leaseHost: '10.0.0.1', host: '10.0.0.1', password: 'flagpw' })
  })

  it('falls back to ROKU_HOST / ROKU_PASSWORD', async () => {
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    const { code, seen } = await runCross({})
    expect(code).toBe(0)
    expect(seen).toMatchObject({ leaseHost: '10.0.0.9', host: '10.0.0.9', password: 'envpw' })
  })

  it('supports ip:pw and hands the device phase a bare host', async () => {
    const { seen } = await runCross({ host: '10.0.0.1:inlinepw' })
    expect(seen).toMatchObject({ leaseHost: '10.0.0.1', host: '10.0.0.1', password: 'inlinepw' })
  })

  it('keeps the error (exit 2) when nothing resolves, before any headless work', async () => {
    const headless = vi.fn()
    const code = await crossCheck.run(cfg, {}, { headless, acquireForLane: vi.fn(), buildAndRun: vi.fn() })
    expect(code).toBe(2)
    expect(headless).not.toHaveBeenCalled()
    expect(errors.join('\n')).toContain('--cross-check requires --host <ip> and --password <dev-password>')
  })
})

describe('resolveLaneOpts', () => {
  it('returns null when host or password is missing and never mutates the input', () => {
    const o = { host: '10.0.0.1:pw' }
    expect(deviceCommand.resolveLaneOpts({})).toBeNull()
    expect(deviceCommand.resolveLaneOpts(o)).toMatchObject({ host: '10.0.0.1', password: 'pw' })
    expect(o.host).toBe('10.0.0.1:pw')
  })
})
