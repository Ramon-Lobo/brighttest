import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const { parseFlow, checkRequires, VALID_KEYS } = require('../lib/e2e/flow.js')
const { lint } = require('../lib/e2e/lint.js')
const { createDevice } = require('../lib/e2e/ecp.js')

const flow = (head, steps) => parseFlow(`appId: dev\n${head}steps:\n${steps.map((s) => '  - ' + s).join('\n')}\n`)

describe('flow DSL parsing (ROB-09)', () => {
  it('rejects an unknown key name with the valid list, for press, pressUntil and holdKey', () => {
    for (const s of ['press: Rigth', 'press: { key: Rigth, count: 2 }', 'pressUntil: { key: Rigth, visible: { id: x } }', 'holdKey: { key: Rigth, ms: 100 }']) {
      let err
      try { flow('', ['launch', s]) } catch (e) { err = e }
      expect(err && err.message, s).toMatch(/unknown key "Rigth"; valid keys: Home, .*Right.*Lit_<char>/)
    }
  })
  it('accepts every valid key and Lit_<char>', () => {
    for (const k of [...VALID_KEYS, 'Lit_a', 'Lit_ ']) expect(() => flow('', [`press: { key: "${k}" }`])).not.toThrow()
  })
  it('parses holdKey and validates ms', () => {
    expect(flow('', ['holdKey: { key: Right, ms: 500 }']).steps[0]).toMatchObject({ op: 'holdKey', key: 'Right', ms: 500 })
    for (const bad of ['{ key: Right }', '{ key: Right, ms: 0 }', '{ key: Right, ms: -5 }', '{ key: Right, ms: abc }', '{ key: Right, ms: 99999 }', '{ ms: 5 }']) {
      expect(() => flow('', [`holdKey: ${bad}`]), bad).toThrow(/holdKey/)
    }
  })
  it('parses flow-level requires (inline and block) and step-level requires', () => {
    expect(flow('requires: { firmware: ">=99", videoMode: 2160p, deviceClass: TV }\n', ['launch']).requires)
      .toEqual({ firmware: { op: '>=', version: '99' }, videoMode: '2160p', deviceClass: 'tv' })
    expect(flow('requires:\n  firmware: 12.5\n', ['launch']).requires).toEqual({ firmware: { op: '>=', version: '12.5' } })
    expect(flow('', ['requires: { firmware: "<10" }']).steps[0]).toMatchObject({ op: 'requires', requires: { firmware: { op: '<', version: '10' } } })
    expect(flow('', ['launch']).requires).toBeNull()
  })
  it('rejects bad requires', () => {
    expect(() => flow('requires: { color: red }\n', ['launch'])).toThrow(/line 2: requires: unknown requirement "color"; valid: firmware, videoMode, deviceClass/)
    expect(() => flow('requires: { firmware: new }\n', ['launch'])).toThrow(/firmware must be a version/)
    expect(() => flow('requires: { deviceClass: phone }\n', ['launch'])).toThrow(/deviceClass must be one of tv, box, stick/)
    expect(() => flow('requires: {}\n', ['launch'])).toThrow(/empty/)
    expect(() => flow('', ['requires: 5'])).toThrow(/needs a map/)
  })
  it('config.noSystemDialog must be a boolean', () => {
    expect(flow('config: { noSystemDialog: true }\n', ['launch']).config.noSystemDialog).toBe(true)
    expect(() => flow('config: { noSystemDialog: yes }\n', ['launch'])).toThrow(/noSystemDialog must be true or false/)
  })
})

