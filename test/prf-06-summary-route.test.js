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
const { summarizeIsolated } = require('../lib/studio/perfetto-summary-run.js')
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
})
