import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require(path.resolve(__dirname, '../lib/instrument/plugin.js'))
const { renderBtConfig } = require(path.resolve(__dirname, '../lib/instrument/build.js'))
const { runtimeSource, runtimeSourceRaw, stripFullLineComments, stagedAsset, AGENT_ASSETS } = plugin

const isFullLineComment = (l) => /^[ \t]*'/.test(l)
const nonComment = (t) => t.split('\n').filter((l) => !isFullLineComment(l))

// The staged zip's injected runtime: source/bt/* + components/bt/*, as the plugin and build stage them.
const stagedFiles = (netSpec) => [
  { name: 'source/bt/BT_runtime.brs', text: runtimeSource(true, true, netSpec) },
  { name: 'source/bt/BT_config.brs', text: renderBtConfig('0'.repeat(32), {}) },
  ...AGENT_ASSETS.map((a) => ({ name: a.dest, text: stagedAsset(a) })),
]
const rawFiles = (netSpec) => [
  { name: 'source/bt/BT_runtime.brs', text: runtimeSourceRaw(true, true, netSpec) },
  { name: 'source/bt/BT_config.brs', text: renderBtConfig('0'.repeat(32), {}) },
  ...AGENT_ASSETS.map((a) => ({ name: a.dest, text: fs.readFileSync(a.src, 'utf8') })),
]
const measure = (files) => ({
  lines: files.filter((f) => f.name.endsWith('.brs')).reduce((n, f) => n + f.text.replace(/\n$/, '').split('\n').length, 0),
  bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
})

describe('staged runtime comment strip (ADR 0020 D3)', () => {
  it('stripped output has no full-line comment and keeps every other line byte-identical', () => {
    for (const args of [[true, true, false], [true, true, true], [true, false, false], [false, true, false], [false, false, false]]) {
      const raw = runtimeSourceRaw(...args)
      const out = runtimeSource(...args)
      expect(out.split('\n').some(isFullLineComment)).toBe(false)
      expect(out.split('\n')).toEqual(nonComment(raw))
    }
    for (const a of AGENT_ASSETS.filter((x) => x.dest.endsWith('.brs'))) {
      const src = fs.readFileSync(a.src, 'utf8')
      expect(stagedAsset(a).split('\n')).toEqual(nonComment(src))
    }
  })

  it('does not touch trailing comments, strings or blank lines', () => {
    const src = ["x = 1 ' trailing", 's = "a \' b"', '', "   ' indented full-line", "' full", 'y = 2'].join('\n')
    expect(stripFullLineComments(src)).toBe(["x = 1 ' trailing", 's = "a \' b"', '', 'y = 2'].join('\n'))
  })

  it('leaves the repo runtime files untouched (they keep their comments)', () => {
    const f = fs.readFileSync(path.resolve(__dirname, '../lib/instrument/runtime/source/bt/BT_core.brs'), 'utf8')
    expect(f.split('\n').some(isFullLineComment)).toBe(true)
  })

  it('TP-INS-16: staged source/bt + components/bt is at most 1500 BrightScript lines and 60 KB', () => {
    // The shipped build (no BTNet_spec). The netSpec build adds the test-only BTNet_spec.brs and is reported, not budgeted.
    const m = measure(stagedFiles(false))
    const before = measure(rawFiles(false))
    const spec = measure(stagedFiles(true))
    console.log(`staged: ${m.lines} lines, ${m.bytes} bytes (before strip: ${before.lines} lines, ${before.bytes} bytes); with netSpec: ${spec.lines} lines, ${spec.bytes} bytes`)
    expect(m.lines).toBeLessThanOrEqual(1500)
    expect(m.bytes).toBeLessThanOrEqual(60 * 1024)
  })
})
