import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { extractLcov, extractLcovFull } = require('../lib/device.js')
const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'lcov-full', 'coverage-dir.lcov.info'), 'utf8')
const lines = (t, re) => t.split('\n').filter((l) => re.test(l))

describe('extractLcovFull', () => {
  it('keeps function and branch records that extractLcov strips', () => {
    const full = extractLcovFull(FIXTURE)
    expect(full.count).toBe(7)
    expect(lines(full.text, /^FN:/).length).toBeGreaterThan(0)
    expect(lines(full.text, /^FNDA:/).length).toBeGreaterThan(0)
    expect(lines(full.text, /^BRDA:/).length).toBe(64)
    expect(lines(full.text, /^(FNF|FNH|BRF|BRH):/).length).toBeGreaterThan(0)
    expect(extractLcov(FIXTURE).text).not.toMatch(/^(FN|BRDA|BRF)/m)
  })
  it('the SF/DA/LF/LH records equal extractLcov output', () => {
    const re = /^(TN:|SF:|DA:|LF:|LH:|end_of_record)/
    expect(lines(extractLcovFull(FIXTURE).text, re)).toEqual(lines(extractLcov(FIXTURE).text, re))
  })
  it('keeps a BRDA with a "-" taken count', () => {
    const t = 'TN:\nSF:a.brs\nBRDA:3,0,0,-\nBRDA:3,0,1,2\nBRF:2\nBRH:1\nend_of_record\n'
    expect(extractLcovFull(t).text).toContain('BRDA:3,0,0,-')
  })
  it('drops rooibos/ framework records', () => {
    const t = FIXTURE + 'TN:\nSF:pkg:/components/rooibos/Framework.brs\nFN:1,x\nDA:1,1\nLF:1\nLH:1\nend_of_record\n'
    const full = extractLcovFull(t)
    expect(full.count).toBe(7)
    expect(full.text).not.toContain('rooibos/')
  })
  it('strips ANSI escapes and accepts CRLF', () => {
    const t = 'TN:\r\nSF:a\x1b[36m.brs\x1b[0m\r\nFN:1,\x1b[32mf\x1b[0m\r\nFNDA:2,f\r\nDA:1,\x1b[33m2\x1b[0m\r\nLF:1\r\nLH:1\r\nend_of_record\r\n'
    expect(extractLcovFull(t).text).toBe('TN:\nSF:a.brs\nFN:1,f\nFNDA:2,f\nDA:1,2\nLF:1\nLH:1\nend_of_record\n')
  })
  it('returns nothing for text without records', () => {
    expect(extractLcovFull('no coverage here')).toEqual({ text: '', count: 0 })
  })
})