describe('checkRequires', () => {
  const info = { firmware: '16.0.4', videoMode: '1080p', isTv: false, isStick: false }
  const req = (head) => flow(`requires: ${head}\n`, ['launch']).requires
  it('compares firmware numerically per segment', () => {
    expect(checkRequires(req('{ firmware: ">=16.0.4" }'), info)).toBeNull()
    expect(checkRequires(req('{ firmware: ">=9.10" }'), info)).toBeNull()
    expect(checkRequires(req('{ firmware: ">=99" }'), info)).toBe('requires firmware >=99, device has 16.0.4')
    expect(checkRequires(req('{ firmware: "<16" }'), info)).toMatch(/device has 16\.0\.4/)
    expect(checkRequires(req('{ firmware: "=16.0.4" }'), info)).toBeNull()
  })
  it('videoMode and deviceClass', () => {
    expect(checkRequires(req('{ videoMode: 1080P }'), info)).toBeNull()
    expect(checkRequires(req('{ videoMode: 2160p }'), info)).toBe('requires videoMode 2160p, device reports 1080p')
    expect(checkRequires(req('{ deviceClass: box }'), info)).toBeNull()
    expect(checkRequires(req('{ deviceClass: tv }'), info)).toBe('requires deviceClass tv, device is a box')
    expect(checkRequires(req('{ deviceClass: stick }'), { ...info, isStick: true })).toBeNull()
  })
  it('a value the device did not report is unmet with that reason', () => {
    expect(checkRequires(req('{ videoMode: 1080p }'), {})).toMatch(/did not report a video mode/)
    expect(checkRequires(req('{ firmware: ">=1" }'), null)).toMatch(/did not report a firmware/)
    expect(checkRequires(req('{ deviceClass: box }'), {})).toMatch(/did not report its class/)
  })
})

describe('lint reports DSL errors', () => {
  it('an unknown key is an error (exit 1) naming the key and valid names', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dsl-lint-'))
    const f = path.join(d, 'badkey.e2e.yaml')
    fs.writeFileSync(f, 'steps:\n  - launch\n  - press: Rigth\n')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(lint([f], () => {})).toBe(1)
      expect(err.mock.calls.join('\n')).toMatch(/unknown key "Rigth"; valid keys: Home/)
    } finally { err.mockRestore(); fs.rmSync(d, { recursive: true, force: true }) }
  })
})

describe('holdKey against the fake Roku', () => {
  const stubs = []
  afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.stop())) })
  async function boot(scenario) {
    const stub = createFakeRoku({ scenario }); const a = await stub.start(); stubs.push(stub)
    return { stub, device: createDevice({ host: a.host, ecpPort: a.ecpPort }) }
  }
  it('sends keydown, waits, then keyup', async () => {
    const { stub, device } = await boot('healthy')
    const t0 = Date.now()
    await device.holdKey('Right', 300)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280)
    expect(stub.keypresses.map((k) => `${k.kind}:${k.key}`)).toEqual(['keydown:Right', 'keyup:Right'])
    expect(Date.parse(stub.keypresses[1].time) - Date.parse(stub.keypresses[0].time)).toBeGreaterThanOrEqual(250)
  })
  it('keyup-fails: the step errors, but the keyup was still attempted (503)', async () => {
    const { stub, device } = await boot('keyup-fails')
    await expect(device.holdKey('Right', 20)).rejects.toThrow(/keyup Right failed \(HTTP 503\)/)
    expect(stub.log.filter((l) => l.endpoint === '/keyup/Right').map((l) => l.status)).toEqual([503])
  })
  it('a failing keydown still sends the keyup', async () => {
    const { stub, device } = await boot('healthy')
    stub.setFault({ mode: 'status', status: 500, path: '/keydown/*' })
    await expect(device.holdKey('Up', 10)).rejects.toThrow(/keydown Up failed \(HTTP 500\)/)
    expect(stub.keypresses.filter((k) => k.kind === 'keyup').length).toBe(1)
  })
})

