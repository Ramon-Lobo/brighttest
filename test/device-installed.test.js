import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const inst = require('../lib/device-installed')
const lease = require('../lib/device-lease')
const { sideload } = require('../lib/instrument/sideload')
const V = require('../lib/device-lease-view')
const W = require('../lib/device-watch')
const dc = require('../lib/device-command')
const studio = require('../lib/studio/server.js')

const PW = 'sentinel-password-0001'
const TOKEN = 'sentinel-hub-token-0002'
const HOST = '192.0.2.5'
const ADDR_KEY = lease.keyFromAddress(HOST)
const ID_KEY = lease.keyFromIdentity('SERIAL-T7')
const NOW = Date.parse('2026-11-26T12:00:00.000Z')

let tmp, zipPath, zipBuf
const saved = {}
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-inst-'))
  for (const k of ['BRIGHTTEST_LEASE_DIR', 'BRIGHTTEST_AGENT', 'BRIGHTTEST_CACHE', 'ROKU_ECP_PORT']) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
  process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
  const z = new JSZip()
  z.file('manifest', 'title=Greenfield Sample\nmajor_version=1\nminor_version=0\nbuild_version=1\n')
  z.file('source/main.brs', 'sub main()\nend sub\n')
  zipBuf = await z.generateAsync({ type: 'nodebuffer' })
  zipPath = path.join(tmp, 'app.zip')
  fs.writeFileSync(zipPath, zipBuf)
})
afterEach(() => {
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const dirOf = () => process.env.BRIGHTTEST_LEASE_DIR
const FACTS_GIT = { worktree: '/work/wt-feature-x', branch: 'feat/x', commit: 'a1b2c3d', dirty: true }
const entryOf = async (extra = {}) => inst.buildEntry({ facts: { ...(await inst.collectFacts({ zipData: zipBuf, cwd: tmp })), git: FACTS_GIT }, agent: 'dev#2', via: 'cli', now: NOW, ...extra })

function walkText(d) {
  let out = ''
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n)
    out += fs.statSync(p).isDirectory() ? walkText(p) : fs.readFileSync(p, 'utf8')
  }
  return out
}

describe('device-installed record', () => {
  it('has every listed field and no secret', async () => {
    const e = await entryOf()
    expect(e).toMatchObject({
      schema: 'brighttest-installed/v1', sha256: inst.sha256Hex(zipBuf), size: zipBuf.length, via: 'cli', identical: false,
      manifest: { title: 'Greenfield Sample', version: '1.0.1' },
      by: { agent: 'dev#2', worktree: '/work/wt-feature-x', branch: 'feat/x', commit: 'a1b2c3d', dirty: true },
    })
    expect(Object.keys(e).sort()).toEqual(['at', 'by', 'identical', 'manifest', 'schema', 'sha256', 'size', 'via'])
    expect(Object.keys(e.by).sort()).toEqual(['agent', 'branch', 'commit', 'dirty', 'worktree'])
  })

  it('writes installed.json (0600) and an installed event on every key, atomically', async () => {
    const r = inst.recordInstall({ dir: dirOf(), keys: [ID_KEY, ADDR_KEY], entry: await entryOf() })
    expect(r).toMatchObject({ ok: true, written: [ID_KEY, ADDR_KEY] })
    for (const k of [ID_KEY, ADDR_KEY]) {
      const f = path.join(dirOf(), k, 'installed.json')
      expect(JSON.parse(fs.readFileSync(f, 'utf8')).sha256).toBe(inst.sha256Hex(zipBuf))
      if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(path.join(dirOf(), k)).some((n) => n.endsWith('.tmp'))).toBe(false)
      const evs = lease.readEvents({ dir: dirOf(), key: k })
      expect(evs.filter((x) => x.ev === 'installed')).toHaveLength(1)
    }
    expect(inst.readInstalled({ dir: dirOf(), keys: [ID_KEY, ADDR_KEY] }).by.agent).toBe('dev#2')
  })

  it('readInstalled returns the newest entry across keys, null when absent or corrupt', async () => {
    expect(inst.readInstalled({ dir: dirOf(), keys: [ID_KEY] })).toBeNull()
    inst.recordInstall({ dir: dirOf(), keys: [ID_KEY], entry: await entryOf({ now: NOW - 60000, agent: 'old' }) })
    inst.recordInstall({ dir: dirOf(), keys: [ADDR_KEY], entry: await entryOf({ now: NOW, agent: 'new' }) })
    expect(inst.readInstalled({ dir: dirOf(), keys: [ID_KEY, ADDR_KEY] }).by.agent).toBe('new')
    fs.writeFileSync(path.join(dirOf(), ADDR_KEY, 'installed.json'), '{not json')
    expect(inst.readInstalled({ dir: dirOf(), keys: [ADDR_KEY] })).toBeNull()
  })

  it('describeInstalled: one line, "unknown" when absent, control characters removed', async () => {
    expect(inst.describeInstalled(null, NOW)).toBe('unknown')
    const line = inst.describeInstalled(await entryOf({ now: NOW - 4 * 60000 }), NOW)
    expect(line).toBe(`Greenfield Sample 1.0.1 · sha ${inst.sha256Hex(zipBuf).slice(0, 8)} · by dev#2 (wt-feature-x @a1b2c3d, dirty) · 4m ago`)
    const evil = inst.describeInstalled({ manifest: { title: 'A\u001b[31mB' }, by: {} }, NOW)
    expect(evil).not.toMatch(/\u001b/)
  })

  it('an unreadable package still records the hash', async () => {
    const f = await inst.collectFacts({ zipData: Buffer.from('PK'), cwd: tmp })
    expect(f.sha256).toBe(inst.sha256Hex(Buffer.from('PK')))
    expect(f.manifest).toEqual({ title: null, version: null })
  })

  it('recordInstall never throws on a bad lease dir', async () => {
    fs.writeFileSync(path.join(tmp, 'file'), 'x')
    const r = inst.recordInstall({ dir: path.join(tmp, 'file', 'sub'), keys: [ADDR_KEY], entry: await entryOf() })
    expect(r.ok).toBe(false)
  })
})

