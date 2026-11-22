'use strict'
// Test-only synthetic Perfetto trace builder (stdlib only, buffers only). No captured data.
// makeTrace(spec, { compress: 'none' | 'blocks', blockSize }) -> Buffer (a protobuf Trace).
const zlib = require('zlib')

function varint(n) {
  let v = typeof n === 'bigint' ? n : BigInt(n)
  v = BigInt.asUintN(64, v)
  const o = []
  while (v > 127n) { o.push(Number(v & 127n) | 128); v >>= 7n }
  o.push(Number(v))
  return Buffer.from(o)
}
const tag = (f, w) => varint(f * 8 + w)
const vf = (f, n) => Buffer.concat([tag(f, 0), varint(n)])
const ld = (f, b) => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8'); return Buffer.concat([tag(f, 2), varint(x.length), x]) }
const cat = (...a) => Buffer.concat(a.filter(Boolean))

// Packet description -> TracePacket bytes.
// { seq, flags, ts, clock, clocks:[{id,inc,mult}], defaults:{clock,track}, track:{uuid,name,thread,process},
//   interned:[{iid,name}], event:{type,track,name,iid,counter}, extra:[{field,value}] }
function encodePacket(p) {
  const parts = []
  if (p.ts != null) parts.push(vf(8, p.ts))
  if (p.seq != null) parts.push(vf(10, p.seq))
  if (p.flags != null) parts.push(vf(13, p.flags))
  if (p.clock != null) parts.push(vf(58, p.clock))
  if (p.clocks) {
    parts.push(ld(6, cat(...p.clocks.map(c => ld(1, cat(vf(1, c.id), c.inc ? vf(3, 1) : null, c.mult != null ? vf(4, c.mult) : null))))))
  }
  if (p.defaults) {
    const d = p.defaults
    parts.push(ld(59, cat(d.clock != null ? vf(58, d.clock) : null, d.track != null ? ld(11, vf(11, d.track)) : null)))
  }
  if (p.track) {
    const t = p.track
    parts.push(ld(60, cat(vf(1, t.uuid), t.name ? ld(2, t.name) : null,
      t.process ? ld(3, ld(6, t.process)) : null, t.thread ? ld(4, ld(5, t.thread)) : null)))
  }
  if (p.interned) parts.push(ld(12, cat(...p.interned.map(e => ld(2, cat(vf(1, e.iid), ld(2, e.name)))))))
  if (p.event) {
    const e = p.event
    parts.push(ld(11, cat(vf(9, e.type), e.iid != null ? vf(10, e.iid) : null, e.track != null ? vf(11, e.track) : null,
      e.name != null ? ld(23, e.name) : null, e.counter != null ? vf(30, e.counter) : null)))
  }
  for (const x of p.extra || []) parts.push(vf(x.field, x.value))
  return cat(...parts)
}

function makeTrace(spec, opts = {}) {
  const compress = opts.compress || 'none'
  const blockSize = opts.blockSize || 8
  const enc = spec.packets.map(p => ld(1, encodePacket(p)))
  if (compress === 'none') return cat(...enc)
  const out = []
  for (let i = 0; i < enc.length; i += blockSize) {
    out.push(ld(1, ld(50, zlib.deflateSync(cat(...enc.slice(i, i + blockSize))))))
  }
  return cat(...out)
}

const BEGIN = 1, END = 2, INSTANT = 3, COUNTER = 4
const MS = 1000000

function buildA() {
  const P = []
  const ev = (seq, ts, type, rest = {}) => P.push({ seq, ts, event: { type, ...rest } })
  // Sequence 1 setup.
  P.push({ seq: 1, flags: 1, clocks: [{ id: 64, inc: true, mult: 1 }], defaults: { clock: 64, track: 100 } })
  P.push({ seq: 1, track: { uuid: 100, thread: 'RenderThread' } })
  P.push({ seq: 1, track: { uuid: 200, thread: 'WorkerThread' } })
  P.push({ seq: 1, track: { uuid: 300, name: 'node_count' } })
  P.push({ seq: 1, track: { uuid: 400, name: 'Orphan' } })
  P.push({ seq: 1, interned: [{ iid: 1, name: 'swapBuffers' }] })
  // Sequence 2 setup (same iid, other name).
  P.push({ seq: 2, flags: 1, clocks: [{ id: 64, inc: true, mult: 1 }], defaults: { clock: 64, track: 500 } })
  P.push({ seq: 2, track: { uuid: 500, thread: 'AuxThread' } })
  P.push({ seq: 2, interned: [{ iid: 1, name: 'render' }] })
  // swapBuffers #1 with sequence 2 slices sitting inside it (packet order).
  ev(1, 1 * MS, BEGIN, { iid: 1 })
  ev(2, 2 * MS, BEGIN, { iid: 1 })
  ev(2, 2 * MS, END)
  ev(2, 1 * MS, BEGIN, { iid: 1 })
  ev(2, 3 * MS, END)
  ev(1, 5 * MS, END)
  // swapBuffers #2..#4, 1 ms apart; the 4th end carries an explicit track.
  ev(1, 1 * MS, BEGIN, { iid: 1 }); ev(1, 16700000, END)
  ev(1, 1 * MS, BEGIN, { iid: 1 }); ev(1, 16800000, END)
  ev(1, 1 * MS, BEGIN, { iid: 1 }); ev(1, 40 * MS, END, { track: 100 })
  // work x20 on track 200.
  for (let i = 1; i <= 20; i++) {
    ev(1, 1 * MS, BEGIN, { track: 200, name: 'work' })
    ev(1, i * MS, END, { track: 200 })
  }
  for (let i = 0; i < 3; i++) ev(1, 1 * MS, INSTANT, { track: 200, name: 'tick' })
  for (const v of [3, 9, 4]) ev(1, 1 * MS, COUNTER, { track: 300, counter: v })
  ev(1, 1 * MS, END, { track: 400 })
  P.push({ seq: 1, extra: [{ field: 900, value: 1 }] })
  ev(1, 1 * MS, BEGIN, { track: 100, name: 'open' })
  ev(1, 1 * MS, BEGIN, { track: 100, name: 'open' })
  return { packets: P }
}

function buildB() {
  const P = []
  const ev = (ts, type) => P.push({ seq: 1, ts, event: { type, track: 1, name: 'abs' } })
  P.push({ seq: 1, flags: 1, track: { uuid: 1, thread: 'AbsThread' } })
  ev(1000000000, BEGIN); ev(1005000000, END)
  ev(1010000000, BEGIN); ev(1030000000, END)
  return { packets: P }
}

module.exports = { makeTrace, encodePacket, SYNTH_A: buildA(), SYNTH_B: buildB(), varint, ld, vf }
