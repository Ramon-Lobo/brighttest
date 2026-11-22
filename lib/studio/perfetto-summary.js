'use strict'
// Frame-budget summary of a saved .perfetto-trace (ADR 0010). Node stdlib only (fs, zlib), no device, no network.
// Hand-rolled protobuf wire reader; field numbers are hard-coded (proto names in comments).
// Neither exported function throws: every failure is { ok: false, error: { code, message, offset } }.
const fs = require('fs')
const zlib = require('zlib')

const DEFAULT_FRAME_BUDGET_MS = 16.7
const LIMITS = { maxBytes: 64 * 1024 * 1024, maxInflatedBytes: 256 * 1024 * 1024, maxPackets: 1000000, maxDepth: 2 }
const SCHEMA = 'brighttest.perfetto-summary/1'
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

// Trace.packet = 1. TracePacket fields:
const PKT_CLOCK_SNAPSHOT = 6, PKT_TIMESTAMP = 8, PKT_SEQ_ID = 10, PKT_TRACK_EVENT = 11, PKT_INTERNED = 12
const PKT_SEQ_FLAGS = 13, PKT_COMPRESSED = 50, PKT_CLOCK_ID = 58, PKT_DEFAULTS = 59, PKT_TRACK_DESC = 60
const PACKET_KNOWN = new Set([6, 8, 10, 11, 12, 13, 50, 58, 59, 60])
// TrackEvent: type 9 (1 begin, 2 end, 3 instant, 4 counter), name_iid 10, track_uuid 11, name 23, counter_value 30.
const TE_KNOWN = new Set([9, 10, 11, 23, 30])
const T_BEGIN = 1, T_END = 2, T_INSTANT = 3, T_COUNTER = 4

class TraceError extends Error {
  constructor(code, message, offset) { super(message); this.code = code; this.offset = offset == null ? null : offset }
}

let vp = 0 // position after the last readVarint
function readVarint(b, p, end, top) {
  let r = 0, mult = 1, big = null
  for (let i = 0; ; i++) {
    if (i >= 10) throw new TraceError('E_TRACE_MALFORMED', 'varint longer than 10 bytes', top ? p : null)
    if (p >= end) throw new TraceError(top ? 'E_TRACE_TRUNCATED' : 'E_TRACE_MALFORMED', 'truncated varint', top ? p : null)
    const c = b[p++]
    if (i < 7) { r += (c & 127) * mult; mult *= 128 } else {
      if (big === null) big = BigInt(r)
      big |= BigInt(c & 127) << BigInt(7 * i)
    }
    if (!(c & 128)) break
  }
  vp = p
  if (big === null) return r
  big = BigInt.asUintN(64, big)
  return big <= MAX_SAFE ? Number(big) : big
}

// Parse b[s,e) into [{ f, w, v }]. v: varint number|bigint, Buffer slice for wire type 2, null for fixed widths.
function parseFields(b, s, e, top) {
  const out = []
  let p = s
  const over = (msg) => new TraceError(top ? 'E_TRACE_TRUNCATED' : 'E_TRACE_MALFORMED', msg, top ? p : null)
  while (p < e) {
    const k = readVarint(b, p, e, top); p = vp
    const f = typeof k === 'bigint' ? Number(k >> 3n) : Math.floor(k / 8)
    const w = typeof k === 'bigint' ? Number(k & 7n) : k % 8
    if (w === 0) { const v = readVarint(b, p, e, top); p = vp; out.push({ f, w, v }) }
    else if (w === 1) { if (p + 8 > e) throw over('truncated fixed64'); p += 8; out.push({ f, w, v: null }) }
    else if (w === 5) { if (p + 4 > e) throw over('truncated fixed32'); p += 4; out.push({ f, w, v: null }) }
    else if (w === 2) {
      const l = readVarint(b, p, e, top); p = vp
      if (typeof l === 'bigint' || p + l > e) throw over('length-delimited field overruns the buffer')
      out.push({ f, w, v: b.subarray(p, p + l) }); p += l
    } else throw new TraceError('E_TRACE_MALFORMED', 'unsupported wire type ' + w, top ? p : null)
  }
  return out
}

