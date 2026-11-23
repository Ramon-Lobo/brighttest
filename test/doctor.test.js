import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  it('video mode line names the ui-resolution fallback when the device has no video-mode', async () => {
    const r = await runDoctor('healthy')
    expect(r.out).toContain('  video mode: 1080p (ui-resolution; no video-mode)\n')
  })
  it('video mode line is unchanged when the device reports video-mode', async () => {
    const caps = { model: 'x', softwareVersion: '16.0.4', developerEnabled: true, ecpSettingMode: 'permissive', videoMode: '720p', videoModeSource: 'video-mode', uiResolution: '1080p' }
    const get = capture()
    await doctor.run({ host: '127.0.0.1' }, { createDevice: () => ({ deviceCapabilities: async () => caps }), probeBind: async () => ({ ok: true }) })
    expect(get()).toContain('  video mode: 720p\n')
    expect(get()).not.toContain('no video-mode')
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
    expect(j).toHaveProperty('model')
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
  const flow = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-roku/flows/fake-smoke.e2e.yaml')
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
  it('throws with the reachable fix text when the device is unreachable', async () => {
    const dev = { host: '10.0.0.9', ecpPort: 8060, deviceCapabilities: async () => { throw new TypeError('fetch failed') } }
    await expect(doctor.preflight(dev)).rejects.toMatchObject({ code: 'DEVICE_UNREACHABLE', fix: expect.stringContaining('No answer from 10.0.0.9') })
    await expect(doctor.preflight(dev)).rejects.toThrow(/port 8060\) is reachable/)
  })
  it('a device that answers but cannot say (non-200) still returns null', async () => {
    const dev = { host: '10.0.0.9', deviceCapabilities: async () => { throw Object.assign(new Error('device-info HTTP 500'), { httpStatus: 500 }) } }
    expect(await doctor.preflight(dev)).toBe(null)
  })
  it('real device: a closed port throws, a 500 answer returns null', async () => {
    const { stub, a } = await boot('healthy')
    await stub.stop()
    await expect(doctor.preflight(createDevice({ host: '127.0.0.1', ecpPort: a.ecpPort }))).rejects.toMatchObject({ code: 'DEVICE_UNREACHABLE' })
    vi.stubGlobal('fetch', async () => ({ status: 500, text: async () => '' }))
    expect(await doctor.preflight(createDevice({ host: 'pre-500-host' }))).toBe(null)
    vi.unstubAllGlobals()
  })
})

