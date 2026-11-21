import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const studio = require('../lib/studio/server.js')
const { defaultQueue } = require('../lib/e2e/ecpq.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// ROB-01b / TP-ROB-05 (headless part): Studio pollers, console, perfetto, bsprof and flows share one per-host
// device queue. Concurrent requests must never overlap device calls and per-endpoint gaps must hold.
describe('Studio shares the device queue (ROB-01b)', () => {
  let dir, fake, server, port, ecpPort, jobs, realRun, saved
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    r.on('error', reject)
    if (body) r.write(JSON.stringify(body))
    r.end()
  })

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-queue-'))
    saved = { port: process.env.ROKU_ECP_PORT, lease: process.env.BRIGHTTEST_LEASE_DIR, cache: process.env.BRIGHTTEST_CACHE }
    fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
    ecpPort = (await fake.start()).ecpPort
    process.env.ROKU_ECP_PORT = String(ecpPort)
    process.env.BRIGHTTEST_LEASE_DIR = path.join(dir, 'lease')
    process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
    // Record every job that goes through the shared queue (start/end), without changing behaviour.
    jobs = []
    realRun = defaultQueue.run
    defaultQueue.run = (host, kind, fn, o) => realRun.call(defaultQueue, host, kind, async () => {
      const j = { host, kind, start: Date.now() }
      try { return await fn() } finally { j.end = Date.now(); jobs.push(j) }
    }, o)
    server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, leaseOpts: { acquireOpts: { dir: path.join(dir, 'lease'), timers: false, identity: {} } } })
    port = server.address().port
  })
  afterEach(async () => {
    defaultQueue.run = realRun
    server.close(); await fake.stop()
    for (const [k, v] of [['ROKU_ECP_PORT', saved.port], ['BRIGHTTEST_LEASE_DIR', saved.lease], ['BRIGHTTEST_CACHE', saved.cache]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('concurrent tree, screenshot, device, perf, console, keypress and perfetto calls never overlap on the device', async () => {
    const reqs = []
    for (let i = 0; i < 3; i++) reqs.push(call('GET', '/api/tree'), call('GET', '/api/device'), call('GET', '/api/screenshot'))
    reqs.push(call('POST', '/api/perf/start', { intervalMs: 100 }))
    reqs.push(call('POST', '/api/perf/console', { command: 'chanperf' }))
    reqs.push(call('GET', '/api/perf/textures'))
    reqs.push(call('POST', '/api/keypress', { key: 'Down', count: 2 }))
    reqs.push(call('POST', '/api/perf/perfetto/enable', {}))
    reqs.push(call('GET', '/api/perf/bsprof-pull'))
    // Second wave after the first settles, so uncoalesced tree reads (sgnodes) hit the 200 ms spacing.
    const wave = async () => { for (let i = 0; i < 3; i++) { await call('GET', '/api/tree'); await new Promise((r) => setTimeout(r, 30)) } }
    reqs.push(wave())
    await Promise.race([
      Promise.allSettled(reqs),
      new Promise((_, rej) => setTimeout(() => rej(new Error('requests did not settle in 60 s')), 60000)),
    ])
    await new Promise((r) => setTimeout(r, 400)) // let the perf sampler issue a few queued reads
    await call('POST', '/api/perf/stop', {})

    // 1) every queued job on this host: strictly sequential, in one lane.
    const mine = jobs.filter((j) => j.host === `127.0.0.1:${ecpPort}` || j.host === '127.0.0.1').sort((a, b) => a.start - b.start)
    expect(mine.length).toBeGreaterThan(10)
    expect(new Set(mine.map((j) => j.host)).size).toBe(1)
    for (let i = 1; i < mine.length; i++) expect(mine[i].start).toBeGreaterThanOrEqual(mine[i - 1].end)
    const kinds = new Set(mine.map((j) => j.kind))
    expect(kinds.has('sgnodes') && kinds.has('screenshot') && kinds.has('other')).toBe(true)

    // 2) the fake device saw the same thing: no request began while another was in flight.
    const ecp = fake.log.filter((e) => e.service === 'ecp' && e.endpoint)
    expect(ecp.length).toBeGreaterThan(5)
    expect(ecp.every((e) => e.inFlight === 1)).toBe(true)
    expect(ecp.some((e) => e.endpoint.startsWith('/perfetto/'))).toBe(true) // perfetto reached the device via the queue

    // 3) per-endpoint gaps hold: sgnodes starts >= 200 ms after the previous successful sgnodes ended.
    for (const kind of ['sgnodes', 'screenshot']) {
      const gap = defaultQueue.gaps[kind]
      const ok = mine.filter((j) => j.kind === kind)
      const sg = ecp.filter((e) => (kind === 'sgnodes' ? /^\/query\/(sgnodes|app-ui)/.test(e.endpoint) : false))
      if (kind === 'sgnodes') {
        expect(sg.length).toBeGreaterThan(1)
        for (let i = 1; i < sg.length; i++) expect(sg[i].startMs - sg[i - 1].endMs).toBeGreaterThanOrEqual(gap - 15)
      }
      expect(ok.length).toBeGreaterThan(0)
    }
  }, 90000)

  it('perfetto enable/heap-snapshot and bsprof-pull go through the shared queue lane of the ECP host', async () => {
    const { PerfettoCapture } = require('../lib/studio/perfetto.js')
    const pf = new PerfettoCapture({ host: '127.0.0.1', channelId: 'dev', dir })
    await pf.enable().catch(() => {}) // the fake has no /perfetto endpoints: a 404 is fine, the queueing is the point
    Object.defineProperty(pf, 'tracing', { get: () => true })
    await pf.heapSnapshot().catch(() => {})
    await call('GET', '/api/perf/bsprof-pull')
    const lane = `127.0.0.1:${ecpPort}`
    const urls = jobs.filter((j) => j.host === lane)
    expect(urls.length).toBeGreaterThanOrEqual(3) // enable, heap trigger, bsprof pull (refused, so retried once): all on the same lane as device-info/sgnodes
    expect(ecpPort).not.toBe(8060)
  })
})
