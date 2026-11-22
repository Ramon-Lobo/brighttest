import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const { makeTrace, SYNTH_A, SYNTH_B, varint, ld } = require('./fixtures/perfetto/make-trace.js')
const M = require('../lib/studio/perfetto-summary.js')
const { summarizeTrace, summarizeFile } = M

// TP-PRF gate cases 01-12 (ADR 0010), synthetic traces built in code.
const A_NONE = makeTrace(SYNTH_A, { compress: 'none' })
const A_BLOCKS = makeTrace(SYNTH_A, { compress: 'blocks', blockSize: 8 })
const sum = (buf, opts) => { const r = summarizeTrace(buf, opts); if (!r.ok) throw new Error(r.error.code); return r.summary }
const code = (r) => (r.ok ? 'ok' : r.error.code)
const wrap = (inner) => ld(1, ld(50, zlib.deflateSync(inner)))
const noInput = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.input; return c }

describe('perfetto summary: decode (TP-PRF-01, 05, 06, 07)', () => {
  const s = sum(A_NONE)
  it('matches the expected SYNTH_A summary', () => {
    expect(s.schema).toBe('brighttest.perfetto-summary/1')
    expect(s.budgetNs).toBe(16700000)
    expect(s.topN).toBe(10)
    expect(s.input).toMatchObject({ compressedBlocks: 0, sequences: 2, tracks: 5 })
    expect(s.slices).toEqual([
      { name: 'work', count: 20, totalNs: 210000000, maxNs: 20000000, p50Ns: 10000000, p95Ns: 19000000, overBudget: 4 },
      { name: 'swapBuffers', count: 4, totalNs: 78500000, maxNs: 40000000, p50Ns: 16700000, p95Ns: 40000000, overBudget: 2 },
      { name: 'render', count: 2, totalNs: 5000000, maxNs: 3000000, p50Ns: 2000000, p95Ns: 3000000, overBudget: 0 }
    ])
    expect(s.overBudgetTotal).toBe(6)
    expect(s.slowest).toEqual([
      { name: 'swapBuffers', maxNs: 40000000, count: 4 },
      { name: 'work', maxNs: 20000000, count: 20 },
      { name: 'render', maxNs: 3000000, count: 2 }
    ])
    expect(s.instants).toEqual([{ name: 'tick', count: 3 }])
    expect(s.counters).toEqual([{ name: 'node_count', samples: 3, min: 3, max: 9, last: 4, undecodedSamples: 0 }])
    expect(s.unmatchedBegin).toBe(2)
    expect(s.unmatchedEnd).toBe(1)
    expect(s.undecoded).toEqual({ 'packet.field900': 1 })
    expect(Object.keys(s)).toEqual(['schema', 'budgetNs', 'topN', 'input', 'slices', 'overBudgetTotal', 'slowest', 'instants', 'counters', 'unmatchedBegin', 'unmatchedEnd', 'undecoded'])
  })
  it('compressed encoding gives the same summary apart from input', () => {
    const b = sum(A_BLOCKS)
    expect(b.input.compressedBlocks).toBeGreaterThanOrEqual(1)
    expect(noInput(b)).toEqual(noInput(s))
  })
  it('is byte-identical across runs (TP-PRF-02)', () => {
    const j = (x) => JSON.stringify(x, null, 2) + '\n'
    expect(j(sum(A_BLOCKS))).toBe(j(sum(A_BLOCKS)))
    expect(j(sum(A_NONE))).not.toMatch(/20\d\d-\d\d-\d\d/)
  })
  it('keeps nearest-rank percentiles, not interpolated (TP-PRF-06)', () => {
    expect(s.slices[0].p95Ns).not.toBe(19050000)
    expect(s.slices[1].p50Ns).not.toBe(16750000)
  })
  it('topN limits slowest only (TP-PRF-05)', () => {
    const t = sum(A_NONE, { topN: 2 })
    expect(t.topN).toBe(2)
    expect(t.slowest.map(x => x.name)).toEqual(['swapBuffers', 'work'])
    expect(t.slices).toEqual(s.slices)
  })
})

describe('perfetto summary: budget (TP-PRF-03, 04)', () => {
  it('default is 16.7 ms and explicit default changes nothing; strict greater', () => {
    expect(M.DEFAULT_FRAME_BUDGET_MS).toBe(16.7)
    expect(sum(A_NONE, { budgetMs: 16.7 })).toEqual(sum(A_NONE))
    expect(sum(A_NONE).slices.find(x => x.name === 'swapBuffers').overBudget).toBe(2)
  })
  it('custom budget', () => {
    const b = sum(A_NONE, { budgetMs: 10 })
    expect(b.budgetNs).toBe(10000000)
    expect(b.slices.map(x => [x.name, x.overBudget])).toEqual([['work', 10], ['swapBuffers', 3], ['render', 0]])
    expect(b.overBudgetTotal).toBe(13)
  })
  it('rejects bad options with E_BAD_OPTION and never throws', () => {
    for (const o of [{ budgetMs: 0 }, { budgetMs: -1 }, { budgetMs: '10' }, { budgetMs: 10001 }, { topN: 0 }, { topN: 1.5 },
      { limits: { maxPackets: 0 } }, { limits: { nope: 1 } }, 5, []]) {
      const r = summarizeTrace(A_NONE, o)
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe('E_BAD_OPTION')
    }
  })
})