describe('e2e preflight: unreachable host', () => {
  const flow = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-roku/flows/fake-smoke.e2e.yaml')
  it('fails only that host with the fix text, no stack trace, and the other host still runs', async () => {
    const { stub, a } = await boot('healthy')
    const get = capture()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-unr-'))
    const flow2 = path.join(dir, 'second.e2e.yaml')
    fs.copyFileSync(flow, flow2)
    const acquire = vi.fn(async () => ({ lease: null }))
    const createDeviceDep = (o) => o.host === '127.0.0.2'
      ? { host: o.host, ecpPort: o.ecpPort, deviceCapabilities: async () => { throw new TypeError('fetch failed') } }
      : createDevice(o)
    let code, thrown = null
    try {
      code = await e2e.run(loadConfig(dir, null), { e2eAction: 'run', flows: [flow, flow2], host: '127.0.0.1,127.0.0.2', ecpPort: a.ecpPort, password: 'rokudev-test', screenshotsMode: 'off' }, { acquireForLane: acquire, createDevice: createDeviceDep })
    } catch (e) { thrown = e }
    fs.rmSync(dir, { recursive: true, force: true })
    expect(thrown).toBe(null)
    expect(code).toBe(1)
    expect(get()).toContain('[127.0.0.2] preflight failed: device not reachable')
    expect(get()).toContain('No answer from 127.0.0.2')
    expect(get()).not.toMatch(/\n\s+at /)
    expect(acquire).toHaveBeenCalledTimes(1) // only the reachable host got as far as the lease
    expect(stub.log.some((l) => /^\/(launch|keypress)\//.test(l.endpoint))).toBe(true)
  })
})

describe('doctor args', () => {
  it('parses flags', () => {
    expect(parseDoctorArgs(['--host=1.2.3.4', '--json', '--show-serial', '--ecp-port', '9'])).toMatchObject({ host: '1.2.3.4', json: true, showSerial: true, ecpPort: '9' })
  })
})

describe('doctor hub reach probe (ADR 0024)', () => {
  const PW = 'pw-secret-xyz'
  const caps = (o = {}) => ({ model: 'x', softwareVersion: '16.0.4', developerEnabled: true, ecpSettingMode: 'permissive', videoMode: '720p', videoModeSource: 'video-mode', serial: 'SER-123', ...o })
  const setup = (o = {}) => {
    const keys = []
    const zips = []
    const deps = {
      env: { BRIGHTTEST_DOCTOR_HUB_PROBE: '1' },
      createDevice: () => ({ deviceCapabilities: async () => caps(o.caps), keypress: async (k) => { keys.push(k) } }),
      probeBind: async () => ({ ok: true, address: '0.0.0.0', port: 1 }),
      lanHost: () => '192.0.2.7',
      resolveDevice: () => ({ host: '127.0.0.1', password: 'password' in o ? o.password : PW }),
      acquireForLane: vi.fn(async () => ('lease' in o ? o.lease : { lease: { leaseId: 'outer-1', release: vi.fn() } })),
      sideload: vi.fn(async (cfg, a) => { zips.push(a.zip); return o.sideload ? o.sideload(a) : 0 }),
      listen: async () => ({ ok: true, waitHit: async () => (o.hit !== false), close: async () => {} }),
      waitMs: 50,
      ...(o.deps || {}),
    }
    return { deps, keys, zips }
  }
  const go = async (deps, extra = {}) => {
    const get = capture()
    const code = await doctor.run({ host: '127.0.0.1', json: true, ...extra }, deps)
    return { code, j: JSON.parse(get()) }
  }

  it('1. default: not-tested/not-requested, no hub-reach check, no sideload or lease', async () => {
    const { deps } = setup()
    deps.env = {}
    const r = await go(deps)
    expect(r.code).toBe(0)
    expect(r.j.hub).toMatchObject({ reach: 'not-tested', reachReason: 'not-requested', reachProven: false })
    expect(r.j.checks.find((k) => k.id === 'hub-reach')).toBeUndefined()
    expect(deps.sideload).not.toHaveBeenCalled()
    expect(deps.acquireForLane).not.toHaveBeenCalled()
  })

  it('2. opt-in, hit: reached, hub-reach ok, exit 0, Home pressed, temp dir removed', async () => {
    const { deps, keys, zips } = setup()
    const r = await go(deps)
    expect(r.code).toBe(0)
    expect(r.j.hub).toMatchObject({ reach: 'reached', reachProven: true })
    expect(r.j.checks.find((k) => k.id === 'hub-reach')).toMatchObject({ ok: true })
    expect(keys).toEqual(['Home'])
    expect(zips).toHaveLength(1)
    expect(fs.existsSync(path.dirname(zips[0]))).toBe(false)
  })

  it('3. opt-in, no hit: not-reached, hub-reach fails with the fix, exit 1', async () => {
    const { deps } = setup({ hit: false })
    const r = await go(deps)
    expect(r.code).toBe(1)
    expect(r.j.hub).toMatchObject({ reach: 'not-reached', reachProven: false })
    expect(r.j.checks.find((k) => k.id === 'hub-reach')).toMatchObject({ ok: false, fix: doctor.FIX_HUB_REACH('192.0.2.7', 8790) })
    const { deps: d2 } = setup({ hit: false })
    const get = capture()
    await doctor.run({ host: '127.0.0.1' }, d2)
    expect(get()).toContain('re-sideload your app')
  })

  it('4. every not-tested reason keeps exit 0 and adds no check', async () => {
    const reasons = async (o, want) => {
      const { deps } = setup(o)
      const r = await go(deps)
      expect(r.code).toBe(0)
      expect(r.j.hub).toMatchObject({ reach: 'not-tested', reachReason: want, reachProven: false })
      expect(r.j.checks.find((k) => k.id === 'hub-reach')).toBeUndefined()
      expect(deps.sideload).not.toHaveBeenCalled()
    }
    await reasons({ password: null }, 'no-password')
    await reasons({ lease: { code: 75 } }, 'lease-busy')
    // developer disabled: its own check fails (exit 1), the probe is skipped
    const { deps: dd } = setup({ caps: { developerEnabled: false } })
    const rd = await go(dd)
    expect(rd.j.hub).toMatchObject({ reach: 'not-tested', reachReason: 'developer-disabled' })
    expect(dd.sideload).not.toHaveBeenCalled()
    // sideload 1 with an auth message that contains the password: scrubbed
    const { deps } = setup()
    deps.sideload = vi.fn(async (c, a, d) => { d.log(`authentication failed: bad ${PW}`); return 1 })
    const r = await go(deps)
    expect(r.code).toBe(0)
    expect(r.j.hub.reachReason).toBe('sideload-failed')
    expect(JSON.stringify(r.j)).not.toContain(PW)
    // device unreachable
    const un = setup({ deps: { createDevice: () => ({ deviceCapabilities: async () => { throw new Error('down') } }) } })
    const ru = await go(un.deps)
    expect(ru.j.hub).toMatchObject({ reach: 'not-tested', reachReason: 'device-unreachable' })
    // port busy: a real loopback listener holds the port
    const net = require('net')
    const holder = net.createServer()
    await new Promise((res) => holder.listen(0, '127.0.0.1', res))
    const port = holder.address().port
    try {
      const res = await doctor.probeHubReach({ host: '127.0.0.1', ecpPort: 8060, password: PW, port, advertisedHost: '127.0.0.1', env: {} }, {
        acquireForLane: async () => ({ lease: { leaseId: 'o', release() {} } }), sideload: vi.fn(),
        listen: (a) => doctor.listenForProbe({ ...a, bindHost: '127.0.0.1' }),
      })
      expect(res).toMatchObject({ reach: 'not-tested', reachReason: 'port-busy' })
    } finally { await new Promise((res) => holder.close(res)) }
  })

  it('5. nested lease: inner acquire gets the outer lease id; the outer release runs once', async () => {
    const release = vi.fn()
    const { deps } = setup({ lease: { lease: { leaseId: 'outer-42', release } } })
    deps.sideload = vi.fn(async (c, a, d) => { await d.acquireForLane({ host: a.host }); return 0 })
    await go(deps)
    expect(deps.acquireForLane).toHaveBeenCalledTimes(2)
    expect(deps.acquireForLane.mock.calls[0][0]).toMatchObject({ purpose: 'doctor hub probe', allowBypass: false })
    expect(deps.acquireForLane.mock.calls[1][0].env.BRIGHTTEST_LEASE).toBe('outer-42')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('6. listenForProbe: wrong nonce or non-device peer gets 404 and does not count; the right one gets 204', async () => {
    const http = require('http')
    const get = (port, p) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)) }))
    const probe = async (peer) => {
      const probeSrv = require('net').createServer()
      await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r)); const port = probeSrv.address().port
      await new Promise((r) => probeSrv.close(r))
      const l = await doctor.listenForProbe({ port, deviceHost: '10.0.0.5', nonce: 'abc', bindHost: '127.0.0.1', peerOf: () => peer })
      return { l, port }
    }
    let { l, port } = await probe('::ffff:10.0.0.5')
    expect(await get(port, '/bt-probe/wrong')).toBe(404)
    expect(await l.waitHit(30)).toBe(false)
    expect(await get(port, '/bt-probe/abc')).toBe(204)
    expect(await l.waitHit(30)).toBe(true)
    await l.close()
    ;({ l, port } = await probe('10.0.0.99'))
    expect(await get(port, '/bt-probe/abc')).toBe(404)
    expect(await l.waitHit(30)).toBe(false)
    await l.close()
  })

  it('7. buildProbeZip: the three entries, main.brs carries the URL', async () => {
    const JSZip = require('jszip')
    const url = 'http://192.0.2.7:8790/bt-probe/n0nce'
    const z = await JSZip.loadAsync(await doctor.buildProbeZip(url))
    expect(Object.keys(z.files).sort()).toEqual(['components/', 'components/ProbeScene.xml', 'manifest', 'source/', 'source/main.brs'])
    expect(await z.file('source/main.brs').async('string')).toContain(url)
    expect(await z.file('manifest').async('string')).toBe(doctor.PROBE_MANIFEST)
  })

  it('8. --json carries reach, reachReason, reachProven; serial stays hidden', async () => {
    const { deps } = setup()
    const r = await go(deps)
    expect(r.j.hub).toMatchObject({ reach: 'reached', reachProven: true })
    expect('reachReason' in r.j.hub).toBe(true)
    expect(r.j.serial).toBeUndefined()
  })
})
