import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { extractLcov } = require('../lib/device.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const capture = fs.readFileSync(path.join(here, 'fixtures/rooibos-517/console-capture.txt'), 'utf8')
const lines = capture.split(/\r?\n/)
const count = (re) => lines.filter((l) => re.test(l)).length

describe('extractLcov on a rooibos 5.17 console capture', () => {
  const out = extractLcov(capture)
  const outLines = out.text.split('\n').filter(Boolean)

  it('returns one record per file entry in the capture', () => {
    expect(count(/^SF:/)).toBe(16)
    expect(out.count).toBe(count(/^SF:/))
    expect(outLines.filter((l) => l.startsWith('SF:'))).toHaveLength(out.count)
    expect(outLines.filter((l) => l === 'end_of_record')).toHaveLength(out.count)
  })

  it('keeps every DA line and the LF/LH totals from the capture', () => {
    expect(outLines.filter((l) => /^DA:\d+,\d+$/.test(l))).toHaveLength(count(/^DA:\d+,\d+$/))
    expect(count(/^DA:/)).toBe(278)
    expect(outLines.filter((l) => l.startsWith('LF:'))).toHaveLength(count(/^LF:/))
    expect(outLines.filter((l) => l.startsWith('LH:'))).toHaveLength(count(/^LH:/))
  })

  it('emits only the TN/SF/DA/LF/LH/end_of_record block', () => {
    for (const l of outLines) expect(l).toMatch(/^(TN:|SF:.+|DA:\d+,\d+|LF:\d+|LH:\d+|end_of_record)$/)
  })

  it('ignores the coverage-counts stream', () => {
    expect(capture).toContain('+-=-coverage-counts:start')
    expect(out.text).not.toContain('coverage-counts')
    expect(out.text).not.toContain('{')
    expect(out.text).not.toContain('"v"')
  })
})

describe('extractLcov without an lcov block', () => {
  it('returns empty text and zero count', () => {
    expect(extractLcov('')).toEqual({ text: '', count: 0 })
    expect(extractLcov('[Rooibos Info]: done\n+-=-coverage-counts:start\n{"v":1}\n+-=-coverage-counts:end\n'))
      .toEqual({ text: '', count: 0 })
  })
})