const sub = (b) => parseFields(b, 0, b.length, false)
const lastNum = (fl, f) => { let r; for (const x of fl) if (x.f === f && x.w === 0) r = x.v; return r }
const lastBuf = (fl, f) => { let r; for (const x of fl) if (x.f === f && x.w === 2) r = x.v; return r }
const str = (b) => (b ? b.toString('utf8') : undefined)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function validate(opts) {
  const bad = (m) => ({ ok: false, error: { code: 'E_BAD_OPTION', message: m, offset: null } })
  if (opts == null) opts = {}
  if (typeof opts !== 'object' || Array.isArray(opts)) return bad('options must be an object')
  const budgetMs = opts.budgetMs === undefined ? DEFAULT_FRAME_BUDGET_MS : opts.budgetMs
  if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 10000) return bad('budgetMs must be a number in (0, 10000]')
  const topN = opts.topN === undefined ? 10 : opts.topN
  if (!Number.isInteger(topN) || topN < 1 || topN > 1000) return bad('topN must be an integer 1..1000')
  const limits = Object.assign({}, LIMITS)
  if (opts.limits !== undefined) {
    const l = opts.limits
    if (l === null || typeof l !== 'object' || Array.isArray(l)) return bad('limits must be an object')
    for (const k of Object.keys(l)) {
      if (!(k in LIMITS)) return bad('unknown limit ' + k)
      if (!Number.isInteger(l[k]) || l[k] < (k === 'maxDepth' ? 0 : 1) || l[k] > Number.MAX_SAFE_INTEGER) return bad('invalid limit ' + k)
      limits[k] = l[k]
    }
  }
  return { ok: true, budgetMs, topN, limits }
}

// Flatten the (possibly nested, zlib-compressed) Trace into leaf packet field lists.
function collectPackets(buf, limits, st) {
  const walk = (b, depth) => {
    const top = depth === 0
    for (const x of parseFields(b, 0, b.length, top)) {
      if (x.f !== 1 || x.w !== 2) continue
      const pf = sub(x.v)
      const blocks = pf.filter(y => y.f === PKT_COMPRESSED && y.w === 2)
      if (blocks.length) {
        if (depth + 1 > limits.maxDepth) throw new TraceError('E_TRACE_MALFORMED', 'compressed_packets nested deeper than ' + limits.maxDepth, null)
        for (const c of blocks) {
          st.compressedBlocks++
          let out
          try { out = zlib.inflateSync(c.v, { maxOutputLength: Math.max(1, limits.maxInflatedBytes - st.inflated) }) } catch (e) {
            if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new TraceError('E_TRACE_TOO_LARGE', 'inflated trace exceeds maxInflatedBytes', null)
            throw new TraceError('E_TRACE_MALFORMED', 'zlib inflate failed', null)
          }
          st.inflated += out.length
          if (st.inflated > limits.maxInflatedBytes) throw new TraceError('E_TRACE_TOO_LARGE', 'inflated trace exceeds maxInflatedBytes', null)
          walk(out, depth + 1)
        }
      } else {
        if (st.packets.length >= limits.maxPackets) throw new TraceError('E_TRACE_TOO_MANY_PACKETS', 'more than ' + limits.maxPackets + ' packets', null)
        st.packets.push(pf)
      }
    }
  }
  walk(buf, 0)
}

