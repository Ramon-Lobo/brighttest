import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'

// NET-HUB-PORT: one hub host/port (instrument.hub.*) for `instrument build --net` and `e2e run`.
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { build, BT_CONFIG_PKG } = require('../lib/instrument/build')
const hubMod = require('../lib/instrument/hub')
const e2e = require('../lib/e2e/run')
const { loadConfig } = require('../lib/config')

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-nethubport-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

function mkapp(name, hub) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest'), 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n')
  fs.writeFileSync(path.join(dir, 'source/main.brs'), 'sub main()\nend sub\n')
  if (hub !== undefined) fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ instrument: { hub } }))
  return dir
}
async function runBuild(name, hub, opts = {}) {
  const dir = mkapp(name, hub); const lines = []
  const out = path.join(tmp, name + '.zip')
  const r = await build({ ...loadConfig(dir), stagingDir: path.join(tmp, 'stage-' + name) }, { log: (l) => lines.push(l), out, net: true, env: { BRIGHTTEST_HUB_TOKEN: TOKEN }, ...opts })
  let cfgText = null
  if (r.out) cfgText = await (await JSZip.loadAsync(fs.readFileSync(out))).file(BT_CONFIG_PKG).async('string')
  return { ...r, lines, cfgText }
}
function badFlow(dir) { const f = path.join(dir, 'bad.e2e.yaml'); fs.writeFileSync(f, 'steps: ['); return f }
const fakeLease = () => ({ leaseId: 'l', onLost: null })

describe('build bakes the configured hub address', () => {
  it('bakes host and port from instrument.hub, never auto', async () => {
    const r = await runBuild('b1', { host: 'hub.example.test', port: 9123 })
    expect(r.exitCode).toBe(0)
    expect(r.cfgText).toContain('hub: { host: "hub.example.test", port: 9123 }')
    expect(r.cfgText).not.toContain('auto')
  })
  it('unset host resolves the LAN address; unset port is 8790', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ en0: [{ family: 'IPv4', internal: false, address: '192.0.2.7' }] })
    const r = await runBuild('b2', {})
    expect(r.cfgText).toContain('hub: { host: "192.0.2.7", port: 8790 }')
    expect(r.cfgText).not.toContain('auto')
  })
  it('--net with no host and no LAN refuses with a clear error', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] })
    const r = await runBuild('b3', {})
    expect(r.exitCode).not.toBe(0)
    expect(r.out).toBeNull()
    expect(r.lines.join('\n')).toContain('instrument.hub.host')
  })
  it('rejects the literal auto and a bad port', async () => {
    expect((await runBuild('b4', { host: 'auto' })).lines.join('\n')).toContain('"auto" is not accepted')
    expect((await runBuild('b5', { host: 'h.example.test', port: 0 })).lines.join('\n')).toContain('instrument.hub.port')
  })
})

describe('run listens on the configured port', () => {
  it('defaults to 8790 and reads instrument.hub.port', () => {
    expect(hubMod.hubAddress({}).port).toBe(8790)
    expect(hubMod.hubAddress({ instrument: { hub: { host: 'h.example.test', port: 9001 } } })).toMatchObject({ host: 'h.example.test', port: 9001 })
  })
  it('passes the configured port to startLanHub (never 0)', async () => {
    const dir = mkapp('r1', { host: 'h.example.test', port: 9455 })
    const cfg = loadConfig(dir)
    const seen = []
    const startLanHub = async (o) => { seen.push(o.port); return { stop: async () => {} } }
    const dev = { deviceInfo: async () => ({ model: 'S', developerEnabled: true }) }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await e2e.run(cfg, { e2eAction: 'run', flows: [badFlow(dir)], host: '10.0.0.1', lanHub: true }, { createDevice: () => dev, acquireForLane: async () => ({ lease: { release() {} } }), startLanHub })
    expect(seen).toEqual([9455])
    const cfg2 = loadConfig(mkapp('r2'))
    seen.length = 0
    await e2e.run(cfg2, { e2eAction: 'run', flows: [badFlow(cfg2.rootDir)], host: '10.0.0.1', lanHub: true }, { createDevice: () => dev, acquireForLane: async () => ({ lease: { release() {} } }), startLanHub })
    expect(seen).toEqual([8790])
  })
  it('a port in use is reported naming the port and the config key; no fallback to port 0', async () => {
    const blocker = net.createServer()
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
    const port = blocker.address().port
    const out = []
    try {
      const cfg = loadConfig(mkapp('r3', { host: 'h.example.test', port }))
      const startLanHub = (o) => hubMod.startLanHub({ ...o, bindHost: '127.0.0.1' })
      const dev = { deviceInfo: async () => ({ model: 'S', developerEnabled: true }) }
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true })
      await e2e.run(cfg, { e2eAction: 'run', flows: [badFlow(cfg.rootDir)], host: '10.0.0.77', lanHub: true }, { createDevice: () => dev, acquireForLane: async () => ({ lease: { ...fakeLease(), held: () => true, release() {} } }), startLanHub })
    } finally { await new Promise((r) => blocker.close(r)) }
    const text = out.join('')
    expect(text).toContain(`port ${port} is already in use`)
    expect(text).toContain('instrument.hub.port')
  })
})

describe('handshake timeout message', () => {
  it('names build/net, host+port, and token as causes; prints the expected address; no token value', () => {
    const cfg = { instrument: { hub: { host: 'hub.example.test', port: 9123 } } }
    const msg = e2e.handshakeMessage({ cfg, net: { hub: { port: 9123 } } })
    expect(msg).toContain('instrument build --net')
    expect(msg).toContain('hub.example.test:9123')
    expect(msg).toMatch(/host or port/)
    expect(msg).toMatch(/token/)
    expect(msg).not.toContain(TOKEN)
    expect(msg).not.toMatch(/[0-9a-f]{32}/)
  })
})

describe('handshake message with a stored package token', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const store = require('../lib/instrument/hub-token-store')
  const SHA = 'ab12cd34ef56' + '0'.repeat(52)
  const STORED = 'f'.repeat(16) + 'e'.repeat(16)
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hs-'))

  it('names the 12-hex package sha and the fix, and prints no token', () => {
    const rootDir = mk()
    try {
      store.storeToken(rootDir, SHA, STORED)
      const cfg = { rootDir, instrument: { hub: { host: 'hub.example.test', port: 9123 } } }
      const msg = e2e.handshakeMessage({ cfg, net: { hub: { port: 9123 } } })
      expect(msg).toContain('ab12cd34ef56')
      expect(msg).not.toContain(SHA)
      expect(msg).toContain('net token --ensure')
      expect(msg).toContain('instrument build --net')
      expect(msg).toContain('hub.example.test:9123')
      expect(msg).not.toContain(STORED)
      expect(msg).not.toMatch(/[0-9a-f]{32}/)
    } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
  })

  it('keeps the generic text when no token is stored', () => {
    const rootDir = mk()
    try {
      const msg = e2e.handshakeMessage({ cfg: { rootDir, instrument: { hub: { host: 'hub.example.test', port: 9123 } } }, net: { hub: { port: 9123 } } })
      expect(msg).toContain('(3) the token baked in the build differs from the hub token (BRIGHTTEST_HUB_TOKEN at build time vs at run time).')
      expect(msg).not.toContain('net token --ensure')
    } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
  })
})
