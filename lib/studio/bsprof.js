'use strict';
// Parser for Roku's BrightScript Profiler files (.bsprof), implemented from the official format
// specification (developer.roku.com → docs → dev tools → "BrightScript Profiler file format").
//
// Shape of the file:
//   header  — magic "bsprof\0\0", varint version triple, header size, sample ratios (float32le),
//             two feature flags (line data / memory ops), start timestamp, six utf8z strings.
//   body    — a stream of varint-tagged entries: string table (0), executable module (1), call-path
//             element (2), memory operation (3), CPU measurement (4), path call count (5). The low
//             3 bits of the tag are the type; the remaining bits are the entry's ID/payload.
//             CPU time and call counts are INCREMENTAL: repeated entries for one path accumulate.
//   end     — a single varint 0, then a footer (metadata mirror) this parser ignores.
//
// The spec does not define the absolute unit of the CPU/time fields, and Roku's own visualization
// tool displays them unitless — so this parser reports raw ticks plus percentages, never invented
// milliseconds.
//
// Getting a .bsprof: manifest `bsprof_enable=1` (+ `bsprof_data_dest=network` to stream), exercise
// the channel, then Developer Settings → Utilities → Profiling Data, or fetch
// http://<device>:8090/bsprof/channel.bsprof while in network mode.

function readVarint(buf, pos) {
  // Protocol-buffers varint. Values can exceed 32 bits (tags carry ID<<3); JS numbers are exact to
  // 2^53, far beyond the spec's 36-bit maximum.
  let result = 0, shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error(`truncated varint at byte ${pos}`);
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 56) throw new Error(`varint too long at byte ${pos}`);
  }
}

function readUtf8z(buf, pos) {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error(`unterminated string at byte ${pos}`);
  return [Buffer.from(buf.slice(pos, end)).toString('utf8'), end + 1];
}

function parseHeader(buf) {
  if (buf.length < 16) throw new Error('not a .bsprof file (too short)');
  const magic = Buffer.from(buf.slice(0, 8)).toString('latin1');
  if (magic !== 'bsprof\0\0') throw new Error('not a .bsprof file (bad magic)');
  let pos = 8;
  const h = {};
  [h.major, pos] = readVarint(buf, pos);
  [h.minor, pos] = readVarint(buf, pos);
  [h.patch, pos] = readVarint(buf, pos);
  [h.headerSize, pos] = readVarint(buf, pos);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  h.requestedSampleRatio = dv.getFloat32(pos, true); pos += 4;
  h.actualSampleRatio = dv.getFloat32(pos, true); pos += 4;
  let flag;
  [flag, pos] = readVarint(buf, pos); h.lineData = Boolean(flag);
  [flag, pos] = readVarint(buf, pos); h.memoryOps = Boolean(flag);
  [h.startedAt, pos] = readVarint(buf, pos);
  [h.target, pos] = readUtf8z(buf, pos);
  [h.supplemental, pos] = readUtf8z(buf, pos);
  [h.targetVersion, pos] = readUtf8z(buf, pos);
  [h.deviceVendor, pos] = readUtf8z(buf, pos);
  [h.deviceModel, pos] = readUtf8z(buf, pos);
  [h.firmware, pos] = readUtf8z(buf, pos);
  // Header size is the byte offset where the body starts (the gap is zero padding).
  return { header: h, bodyStart: h.headerSize };
}

// Parse the whole file into raw tables. All spec indexes are 1-based; 0 means null.
function parseRaw(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { header, bodyStart } = parseHeader(buf);
  if (bodyStart <= 0 || bodyStart > buf.length) throw new Error(`bad header size ${bodyStart}`);

  const strings = new Map();   // id -> string
  const modules = new Map();   // id -> { nameSid }
  const paths = new Map();     // id -> { caller, moduleId?, fileSid, line, funcSid, lineOffset? }
  const cpu = new Map();       // "pathId:lineOffset" -> { pathId, lineOffset, cpuSelf, timeSelf }
  const calls = new Map();     // pathId -> count
  const memOps = [];           // { pathId, op, lineOffset?, addr, size? }

  let pos = bodyStart;
  for (;;) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    if (tag === 0) break; // end of entries; footer follows (ignored)
    const type = tag % 8;
    const rest = Math.floor(tag / 8);
    if (type === 0) { // string table
      let s; [s, pos] = readUtf8z(buf, pos);
      strings.set(rest, s);
    } else if (type === 1) { // executable module
      let sid; [sid, pos] = readVarint(buf, pos);
      modules.set(rest, { nameSid: sid });
    } else if (type === 2) { // path element
      let caller; [caller, pos] = readVarint(buf, pos);
      const p = { id: rest, caller };
      if (caller === 0) {
        [p.moduleId, pos] = readVarint(buf, pos);
      } else if (header.lineData) {
        [p.lineOffset, pos] = readVarint(buf, pos);
      }
      [p.fileSid, pos] = readVarint(buf, pos);
      [p.line, pos] = readVarint(buf, pos);
      [p.funcSid, pos] = readVarint(buf, pos);
      paths.set(rest, p);
    } else if (type === 3) { // memory operation
      const op = rest % 4; // 0=alloc 1=free 2=free_realloc
      const pathId = Math.floor(rest / 4);
      const m = { pathId, op };
      if (header.lineData) [m.lineOffset, pos] = readVarint(buf, pos);
      [m.addr, pos] = readVarint(buf, pos);
      if (op === 0) [m.size, pos] = readVarint(buf, pos);
      memOps.push(m);
    } else if (type === 4) { // CPU measurement (incremental)
      const pathId = rest;
      let lineOffset = 0, cpuSelf, timeSelf;
      if (header.lineData) [lineOffset, pos] = readVarint(buf, pos);
      [cpuSelf, pos] = readVarint(buf, pos);
      [timeSelf, pos] = readVarint(buf, pos);
      const key = `${pathId}:${lineOffset}`;
      const cur = cpu.get(key) || { pathId, lineOffset, cpuSelf: 0, timeSelf: 0 };
      cur.cpuSelf += cpuSelf; cur.timeSelf += timeSelf;
      cpu.set(key, cur);
    } else if (type === 5) { // call count (incremental)
      let count; [count, pos] = readVarint(buf, pos);
      calls.set(rest, (calls.get(rest) || 0) + count);
    } else {
      throw new Error(`unknown entry type ${type} at byte ${pos}`);
    }
  }
  return { header, strings, modules, paths, cpu, calls, memOps };
}

