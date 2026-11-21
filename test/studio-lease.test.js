import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const lease = require('../lib/device-lease.js')
const { StudioLease } = require('../lib/studio/lease.js')
const studio = require('../lib/studio/server.js')
const { PerfettoCapture } = require('../lib/studio/perfetto.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// Studio and the device lease, with a fake clock and a temp lease dir. Other holders are simulated with
// leases taken in-process under a different (live) PID.
let dir, clock, logs
const cfg = { deviceLease: { studioIdle: '10s', studioYield: '5s', wait: '30s' } }
const seams = () => ({ dir, now: () => clock.t, sleep: async (ms) => { clock.t += ms; await new Promise((r) => setImmediate(r)) }, timers: false, identity: {} })
const other = (extra = {}) => lease.acquire({ ...seams(), key: '127.0.0.1', agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, ...extra })
const env = () => ({ BRIGHTTEST_LEASE_DIR: dir })
const mk = () => new StudioLease({ host: '127.0.0.1', cfg, env: env(), now: () => clock.t, log: (s) => logs.push(s), acquireOpts: seams() })

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-lease-')); clock = { t: Date.now() }; logs = [] })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('StudioLease', () => {
  it('first poll acquires; idle release after studioIdle; then polls are refused until a user action', async () => {
    const s = mk()
    expect(await s.ensure()).toBe(true)
    expect(s.holding).toBe(true)
    clock.t += 9000; s.tick()
    expect(s.holding).toBe(true)
    expect(await s.ensure()).toBe(true) // a poll does not mark activity…
    clock.t += 1500; s.tick()
    expect(s.holding).toBe(false) // …so idle is measured from the last user action / acquire
    expect(logs.join('\n')).toMatch(/studio holds 127\.0\.0\.1[\s\S]*studio released 127\.0\.0\.1 \(idle/)
    expect(await s.ensure()).toBe(false)
    expect(await s.ensure({ user: true })).toBe(true)
  })

  it('refuses (no queue, no preemption) while someone else holds; acquires once free', async () => {
    const o = await other()
    const s = mk()
    expect(await s.ensure({ user: true })).toBe(false)
    const info = await s.info()
    expect(info).toMatchObject({ holding: false, holder: { agent: 'device-qa#1', purpose: 'e2e run', mine: false } })
    expect(StudioLease.describe(info)).toMatch(/^Device in use by device-qa#1 — "e2e run"/)
    o.release()
    expect(await s.ensure()).toBe(true)
  })

  it('yields to a queued waiter after studioYield without activity, never under a running operation', async () => {
    const s = mk()
    await s.ensure({ user: true })
    const waiter = other({ waitMs: 60000, agent: 'dev#2' })
    // wait until the waiter's ticket is visible in the lease queue (bounded poll, not a fixed sleep)
    const queueDir = path.join(dir, '127.0.0.1', 'queue')
    const queued = () => { try { return fs.readdirSync(queueDir).filter((n) => n.endsWith('.json')).length } catch { return 0 } }
    for (let i = 0; i < 200 && queued() < 1; i++) await new Promise((r) => setTimeout(r, 25))
    expect(queued()).toBe(1)
    let release
    const op = s.during(() => new Promise((r) => { release = r }))
    clock.t += 6000; s.tick()
    expect(s.holding).toBe(true) // busy: a flow is running
    release(); await op
    clock.t += 3000; s.tick()
    expect(s.holding).toBe(true) // 3 s since the operation ended
    clock.t += 2500; s.tick()
    expect(s.holding).toBe(false)
    expect(logs.at(-1)).toMatch(/yielded to dev#2/)
    const w = await waiter
    expect(w.key).toBe('127.0.0.1')
    expect(await s.ensure()).toBe(false) // yielded: polls stay paused
    w.release()
  })

  it('take over when free: queues like anyone else and acquires after the holder', async () => {
    const o = await other()
    const s = mk()
    s.takeOver()
    expect((await s.info()).queued).toBe(true)
    expect(await s.ensure({ user: true })).toBe(false) // still queued, not preempting
    o.release()
    await s.pending
    expect(s.holding).toBe(true)
    expect(logs.join('\n')).toMatch(/take over/)
  })

  it('a running profiling session is not activity: Studio still goes idle and reports why', async () => {
    const released = []
    const s = mk()
    s.onRelease = (why) => released.push(why)
    await s.ensure({ user: true })
    clock.t += 11000; s.tick()
    expect(s.holding).toBe(false)
    expect(released[0]).toMatch(/idle/)
  })

  it('releasing aborts the operations in flight', async () => {
    const s = mk()
    await s.ensure({ user: true })
    let sig
    const op = s.during((signal) => { sig = signal; return new Promise((r) => signal.addEventListener('abort', () => r('aborted'))) })
    expect(sig.aborted).toBe(false)
    s.release('released from the UI')
    expect(await op).toBe('aborted')
    expect(String(sig.reason)).toMatch(/released from the UI/)
    expect(s.busy).toBe(0)
  })

  it('a lost lease (forced away) aborts the operations in flight', async () => {
    const s = mk()
    await s.ensure({ user: true })
    let sig
    const op = s.during((signal) => { sig = signal; return new Promise((r) => signal.addEventListener('abort', () => r('aborted'))) })
    lease.forceRelease({ ...seams(), key: s.lease.key, reason: 'test' })
    s.lease.heartbeat()
    expect(await op).toBe('aborted')
    expect(String(sig.reason)).toMatch(/lease lost/)
    expect(s.holding).toBe(false)
  })
})

describe('Studio server and the lease', () => {
  let fake, server, port, prevPort
  function req(method, p, body) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
      })
      r.on('error', reject)
      if (body) r.write(JSON.stringify(body))
      r.end()
    })
  }
  beforeEach(async () => {
    fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
    const a = await fake.start()
    prevPort = process.env.ROKU_ECP_PORT
    process.env.ROKU_ECP_PORT = String(a.ecpPort)
    process.env.BRIGHTTEST_LEASE_DIR = dir
    process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
    server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg, leaseOpts: { acquireOpts: seams(), now: () => clock.t, log: (s) => logs.push(s), tickMs: 20 } })
    port = server.address().port
  })
  afterEach(async () => {
    server.close(); await fake.stop()
    if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
    delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  })
  const key = () => `127.0.0.1_p${process.env.ROKU_ECP_PORT}`
  // bounded poll (<= 5 s); throws a clear message on timeout
  const until = async (fn, what = 'condition') => { for (let i = 0; i < 250 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20)); if (!(await fn())) throw new Error(`timed out waiting for ${what}`) }

  it('423 with the holder while someone else holds; 200 after; idle release', async () => {
    const o = await other({ key: key() })
    const r = await req('GET', '/api/tree')
    expect(r.status).toBe(423)
    expect(r.json).toMatchObject({ code: 'LOCKED', lease: { holding: false, holder: { agent: 'device-qa#1', purpose: 'e2e run' } } })
    expect((await req('POST', '/api/keypress', { key: 'Down' })).status).toBe(423)
    expect((await req('GET', '/api/device')).status).toBe(200) // harmless read needs no lease
    const l = await req('GET', '/api/lease')
    expect(l.json.holder.agent).toBe('device-qa#1')
    o.release()
    expect((await req('GET', '/api/tree')).status).toBe(200)
    expect((await req('GET', '/api/lease')).json.holding).toBe(true)
    clock.t += 11000
    await until(() => lease.status({ dir, key: key() })[0].holder === null, 'the idle release')
    expect(lease.status({ dir, key: key() })[0].holder).toBeNull()
    expect(logs.join('\n')).toMatch(/studio holds .*\n.*studio released .*idle/)
  })

  it('POST /api/lease acquire queues behind a holder (no preemption), release frees the device', async () => {
    const o = await other({ key: key() })
    const q = await req('POST', '/api/lease', { action: 'acquire' })
    expect(q.json).toMatchObject({ holding: false, queued: true })
    expect(lease.status({ dir, key: key() })[0].holder.holder.agent).toBe('device-qa#1')
    o.release()
    await until(async () => (await req('GET', '/api/lease')).json.holding === true, 'Studio to take the lease after the holder released')
    expect((await req('GET', '/api/lease')).json.holding).toBe(true)
    await req('POST', '/api/lease', { action: 'release' })
    expect(lease.status({ dir, key: key() })[0].holder).toBeNull()
    expect((await req('GET', '/api/tree')).status).toBe(423) // released from the UI: polls pause
    expect((await req('POST', '/api/lease', { action: 'nope' })).status).toBe(400)
  })

  function sse(p) {
    const events = []
    let end
    const done = new Promise((r) => { end = r })
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, (res) => {
      let buf = ''
      res.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) { const m = /^data: (.*)$/m.exec(buf.slice(0, i)); buf = buf.slice(i + 2); if (m) events.push(JSON.parse(m[1])) }
      })
      res.on('end', end)
    })
    r.on('error', end)
    r.end()
    return { events, done }
  }

  it('a flow running through /api/run is aborted when the lease is released', async () => {
    fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'flows', 'slow.e2e.yaml'), 'appId: dev\nsteps:\n  - wait: 5000\n  - home\n')
    const run = sse('/api/run?file=slow.e2e.yaml')
    await until(() => run.events.some((e) => e.type === 'step' && e.status === 'running'))
    const t0 = Date.now()
    await req('POST', '/api/lease', { action: 'release' })
    await run.done
    expect(Date.now() - t0).toBeLessThan(2000) // did not wait out the 5 s step
    const types = run.events.map((e) => e.type)
    expect(types).toContain('aborted')
    expect(run.events.at(-1)).toMatchObject({ type: 'done', ok: false, aborted: true })
    expect(run.events.find((e) => e.type === 'aborted').reason).toMatch(/released the device/)
    expect(run.events.filter((e) => e.type === 'step' && e.status !== 'running')).toEqual([]) // no step 2
  })

  for (const [name, body] of [
    ['pressUntil', '  - pressUntil: { key: Down, visible: { id: neverThere }, max: 200 }\n'],
    ['a runFlow sub-flow', '  - runFlow: { file: sub.e2e.yaml }\n'],
    ['a counted press', '  - press: { key: Down, count: 200 }\n'],
  ]) {
    it(`${name} stops touching the device once the lease is released`, async () => {
      fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'flows', 'sub.e2e.yaml'), 'appId: dev\nsteps:\n  - pressUntil: { key: Down, visible: { id: neverThere }, max: 200 }\n')
      fs.writeFileSync(path.join(dir, 'flows', 'loop.e2e.yaml'), `appId: dev\nsteps:\n${body}`)
      const run = sse('/api/run?file=loop.e2e.yaml')
      await until(() => fake.keypresses.length >= 2)
      await req('POST', '/api/lease', { action: 'release' })
      await run.done
      // stays: no observable signal for "an in-flight request already sent has landed"; this is a settle window
      await new Promise((r) => setTimeout(r, 100))
      const n = fake.keypresses.length
      expect(n).toBeLessThan(200)
      await new Promise((r) => setTimeout(r, 700)) // stays: proves a negative (no further presses), nothing to poll for
      expect(fake.keypresses.length).toBe(n) // nothing after the abort
      expect(run.events.at(-1)).toMatchObject({ type: 'done', aborted: true })
    })
  }

  it('a Perfetto capture is stopped, with an events.log note, when Studio releases the device', async () => {
    const stop = vi.spyOn(PerfettoCapture.prototype, 'stop').mockResolvedValue({ file: null, bytes: 0 })
    vi.spyOn(PerfettoCapture.prototype, 'tracing', 'get').mockReturnValue(true)
    try {
      expect((await req('GET', '/api/tree')).status).toBe(200) // Studio holds the lease
      await req('GET', '/api/perf/perfetto/status') // creates the capture object
      expect(stop).not.toHaveBeenCalled()
      await req('POST', '/api/lease', { action: 'release' })
      expect(stop).toHaveBeenCalledTimes(1)
      expect(logs.join('\n')).toMatch(/stopped the Perfetto capture/)
      const ev = lease.readEvents({ dir, key: key() })
      expect(ev.some((e) => e.ev === 'note' && /perfetto capture stopped: Studio released the device/.test(e.note))).toBe(true)
    } finally { vi.restoreAllMocks() }
  })

  it('events.log records why Studio released (reason) and a profiling stop note', async () => {
    await req('GET', '/api/tree')
    expect((await req('POST', '/api/perf/start', { intervalMs: 500 })).status).toBe(200)
    await req('POST', '/api/lease', { action: 'release' })
    const ev = lease.readEvents({ dir, key: key() })
    const rel = ev.find((e) => e.ev === 'released')
    expect(rel.reason).toMatch(/released/)
    expect(rel.reason).not.toBe(undefined)
    expect(ev.some((e) => e.ev === 'note' && /profiling stopped: Studio released the device/.test(e.note))).toBe(true)
  })

  it('an idle release records the idle reason in events.log', async () => {
    await req('GET', '/api/tree')
    clock.t += 11000
    await until(() => lease.readEvents({ dir, key: key() }).some((e) => e.ev === 'released'), 'the idle released event')
    const rel = lease.readEvents({ dir, key: key() }).find((e) => e.ev === 'released')
    expect(rel.reason).toMatch(/^idle /)
  })

  it('profiling stops cleanly, with a reason, when Studio releases the device', async () => {
    expect((await req('POST', '/api/perf/start', { intervalMs: 500 })).status).toBe(200)
    expect((await req('GET', '/api/perf/session')).json.running).toBe(true)
    await req('POST', '/api/lease', { action: 'release' })
    const s = (await req('GET', '/api/perf/session')).json
    expect(s.running).toBe(false)
    expect(s.markers.map((m) => m.label).join('|')).toMatch(/profiling stopped: Studio released the device/)
    expect(logs.join('\n')).toMatch(/stopped the profiling session/)
  })
})
