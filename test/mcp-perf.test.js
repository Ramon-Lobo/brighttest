import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { bootStub, startMcp, payload, cleanupMcp, tmpdir } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const leaseLib = require('../lib/device-lease.js')
const pt = require('../lib/mcp/perf-tools.js')
const { LIMITS } = require('../lib/mcp/tools.js')
const { makeTrace, SYNTH_A } = require('./fixtures/perfetto/make-trace.js')

afterEach(async () => { vi.useRealTimers(); await cleanupMcp() })

const isErr = (r) => r.result.isError === true
const FAST = { perfIntervalMs: 20, queueWaitMs: 5000 }
const holders = (dir) => fs.readdirSync(dir).filter((k) => fs.existsSync(path.join(dir, k, 'holder.json')))
const perfLog = (stub) => stub.log.filter((e) => /^\/query\//.test(e.endpoint || '')).map((e) => e.endpoint)
const tryLease = (a, dir) => leaseLib.acquire({ host: '127.0.0.1', port: a.ecpPort, waitMs: 0, mode: 'command', env: { ...process.env, BRIGHTTEST_LEASE_DIR: dir, BRIGHTTEST_LEASE: '' }, onWait: () => {}, purpose: 'test holder' })

async function ready(stubExtra = {}, mcpExtra = {}) {
  const { stub, a } = await bootStub('healthy', stubExtra)
  const c = startMcp({ a, limits: FAST, ...mcpExtra })
  await c.initialize()
  return { stub, a, c }
}

describe('deviceText', () => {
  it('removes controls and bidi characters, collapses whitespace and cuts with a marker', () => {
    expect(pt.deviceText('a\u0000b\u001bc‮d⁦e\u009ff')).toBe('abcdef')
    expect(pt.deviceText('  a \n\t b  ')).toBe('a b')
    const cut = pt.deviceText('x'.repeat(50), 10)
    expect(cut).toHaveLength(10)
    expect(cut.endsWith('…')).toBe(true)
    expect(pt.deviceText(null)).toBe('')
  })
})

describe('cleanUrlName', () => {
  it('drops userinfo, query and fragment of URLs and leaves other names alone', () => {
    expect(pt.cleanUrlName('https://user:pw@cdn.example/img/a.png?token=abc#frag')).toBe('https://cdn.example/img/a.png')
    expect(pt.cleanUrlName('pkg:/images/bg.png')).toBe('pkg:/images/bg.png')
    expect(pt.cleanUrlName('pkg:/images/bg.png?x=1')).toBe('pkg:/images/bg.png')
    expect(pt.cleanUrlName('plain name?x=1')).toBe('plain name?x=1')
    expect(pt.cleanUrlName('http://[bad')).toBe('http://[bad')
  })
})

describe('traceError mapping', () => {
  const m = (c) => pt.traceError({ code: c, message: 'm' }, 'f')
  it('maps every summarizer code and carries the cause', () => {
    const table = { E_TRACE_READ: 'TRACE_NOT_FOUND', E_TRACE_TOO_LARGE: 'TRACE_TOO_LARGE', E_TRACE_EMPTY: 'TRACE_INVALID', E_TRACE_TRUNCATED: 'TRACE_INVALID', E_TRACE_MALFORMED: 'TRACE_INVALID', E_TRACE_TOO_MANY_PACKETS: 'TRACE_INVALID', E_TRACE_TIMEOUT: 'TRACE_TIMEOUT', E_TRACE_BUSY: 'TRACE_BUSY', E_TRACE_WORKER: 'TRACE_FAILED', E_TRACE_ABORTED: 'TRACE_FAILED', E_OTHER: 'TRACE_FAILED' }
    for (const [cause, code] of Object.entries(table)) { const e = m(cause); expect(e.code, cause).toBe(code); expect(e.data.cause).toBe(cause) }
    expect(m('E_TRACE_TRUNCATED').message).toMatch(/still being recorded/)
  })
})

describe('projectTrace', () => {
  const summary = {
    schema: 's', budgetNs: 1, input: {}, overBudgetTotal: 0, unmatchedBegin: 0, unmatchedEnd: 0,
    slowest: [], counters: [], instants: [], slices: Array.from({ length: 30 }, (_, i) => ({ name: `s${i}‮` + 'x'.repeat(300), count: i })),
    undecoded: { 'slices.dropped': 5, a: 1, b: 2 },
  }
  it('caps lists, flags truncation with totals, cleans names and counts undecoded keys', () => {
    const p = pt.projectTrace(summary, { top: 10, nameCap: 120 })
    expect(p.slices.items).toHaveLength(10)
    expect(p.slices.total).toBe(35)
    expect(p.slices.truncated).toBe(true)
    expect(p.slices.items[0].name.length).toBe(120)
    expect(p.slices.items[0].name).not.toMatch(/‮/)
    expect(p.slowest).toEqual({ total: 0, truncated: false, items: [] })
    expect(p.undecodedKeys).toBe(3)
  })
})

describe('perf_summary', () => {
  it('samples the dev channel and returns stats, textures and the flat series', async () => {
    const { stub, c } = await ready()
    const d = payload(await c.tool('perf_summary', { samples: 3, topTextures: 2 }))
    expect(d.samples).toMatchObject({ requested: 3, taken: 3, intervalMs: 20, truncated: false })
    expect(d.cpu.userPct).toMatchObject({ min: expect.any(Number), last: expect.any(Number) })
    expect(d.memory.usedBytes.last).toBeGreaterThan(0)
    expect(d.pageFaults.minorDelta).toBeGreaterThan(0)
    expect(d.textures.top).toHaveLength(2)
    expect(d.textures.topTruncated).toBe(true)
    expect(d.series).toHaveLength(3)
    expect(Object.keys(d)).toEqual(['samples', 'cpu', 'memory', 'pageFaults', 'fps', 'fpsReason', 'textures', 'texturesReason', 'series', 'errors'])
    expect(perfLog(stub)[0]).toBe('/query/active-app')
    expect(JSON.stringify(d).length).toBeLessThan(LIMITS.maxPerfBytes)
  })
  it('topTextures 0 lists none; fps FAILED gives null and a reason', async () => {
    const { c } = await ready({ fps: 'failed' })
    const d = payload(await c.tool('perf_summary', { samples: 1, topTextures: 0 }))
    expect(d.textures.top).toEqual([])
    expect(d.fps).toBe(null)
    expect(d.fpsReason).toEqual(expect.any(String))
    expect(d.errors.some((e) => e.source === 'fps')).toBe(true)
  })
  it('rejects out-of-range arguments through the schema', async () => {
    const { c } = await ready()
    expect((await c.tool('perf_summary', { samples: 11 })).error).toBeTruthy()
    expect((await c.tool('perf_summary', { topTextures: 51 })).error).toBeTruthy()
  })
  it('Home in front fails PERF_NOT_FOREGROUND and sends only active-app', async () => {
    const { stub, c } = await ready({ activeApp: 'roku' })
    const d = payload(await c.tool('perf_summary'))
    expect(d.code).toBe('PERF_NOT_FOREGROUND')
    expect(d.home).toBe(true)
    expect(perfLog(stub)).toEqual(['/query/active-app'])
  })
  it('PERF_UNAVAILABLE when no source answers', async () => {
    const { c } = await ready({ perf: 'no-channel', fps: 'failed' })
    const d = payload(await c.tool('perf_summary', { samples: 2 }))
    expect(d.code).toBe('PERF_UNAVAILABLE')
    expect(d.reasons.length).toBeGreaterThan(0)
  })
  it('missing r2d2 (no developer mode) still returns cpu and memory with texturesReason', async () => {
    const { c } = await ready({ perf: 'no-dev-mode' })
    const d = payload(await c.tool('perf_summary', { samples: 1 }))
    expect(d.textures).toBe(null)
    expect(d.texturesReason).toEqual(expect.any(String))
    expect(d.memory.usedBytes).not.toBe(null)
  })
  it('sanitises bitmap names (URL parts, controls, bidi) and scrubs secrets', async () => {
    const name = 'https://u:p@cdn.example/a.png?sig=1‮\u0007 rokudev-test'
    const { c } = await ready({ perfBitmapName: name })
    const d = payload(await c.tool('perf_summary', { samples: 1, topTextures: 1 }))
    const n = d.textures.top[0].name
    expect(n).not.toMatch(/sig=|u:p@|[\u0000-\u001f‪-‮]/)
    expect(n).toContain('cdn.example/a.png')
    expect(JSON.stringify(d)).not.toContain('rokudev-test')
  })
  it('stays under the byte cap with many bitmaps and a small cap, flagging the trim', async () => {
    const { c } = await ready({ perfBitmaps: 200 }, { limits: { ...FAST, maxPerfBytes: 3000 } })
    const d = payload(await c.tool('perf_summary', { samples: 3, topTextures: 50 }))
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(3000)
    expect(d.textures.topTruncated).toBe(true)
  })
  it('returns truncated deadline with the samples taken when the deadline passes', async () => {
    const { c } = await ready({}, { limits: { perfIntervalMs: 100, perfSampleDeadlineMs: 150, queueWaitMs: 5000 } })
    const d = payload(await c.tool('perf_summary', { samples: 10 }))
    expect(d.samples.truncated).toBe(true)
    expect(d.samples.truncatedReason).toBe('deadline')
    expect(d.samples.taken).toBeGreaterThanOrEqual(1)
    expect(d.samples.taken).toBeLessThan(10)
  })
  it('takes a command lease for the call and releases it', async () => {
    const { a, c } = await ready()
    expect(isErr(await c.tool('perf_summary', { samples: 1 }))).toBe(false)
    expect(holders(c.lease)).toHaveLength(0)
    expect(c.server.session.lease).toBe(null)
    ;(await tryLease(a, c.lease)).release()
  })
  it('DEVICE_BUSY with another holder, and no ECP request', async () => {
    const { stub, a, c } = await ready()
    const h = await tryLease(a, c.lease)
    const before = stub.log.length
    expect(payload(await c.tool('perf_summary')).code).toBe('DEVICE_BUSY')
    expect(stub.log.length).toBe(before)
    h.release()
  })
  it('never opens a window; inside an open net window it re-enters (no second lease, no new hub)', async () => {
    let starts = 0
    const startLanHub = async () => { starts++; return { stop: async () => {} } }
    const { c } = await ready({}, { startLanHub })
    await c.tool('perf_summary', { samples: 1 })
    expect(c.server.session.win).toBe(null)
    expect(starts).toBe(0)
    await c.tool('net_requests')
    expect(starts).toBe(1)
    expect(holders(c.lease)).toHaveLength(1)
    const d = payload(await c.tool('perf_summary', { samples: 2 }))
    expect(d.samples.taken).toBe(2)
    expect(starts).toBe(1)
    expect(holders(c.lease)).toHaveLength(1)
    expect(c.server.session.win).not.toBe(null)
  })
})

describe('perf_summary cadence (fake timers)', () => {
  it('sleeps to the next slot between samples', async () => {
    vi.useFakeTimers()
    const times = []
    const device = { activeApp: async () => ({ id: 'dev' }), ecpGet: async (p) => { if (p.includes('chanperf')) times.push(Date.now()); return { status: 200, text: '' } } }
    const self = { limits: { ...LIMITS }, secrets: () => [], withDevice: (call, fn) => fn({ device }) }
    const ac = new AbortController()
    const p = pt.methods.perfSummary.call(self, { samples: 3 }, { signal: ac.signal }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(3000)
    const r = await p
    expect(r.code).toBe('PERF_UNAVAILABLE') // empty bodies: no metric
    expect(times).toHaveLength(3)
    expect(times[1] - times[0]).toBe(1000)
    expect(times[2] - times[1]).toBe(1000)
  })
})

describe('perf_trace_summary', () => {
  function project(files = {}) {
    const cwd = tmpdir('bt-perf-proj-')
    const dir = path.join(cwd, '.brighttest', 'studio', 'profiling')
    fs.mkdirSync(dir, { recursive: true })
    for (const [n, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), buf)
    return { cwd, dir }
  }
  const trace = () => makeTrace(SYNTH_A)
  async function boot(files, stubExtra) {
    const p = project(files)
    const { stub, a } = await bootStub('healthy', stubExtra)
    const c = startMcp({ a, cwd: p.cwd, limits: FAST })
    await c.initialize()
    return { ...p, stub, a, c }
  }

  it('summarises the newest trace by default and lists the files', async () => {
    const { c, stub } = await boot({ 'trace-2026-01-01.perfetto-trace': trace(), 'trace-2026-02-01.perfetto-trace': trace() })
    const d = payload(await c.tool('perf_trace_summary', { top: 2 }))
    expect(d.file).toBe('trace-2026-02-01.perfetto-trace')
    expect(d.schema).toBe('brighttest.perfetto-summary/1')
    expect(d.slices.items).toHaveLength(2)
    expect(d.slices.truncated).toBe(true)
    expect(d.overBudgetTotal).toBe(6)
    expect(d.files.map((f) => f.name)).toEqual(['trace-2026-02-01.perfetto-trace', 'trace-2026-01-01.perfetto-trace'])
    expect(JSON.stringify(d)).not.toContain(c.server.session.cwd)
    expect(stub.log.filter((e) => /^\/query\//.test(e.endpoint || ''))).toHaveLength(0)
  })
  it('summarises a named file', async () => {
    const { c } = await boot({ 'a.perfetto-trace': trace(), 'b.perfetto-trace': trace() })
    expect(payload(await c.tool('perf_trace_summary', { file: 'a.perfetto-trace' })).file).toBe('a.perfetto-trace')
  })
  it('TRACE_NOT_FOUND with no traces or an unknown name', async () => {
    const { c } = await boot({})
    expect(payload(await c.tool('perf_trace_summary')).code).toBe('TRACE_NOT_FOUND')
    const b = await boot({ 'a.perfetto-trace': trace() })
    expect(payload(await b.c.tool('perf_trace_summary', { file: 'zz.perfetto-trace' })).code).toBe('TRACE_NOT_FOUND')
  })
  it('TRACE_BAD_NAME for traversal, absolute, wrong suffix and a symlink out of the folder', async () => {
    const { c, dir, cwd } = await boot({ 'a.perfetto-trace': trace() })
    fs.writeFileSync(path.join(cwd, 'outside.perfetto-trace'), trace())
    fs.symlinkSync(path.join(cwd, 'outside.perfetto-trace'), path.join(dir, 'link.perfetto-trace'))
    for (const file of ['../outside.perfetto-trace', '/etc/passwd', 'a.txt', 'sub/a.perfetto-trace', 'link.perfetto-trace']) {
      expect(payload(await c.tool('perf_trace_summary', { file })).code, file).toBe('TRACE_BAD_NAME')
    }
  })
  it('TRACE_INVALID for a truncated file, with the stop-the-trace hint', async () => {
    const t = trace()
    const { c } = await boot({ 'cut.perfetto-trace': t.subarray(0, t.length - 3) })
    const d = payload(await c.tool('perf_trace_summary'))
    expect(d.code).toBe('TRACE_INVALID')
    expect(d.message).toMatch(/stop the trace first/)
    expect(d.cause).toMatch(/^E_TRACE_/)
  })
  it('works while another party holds the device lease, without taking one', async () => {
    const { c, a, stub } = await boot({ 'a.perfetto-trace': trace() })
    const h = await tryLease(a, c.lease)
    const before = stub.log.length
    expect(isErr(await c.tool('perf_trace_summary'))).toBe(false)
    expect(stub.log.length).toBe(before)
    h.release()
  })
  it('stays under the byte cap with a small cap, flagging the trim', async () => {
    const { c } = await boot({ 'a.perfetto-trace': trace() })
    const small = startMcp({ a: (await bootStub('healthy')).a, cwd: c.server.session.cwd, limits: { ...FAST, maxTraceBytes: 1500 } })
    await small.initialize()
    const d = payload(await small.tool('perf_trace_summary', { top: 50 }))
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(1500)
  })
})