// ---- sideload writes the record --------------------------------------------------------------------------------
const challenge = 'Digest realm="rokudev", nonce="abc", qop="auth"'
function installer(html) {
  return async (url, init) => {
    if (/:8060\/launch\/dev$/.test(url)) return { status: 200, headers: { get: () => null }, text: async () => '' }
    if (/:8060\/query\/active-app$/.test(url)) return { status: 200, headers: { get: () => null }, text: async () => '<active-app><app id="dev" type="appl" version="1.0.0">Sample</app></active-app>' }
    if (!(init.headers && init.headers.Authorization)) return { status: 401, headers: { get: () => challenge }, text: async () => '' }
    return { status: 200, headers: { get: () => null }, text: async () => html }
  }
}
function runSideload({ html = 'Install Success', via, recordInstall, lines = [], leaseKeys = [ID_KEY, ADDR_KEY], opts = {} } = {}) {
  let released = 0
  const fakeLease = { keys: leaseKeys, key: leaseKeys[0], release() { released++ } }
  const deps = {
    fetch: installer(html), log: (l) => lines.push(l), tcpProbe: async () => true, sleep: async () => {}, activeTries: 2,
    acquireForLane: async () => ({ lease: fakeLease }), installedDir: dirOf(), recordInstall,
    collectFacts: async () => ({ ...(await inst.collectFacts({ zipData: fs.readFileSync(zipPath), cwd: tmp })), git: FACTS_GIT }),
  }
  return sideload({}, { zip: zipPath, host: HOST, password: PW, as: 'dev#2', via, ...opts }, deps).then((code) => ({ code, lines, released: () => released }))
}

describe('sideload records the installed build', () => {
  it('a successful install writes the record on every held key and the event', async () => {
    const r = await runSideload({ via: 'studio' })
    expect(r.code).toBe(0)
    const e = inst.readInstalled({ dir: dirOf(), keys: [ADDR_KEY] })
    expect(e).toMatchObject({ via: 'studio', identical: false, by: { agent: 'dev#2', branch: 'feat/x', dirty: true } })
    expect(fs.existsSync(path.join(dirOf(), ID_KEY, 'installed.json'))).toBe(true)
  })

  it('defaults via to cli and records the identical-package path', async () => {
    const r = await runSideload({ html: 'Identical to previous version -- not replacing.' })
    expect(r.code).toBe(0)
    expect(inst.readInstalled({ dir: dirOf(), keys: [ADDR_KEY] })).toMatchObject({ via: 'cli', identical: true })
  })

  it('a failed install records nothing', async () => {
    const r = await runSideload({ html: 'Install Failure: Compilation Failed.' })
    expect(r.code).toBe(1)
    expect(fs.existsSync(path.join(dirOf(), ADDR_KEY, 'installed.json'))).toBe(false)
  })

  it('a failed record write is a warning and leaves the install result unchanged', async () => {
    const lines = []
    const r = await runSideload({ lines, recordInstall: () => ({ ok: false, written: [], error: 'disk full' }) })
    expect(r.code).toBe(0)
    expect(r.released()).toBe(1)
    expect(lines.join('\n')).toMatch(/warning: could not record the installed build \(disk full\)/)
    const lines2 = []
    const r2 = await runSideload({ lines: lines2, recordInstall: () => { throw new Error('boom') } })
    expect(r2.code).toBe(0)
    expect(lines2.join('\n')).toMatch(/warning: could not record/)
  })

  it('holds no new lease: the record is written with the keys of the lease the install already holds', async () => {
    const seen = []
    await runSideload({ recordInstall: (a) => { seen.push(a.keys); return { ok: true, written: a.keys } } })
    expect(seen).toEqual([[ID_KEY, ADDR_KEY]])
  })

  it('no password, hub token or hash of either anywhere in the lease dir or output', async () => {
    process.env.ROKU_HUB_TOKEN = TOKEN
    try {
      const lines = []
      await runSideload({ lines })
      const all = walkText(dirOf()) + lines.join('\n')
      const crypto = require('node:crypto')
      for (const s of [PW, TOKEN]) {
        expect(all).not.toContain(s)
        for (const alg of ['sha256', 'sha1', 'md5']) expect(all).not.toContain(crypto.createHash(alg).update(s).digest('hex'))
      }
      expect(all).not.toMatch(/leaseId/)
    } finally { delete process.env.ROKU_HUB_TOKEN }
  })
})

