import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// STA-SP7: BT_fit (BT_core.brs) is the over-cap truncation path of the published snapshot. This pins the bytes it emits
// (so a cost fix cannot change them) and reports the work done per size/cap. The real runtime runs headless on the fork
// engine (brs-cli, run through its js entry so it also works on Windows). No timing assert: ms are printed only.
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const CORE = fs.readFileSync(path.join(SRC, 'BT_core.brs'), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')

// Each case: [name, fields, string length per field, maxBytes]. Field i has length len + (i % 7) * 3, so sizes tie often.
const CASES = [
  ['fits', 40, 100, 65536],
  ['64KB-at-64KB', 500, 130, 65536],
  ['256KB-at-64KB', 500, 520, 65536],
  ['256KB-raised', 500, 520, 524288],
  ['all-dropped-fallback', 60, 1500, 1024],
]

function run() {
  const lines = []
  for (const [name, n, len, max] of CASES) {
    lines.push(
      `    g = CreateObject("roSGNode", "Node")`,
      `    sc = CreateObject("roSGNode", "Node")`,
      `    f = {}`,
      `    for i = 0 to ${n - 1}`,
      `        f["f" + i.toStr()] = String(${len} + (i mod 7) * 3, "x")`,
      `    end for`,
      `    f["q""é"] = "odd key"`,
      `    f.user = { a: 1, b: [1, 2, 3] }`,
      `    g.addFields(f)`,
      `    cfg = { publish: { maxBytes: ${max} }, caps: {} }`,
      `    t = CreateObject("roTimespan")`,
      `    j = BT_labelJson(1, g, sc, cfg, 0)`,
      `    print "@@${name} " + t.TotalMilliseconds().toStr() + " " + Len(j).toStr()`,
      // One big `print j` costs the engine seconds per 64 KB (about 90 s for these cases, near the 120 s kill on the Windows
      // runner); the same bytes printed in 2 KB slices take well under a second. The output is identical.
      `    for p = 1 to Len(j) step 2048`,
      `        print Mid(j, p, 2048);`,
      `    end for`,
      `    print ""`,
    )
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fit-')), 'fit.brs')
  fs.writeFileSync(file, `${CORE}\nsub main()\n${lines.join('\n')}\nend sub\n`)
  try {
    const out = execFileSync(process.execPath, [brsCli, file], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
    return out.split(/\r?\n/)
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }) }
}

describe('BT_fit over-cap output (STA-SP7)', () => {
  const out = run()
  const res = {}
  out.forEach((l, i) => {
    const m = /^@@(\S+) (\d+) (\d+)$/.exec(l)
    if (m) res[m[1]] = { ms: +m[2], len: +m[3], json: out[i + 1] }
  })

  it('reports ms and entries replaced per case', () => {
    for (const [name] of CASES) {
      const marks = (res[name].json.match(/:bytes"/g) || []).length
      console.log(`STA-SP7 ${name}: ${res[name].ms} ms, ${res[name].len} B out, ${marks} :bytes marks`)
      expect(res[name].len).toBeLessThanOrEqual(name === 'all-dropped-fallback' ? 1024 : 524288)
    }
  })

  // Hashes captured from the build before the cost fix (main 381ebc7); the output must stay byte-identical.
  const PIN = {
    'fits': 'bf0c2e27efd98e62',
    '64KB-at-64KB': '9304818283bebef5',
    '256KB-at-64KB': '578d6b572646384c',
    '256KB-raised': '8c79f82d00eb7c52',
    'all-dropped-fallback': 'ed6cae15ed968229',
  }
  for (const [name] of CASES) {
    it(`pins the emitted bytes: ${name}`, () => {
      const h = crypto.createHash('sha256').update(res[name].json).digest('hex').slice(0, 16)
      expect(h).toBe(PIN[name])
    })
  }
})

// STA-SP7-FU: cap-edge pins for BT_fit, called directly with a hand-built document so the cap is exact.
// Layer "global" holds one large entry and a small one; the cap is taken from Len(FormatJson(doc)) inside the program.
function runEdges() {
  const body = [
    'function mk(k as string) as object',
    '    l = {}',
    '    l[k] = String(60, "x")',
    '    l["z"] = "zz"',
    '    return { v: 1, seq: 1, snapshot: { layers: { global: l } }, truncated: [] }',
    'end function',
    'sub main()',
    '    for each k in ["big", Chr(1082) + Chr(1083) + Chr(1102) + Chr(1095)]',
    '        n = Len(FormatJson(mk(k)))',
    '        print "@@cap " + n.toStr()',
    '        print "@@at"',
    '        print BT_fit(mk(k), n)',
    '        print "@@under"',
    '        print BT_fit(mk(k), n - 1)',
    '    end for',
    'end sub',
  ].join('\n')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fit-edge-')), 'edge.brs')
  fs.writeFileSync(file, `${CORE}\n${body}\n`)
  try {
    const out = execFileSync(process.execPath, [brsCli, file], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    const lines = out.split(/\r?\n/)
    const res = []
    lines.forEach((l, i) => {
      const m = /^@@cap (\d+)$/.exec(l)
      if (m) res.push({ cap: +m[1], at: lines[i + 2], under: lines[i + 4] })
    })
    return res
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }) }
}

describe('BT_fit cap edges (STA-SP7-FU)', () => {
  const [ascii, uni] = runEdges()
  const X = 'x'.repeat(60)
  const KEY = 'ключ'

  it('output exactly at the cap is returned untouched', () => {
    const doc = `{"seq":1,"snapshot":{"layers":{"global":{"big":"${X}","z":"zz"}}},"truncated":[],"v":1}`
    expect(ascii.cap).toBe(143)
    expect(ascii.at).toBe(doc)
    expect(Buffer.byteLength(ascii.at)).toBe(ascii.cap)
  })

  it('cap minus 1 byte replaces the largest entry with the 18 B marker and records it', () => {
    const doc = '{"seq":1,"snapshot":{"layers":{"global":{"big":"$truncated:bytes","z":"zz"}}},"truncated":["global.big:bytes"],"v":1}'
    expect(ascii.under).toBe(doc)
    expect(Buffer.byteLength(ascii.under)).toBeLessThanOrEqual(ascii.cap - 1)
  })

  // The engine emits object keys raw (UTF-8) while Len counts characters, so a non-ASCII key makes the byte size exceed
  // the character count. These pin what the runtime does today: the exact-cap document is kept although it is KEY.length bytes
  // over in UTF-8 (finding logged for the reviewer); cap minus 1 truncates and the marker path escapes the key as \uXXXX.
  it('unicode key at the cap: kept by character count, bytes pinned', () => {
    const doc = `{"seq":1,"snapshot":{"layers":{"global":{"z":"zz","${KEY}":"${X}"}}},"truncated":[],"v":1}`
    expect(uni.cap).toBe(144)
    expect(uni.at).toBe(doc)
    expect(uni.at.length).toBe(uni.cap)
    expect(Buffer.byteLength(uni.at)).toBe(uni.cap + KEY.length)
  })

  it('unicode key at cap minus 1: truncated, marker path is escaped', () => {
    const doc = `{"seq":1,"snapshot":{"layers":{"global":{"z":"zz","${KEY}":"$truncated:bytes"}}},"truncated":["global.\\u043A\\u043B\\u044E\\u0447:bytes"],"v":1}`
    expect(uni.under).toBe(doc)
  })
})
