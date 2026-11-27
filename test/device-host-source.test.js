import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const dc = require('../lib/device-command.js')
const { cmdReset } = require('../lib/e2e/reset.js')
const identity = require('../lib/device-identity.js')

// The cached-host rule for device with / lock / reset (LMA-T1). Fake device-info responders on loopback only;
// the lease directory is a temp dir, so "no lease file" is an assertion on that directory.
const KEYS = ['BRIGHTTEST_CACHE', 'BRIGHTTEST_LEASE_DIR', 'BRIGHTTEST_LEASE', 'BRIGHTTEST_NO_LEASE', 'ROKU_HOST', 'ROKU_PASSWORD', 'ROKU_ECP_PORT']
const saved = {}
let dir, leaseDir, err, servers
const seed = (devs, last) => fs.writeFileSync(process.env.BRIGHTTEST_CACHE, JSON.stringify({ lastHost: last, devices: devs }))
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }) : [])
const stderrText = () => err.mock.calls.map((c) => String(c[0])).join('')

function fakeDevice() {
  const s = http.createServer((req, res) => { res.end('<device-info><serial-number>FAKE-SN-1</serial-number><model-name>Fake</model-name></device-info>') })
  servers.push(s)
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
}
function closedPort() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
}

beforeEach(() => {
  servers = []
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-host-src-'))
  leaseDir = path.join(dir, 'leases')
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  process.env.BRIGHTTEST_LEASE_DIR = leaseDir
  identity.processCache.clear()
  err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of servers) await new Promise((r) => { s.close(r); s.closeAllConnections && s.closeAllConnections() })
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  fs.rmSync(dir, { recursive: true, force: true })
})

const withOpts = (extra = {}) => ({ deviceAction: 'with', cmd: [process.execPath, '-e', '0'], noHygiene: true, wait: '20s', ...extra })
const two = () => seed({ '192.0.2.1': { password: 'pw-a', lastUsed: Date.now() }, '192.0.2.2': { password: 'pw-b', lastUsed: Date.now() } }, '192.0.2.2')

describe('ambiguity rule on with / lock / reset', () => {
  it('device with: several cached devices and no host exits 2, no lease file', async () => {
    two()
    expect(await dc.run(withOpts(), {})).toBe(2)
    expect(stderrText()).toMatch(/multiple devices are cached.*--host/)
    expect(files(leaseDir)).toEqual([])
  })
  it('device lock: same rule', async () => {
    two()
    expect(await dc.run({ deviceAction: 'lock' }, {})).toBe(2)
    expect(stderrText()).toMatch(/multiple devices are cached/)
    expect(files(leaseDir)).toEqual([])
  })
  it('device reset: same rule, even with a stubbed target', async () => {
    two()
    expect(await cmdReset({}, {})).toBe(2)
    expect(stderrText()).toMatch(/multiple devices are cached/)
    expect(files(leaseDir)).toEqual([])
  })
  it('ROKU_HOST makes the choice explicit (no ambiguity)', async () => {
    two()
    process.env.ROKU_HOST = '192.0.2.9'
    expect(dc.ambiguousHostMessage({})).toBeNull()
  })
})

describe('cache-sourced host', () => {
  it('is announced on stderr with its age and the --host hint', async () => {
    const port = await fakeDevice()
    process.env.ROKU_ECP_PORT = String(port)
    seed({ '127.0.0.1': { password: 'pw', lastUsed: Date.now() - 5 * 60e3 } }, '127.0.0.1')
    expect(await dc.run(withOpts(), {})).toBe(0)
    expect(stderrText()).toContain('[brighttest device] using the cached device 127.0.0.1 (last used 5m ago); pass --host to choose another')
  })
  it('an explicit --host prints no announcement', async () => {
    const port = await fakeDevice()
    process.env.ROKU_ECP_PORT = String(port)
    seed({ '127.0.0.1': { password: 'pw', lastUsed: Date.now() } }, '127.0.0.1')
    expect(await dc.run(withOpts({ host: '127.0.0.1:pw' }), {})).toBe(0)
    expect(stderrText()).not.toContain('using the cached device')
  })
  it('unreachable cached host: exit 2 with the message, before any lease file', async () => {
    process.env.ROKU_ECP_PORT = String(await closedPort())
    seed({ '127.0.0.1': { password: 'pw', lastUsed: Date.now() } }, '127.0.0.1')
    expect(await dc.run(withOpts(), {})).toBe(2)
    expect(stderrText()).toMatch(/cached device 127\.0\.0\.1 did not answer device-info \(.+\); pass --host <ip> or set ROKU_HOST/)
    expect(files(leaseDir)).toEqual([])
  })
  it('unreachable cached host on device lock: exit 2, no lease file', async () => {
    process.env.ROKU_ECP_PORT = String(await closedPort())
    seed({ '127.0.0.1': { password: 'pw', lastUsed: Date.now() } }, '127.0.0.1')
    expect(await dc.run({ deviceAction: 'lock', noHygiene: true }, {})).toBe(2)
    expect(files(leaseDir)).toEqual([])
  })
  it('acquireForLane: hostSource cache + failed read returns { code: 2 } and never touches the store', async () => {
    const createStore = vi.fn(); const acquire = vi.fn()
    const lease = { ...require('../lib/device-lease.js'), createStore, acquire }
    const got = await dc.acquireForLane({
      cfg: {}, host: '127.0.0.1', ecpPort: 8060, hostSource: 'cache', purpose: 'x', command: ['x'],
      deps: { lease, readIdentity: async () => ({ reason: 'device-info unreachable' }) },
    })
    expect(got).toEqual({ code: 2 })
    expect(acquire).not.toHaveBeenCalled()
  })
})

describe('explicit host keeps today\'s behaviour', () => {
  it('--host to an unreachable device is still leased', async () => {
    process.env.ROKU_ECP_PORT = String(await closedPort())
    expect(await dc.run(withOpts({ host: '127.0.0.1:pw' }), {})).toBe(0)
    expect(stderrText()).toMatch(/device identity not read/)
    expect(files(leaseDir).length).toBeGreaterThan(0)
  })
  it('ROKU_HOST to an unreachable device is still leased', async () => {
    process.env.ROKU_ECP_PORT = String(await closedPort())
    process.env.ROKU_HOST = '127.0.0.1'
    expect(await dc.run(withOpts(), {})).toBe(0)
    expect(files(leaseDir).length).toBeGreaterThan(0)
  })
})