// ---- readers --------------------------------------------------------------------------------------------------
describe('device status shows the record', () => {
  const run = async (args = {}) => {
    const out = []
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    const code = await dc.run({ deviceAction: 'status', unknown: [], ...args }, {})
    return { code, text: out.join('\n') }
  }
  const mkKey = (k) => fs.mkdirSync(path.join(dirOf(), k, 'queue'), { recursive: true })

  it('prints the installed line, and "unknown" for an old device with no record', async () => {
    mkKey(ADDR_KEY); mkKey('198.51.100.9')
    inst.recordInstall({ dir: dirOf(), keys: [ADDR_KEY], entry: await entryOf({ now: Date.now() - 120000 }) })
    const { code, text } = await run()
    expect(code).toBe(0)
    expect(text).toMatch(/installed: Greenfield Sample 1\.0\.1 · sha [0-9a-f]{8} · by dev#2 \(wt-feature-x @a1b2c3d, dirty\) · 2m ago/)
    expect(text).toMatch(/198\.51\.100\.9[^\n]*\n\s*installed: unknown/)
  })

  it('--json carries installed (entry or null)', async () => {
    mkKey(ADDR_KEY); mkKey('198.51.100.9')
    inst.recordInstall({ dir: dirOf(), keys: [ADDR_KEY], entry: await entryOf() })
    const { text } = await run({ json: true })
    const list = JSON.parse(text)
    expect(list.find((s) => s.key === ADDR_KEY).installed.sha256).toBe(inst.sha256Hex(zipBuf))
    expect(list.find((s) => s.key === '198.51.100.9').installed).toBeNull()
  })
})

describe('device watch shows the record', () => {
  const view = () => V.createView({ dir: dirOf(), env: {}, now: () => NOW, hostname: 'h', machine: 'h', isAlive: () => false, pidStart: () => null, knownDevices: () => [] })
  it('the board carries it and the static render prints it; unknown for an old device', async () => {
    fs.mkdirSync(path.join(dirOf(), ADDR_KEY, 'queue'), { recursive: true })
    fs.mkdirSync(path.join(dirOf(), '198.51.100.9', 'queue'), { recursive: true })
    fs.writeFileSync(path.join(dirOf(), '198.51.100.9', 'events.log'), JSON.stringify({ t: new Date(NOW - 1000).toISOString(), ev: 'note', note: 'x' }) + '\n')
    inst.recordInstall({ dir: dirOf(), keys: [ADDR_KEY], entry: await entryOf({ now: NOW - 240000 }) })
    const board = view().snapshot({})
    const a = board.devices.find((d) => d.keys.includes(ADDR_KEY))
    const b = board.devices.find((d) => d.keys.includes('198.51.100.9'))
    expect(a.installed.by.agent).toBe('dev#2')
    expect(b.installed).toBeNull()
    const text = W.renderOnce(board, { now: NOW, utc: true, level: 'none' })
    expect(text).toMatch(/installed: Greenfield Sample 1\.0\.1 · sha [0-9a-f]{8} · by dev#2 \(wt-feature-x @a1b2c3d, dirty\) · 4m ago/)
    expect(text).toMatch(/installed: unknown/)
  })
})

describe('Studio /api/device includes the record', () => {
  const get = (srv, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d }); res.on('end', () => resolve(JSON.parse(b))) }).on('error', reject)
  })
  const stop = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections && srv.closeAllConnections() })
  it('null before any install, the record after (loopback fake device-info)', async () => {
    const fake = await new Promise((r) => {
      const s = http.createServer((q, res) => res.end('<device-info><serial-number>FAKE-SN</serial-number><model-name>Fake</model-name></device-info>'))
      s.listen(0, '127.0.0.1', () => r(s))
    })
    process.env.ROKU_ECP_PORT = String(fake.address().port)
    const srv = await studio.start({ port: 0, rootDir: tmp, host: '127.0.0.1', password: PW })
    try {
      const before = await get(srv, '/api/device')
      expect(before.connected).toBe(true)
      expect(before.installed).toBeNull()
      const key = lease.keyFromAddress('127.0.0.1', fake.address().port)
      inst.recordInstall({ dir: dirOf(), keys: [key], entry: await entryOf() })
      const after = await get(srv, '/api/device')
      expect(after.installed).toMatchObject({ sha256: inst.sha256Hex(zipBuf), by: { agent: 'dev#2' } })
      expect(after.installed.text).toMatch(/Greenfield Sample 1\.0\.1/)
      expect(JSON.stringify(after)).not.toContain(PW)
    } finally { await stop(srv); await stop(fake) }
  })
})
