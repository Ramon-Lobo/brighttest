import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'

const require = createRequire(import.meta.url)
const studio = require('../lib/studio/server.js')

// Studio resolves its device with the CLI-lane rules: explicit host wins, one cached device is the only
// guess allowed, several cached devices fail, ROKU_PASSWORD applies to any host. Synthetic hosts only.
const saved = {}
let dir
const seed = (devs, last) => fs.writeFileSync(process.env.BRIGHTTEST_CACHE, JSON.stringify({ lastHost: last, devices: devs }))
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-resolve-'))
  for (const k of ['BRIGHTTEST_CACHE', 'ROKU_HOST', 'ROKU_PASSWORD']) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
})
afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('studio device resolution', () => {
  it('two cached devices and no host: fails with a clear message, no guess', () => {
    seed({ '192.0.2.1': { password: 'a' }, '192.0.2.2': { password: 'b' } }, '192.0.2.2')
    expect(() => studio.resolveStudioTarget({})).toThrow(/multiple devices are cached.*--host/)
  })
  it('two cached devices and no host: start() rejects/throws before opening a server', async () => {
    seed({ '192.0.2.1': { password: 'a' }, '192.0.2.2': { password: 'b' } }, '192.0.2.2')
    const err = await Promise.resolve().then(() => studio.start({ port: 0, rootDir: dir })).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/multiple devices are cached/)
  })
  it('explicit host is never replaced by a cached device, even with several cached', () => {
    seed({ '192.0.2.1': { password: 'a' }, '192.0.2.2': { password: 'b' } }, '192.0.2.2')
    expect(studio.resolveStudioTarget({ host: '192.0.2.9', password: 'x' })).toEqual({ host: '192.0.2.9', password: 'x' })
  })
  it('ROKU_HOST with several cached devices is explicit, not ambiguous', () => {
    seed({ '192.0.2.1': { password: 'a' }, '192.0.2.2': { password: 'b' } }, '192.0.2.2')
    process.env.ROKU_HOST = '192.0.2.7'; process.env.ROKU_PASSWORD = 'shared'
    expect(studio.resolveStudioTarget({})).toEqual({ host: '192.0.2.7', password: 'shared' })
  })
  it('exactly one cached device and no host: uses it with its cached password', () => {
    seed({ '192.0.2.1': { password: 'a' } }, '192.0.2.1')
    expect(studio.resolveStudioTarget({})).toEqual({ host: '192.0.2.1', password: 'a' })
  })
  it('one cached device without a password: fails like the lanes', () => {
    seed({ '192.0.2.1': {} }, '192.0.2.1')
    expect(() => studio.resolveStudioTarget({})).toThrow(/no password/)
  })
  it('ROKU_PASSWORD applies to the single cached host', () => {
    seed({ '192.0.2.1': {} }, '192.0.2.1'); process.env.ROKU_PASSWORD = 'shared'
    expect(studio.resolveStudioTarget({})).toEqual({ host: '192.0.2.1', password: 'shared' })
  })
  it('explicit host with only ROKU_PASSWORD in the env carries that password', () => {
    process.env.ROKU_PASSWORD = 'env-fake-pw'
    expect(studio.resolveStudioTarget({ host: '192.0.2.9' })).toEqual({ host: '192.0.2.9', password: 'env-fake-pw' })
  })
  it('explicit host with no password anywhere: fails as missing, message carries no value', () => {
    const err = (() => { try { studio.resolveStudioTarget({ host: '192.0.2.9' }) } catch (e) { return e } })()
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/no password for device 192\.0\.2\.9/)
  })
  it('nothing cached, no host: device-less', () => {
    expect(studio.resolveStudioTarget({})).toEqual({ host: null, password: null })
  })
})

// LMA-T1: Studio caches its startup host only after reaching it (fake device-info on loopback).
describe('studio caches the host only after a successful device-info read', () => {
  const freshFake = () => new Promise((r) => {
    const s = http.createServer((q, res) => res.end('<device-info><serial-number>FAKE-SN</serial-number><model-name>Fake</model-name></device-info>'))
    s.listen(0, '127.0.0.1', () => r(s))
  })
  const closedPort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const get = (srv, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d }); res.on('end', () => resolve(JSON.parse(b))) }).on('error', reject)
  })
  const stop = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections && srv.closeAllConnections() })
  let leaseDirSaved
  beforeEach(() => { leaseDirSaved = process.env.BRIGHTTEST_LEASE_DIR; saved.ROKU_ECP_PORT = process.env.ROKU_ECP_PORT; process.env.BRIGHTTEST_LEASE_DIR = path.join(dir, 'leases') })
  afterEach(() => { if (leaseDirSaved === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = leaseDirSaved })

  it('started on an unreachable host: the devices cache file is not created or changed', async () => {
    process.env.ROKU_ECP_PORT = String(await closedPort())
    const srv = await studio.start({ port: 0, rootDir: dir, host: '127.0.0.1', password: 'pw' })
    try {
      expect(fs.existsSync(process.env.BRIGHTTEST_CACHE)).toBe(false)
      const body = await get(srv, '/api/device')
      expect(body.connected).toBe(false)
      expect(fs.existsSync(process.env.BRIGHTTEST_CACHE)).toBe(false)
    } finally { await stop(srv) }
  })
  it('unreachable host with an existing cache: the file is byte-identical', async () => {
    seed({ '192.0.2.1': { password: 'a', lastUsed: 1 } }, '192.0.2.1')
    const before = fs.readFileSync(process.env.BRIGHTTEST_CACHE, 'utf8')
    process.env.ROKU_ECP_PORT = String(await closedPort())
    const srv = await studio.start({ port: 0, rootDir: dir, host: '127.0.0.1', password: 'pw' })
    try { await get(srv, '/api/device') } finally { await stop(srv) }
    expect(fs.readFileSync(process.env.BRIGHTTEST_CACHE, 'utf8')).toBe(before)
  })
  it('writes the cache after the first successful device-info read, not before', async () => {
    const fake = await freshFake()
    process.env.ROKU_ECP_PORT = String(fake.address().port)
    const srv = await studio.start({ port: 0, rootDir: dir, host: '127.0.0.1', password: 'pw' })
    try {
      expect(fs.existsSync(process.env.BRIGHTTEST_CACHE)).toBe(false)
      const body = await get(srv, '/api/device')
      expect(body.connected).toBe(true)
      const c = JSON.parse(fs.readFileSync(process.env.BRIGHTTEST_CACHE, 'utf8'))
      expect(c.lastHost).toBe('127.0.0.1')
      expect(c.devices['127.0.0.1'].password).toBe('pw')
    } finally { await stop(srv); await stop(fake) }
  })
})