describe('perfetto summary: time rule (TP-PRF-08)', () => {
  it('absolute-clock trace is not accumulated as deltas', () => {
    expect(sum(makeTrace(SYNTH_B)).slices).toEqual([
      { name: 'abs', count: 2, totalNs: 25000000, maxNs: 20000000, p50Ns: 5000000, p95Ns: 20000000, overBudget: 1 }
    ])
  })
})

describe('perfetto summary: truncated and malformed input (TP-PRF-09, 10)', () => {
  it('every prefix is ok at a packet boundary and truncated elsewhere, never throws', () => {
    const rv = (b, p) => { let r = 0, s = 0, c; do { c = b[p++]; r += (c & 127) * 2 ** s; s += 7 } while (c & 128); return [r, p] }
    for (const U of [A_NONE, A_BLOCKS]) {
      const B = new Set([0])
      for (let p = 0; p < U.length;) { let l; [, p] = rv(U, p); [l, p] = rv(U, p); p += l; B.add(p) }
      for (let L = 0; L <= U.length; L++) {
        const r = summarizeTrace(U.subarray(0, L))
        const want = L === 0 ? 'E_TRACE_EMPTY' : B.has(L) ? 'ok' : 'E_TRACE_TRUNCATED'
        expect([L, code(r)]).toEqual([L, want])
        if (want === 'E_TRACE_TRUNCATED') expect(typeof r.error.offset).toBe('number')
      }
    }
  })
  it('typed errors for malformed input', () => {
    expect(code(summarizeTrace(Buffer.alloc(0)))).toBe('E_TRACE_EMPTY')
    expect(code(summarizeTrace(Buffer.from([0x0a, 0x80])))).toBe('E_TRACE_TRUNCATED')
    expect(code(summarizeTrace(Buffer.from([0x0b])))).toBe('E_TRACE_MALFORMED')
    expect(code(summarizeTrace(ld(1, ld(50, Buffer.from('notzlib')))))).toBe('E_TRACE_MALFORMED')
    expect(code(summarizeTrace(Buffer.alloc(11, 0x80)))).toBe('E_TRACE_MALFORMED')
    expect(code(summarizeTrace('nope'))).toBe('E_TRACE_MALFORMED')
  })
  it('nesting depth 2 is allowed, 3 is not', () => {
    const d2 = summarizeTrace(wrap(wrap(A_NONE)))
    expect(d2.ok).toBe(true)
    expect(noInput(d2.summary)).toEqual(noInput(sum(A_NONE)))
    expect(code(summarizeTrace(wrap(wrap(wrap(A_NONE)))))).toBe('E_TRACE_MALFORMED')
  })
  it('random garbage never throws', () => {
    let s = 1
    const g = Buffer.alloc(4096)
    for (let i = 0; i < g.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; g[i] = s & 255 }
    for (let n = 1; n < 200; n++) expect(() => summarizeTrace(g.subarray(0, n * 20))).not.toThrow()
  })
})

describe('perfetto summary: limits and files (TP-PRF-11)', () => {
  it('limits', () => {
    expect(M.LIMITS).toEqual({ maxBytes: 67108864, maxInflatedBytes: 268435456, maxPackets: 1000000, maxDepth: 2 })
    expect(code(summarizeTrace(A_NONE, { limits: { maxPackets: 5 } }))).toBe('E_TRACE_TOO_MANY_PACKETS')
    expect(code(summarizeTrace(A_NONE, { limits: { maxBytes: 100 } }))).toBe('E_TRACE_TOO_LARGE')
    expect(code(summarizeTrace(wrap(Buffer.alloc(1 << 20)), { limits: { maxInflatedBytes: 65536 } }))).toBe('E_TRACE_TOO_LARGE')
  })
  it('summarizeFile reads, applies the size limit before reading, and reports read errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-prf-'))
    try {
      const f = path.join(dir, 'a.perfetto-trace')
      fs.writeFileSync(f, A_BLOCKS)
      expect(summarizeFile(f).ok).toBe(true)
      expect(noInput(summarizeFile(f).summary)).toEqual(noInput(sum(A_NONE)))
      expect(code(summarizeFile(f, { limits: { maxBytes: 100 } }))).toBe('E_TRACE_TOO_LARGE')
      expect(code(summarizeFile(path.join(dir, 'missing.perfetto-trace')))).toBe('E_TRACE_READ')
      expect(code(summarizeFile(dir))).toBe('E_TRACE_READ')
      expect(code(summarizeFile(f, { topN: 0 }))).toBe('E_BAD_OPTION')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('large counter values come out as decimal strings', () => {
    const spec = { packets: [
      { seq: 1, flags: 1, track: { uuid: 1, name: 'big' } },
      { seq: 1, event: { type: 4, track: 1, counter: 2n ** 62n } },
      { seq: 1, event: { type: 4, track: 1, counter: -5 } }
    ] }
    const c = sum(makeTrace(spec)).counters[0]
    expect(c).toMatchObject({ min: -5, max: '4611686018427387904', last: -5 })
    expect(varint(1).length).toBe(1)
  })
})

describe('perfetto summary: stdlib only (TP-PRF-12)', () => {
  it('requires only fs and zlib', () => {
    for (const f of ['../lib/studio/perfetto-summary.js', './fixtures/perfetto/make-trace.js']) {
      const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
      const m = [...s.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(x => x[1])
      expect(m.filter(x => !['fs', 'zlib', 'node:fs', 'node:zlib'].includes(x))).toEqual([])
      expect(s).not.toMatch(/child_process|process\.binding|import\(/)
    }
  })
})