function summarizeTrace(buf, opts) {
  try {
    const o = validate(opts)
    if (!o.ok) return o
    if (!Buffer.isBuffer(buf)) {
      if (!(buf instanceof Uint8Array)) throw new TraceError('E_TRACE_MALFORMED', 'input is not a Buffer', null)
      buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    if (buf.length === 0) throw new TraceError('E_TRACE_EMPTY', 'empty trace', 0)
    if (buf.length > o.limits.maxBytes) throw new TraceError('E_TRACE_TOO_LARGE', 'trace larger than maxBytes', null)
    const st = { packets: [], compressedBlocks: 0, inflated: 0 }
    collectPackets(buf, o.limits, st)
    if (!st.packets.length) throw new TraceError('E_TRACE_EMPTY', 'no packet decoded', null)
    return { ok: true, summary: build(st, buf.length, o) }
  } catch (e) {
    if (e instanceof TraceError) return { ok: false, error: { code: e.code, message: e.message, offset: e.offset } }
    return { ok: false, error: { code: 'E_TRACE_MALFORMED', message: String(e && e.message), offset: null } }
  }
}

function build(st, bytes, o) {
  const budgetNs = Math.round(o.budgetMs * 1e6)
  const undecoded = {}
  const note = (k) => { undecoded[k] = (undecoded[k] || 0) + 1 }
  const seqs = new Map(), globalClocks = new Map(), tracks = new Map()
  const durations = new Map(), instants = new Map(), counters = new Map()
  let unmatchedEnd = 0, order = 0

  for (const pf of st.packets) {
    const sid = String(lastNum(pf, PKT_SEQ_ID) || 0)
    let q = seqs.get(sid)
    if (!q) { q = { ts: 0, defClock: null, defTrack: null, names: new Map(), clocks: new Map(), stacks: new Map() }; seqs.set(sid, q) }
    for (const x of pf) if (!PACKET_KNOWN.has(x.f)) note('packet.field' + x.f)
    if ((Number(lastNum(pf, PKT_SEQ_FLAGS) || 0) & 1) !== 0) q.ts = 0
    for (const x of pf) {
      if (x.w !== 2) continue
      if (x.f === PKT_CLOCK_SNAPSHOT) {
        for (const c of sub(x.v)) {
          if (c.f !== 1 || c.w !== 2) continue
          const cf = sub(c.v)
          const id = String(lastNum(cf, 1))
          const info = { inc: Number(lastNum(cf, 3) || 0) !== 0, mult: Number(lastNum(cf, 4) || 1) || 1 }
          q.clocks.set(id, info); globalClocks.set(id, info)
        }
      } else if (x.f === PKT_DEFAULTS) {
        const d = sub(x.v)
        const c = lastNum(d, 58); if (c !== undefined) q.defClock = String(c)
        const ted = lastBuf(d, 11)
        if (ted) { const u = lastNum(sub(ted), 11); if (u !== undefined) q.defTrack = String(u) }
      } else if (x.f === PKT_TRACK_DESC) {
        const d = sub(x.v)
        const uuid = String(lastNum(d, 1) || 0)
        const t = tracks.get(uuid) || { name: null }
        const name = str(lastBuf(d, 2))
        const pr = lastBuf(d, 3), th = lastBuf(d, 4)
        const label = name || (th && str(lastBuf(sub(th), 5))) || (pr && str(lastBuf(sub(pr), 6)))
        if (label) t.name = label
        tracks.set(uuid, t)
      } else if (x.f === PKT_INTERNED) {
        for (const e of sub(x.v)) {
          if (e.f === 2 && e.w === 2) {
            const ef = sub(e.v)
            q.names.set(String(lastNum(ef, 1)), str(lastBuf(ef, 2)))
          } else note('interned_data.field' + e.f)
        }
      }
    }
    const te = lastBuf(pf, PKT_TRACK_EVENT)
    if (!te) continue
    // Time rule: delta accumulated per sequence on an incremental clock, else absolute.
    const cid = lastNum(pf, PKT_CLOCK_ID)
    const eff = cid !== undefined ? String(cid) : q.defClock
    const info = eff != null ? (q.clocks.get(eff) || globalClocks.get(eff)) : undefined
    const raw = lastNum(pf, PKT_TIMESTAMP)
    let ts = null
    if (info && info.inc) { if (raw !== undefined) q.ts += Number(raw) * info.mult; ts = q.ts }
    else if (raw !== undefined) ts = Number(raw) * (info ? info.mult : 1)

    const d = sub(te)
    for (const x of d) if (!TE_KNOWN.has(x.f)) note('track_event.field' + x.f)
    const type = Number(lastNum(d, 9) || 0)
    const uuid = lastNum(d, 11)
    const track = uuid !== undefined ? String(uuid) : (q.defTrack != null ? q.defTrack : 'seq' + sid)
    const inline = lastBuf(d, 23), iid = lastNum(d, 10)
    const name = inline ? str(inline) : (iid !== undefined ? q.names.get(String(iid)) : undefined) || '(unnamed)'
    const key = sid + '|' + track
    let stack = q.stacks.get(key)
    if (!stack) { stack = []; q.stacks.set(key, stack) }
    if (type === T_COUNTER) {
      const c = counters.get(track) || { samples: 0, min: null, max: null, last: null, lastOrder: -1, und: 0 }
      c.samples++
      const cv = lastNum(d, 30)
      if (cv === undefined) c.und++
      else {
        const v = BigInt.asIntN(64, BigInt(cv))
        if (c.min === null || v < c.min) c.min = v
        if (c.max === null || v > c.max) c.max = v
        c.last = v; c.lastOrder = order++
      }
      counters.set(track, c)
    } else if (type === T_BEGIN || type === T_END || type === T_INSTANT) {
      if (ts === null) { note('track_event.no_timestamp'); continue }
      if (type === T_BEGIN) stack.push({ name, ts })
      else if (type === T_END) {
        const b = stack.pop()
        if (!b) unmatchedEnd++
        else if (ts - b.ts < 0) note('negative_duration')
        else { const a = durations.get(b.name); if (a) a.push(ts - b.ts); else durations.set(b.name, [ts - b.ts]) }
      } else instants.set(name, (instants.get(name) || 0) + 1)
    } else note('track_event.type' + type)
  }

  let unmatchedBegin = 0
  for (const q of seqs.values()) for (const s of q.stacks.values()) unmatchedBegin += s.length

  const slices = []
  for (const [name, ds] of durations) {
    ds.sort((a, b) => a - b)
    const n = ds.length
    let total = 0, over = 0
    for (const x of ds) { total += x; if (x > budgetNs) over++ }
    slices.push({ name, count: n, totalNs: total, maxNs: ds[n - 1], p50Ns: ds[Math.ceil(0.5 * n) - 1], p95Ns: ds[Math.ceil(0.95 * n) - 1], overBudget: over })
  }
  slices.sort((a, b) => b.count - a.count || cmp(a.name, b.name))
  const slowest = slices.slice().sort((a, b) => b.maxNs - a.maxNs || cmp(a.name, b.name)).slice(0, o.topN)
    .map(s => ({ name: s.name, maxNs: s.maxNs, count: s.count }))

  const num = (v) => (v === null ? null : (v <= MAX_SAFE && v >= -MAX_SAFE ? Number(v) : v.toString()))
  const merged = new Map()
  for (const [uuid, c] of counters) {
    const t = tracks.get(uuid)
    const name = (t && t.name) || uuid
    const m = merged.get(name)
    if (!m) merged.set(name, Object.assign({}, c))
    else {
      m.samples += c.samples; m.und += c.und
      if (c.min !== null && (m.min === null || c.min < m.min)) m.min = c.min
      if (c.max !== null && (m.max === null || c.max > m.max)) m.max = c.max
      if (c.lastOrder > m.lastOrder) { m.last = c.last; m.lastOrder = c.lastOrder }
    }
  }
  const counterOut = [...merged].sort((a, b) => cmp(a[0], b[0]))
    .map(([name, c]) => ({ name, samples: c.samples, min: num(c.min), max: num(c.max), last: num(c.last), undecodedSamples: c.und }))
  const und = {}
  for (const k of Object.keys(undecoded).sort()) und[k] = undecoded[k]

  return {
    schema: SCHEMA,
    budgetNs,
    topN: o.topN,
    input: { bytes, compressedBlocks: st.compressedBlocks, packets: st.packets.length, sequences: seqs.size, tracks: tracks.size },
    slices,
    overBudgetTotal: slices.reduce((a, s) => a + s.overBudget, 0),
    slowest,
    instants: [...instants].sort((a, b) => cmp(a[0], b[0])).map(([name, count]) => ({ name, count })),
    counters: counterOut,
    unmatchedBegin,
    unmatchedEnd,
    undecoded: und
  }
}

function summarizeFile(path, opts) {
  try {
    const o = validate(opts)
    if (!o.ok) return o
    const fail = (code, message) => ({ ok: false, error: { code, message, offset: null } })
    if (typeof path !== 'string' || !path) return fail('E_TRACE_READ', 'path must be a non-empty string')
    let st
    try { st = fs.statSync(path) } catch (e) { return fail('E_TRACE_READ', 'cannot stat trace: ' + (e && e.code)) }
    if (!st.isFile()) return fail('E_TRACE_READ', 'not a regular file')
    if (st.size > o.limits.maxBytes) return fail('E_TRACE_TOO_LARGE', 'trace larger than maxBytes')
    let buf
    try { buf = fs.readFileSync(path) } catch (e) { return fail('E_TRACE_READ', 'cannot read trace: ' + (e && e.code)) }
    return summarizeTrace(buf, opts)
  } catch (e) {
    return { ok: false, error: { code: 'E_TRACE_READ', message: String(e && e.message), offset: null } }
  }
}

module.exports = { summarizeTrace, summarizeFile, DEFAULT_FRAME_BUDGET_MS, LIMITS }
