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
let realWait = false // true: a queued acquire waits in real time (its sleep does not advance the fake clock)
const cfg = { deviceLease: { studioIdle: '10s', studioYield: '5s', wait: '30s' } }
const seams = () => ({ dir, now: () => clock.t, sleep: async (ms) => { if (realWait) { await new Promise((r) => setTimeout(r, Math.min(ms, 20))); return } clock.t += ms; await new Promise((r) => setImmediate(r)) }, timers: false, identity: {} })
const other = (extra = {}) => lease.acquire({ ...seams(), key: '127.0.0.1', agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, ...extra })
const env = () => ({ BRIGHTTEST_LEASE_DIR: dir })
const made = [] // every StudioLease a test creates, stopped before the temp dir is removed
const track = (s) => { made.push(s); return s }
const mk = () => track(new StudioLease({ host: '127.0.0.1', cfg, env: env(), now: () => clock.t, log: (s) => logs.push(s), acquireOpts: seams() }))

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-lease-')); clock = { t: Date.now() }; logs = []; realWait = false; made.length = 0 })
afterEach(async () => {
  for (const s of made.splice(0)) { try { s.cancel() } catch {} try { s.release('test cleanup') } catch {} }
  await new Promise((r) => setTimeout(r, 50)) // let in-flight lease writes land before the dir goes
  fs.rmSync(dir, { recursive: true, force: true })
})

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

  it('single host: while Studio holds the device with no queue the text says Studio holds it', async () => {
    const s = mk()
    expect(await s.ensure({ user: true })).toBe(true)
    const info = await s.info()
    expect(info).toMatchObject({ holding: true, holder: { mine: true } })
    expect(info.queue).toEqual([])
    expect(StudioLease.describe(info)).toBe('Studio holds 127.0.0.1')
    s.release()
  })

  it('the lease record is marked interactive with timings, activity and busy', async () => {
    const s = mk()
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, '127.0.0.1', 'holder.json'), 'utf8')).holder
    expect(await s.ensure({ user: true })).toBe(true)
    expect(read()).toMatchObject({ kind: 'interactive', yieldAfterMs: 5000, idleReleaseMs: 10000, busy: false })
    clock.t += 6000
    let release
    const run = s.during(() => new Promise((r) => { release = r }))
    expect(read().busy).toBe(true)
    expect(Date.parse(read().activityAt)).toBe(clock.t)
    clock.t += 6000
    release(); await run
    expect(s.lease.record.holder.busy).toBe(false)
    s.release()
  })

  it('--as sets the holder label', async () => {
    const s = track(new StudioLease({ host: '127.0.0.1', cfg, env: env(), now: () => clock.t, log: () => {}, acquireOpts: { ...seams(), agent: 'dev#7' } }))
    expect(await s.ensure({ user: true })).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, '127.0.0.1', 'holder.json'), 'utf8')).holder.agent).toBe('dev#7')
    s.release()
  })

  it('describe: a yield is not an idle release', () => {
    const base = { host: '127.0.0.1', holding: false, holder: null, queue: [], queued: false }
    for (const pool of [false, true]) {
      const t = StudioLease.describe({ ...base, pool, poolState: null, yielded: true })
      expect(t).toBe('Studio yielded the device (a run may be using it)')
      expect(t).not.toMatch(/released the device/)
    }
    expect(StudioLease.describe({ ...base, pool: false, yielded: false })).toBe('Studio released the device (idle)')
    expect(StudioLease.describe({ ...base, pool: true, poolState: null, yielded: false })).toBe('Studio released the device (idle)')
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
    await new Promise((r) => server.close(r)); await fake.stop()
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

  it('POST /api/lease acquire with wait answers 200 once the holder releases', async () => {
    realWait = true
    const o = await other({ key: key() })
    const t0 = Date.now()
    const pending = req('POST', '/api/lease', { action: 'acquire', wait: '20s' })
    await new Promise((r) => setTimeout(r, 100)) // stays: the request must be parked behind the holder before it is released
    o.release()
    const r = await pending
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ holding: true, holder: { mine: true } })
    expect(Date.now() - t0).toBeLessThan(10000)
  })

  it('POST /api/lease acquire with wait answers 423 with the holder when the wait ends first', async () => {
    realWait = true
    const o = await other({ key: key() })
    const r = await req('POST', '/api/lease', { action: 'acquire', wait: '300ms' })
    expect(r.status).toBe(423)
    expect(r.json).toMatchObject({ code: 'LOCKED', lease: { holding: false, holder: { agent: 'device-qa#1' } } })
    await until(() => lease.status({ dir, key: key() })[0].queue.length === 0, 'the give-up to leave the queue') // gave up: not left queued
    o.release()
  })

  it('POST /api/lease acquire rejects a bad or over-cap wait with 400', async () => {
    const bad = await req('POST', '/api/lease', { action: 'acquire', wait: 'soon' })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('BAD_WAIT')
    const over = await req('POST', '/api/lease', { action: 'acquire', wait: '31s' }) // cap is deviceLease.wait (30s)
    expect(over.status).toBe(400)
    expect(over.json.error).toMatch(/longer than the limit/)
  })

  it('a client that disconnects during the wait leaves no queued take-over', async () => {
    realWait = true
    const o = await other({ key: key() })
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/lease', headers: { 'Content-Type': 'application/json' } })
    r.on('error', () => {})
    r.end(JSON.stringify({ action: 'acquire', wait: '20s' }))
    await until(() => lease.status({ dir, key: key() })[0].queue.length === 1, 'Studio to queue')
    r.destroy()
    await until(() => lease.status({ dir, key: key() })[0].queue.length === 0, 'the queued take-over to be dropped')
    expect((await req('GET', '/api/lease')).json.queued).toBe(false)
    o.release()
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

  it('/api/run skips (no failed step, no key sent) when flow-level requires is unmet, and for a step-level one', async () => {
    fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'flows', 'req.e2e.yaml'), 'appId: dev\nrequires: { firmware: ">=99" }\nsteps:\n  - press: Right\n')
    const a = sse('/api/run?file=req.e2e.yaml')
    await a.done
    expect(a.events.find((e) => e.type === 'skipped').reason).toMatch(/requires firmware >=99, device has 16\.0\.4/)
    expect(a.events.at(-1)).toMatchObject({ type: 'done', ok: true })
    expect(a.events.some((e) => e.status === 'fail')).toBe(false)
    fs.writeFileSync(path.join(dir, 'flows', 'reqstep.e2e.yaml'), 'appId: dev\nsteps:\n  - requires: { deviceClass: tv }\n  - press: Right\n')
    const b = sse('/api/run?file=reqstep.e2e.yaml')
    await b.done
    expect(b.events.find((e) => e.status === 'skipped')).toMatchObject({ op: 'requires' })
    expect(b.events.at(-1)).toMatchObject({ type: 'done', ok: true })
    expect(fake.keypresses).toEqual([])
  })

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

