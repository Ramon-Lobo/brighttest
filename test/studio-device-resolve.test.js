import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  it('nothing cached, no host: device-less', () => {
    expect(studio.resolveStudioTarget({})).toEqual({ host: null, password: null })
  })
})
