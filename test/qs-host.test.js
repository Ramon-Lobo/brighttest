import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const { resolveDevice, rememberDevice } = require('../lib/devices.js')
const doctor = require('../lib/doctor.js')
const e2e = require('../lib/e2e/run.js')
const { loadConfig } = require('../lib/config.js')

// QS-T1: one host chain for every surface (flag, shell env, project .env, single cached device).
let dir, cwd0
const stubs = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-qs1-'))
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD
  cwd0 = process.cwd()
})
afterEach(async () => {
  process.chdir(cwd0)
  vi.restoreAllMocks()
  delete process.env.BRIGHTTEST_CACHE; delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD
  await Promise.all(stubs.splice(0).map((s) => s.stop()))
  fs.rmSync(dir, { recursive: true, force: true })
})
const dotenv = (text) => fs.writeFileSync(path.join(dir, '.env'), text)
function capture() {
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out += s; return true })
  return () => out
}
async function boot(scenario) {
  const stub = createFakeRoku({ scenario })
  const a = await stub.start()
  stubs.push(stub)
  return a
}
const flow = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-roku/flows/fake-smoke.e2e.yaml')

describe('resolveDevice source', () => {
  it('reports env, dotenv, cache and flag separately', () => {
    rememberDevice('10.0.0.5', 'pw')
    expect(resolveDevice({ cwd: dir }).source).toBe('cache')
    dotenv('ROKU_HOST=10.0.0.7\n')
    expect(resolveDevice({ cwd: dir })).toMatchObject({ host: '10.0.0.7', source: 'dotenv', dotenvPath: path.join(dir, '.env') })
    process.env.ROKU_HOST = '10.0.0.9'
    expect(resolveDevice({ cwd: dir })).toMatchObject({ host: '10.0.0.9', source: 'env' })
    expect(resolveDevice({ host: '1.2.3.4', cwd: dir }).source).toBe('flag')
  })
})

describe('e2e parseTargets uses the shared chain', () => {
  it('reads the host and password from the project .env', () => {
    dotenv('ROKU_HOST=10.0.0.7\nROKU_PASSWORD=envpw\n')
    const t = e2e.parseTargets({ cwd: dir })
    expect(t.hosts).toEqual(['10.0.0.7'])
    expect(t.passwords.get('10.0.0.7')).toBe('envpw')
  })
  it('falls back to the single cached device and its password', () => {
    rememberDevice('10.0.0.5', 'cachepw')
    const t = e2e.parseTargets({ cwd: dir })
    expect(t.hosts).toEqual(['10.0.0.5'])
    expect(t.passwords.get('10.0.0.5')).toBe('cachepw')
  })
  it('--host and the shell ROKU_HOST still win over .env', () => {
    dotenv('ROKU_HOST=10.0.0.7\n')
    expect(e2e.parseTargets({ cwd: dir, host: '10.0.0.1' }).hosts).toEqual(['10.0.0.1'])
    process.env.ROKU_HOST = '10.0.0.2'
    expect(e2e.parseTargets({ cwd: dir }).hosts).toEqual(['10.0.0.2'])
  })
})

describe('e2e run host resolution', () => {
  it('uses the .env host when no --host is given', async () => {
    const a = await boot('limited')
    dotenv('ROKU_HOST=127.0.0.1\nROKU_PASSWORD=rokudev-test\n')
    const get = capture()
    const code = await e2e.run(loadConfig(dir, null), { e2eAction: 'run', flows: [flow], ecpPort: a.ecpPort, screenshotsMode: 'off' }, { acquireForLane: vi.fn(async () => ({ lease: null })) })
    expect(code).toBe(1) // reached the device: the Limited-ECP preflight failed
    expect(get()).toContain('Control by mobile apps')
  })
  it('refuses when several devices are cached and no host is given', async () => {
    rememberDevice('10.0.0.5', 'a'); rememberDevice('10.0.0.6', 'b')
    const get = capture()
    const code = await e2e.run(loadConfig(dir, null), { e2eAction: 'run', flows: [flow], screenshotsMode: 'off' }, {})
    expect(code).toBe(2)
    expect(get()).toContain('multiple devices are cached')
  })
  it('a .env host decides even when several devices are cached', async () => {
    rememberDevice('10.0.0.5', 'a'); rememberDevice('10.0.0.6', 'b')
    const a = await boot('limited')
    dotenv('ROKU_HOST=127.0.0.1\n')
    const get = capture()
    const code = await e2e.run(loadConfig(dir, null), { e2eAction: 'run', flows: [flow], ecpPort: a.ecpPort, password: 'x', screenshotsMode: 'off' }, { acquireForLane: vi.fn(async () => ({ lease: null })) })
    expect(code).toBe(1)
    expect(get()).not.toContain('multiple devices')
  })
  it('names the sources when no device is known', async () => {
    const get = capture()
    const code = await e2e.run(loadConfig(dir, null), { e2eAction: 'run', flows: [flow], screenshotsMode: 'off' }, {})
    expect(code).toBe(2)
    expect(get()).toContain('project .env')
  })
})

describe('doctor shows the host source', () => {
  it('says .env, then the shell, then warns on a cache pick among several devices', async () => {
    const a = await boot('healthy')
    process.chdir(dir)
    dotenv('ROKU_HOST=127.0.0.1\n')
    let get = capture()
    expect(await doctor.run({ ecpPort: a.ecpPort }, { probeBind: async () => ({ ok: true }) })).toBe(0)
    expect(get()).toContain('host: 127.0.0.1 (from ROKU_HOST in .env)')
    vi.restoreAllMocks()
    process.env.ROKU_HOST = '127.0.0.1'
    get = capture()
    await doctor.run({ ecpPort: a.ecpPort }, { probeBind: async () => ({ ok: true }) })
    expect(get()).toContain('(from ROKU_HOST in the environment)')
    vi.restoreAllMocks()
    delete process.env.ROKU_HOST; fs.rmSync(path.join(dir, '.env'))
    rememberDevice('127.0.0.1', 'a'); rememberDevice('10.0.0.6', 'b'); rememberDevice('127.0.0.1', 'a')
    get = capture()
    await doctor.run({ ecpPort: a.ecpPort }, { probeBind: async () => ({ ok: true }) })
    expect(get()).toContain('(from the cached device)')
    expect(get()).toContain('several devices are cached')
  })
  it('json carries hostSource and warns on ip:pw in ROKU_HOST', async () => {
    const a = await boot('healthy')
    process.chdir(dir)
    dotenv('ROKU_HOST=127.0.0.1:secretpw\n')
    const get = capture()
    await doctor.run({ ecpPort: a.ecpPort, json: true }, { createDevice: () => ({ deviceCapabilities: async () => ({ model: 'x', developerEnabled: true, ecpSettingMode: 'permissive' }) }), probeBind: async () => ({ ok: true }) })
    const j = JSON.parse(get())
    expect(j.hostSource).toBe('dotenv')
    expect(j.hostWarnings.join(' ')).toContain('only e2e run accepts')
  })
})