// DEV2-02 follow-up: with deviceLease.pool and no --host, Studio binds exactly one free pool member.
describe('Studio server with a device pool', () => {
  let server, port, prevPort
  const POOL = ['127.0.0.1', '127.0.0.2']
  const poolCfg = { deviceLease: { ...cfg.deviceLease, pool: POOL } }
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
    prevPort = process.env.ROKU_ECP_PORT
    process.env.ROKU_ECP_PORT = '8060'
    process.env.BRIGHTTEST_LEASE_DIR = dir
    process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
    server = await studio.start({ password: 'rokudev-test', port: 0, rootDir: dir, cfg: poolCfg, leaseOpts: { acquireOpts: seams(), now: () => clock.t, log: (s) => logs.push(s), tickMs: 20 } })
    port = server.address().port
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
    if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
    delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  })
  const k = (h) => h // the default ECP port adds no suffix to the key
  const held = () => POOL.filter((h) => lease.status({ dir, key: k(h) })[0].holder)

  it('binds the first free member, /api/lease names exactly that one key, and holds only it', async () => {
    const o = await other({ key: k(POOL[0]) })
    const r = await req('POST', '/api/lease', { action: 'acquire' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ holding: true, host: POOL[1], key: k(POOL[1]), pool: true })
    expect(r.json.holder.mine).toBe(true)
    expect(held()).toEqual(POOL) // the other run holds member 0, Studio holds member 1: no gate or third key left behind
    expect(lease.status({ dir }).filter((s) => s.holder).map((s) => s.key).sort()).toEqual([k(POOL[0]), k(POOL[1])])
    o.release()
  })

  it('a queued take-over does not survive server close: freeing a member afterwards leaves no lease', async () => {
    const a = await other({ key: k(POOL[0]) })
    const b = await other({ key: k(POOL[1]) })
    const acq = { ...seams(), sleep: (ms) => new Promise((r) => setTimeout(r, 10)) }
    const srv = await studio.start({ password: 'rokudev-test', port: 0, rootDir: dir, cfg: poolCfg, leaseOpts: { acquireOpts: acq, now: () => clock.t, log: (s) => logs.push(s), tickMs: 20 } })
    const prev = port
    port = srv.address().port
    try {
      const r = await req('POST', '/api/lease', { action: 'acquire' })
      expect(r.json.queued).toBe(true)
    } finally { port = prev }
    await new Promise((r) => srv.close(r))
    a.release(); b.release()
    await new Promise((r) => setTimeout(r, 300)) // several 10 ms polls: a surviving waiter would have taken a member by now
    expect(lease.status({ dir }).filter((x) => x.holder)).toEqual([])
  })

  it('every member busy: BUSY is reported (Studio queues), no member is taken', async () => {
    const a = await other({ key: k(POOL[0]) })
    const b = await other({ key: k(POOL[1]) })
    const r = await req('POST', '/api/lease', { action: 'acquire' })
    expect(r.json.holding).toBe(false)
    expect(r.json.queued).toBe(true)
    a.release(); b.release()
  })
})

