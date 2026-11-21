import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bsprof = require('../lib/studio/bsprof.js');

// ---------------------------------------------------------------------------------------------------
// Synthetic .bsprof encoder implementing the official spec (header + tagged varint entry stream), so
// the parser is exercised against files whose expected content is known exactly. Caveat: this validates
// the parser against the SPEC; a file produced by a real device additionally has a footer and padding,
// both of which the parser deliberately ignores.
// ---------------------------------------------------------------------------------------------------

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
const utf8z = (s) => [...Buffer.from(s, 'utf8'), 0];
const tag = (type, rest) => varint(rest * 8 + type);

function buildFile({ lineData = false, memoryOps = false, entries = [] } = {}) {
  const head = [];
  head.push(...Buffer.from('bsprof\0\0', 'latin1'));
  head.push(...varint(3), ...varint(1), ...varint(0));      // version 3.1.0
  const sizeAt = head.length; head.push(0);                  // headerSize placeholder (1-byte varint)
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return [...b]; };
  head.push(...f32(1), ...f32(0.98));
  head.push(...varint(lineData ? 1 : 0), ...varint(memoryOps ? 1 : 0));
  head.push(...varint(1754323200000));                       // startedAt
  for (const s of ['MyChannel', 'sup', '1.2.3', 'Roku', 'Ultra-4802X', '15.3.4']) head.push(...utf8z(s));
  head[sizeAt] = head.length;                                // body starts right after the header
  const body = entries.flat(Infinity);
  return new Uint8Array([...head, ...body, ...varint(0)]);   // end marker; no footer
}

// A small realistic profile: main() calls render() (twice) and util(); render() also calls util().
const strings = [
  [...tag(0, 1), ...utf8z('main')], [...tag(0, 2), ...utf8z('render')], [...tag(0, 3), ...utf8z('util')],
  [...tag(0, 4), ...utf8z('pkg:/source/main.brs')], [...tag(0, 5), ...utf8z('Main')],
];
const module1 = [[...tag(1, 1), ...varint(5)]];
const pathsPlain = [
  [...tag(2, 1), ...varint(0), ...varint(1), ...varint(4), ...varint(10), ...varint(1)], // main (root, module 1)
  [...tag(2, 2), ...varint(1), ...varint(4), ...varint(20), ...varint(2)],               // main > render
  [...tag(2, 3), ...varint(2), ...varint(4), ...varint(30), ...varint(3)],               // main > render > util
  [...tag(2, 4), ...varint(1), ...varint(4), ...varint(30), ...varint(3)],               // main > util
];
const cpuPlain = [
  [...tag(4, 1), ...varint(10), ...varint(12)],
  [...tag(4, 2), ...varint(50), ...varint(55)],
  [...tag(4, 2), ...varint(25), ...varint(30)],  // incremental: accumulates onto path 2
  [...tag(4, 3), ...varint(40), ...varint(44)],
  [...tag(4, 4), ...varint(5), ...varint(6)],
];
const callsPlain = [
  [...tag(5, 1), ...varint(1)], [...tag(5, 2), ...varint(2)],
  [...tag(5, 2), ...varint(1)], // incremental
  [...tag(5, 3), ...varint(3)], [...tag(5, 4), ...varint(1)],
];

describe('bsprof header', () => {
  it('round-trips the header fields', () => {
    const r = bsprof.parse(buildFile({ entries: [strings, module1] }));
    expect(r.header.major).toBe(3);
    expect(r.header.minor).toBe(1);
    expect(r.header.target).toBe('MyChannel');
    expect(r.header.deviceModel).toBe('Ultra-4802X');
    expect(r.header.firmware).toBe('15.3.4');
    expect(r.header.actualSampleRatio).toBeCloseTo(0.98, 5);
    expect(r.header.lineData).toBe(false);
  });

  it('rejects a non-bsprof file', () => {
    expect(() => bsprof.parse(Buffer.from('not a profile, just text padding here'))).toThrow(/magic/);
    expect(() => bsprof.parse(Buffer.from('xx'))).toThrow(/short/);
  });

  it('throws on truncation instead of looping', () => {
    const full = buildFile({ entries: [strings, module1, pathsPlain, cpuPlain] });
    expect(() => bsprof.parse(full.slice(0, full.length - 6))).toThrow(/truncated|unterminated/);
  });
});

