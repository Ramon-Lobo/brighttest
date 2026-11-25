import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import device from '../lib/device.js'
import crossCheck from '../lib/cross-check.js'

const NOTE = (lane) => `[brighttest] instrument.enabled applies to the headless lanes only; ignored by ${lane}`
let dir, out
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-insnote-'))
  fs.mkdirSync(path.join(dir, 'source'))
  fs.writeFileSync(path.join(dir, 'manifest'), 'title=x\n')
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const cfgWith = (instrument) => ({ rootDir: dir, sourceGlobs: ['manifest', 'source/**/*'], testsFilePattern: '**/*.spec.bs', stagingDir: path.join(dir, '.brighttest'), ...(instrument ? { instrument } : {}) })
const child = () => {
  const c = new EventEmitter(); c.pid = 1; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}
  setTimeout(() => c.emit('close', 0), 5)
  return c
}
const deviceDeps = { homeBeforeDeploy: async () => null, acquireForLane: async () => ({ lease: { addChild() {}, release() {} } }), spawn: () => child() }
const opts = { host: '127.0.0.1', password: 'pw' }

describe('instrument.enabled on device lanes', () => {
  it('device prints the ignore note once and still takes the lease path', async () => {
    await device.run(cfgWith({ enabled: true }), opts, deviceDeps)
    expect(out.filter((l) => l === NOTE('device')).length).toBe(1)
  })
  it('device prints no note when instrument is absent or not enabled', async () => {
    await device.run(cfgWith(), opts, deviceDeps)
    await device.run(cfgWith({ enabled: false }), opts, deviceDeps)
    expect(out.some((l) => l.includes('instrument.enabled'))).toBe(false)
  })
  it('cross-check prints the ignore note before the headless leg', async () => {
    const headless = async () => ({ built: false, output: '' })
    await crossCheck.run(cfgWith({ enabled: true }), opts, { headless })
    expect(out).toContain(NOTE('cross-check'))
  })
})
