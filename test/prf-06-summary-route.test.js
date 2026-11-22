import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-prf06-cache-')), 'devices.json')
const studio = require('../lib/studio/server.js')
const { summarizeIsolated, createPool, DEFAULTS } = require('../lib/studio/perfetto-summary-run.js')
const { makeTrace, SYNTH_A } = require('./fixtures/perfetto/make-trace.js')
const fx = (n) => path.join(__dirname, 'fixtures/perfetto', n)

describe('PRF-06 isolated summarizer', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-prf06-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('returns the summary from a worker thread', async () => {
    const f = path.join(dir, 'a.perfetto-trace'); fs.writeFileSync(f, makeTrace(SYNTH_A))
    const r = await summarizeIsolated(f)
    expect(r.ok).toBe(true)
    expect(r.summary).toBeTruthy()
  })
  it('passes typed summarizer errors through', async () => {
    const f = path.join(dir, 'e.perfetto-trace'); fs.writeFileSync(f, Buffer.alloc(0))
    expect((await summarizeIsolated(f)).error.code).toBe('E_TRACE_EMPTY')
    expect((await summarizeIsolated(path.join(dir, 'nope.perfetto-trace'))).error.code).toBe('E_TRACE_READ')
  })
  it('applies the inflated-bytes bound', async () => {
    const f = path.join(dir, 'z.perfetto-trace')
    // one compressed_packets block (TracePacket field 50) inflating to 2 MiB of zeros
    const z = zlib.deflateSync(Buffer.alloc(2 * 1024 * 1024))
    const { ld } = require('./fixtures/perfetto/make-trace.js')
    fs.writeFileSync(f, ld(1, ld(50, z)))
    const r = await summarizeIsolated(f, { maxInflatedBytes: 1024 * 1024 })
    expect(r.error.code).toBe('E_TRACE_TOO_LARGE')
  })
  it('times out a stuck worker with E_TRACE_TIMEOUT', async () => {
    const t0 = Date.now()
    const r = await summarizeIsolated('x', { workerPath: fx('busy-worker.js'), timeoutMs: 300 })
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('E_TRACE_TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  it('reports heap exhaustion as E_TRACE_WORKER without killing the host', async () => {
    const r = await summarizeIsolated('x', { workerPath: fx('oom-worker.js'), maxHeapMb: 32, timeoutMs: 20000 })
    expect(r.error.code).toBe('E_TRACE_WORKER')
  }, 30000)
})

