import { describe, it, expect } from 'vitest'
import { parseLcov, compressRanges, printCoverageTable } from '../lib/coverage-report.js'

describe('parseLcov', () => {
  it('parses a single file record into totals and uncovered lines', () => {
    const lcov = [
      'SF:source/util.brs',
      'DA:1,3',
      'DA:2,0',
      'DA:3,1',
      'DA:4,0',
      'end_of_record',
    ].join('\n')
    const [f] = parseLcov(lcov)
    expect(f.file).toBe('source/util.brs')
    expect(f.total).toBe(4)
    expect(f.covered).toBe(2)
    expect(f.uncovered).toEqual([2, 4])
  })

  it('parses multiple file records', () => {
    const lcov = [
      'SF:a.brs', 'DA:1,1', 'end_of_record',
      'SF:b.brs', 'DA:1,0', 'DA:2,0', 'end_of_record',
    ].join('\n')
    const files = parseLcov(lcov)
    expect(files.map((f) => f.file)).toEqual(['a.brs', 'b.brs'])
    expect(files[1]).toMatchObject({ total: 2, covered: 0, uncovered: [1, 2] })
  })

  it('handles CRLF line endings and ignores DA lines before any SF', () => {
    const lcov = 'DA:9,1\r\nSF:x.brs\r\nDA:1,1\r\nend_of_record\r\n'
    const files = parseLcov(lcov)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ file: 'x.brs', total: 1, covered: 1 })
  })

  it('returns an empty array for empty or blank input', () => {
    expect(parseLcov('')).toEqual([])
    expect(parseLcov('\n\n')).toEqual([])
  })
})

describe('compressRanges', () => {
  it('collapses consecutive runs and keeps singletons', () => {
    expect(compressRanges([2, 3, 4, 8, 11, 12])).toBe('2-4, 8, 11-12')
  })

  it('sorts unsorted input first', () => {
    expect(compressRanges([12, 2, 11, 3, 4, 8])).toBe('2-4, 8, 11-12')
  })

  it('handles single values and empty input', () => {
    expect(compressRanges([5])).toBe('5')
    expect(compressRanges([])).toBe('')
  })

  it('treats a full consecutive run as one range', () => {
    expect(compressRanges([1, 2, 3, 4, 5])).toBe('1-5')
  })
})

describe('printCoverageTable', () => {
  it('returns null when there is no coverage data', () => {
    expect(printCoverageTable('', { rootDir: '.' }, false)).toBeNull()
  })

  it('returns the overall line-coverage percentage across files', () => {
    const lcov = [
      'SF:a.brs', 'DA:1,1', 'DA:2,1', 'end_of_record',
      'SF:b.brs', 'DA:1,0', 'DA:2,0', 'end_of_record',
    ].join('\n')
    // 2 of 4 lines covered overall = 50%.
    const overall = printCoverageTable(lcov, { rootDir: '.' }, false)
    expect(overall).toBe(50)
  })

  it('reports 100% when every line is hit', () => {
    const lcov = ['SF:a.brs', 'DA:1,2', 'DA:2,5', 'end_of_record'].join('\n')
    expect(printCoverageTable(lcov, { rootDir: '.' }, false)).toBe(100)
  })
})