describe('bsprof body', () => {
  const report = () => bsprof.parse(buildFile({ entries: [strings, module1, pathsPlain, cpuPlain, callsPlain] }));

  it('accumulates incremental CPU and call-count entries', () => {
    const render = report().functions.find((f) => f.func === 'render');
    expect(render.cpuSelf).toBe(75);   // 50 + 25
    expect(render.timeSelf).toBe(85);  // 55 + 30
    expect(render.calls).toBe(3);      // 2 + 1
  });

  it('computes totals as self + descendants along the call paths', () => {
    const r = report();
    const main = r.functions.find((f) => f.func === 'main');
    // main total = its 10, + render (75) + render>util (40) + main>util (5)
    expect(main.cpuTotal).toBe(130);
    const util = r.functions.find((f) => f.func === 'util');
    expect(util.cpuSelf).toBe(45);     // both util paths
    expect(util.paths).toBe(2);
  });

  it('ranks functions by self CPU and reports percentages against the grand total', () => {
    const r = report();
    expect(r.functions[0].func).toBe('render');
    expect(r.totals.cpu).toBe(130);
    expect(r.functions[0].cpuSelfPct).toBeCloseTo((75 / 130) * 100, 5);
  });

  it('resolves module names for root paths', () => {
    const r = report();
    const main = r.functions.find((f) => f.func === 'main');
    expect(main.file).toBe('pkg:/source/main.brs');
    expect(main.line).toBe(10);
  });
});

describe('bsprof optional features', () => {
  it('reads line offsets when the header flag is set', () => {
    const paths = [
      [...tag(2, 1), ...varint(0), ...varint(1), ...varint(4), ...varint(10), ...varint(1)],
      // chained entries carry a line-offset field when lineData=1
      [...tag(2, 2), ...varint(1), ...varint(7), ...varint(4), ...varint(20), ...varint(2)],
    ];
    const cpu = [
      // cpu entries also carry a line offset when lineData=1
      [...tag(4, 2), ...varint(3), ...varint(9), ...varint(9)],
    ];
    const r = bsprof.parse(buildFile({ lineData: true, entries: [strings, module1, paths, cpu] }));
    expect(r.functions.find((f) => f.func === 'render').cpuSelf).toBe(9);
  });

  it('parses memory operations and attributes them to functions', () => {
    const mem = [
      // alloc (op 0) on path 2: rest = pathId*4 + op
      [...tag(3, 2 * 4 + 0), ...varint(0x1000), ...varint(2048)],
      [...tag(3, 2 * 4 + 0), ...varint(0x2000), ...varint(1024)],
      // free (op 1) on path 2 — no size field
      [...tag(3, 2 * 4 + 1), ...varint(0x1000)],
    ];
    const r = bsprof.parse(buildFile({ memoryOps: true, entries: [strings, module1, pathsPlain, mem] }));
    const render = r.functions.find((f) => f.func === 'render');
    expect(render.allocs).toBe(2);
    expect(render.frees).toBe(1);
    expect(render.allocBytes).toBe(3072);
    expect(r.totals.memOps).toBe(3);
  });

  it('handles multi-byte varints (IDs and values beyond 127)', () => {
    const bigStrings = [[...tag(0, 300), ...utf8z('bigFunc')], [...tag(0, 301), ...utf8z('big.brs')]];
    const bigPath = [[...tag(2, 5000), ...varint(0), ...varint(1), ...varint(301), ...varint(999), ...varint(300)]];
    const bigCpu = [[...tag(4, 5000), ...varint(1000000), ...varint(2000000)]];
    const r = bsprof.parse(buildFile({ entries: [module1, bigStrings, bigPath, bigCpu] }));
    const f = r.functions.find((x) => x.func === 'bigFunc');
    expect(f.cpuSelf).toBe(1000000);
    expect(f.line).toBe(999);
  });

  it('tolerates entries arriving before the strings they reference', () => {
    // The spec allows any order: paths/cpu first, string table afterwards.
    const r = bsprof.parse(buildFile({ entries: [pathsPlain, cpuPlain, module1, strings] }));
    expect(r.functions.find((f) => f.func === 'render').cpuSelf).toBe(75);
  });
});