describe('e2e run with the DSL against the fake Roku', () => {
  let dir, cfg, out
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-dsl-'))
    cfg = loadConfig(dir, null)
    out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
  const acquire = async () => ({ lease: { release() {} } })
  async function run(scenario, name, body) {
    const stub = createFakeRoku({ scenario })
    const a = await stub.start()
    const file = path.join(dir, `${name}.e2e.yaml`)
    fs.writeFileSync(file, body)
    try {
      const code = await e2e.run(cfg, { e2eAction: 'run', flows: [file], host: a.host, ecpPort: a.ecpPort, logPort: a.debugPort, screenshots: path.join(dir, 's'), screenshotsMode: 'off' }, { acquireForLane: acquire })
      return { code, stub, endpoints: stub.log.map((l) => l.endpoint).filter(Boolean) }
    } finally { await stub.stop() }
  }

  for (const [name, req] of [['req-firmware', '{ firmware: ">=99" }'], ['req-video', '{ videoMode: "2160p" }'], ['req-class', '{ deviceClass: "tv" }']]) {
    it(`${name}: skipped with the reason, no launch, exit 0`, async () => {
      const { code, endpoints } = await run('healthy', name, `appId: dev\nrequires: ${req}\nsteps:\n  - launch\n`)
      expect(code).toBe(0)
      expect(out).toMatch(/skipped: requires /)
      expect(out).toMatch(/1 skipped/)
      expect(endpoints.filter((e) => e.startsWith('/launch/'))).toEqual([])
    }, 15000)
  }

  it('a met requires runs normally', async () => {
    const { code, endpoints } = await run('healthy', 'req-ok', 'appId: dev\nrequires: { firmware: ">=10", videoMode: 1080p, deviceClass: box }\nsteps:\n  - launch\n')
    expect(code).toBe(0)
    expect(endpoints).toContain('/launch/dev')
  }, 15000)

  it('step-level requires skips the rest of the flow, keeping earlier passes', async () => {
    const { code, endpoints } = await run('healthy', 'req-step', 'appId: dev\nsteps:\n  - launch\n  - requires: { firmware: ">=99" }\n  - press: Right\n')
    expect(code).toBe(0)
    expect(out).toMatch(/○ requires.*skipped: requires firmware >=99, device has 16\.0\.4/)
    expect(endpoints.filter((e) => e.startsWith('/keypress/Right'))).toEqual([])
  }, 15000)

  it('hold on healthy: keydown then keyup', async () => {
    const { code, stub } = await run('healthy', 'hold', 'appId: dev\nsteps:\n  - launch\n  - holdKey: { key: Right, ms: 500 }\n')
    expect(code).toBe(0)
    const k = stub.keypresses.filter((x) => x.key === 'Right').map((x) => x.kind)
    expect(k).toEqual(['keydown', 'keyup'])
  }, 15000)

  it('hold on keyup-fails: the step fails and the keyup was attempted (503)', async () => {
    const { code, stub } = await run('keyup-fails', 'hold', 'appId: dev\nsteps:\n  - launch\n  - holdKey: { key: Right, ms: 100 }\n')
    expect(code).toBe(1)
    expect(out).toMatch(/keyup Right failed \(HTTP 503\)/)
    expect(stub.log.filter((l) => l.endpoint === '/keyup/Right').map((l) => l.status)).toEqual([503])
  }, 15000)

  it('badkey: parse error naming Rigth, and the device is never contacted', async () => {
    const { code, stub } = await run('healthy', 'badkey', 'appId: dev\nsteps:\n  - launch\n  - press: Rigth\n')
    expect(code).toBe(1)
    expect(out).toMatch(/unknown key "Rigth"/)
    expect(stub.log).toEqual([])
  }, 15000)

  it('noSystemDialog: fails with the system-dialog reason', async () => {
    const { code } = await run('system-dialog-root', 'nodialog', 'appId: dev\nconfig: { noSystemDialog: true, readyTimeout: 600, timeout: 2 }\nsteps:\n  - launch\n  - assertVisible: { id: title }\n')
    expect(code).toBe(1)
    expect(out).toMatch(/noSystemDialog: a system dialog is in front/)
  }, 15000)

  it('noSystemDialog guard refuses a key press while a dialog is in front, and presses nothing', async () => {
    const stub = createFakeRoku({ scenario: 'system-dialog-root' })
    const a = await stub.start()
    try {
      const device = createDevice({ host: a.host, ecpPort: a.ecpPort })
      const ctx = { device, stepTimeoutMs: 1000, noSystemDialog: true }
      const err = await e2e.execStep({ op: 'press', key: 'Select', count: 1 }, ctx).catch((e) => e)
      expect(err.code).toBe('SYSTEM_DIALOG')
      expect(err.message).toMatch(/refusing to press Select/)
      expect(stub.keypresses).toEqual([])
      // off by default: the same press goes through
      await e2e.execStep({ op: 'press', key: 'Select', count: 1 }, { device, stepTimeoutMs: 1000 })
      expect(stub.keypresses.length).toBe(1)
    } finally { await stub.stop() }
  }, 15000)
})
