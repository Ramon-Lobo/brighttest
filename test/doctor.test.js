import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const doctor = require('../lib/doctor.js')
const { createDevice } = require('../lib/e2e/ecp.js')
const e2e = require('../lib/e2e/run.js')
const { loadConfig } = require('../lib/config.js')
const { parseDoctorArgs } = require('../bin/cli.js')

const stubs = []
async function boot(scenario) {
  const stub = createFakeRoku({ scenario })
  const a = await stub.start()
  stubs.push(stub)
  return { stub, a }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stubs.splice(0).map((s) => s.stop())) })

function capture() {
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out += s; return true })
  return () => out
}

describe('doctor evaluate', () => {
  it('flags only definite bad values', () => {
    expect(doctor.evaluate({ ecpSettingMode: 'permissive', developerEnabled: true }).every((k) => k.ok)).toBe(true)
    expect(doctor.evaluate({ ecpSettingMode: null, developerEnabled: null }).every((k) => k.ok)).toBe(true)
    const lim = doctor.evaluate({ ecpSettingMode: 'limited', developerEnabled: true })
    expect(lim.find((k) => k.id === 'ecp-mode')).toMatchObject({ ok: false, fix: doctor.FIX_LIMITED })
    expect(doctor.evaluate({ developerEnabled: false }).find((k) => k.id === 'developer-mode').fix).toBe(doctor.FIX_DEV_DISABLED)
  })
  it('classifies the device', () => {
    expect(doctor.deviceClass({ isTv: true })).toBe('tv')
    expect(doctor.deviceClass({ isTv: false, isStick: true })).toBe('stick')
    expect(doctor.deviceClass({ isTv: false, isStick: false })).toBe('box')
    expect(doctor.deviceClass({})).toBe(null)
  })
})

describe('doctor against the fake', () => {
  const runDoctor = async (scenario, extra = {}) => {
    const { a } = await boot(scenario)
    const get = capture()
    const code = await doctor.run({ host: '127.0.0.1', ecpPort: a.ecpPort, ...extra })
    return { code, out: get() }
  }

  it('healthy: exit 0, no serial', async () => {
    const r = await runDoctor('healthy')
    expect(r.code).toBe(0)
    expect(r.out).toContain('16.0.4')
    expect(r.out).not.toContain('FAKE-SERIAL-0001')
  })
  it('limited: exit 1 with the Settings path', async () => {
    const r = await runDoctor('limited')
    expect(r.code).toBe(1)
    expect(r.out).toContain('Control by mobile apps')
    expect(r.out).toContain('limited')
  })
  it('dev-disabled: exit 1 with the fix', async () => {
    const r = await runDoctor('dev-disabled')
    expect(r.code).toBe(1)
    expect(r.out).toContain('Enable developer mode')
  })
  it('unreachable: exit 1', async () => {
    const { a } = await boot('unreachable')
    const get = capture()
    expect(await doctor.run({ host: '127.0.0.1', ecpPort: a.ecpPort })).toBe(1)
    expect(get()).toContain('not reachable')
  })
  it('--json has the doctor.json shape and hides the serial unless asked', async () => {
    const r = await runDoctor('healthy', { json: true })
    const j = JSON.parse(r.out)
    expect(j).toMatchObject({ host: '127.0.0.1', reachable: true, softwareVersion: '16.0.4', build: '853', developerEnabled: true, ecpSettingMode: 'permissive', videoMode: '1080p', deviceClass: 'box' })
    expect(j.checks.every((k) => k.ok)).toBe(true)
    expect(r.out).not.toContain('FAKE-SERIAL-0001')
    const s = await runDoctor('healthy', { json: true, showSerial: true })
    expect(JSON.parse(s.out).serial).toBe('FAKE-SERIAL-0001')
  })
  it('--show-serial prints the serial in text', async () => {
    expect((await runDoctor('healthy', { showSerial: true })).out).toContain('FAKE-SERIAL-0001')
  })
})

describe('ecp deviceInfo reuses the parser', () => {
  it('keeps the legacy fields and adds ecpSettingMode, without the serial', async () => {
    const { a } = await boot('limited')
    const info = await createDevice({ host: '127.0.0.1', ecpPort: a.ecpPort }).deviceInfo()
    expect(info).toMatchObject({ model: 'Ultra', firmware: '16.0.4', developerEnabled: true, developerDisabled: false, ecpSettingMode: 'limited', uiResolution: '1080p' })
    expect(JSON.stringify(info)).not.toContain('FAKE-SERIAL-0001')
  })
})

describe('e2e preflight', () => {
  const flow = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/fake-roku/flows/fake-smoke.e2e.yaml')
  it('fails before the lease and any launch/keypress on a Limited device', async () => {
    const { stub, a } = await boot('limited')
    const get = capture()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pre-'))
    const acquire = vi.fn(async () => ({ lease: null }))
    const code = await e2e.run(loadConfig(dir, null), { e2eAction: 'run', flows: [flow], host: '127.0.0.1', ecpPort: a.ecpPort, password: 'rokudev-test', screenshotsMode: 'off' }, { acquireForLane: acquire })
    fs.rmSync(dir, { recursive: true, force: true })
    expect(code).toBe(1)
    expect(acquire).not.toHaveBeenCalled()
    expect(get()).toContain('Control by mobile apps')
    expect(get()).not.toContain('rokudev-test')
    expect(stub.log.filter((l) => /^\/(launch|keypress|keydown|keyup)\//.test(l.endpoint))).toEqual([])
  })
  it('preflight passes stubs that cannot report capabilities', async () => {
    expect(await doctor.preflight({ deviceInfo: async () => ({}) })).toBe(null)
  })
})

describe('doctor args', () => {
  it('parses flags', () => {
    expect(parseDoctorArgs(['--host=1.2.3.4', '--json', '--show-serial', '--ecp-port', '9'])).toMatchObject({ host: '1.2.3.4', json: true, showSerial: true, ecpPort: '9' })
  })
})