describe('PRF-06 pool and error hygiene', () => {
  it('rejects beyond the cap with E_TRACE_BUSY and frees slots afterwards', async () => {
    const pool = createPool(2)
    const o = { workerPath: fx('busy-worker.js'), timeoutMs: 400, pool }
    const runs = [summarizeIsolated('x', o), summarizeIsolated('x', o)]
    const third = await summarizeIsolated('x', o)
    expect(third.error.code).toBe('E_TRACE_BUSY')
    expect((await Promise.all(runs)).map((r) => r.error.code)).toEqual(['E_TRACE_TIMEOUT', 'E_TRACE_TIMEOUT'])
    expect(pool.inflight.size).toBe(0)
  })
  it('terminates the worker when the signal aborts', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = summarizeIsolated('x', { workerPath: fx('busy-worker.js'), timeoutMs: 10000, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    expect((await p).error.code).toBe('E_TRACE_ABORTED')
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  it('terminateAll ends every in-flight worker', async () => {
    const pool = createPool(2)
    const ps = [1, 2].map(() => summarizeIsolated('x', { workerPath: fx('busy-worker.js'), timeoutMs: 10000, pool }))
    await new Promise((r) => setTimeout(r, 100))
    pool.terminateAll()
    expect((await Promise.all(ps)).every((r) => r.error.code === 'E_TRACE_ABORTED')).toBe(true)
  })
  it('does not echo error text or paths from a crashing worker', async () => {
    const r = await summarizeIsolated('x', { workerPath: fx('throw-worker.js') })
    expect(r.error.code).toBe('E_TRACE_WORKER')
    expect(r.error.message).toBe('summarizer crashed')
    const m = await summarizeIsolated('x', { workerPath: path.join(os.tmpdir(), 'no-such-worker-dir', 'w.js') })
    expect(m.error.message).not.toContain(os.tmpdir())
  })
  it('defaults to a 32 MiB inflated bound', () => {
    expect(DEFAULTS.maxInflatedBytes).toBe(32 * 1024 * 1024)
  })
})

describe('PRF-06 Studio route', () => {
  let server, port, root, prof
  const get = (q) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/perf/perfetto-summary${q}` }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }))
    }).on('error', reject)
  })
  const boot = async (perfettoSummaryOpts) => {
    server = await studio.start({
      host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: root, perfettoSummaryOpts,
      leaseOpts: { acquireOpts: { dir: path.join(root, 'lease'), timers: false, identity: {}, foregroundCheck: false } },
    })
    port = server.address().port
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-prf06-root-'))
    prof = path.join(root, '.brighttest', 'studio', 'profiling'); fs.mkdirSync(prof, { recursive: true })
    fs.writeFileSync(path.join(prof, 'trace-1.perfetto-trace'), makeTrace(SYNTH_A))
    fs.writeFileSync(path.join(root, 'secret.perfetto-trace'), makeTrace(SYNTH_A))
  })
  afterEach(async () => { if (server) await new Promise((r) => server.close(r)); server = null; fs.rmSync(root, { recursive: true, force: true }) })

  it('summarizes a saved trace with no device connected', async () => {
    await boot()
    const r = await get('?file=trace-1.perfetto-trace')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
  })
  it('rejects traversal, wrong extension and missing name', async () => {
    await boot()
    for (const q of ['?file=../../../../secret.perfetto-trace', `?file=${encodeURIComponent(path.join(root, 'secret.perfetto-trace'))}`, '?file=a.txt', '']) {
      const r = await get(q)
      expect(r.status).toBe(400)
      expect(r.json.error.code).toBe('E_BAD_FILE')
    }
  })
  it('404 for a missing trace, 422 for a malformed one', async () => {
    await boot()
    expect((await get('?file=none.perfetto-trace')).status).toBe(404)
    fs.writeFileSync(path.join(prof, 'bad.perfetto-trace'), Buffer.from([0x0a, 0xff]))
    const r = await get('?file=bad.perfetto-trace')
    expect(r.status).toBe(422)
    expect(r.json.error.code).toMatch(/^E_TRACE_/)
  })
  it('504 with E_TRACE_TIMEOUT when the worker overruns', async () => {
    await boot({ workerPath: fx('busy-worker.js'), timeoutMs: 300 })
    const r = await get('?file=trace-1.perfetto-trace')
    expect(r.status).toBe(504)
    expect(r.json.error.code).toBe('E_TRACE_TIMEOUT')
    // the server stays responsive afterwards
    expect((await get('?file=a.txt')).status).toBe(400)
  })
  it('applies the 32 MiB inflated bound at the route', async () => {
    await boot({ workerPath: fx('echo-worker.js') })
    const r = await get('?file=trace-1.perfetto-trace')
    expect(r.json.summary.opts.limits.maxInflatedBytes).toBe(32 * 1024 * 1024)
  })
  it('rejects a NUL in the file name with 400 E_BAD_FILE', async () => {
    await boot()
    const r = await get('?file=a%00.perfetto-trace')
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('E_BAD_FILE')
  })
  it('rejects a symlink that escapes the profiling dir without leaking paths', async () => {
    try { fs.symlinkSync(path.join(root, 'secret.perfetto-trace'), path.join(prof, 'link.perfetto-trace')) }
    catch (e) { if (process.platform === 'win32') return; throw e }
    await boot()
    const r = await get('?file=link.perfetto-trace')
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('E_BAD_FILE')
    expect(JSON.stringify(r.json)).not.toContain(root)
  })
  it('still follows a symlink that stays inside the profiling dir', async () => {
    try { fs.symlinkSync(path.join(prof, 'trace-1.perfetto-trace'), path.join(prof, 'inner.perfetto-trace')) }
    catch (e) { if (process.platform === 'win32') return; throw e }
    await boot()
    expect((await get('?file=inner.perfetto-trace')).status).toBe(200)
  })
  it('caps concurrent summaries at 2 and answers 503 E_TRACE_BUSY beyond', async () => {
    await boot({ workerPath: fx('busy-worker.js'), timeoutMs: 1500 })
    const rs = await Promise.all([1, 2, 3, 4].map(() => get('?file=trace-1.perfetto-trace')))
    const by = (c) => rs.filter((r) => r.json.error.code === c)
    expect(by('E_TRACE_BUSY').length).toBe(2)
    expect(by('E_TRACE_BUSY').every((r) => r.status === 503)).toBe(true)
    expect(by('E_TRACE_TIMEOUT').length).toBe(2)
  }, 15000)
  it('terminates workers when the client disconnects early', async () => {
    await boot({ workerPath: fx('busy-worker.js'), timeoutMs: 10000 })
    const abort = () => new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/perf/perfetto-summary?file=trace-1.perfetto-trace' })
      req.on('error', () => {})
      setTimeout(() => { req.destroy(); resolve() }, 150)
    })
    // Without the fix both aborted workers keep their slots for 10 s and a third request gets an instant 503.
    await abort(); await abort()
    await new Promise((r) => setTimeout(r, 300))
    const status = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/perf/perfetto-summary?file=trace-1.perfetto-trace' }, (res) => { resolve(res.statusCode); res.resume() })
      req.on('error', () => {})
      setTimeout(() => { req.destroy(); resolve('admitted') }, 800)
    })
    expect(status).toBe('admitted')
  }, 8000)
  it('terminates in-flight workers when the server closes', async () => {
    await boot({ workerPath: fx('busy-worker.js'), timeoutMs: 20000 })
    const pending = get('?file=trace-1.perfetto-trace').catch(() => 'closed')
    await new Promise((r) => setTimeout(r, 200))
    const t0 = Date.now()
    const closed = new Promise((r) => server.close(r)); server = null
    // the in-flight request is answered promptly (worker killed) instead of after the 20 s timeout
    const got = await pending
    expect(got === 'closed' || got.json.error.code === 'E_TRACE_ABORTED').toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
    await closed
  }, 10000)
})