// LSE-T13 review fixes: pool yield, stale take-over, pool status text, member password.
describe('StudioLease pool mode and cancellation', () => {
  const POOL = ['127.0.0.1', '127.0.0.2']
  const mkPool = (acq = seams(), hosts = POOL) => track(new StudioLease({ cfg, env: env(), now: () => clock.t, log: (s) => logs.push(s), acquireOpts: acq, pool: hosts }))
  // The fake clock's sleep jumps time forward, so a waiter on it times out in ~40 ms of real time (CI is faster than a
  // laptop). Tests that need a waiter to stay queued use this: a frozen clock and a real 10 ms pause per poll.
  const patient = () => ({ ...seams(), sleep: (ms) => new Promise((r) => setTimeout(r, 10)) })
  // bounded poll (<= 5 s) on a condition; throws a clear message on timeout
  const waitFor = async (fn, what) => { for (let i = 0; i < 250 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20)); if (!(await fn())) throw new Error(`timed out waiting for ${what}`) }
  const gateKey = async () => lease.poolGateKey(await lease.poolKeys(POOL))

  it('yields within studioYield to a holder on the pool gate', async () => {
    const s = mkPool()
    expect(await s.ensure({ user: true })).toBe(true)
    expect(s.holding).toBe(true)
    const g = await other({ key: await gateKey(), purpose: 'pool pick (2 devices)' })
    clock.t += 6000; s.tick()
    expect(s.holding).toBe(false)
    expect(logs.join('\n')).toMatch(/studio released .*yielded to/)
    g.release()
  })

  it('does not yield to the pool gate when nobody waits', async () => {
    const s = mkPool()
    await s.ensure({ user: true })
    clock.t += 6000; s.tick()
    expect(s.holding).toBe(true)
  })

  it('a pending take-over does not survive setHost: a stale lease is released at once', async () => {
    const o = await other({ key: '127.0.0.1' })
    const s = mk()
    s.takeOver()
    const p = s.pending
    expect(p).toBeTruthy()
    s.setHost('127.0.0.9')
    expect(s.pending).toBeNull()
    o.release()
    await p
    expect(s.holding).toBe(false)
    expect(lease.status({ dir, key: '127.0.0.1' })[0].holder).toBeNull()
  })

  it('cancel() drops a pending take-over', async () => {
    const o = await other({ key: '127.0.0.1' })
    const s = mk()
    s.takeOver()
    const p = s.pending
    s.cancel()
    o.release()
    await p
    expect(s.holding).toBe(false)
    expect(lease.status({ dir, key: '127.0.0.1' })[0].holder).toBeNull()
  })

  it('pool info: all members busy says so; never "free" while Studio is queued on the gate', async () => {
    const a = await other({ key: '127.0.0.1', agent: 'a#1' })
    const b = await other({ key: '127.0.0.2', agent: 'b#1' })
    const s = mkPool(patient())
    let info = await s.info()
    expect(info.poolState).toMatchObject({ size: 2, busy: 2 })
    expect(StudioLease.describe(info)).toMatch(/all 2 .*busy/i)
    s.takeOver()
    await waitFor(async () => (await s.info()).queued, 'Studio to be queued')
    info = await s.info()
    expect(info.queued).toBe(true)
    expect(StudioLease.describe(info)).not.toMatch(/free/i)
    s.cancel(); a.release(); b.release()
  })

  it('pool info: while Studio holds a member the text says Studio holds it, not released', async () => {
    const s = mkPool()
    expect(await s.ensure({ user: true })).toBe(true)
    const info = await s.info()
    expect(info).toMatchObject({ holding: true, pool: true, holder: { mine: true } })
    const text = StudioLease.describe(info)
    expect(text).not.toMatch(/released the device/)
    expect(text).toBe(`Studio holds ${info.host}`)
    expect(info.text).toBe(text)
    s.release()
  })

  it('pool info: a free member with a waiter on the gate is not plain "free"', async () => {
    const g = await other({ key: await gateKey(), agent: 'g#1' })
    const w = lease.acquire({ ...patient(), key: await gateKey(), agent: 'w#1', purpose: 'pool pick', pid: process.ppid, waitMs: 60000, exitOnLost: false }).catch(() => {})
    await waitFor(async () => (await mkPool().info()).queue.length > 0, 'the gate waiter to queue')
    const info = await mkPool().info()
    expect(info.queue.length).toBeGreaterThan(0)
    expect(StudioLease.describe(info)).toMatch(/waiter/)
    g.release(); (await w) && (await w).release()
  })

  it('a pool member password resolves like the preflight (env only)', () => {
    const prev = process.env.ROKU_PASSWORD
    process.env.ROKU_PASSWORD = 'env-only-pw'
    process.env.BRIGHTTEST_CACHE = path.join(dir, 'none.json')
    try { expect(studio.memberPassword('127.0.0.1', {})).toBe('env-only-pw') }
    finally { if (prev === undefined) delete process.env.ROKU_PASSWORD; else process.env.ROKU_PASSWORD = prev; delete process.env.BRIGHTTEST_CACHE }
  })

  it('poolInfo derives the gate key from the same lookup seam acquirePool uses', async () => {
    const hosts = ['pool-a.test', 'pool-b.test']
    const lookup = async (h) => ({ address: h === 'pool-a.test' ? '10.9.0.1' : '10.9.0.2' })
    const s = mkPool({ ...seams(), lookup }, hosts)
    const ids = await s.poolInfo()
    expect(ids.keys).toEqual(['10.9.0.1', '10.9.0.2'])
    expect(ids.gateKey).toBe(lease.poolGateKey(await lease.poolKeys(hosts, { lookup })))
    // and a pick through acquirePool leases the member the lookup named
    expect(await s.ensure({ user: true })).toBe(true)
    expect(s.lease.key).toBe('10.9.0.1')
  })

  it('setHost(bound member) cancels a queued pool take-over and keeps a held lease', async () => {
    const s = mkPool()
    await s.ensure({ user: true })
    const bound = s.host
    s.release('test'); s.yielded = false
    const a = await other({ key: '127.0.0.1', agent: 'a#1' })
    const b = await other({ key: '127.0.0.2', agent: 'b#1' })
    s.host = bound
    s.takeOver()
    const p = s.pending
    expect(p).toBeTruthy()
    s.setHost(bound)
    expect(s.pool).toBeNull()
    expect(s.pending).toBeNull()
    a.release(); b.release()
    await p
    expect(s.holding).toBe(false)
    expect(lease.status({ dir }).filter((x) => x.holder)).toEqual([])
    // already holding the bound member: leaving pool mode keeps the lease
    const s2 = mkPool()
    await s2.ensure({ user: true })
    s2.setHost(s2.host)
    expect(s2.holding).toBe(true)
  })

  it('an acquire that resolves after cancel() is released with "cancelled" (fake lib)', async () => {
    let resolve
    const fakeLease = { key: '127.0.0.1', leaseId: 'x', release: vi.fn(), lost: false, expired: false }
    const lib = { ...lease, acquire: () => new Promise((r) => { resolve = r }) }
    const s = new StudioLease({ host: '127.0.0.1', cfg, env: env(), now: () => clock.t, log: (m) => logs.push(m), acquireOpts: seams(), lib })
    s.takeOver()
    const p = s.pending
    s.cancel()
    resolve(fakeLease)
    await p
    expect(fakeLease.release).toHaveBeenCalledWith('cancelled')
    expect(s.holding).toBe(false)
  })

  it('an unbound pool with nothing held reads "N of M free"', async () => {
    const info = await mkPool().info()
    expect(StudioLease.describe(info)).toBe('Device pool: 2 of 2 free')
  })

  it('setHost to the bound member leaves pool mode', async () => {
    const s = mkPool()
    await s.ensure({ user: true })
    s.setHost(s.host)
    expect(s.pool).toBeNull()
  })
})
