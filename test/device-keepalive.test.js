import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import KA from '../lib/device-keepalive.js'
import deviceCommand from '../lib/device-command.js'

const mkDev = (impl) => { const calls = []; const dev = { keypress: vi.fn(async (k) => { calls.push(k); if (impl) await impl(calls.length) }) }; return { dev, calls, createDevice: () => dev } }

describe('device-keepalive helper', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is off for 0 / undefined: no timer, no keypress', () => {
    const m = mkDev()
    expect(vi.getTimerCount()).toBe(0)
    KA.start('h', 'Fwd', 0, { createDevice: m.createDevice })()
    KA.start('h', 'Fwd', undefined, { createDevice: m.createDevice })()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends exactly one Fwd per interval, first at 240 s, logs each', async () => {
    const m = mkDev(); const log = []
    const stop = KA.start('h', KA.KEEPALIVE_KEY, 240, { createDevice: m.createDevice, log: (l) => log.push(l) })
    await vi.advanceTimersByTimeAsync(239_000)
    expect(m.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.calls).toEqual(['Fwd'])
    await vi.advanceTimersByTimeAsync(480_000)
    expect(m.calls).toEqual(['Fwd', 'Fwd', 'Fwd'])
    expect(log).toHaveLength(3)
    expect(log[0]).toMatch(/t\+240s keypress Fwd ok/)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop() clears the timer and no more sends happen; stop is idempotent', async () => {
    const m = mkDev()
    const stop = KA.start('h', 'Fwd', 60, { createDevice: m.createDevice })
    expect(vi.getTimerCount()).toBe(1)
    stop(); stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(m.calls).toEqual([])
  })

  it('timer is unref\'d', () => {
    const unref = vi.fn(); const clear = vi.fn()
    const stop = KA.start('h', 'Fwd', 60, { createDevice: mkDev().createDevice, setInterval: () => ({ unref }), clearInterval: clear })
    expect(unref).toHaveBeenCalled()
    stop(); expect(clear).toHaveBeenCalledTimes(1)
  })

  it('3 consecutive failures stop the helper with one warning; a success resets the counter', async () => {
    const fail = mkDev(() => { throw new Error('boom') }); const log = []
    KA.start('h', 'Fwd', 60, { createDevice: fail.createDevice, log: (l) => log.push(l) })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fail.calls).toHaveLength(3)
    expect(log.filter((l) => /warning/.test(l))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    const mixed = mkDev((n) => { if (n !== 3) throw new Error('x') }) // fail, fail, ok, fail, fail, fail
    KA.start('h', 'Fwd', 60, { createDevice: mixed.createDevice })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(mixed.calls).toHaveLength(6)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never sends Home, Back or Select, and rejects keys outside the list', async () => {
    const m = mkDev()
    for (const k of ['Home', 'Back', 'Select', 'Up']) expect(() => KA.start('h', k, 60, { createDevice: m.createDevice })).toThrow(/not allowed/)
    const stop = KA.start('h', 'Fwd', 60, { createDevice: m.createDevice })
    await vi.advanceTimersByTimeAsync(600_000)
    stop()
    expect(m.calls.every((k) => k === 'Fwd')).toBe(true)
    expect(m.calls.length).toBeGreaterThan(0)
  })

  it('validates seconds: bare = 240, 0 = off, <60 and non-numbers rejected', () => {
    expect(KA.parseKeepaliveSec('')).toEqual({ sec: 240 })
    expect(KA.parseKeepaliveSec(undefined)).toEqual({ sec: 240 })
    expect(KA.parseKeepaliveSec('0')).toEqual({ sec: 0 })
    expect(KA.parseKeepaliveSec('60')).toEqual({ sec: 60 })
    expect(KA.parseKeepaliveSec('59').error).toMatch(/minimum/)
    expect(KA.parseKeepaliveSec('abc').error).toMatch(/number/)
    expect(() => KA.start('h', 'Fwd', 30, { createDevice: mkDev().createDevice })).toThrow(/minimum/)
  })
})

describe('device with --keepalive wiring', () => {
  let dir, saved
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ka-'))
    saved = process.env.BRIGHTTEST_LEASE_DIR
    process.env.BRIGHTTEST_LEASE_DIR = dir
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (saved === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const base = { deviceAction: 'with', host: '127.0.0.1', noHygiene: true, wait: '0', cmd: [process.execPath, '-e', 'process.exit(3)'], unknown: [] }

  it('rejects a bad interval before running anything', async () => {
    const start = vi.fn()
    expect(await deviceCommand.run({ ...base, keepalive: '30' }, {}, { keepalive: { start } })).toBe(2)
    expect(start).not.toHaveBeenCalled()
  })

  it('does not start without the flag, and with 0', async () => {
    const start = vi.fn(() => () => {})
    expect(await deviceCommand.run({ ...base, keepalive: null }, {}, { keepalive: { start } })).toBe(3)
    expect(await deviceCommand.run({ ...base, keepalive: '0' }, {}, { keepalive: { start } })).toBe(3)
    expect(start).not.toHaveBeenCalled()
  })

  it('starts with Fwd/240 and stops on wrapped-command exit, and removes signal listeners', async () => {
    const stop = vi.fn(); const start = vi.fn(() => stop)
    const before = process.listenerCount('SIGINT')
    expect(await deviceCommand.run({ ...base, keepalive: '' }, {}, { keepalive: { ...KA, start } })).toBe(3)
    expect(start.mock.calls[0].slice(0, 3)).toEqual(['127.0.0.1', 'Fwd', 240])
    expect(stop).toHaveBeenCalled()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('SIGINT stops the keep-alive', async () => {
    const stop = vi.fn(); const start = vi.fn(() => stop)
    const p = deviceCommand.run({ ...base, keepalive: '60', cmd: [process.execPath, '-e', 'setTimeout(()=>{},400)'] }, {}, { keepalive: { ...KA, start } })
    await new Promise((r) => setTimeout(r, 150))
    process.emit('SIGINT')
    expect(stop).toHaveBeenCalled()
    await p
  })
})

describe('parseDeviceArgs --keepalive', () => {
  it('parses bare, =sec and separate value, and defaults to null', async () => {
    const { parseDeviceArgs } = (await import('../bin/cli.js')).default || (await import('../bin/cli.js'))
    expect(parseDeviceArgs(['with', '--', 'x']).keepalive).toBeNull()
    expect(parseDeviceArgs(['with', '--keepalive', '--', 'x']).keepalive).toBe('')
    expect(parseDeviceArgs(['with', '--keepalive=90', '--', 'x']).keepalive).toBe('90')
    const r = parseDeviceArgs(['with', '--keepalive', '120', '--', 'x'])
    expect(r.keepalive).toBe('120'); expect(r.cmd).toEqual(['x'])
  })
})