// Turn raw tables into the report the UI renders: per-call-path rows with self and total (inclusive of
// callees) time, rolled up per function, plus per-function memory stats when present.
function summarize(raw) {
  const { header, strings, modules, paths, cpu, calls, memOps } = raw;
  const str = (sid) => (sid ? strings.get(sid) || `#${sid}` : '');

  // Per-path self numbers.
  const perPath = new Map(); // id -> row
  for (const p of paths.values()) {
    perPath.set(p.id, {
      id: p.id, caller: p.caller,
      func: str(p.funcSid), file: str(p.fileSid), line: p.line || 0,
      module: p.caller === 0 ? str((modules.get(p.moduleId) || {}).nameSid) : null,
      calls: calls.get(p.id) || 0,
      cpuSelf: 0, timeSelf: 0, cpuTotal: 0, timeTotal: 0,
    });
  }
  for (const c of cpu.values()) {
    const row = perPath.get(c.pathId);
    if (row) { row.cpuSelf += c.cpuSelf; row.timeSelf += c.timeSelf; }
  }

  // Totals: self + all descendants. Children sum into parents; process leaves first (paths form a
  // forest via `caller`, so accumulate depth-first).
  const children = new Map();
  for (const r of perPath.values()) {
    if (r.caller && perPath.has(r.caller)) {
      if (!children.has(r.caller)) children.set(r.caller, []);
      children.get(r.caller).push(r.id);
    }
  }
  const totals = (id) => {
    const r = perPath.get(id);
    if (r._done) return r;
    r.cpuTotal = r.cpuSelf; r.timeTotal = r.timeSelf;
    for (const cid of children.get(id) || []) {
      const c = totals(cid);
      r.cpuTotal += c.cpuTotal; r.timeTotal += c.timeTotal;
    }
    r._done = true;
    return r;
  };
  for (const id of perPath.keys()) totals(id);

  // Memory per path -> per function.
  const memByPath = new Map();
  for (const m of memOps) {
    const cur = memByPath.get(m.pathId) || { allocs: 0, frees: 0, bytes: 0 };
    if (m.op === 0) { cur.allocs++; cur.bytes += m.size || 0; } else cur.frees++;
    memByPath.set(m.pathId, cur);
  }

  // Function rollup (a function can appear on many call paths).
  const byFunc = new Map();
  let grandCpu = 0, grandTime = 0;
  for (const r of perPath.values()) {
    grandCpu += r.cpuSelf; grandTime += r.timeSelf;
    const key = `${r.func}@${r.file}`;
    const f = byFunc.get(key) || {
      func: r.func, file: r.file, line: r.line, paths: 0,
      calls: 0, cpuSelf: 0, timeSelf: 0, cpuTotal: 0, timeTotal: 0,
      allocs: 0, frees: 0, allocBytes: 0,
    };
    f.paths++; f.calls += r.calls;
    f.cpuSelf += r.cpuSelf; f.timeSelf += r.timeSelf;
    f.cpuTotal += r.cpuTotal; f.timeTotal += r.timeTotal;
    const mem = memByPath.get(r.id);
    if (mem) { f.allocs += mem.allocs; f.frees += mem.frees; f.allocBytes += mem.bytes; }
    byFunc.set(key, f);
  }
  const functions = [...byFunc.values()].map((f) => ({
    ...f,
    cpuSelfPct: grandCpu ? (100 * f.cpuSelf) / grandCpu : 0,
    timeSelfPct: grandTime ? (100 * f.timeSelf) / grandTime : 0,
  })).sort((a, b) => b.cpuSelf - a.cpuSelf);

  return {
    kind: 'bsprof',
    header,
    totals: { cpu: grandCpu, time: grandTime, functions: functions.length, paths: perPath.size, memOps: memOps.length },
    functions,
  };
}

function parse(input) {
  return summarize(parseRaw(input));
}

module.exports = { parse, parseRaw, summarize, readVarint, readUtf8z };
