import { describe, it, expect } from 'vitest'
import { palette, relLoc, lineSplitter, parseSummary, failureMessages, makeReporter } from '../lib/reporter.js'

describe('palette', () => {
  it('wraps strings in ANSI codes when enabled', () => {
    const c = palette(true)
    expect(c.green('ok')).toBe('\x1b[32mok\x1b[39m')
    expect(c.bold('x')).toBe('\x1b[1mx\x1b[22m')
  })

  it('is a no-op passthrough when disabled', () => {
    const c = palette(false)
    expect(c.green('ok')).toBe('ok')
    expect(c.red(42)).toBe('42')
  })
})

describe('relLoc', () => {
  const cfg = { rootDir: '/proj' }

  it('strips file:// and makes the path project-relative with its line', () => {
    expect(relLoc(cfg, 'file:///proj/source/a.spec.bs:12')).toBe('source/a.spec.bs:12')
  })

  it('falls back to the absolute path when outside rootDir', () => {
    expect(relLoc(cfg, 'file:///other/b.spec.bs:3')).toBe('/other/b.spec.bs:3')
  })

  it('returns the path without a suffix when there is no line number', () => {
    expect(relLoc(cfg, 'file:///proj/source/a.spec.bs')).toBe('source/a.spec.bs')
  })
})

describe('lineSplitter', () => {
  it('emits complete lines and strips ANSI codes', () => {
    const seen = []
    const s = lineSplitter((l) => seen.push(l))
    s.push('\x1b[32mhello\x1b[39m\nwor')
    s.push('ld\n')
    expect(seen).toEqual(['hello', 'world'])
  })

  it('handles CRLF and CR line endings', () => {
    const seen = []
    const s = lineSplitter((l) => seen.push(l))
    s.push('a\r\nb\rc\n')
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('flush() emits a trailing partial line', () => {
    const seen = []
    const s = lineSplitter((l) => seen.push(l))
    s.push('partial')
    expect(seen).toEqual([])
    s.flush()
    expect(seen).toEqual(['partial'])
  })
})

describe('failureMessages', () => {
  it('maps each failed test name to its error message', () => {
    const report = [
      '|--adds two numbers : ....... FAIL',
      '  Error Message: Expected 5 but got 6',
      '|--other test : ....... FAIL',
      '  Error Message: nope',
    ].join('\n')
    expect(failureMessages(report)).toEqual({
      'adds two numbers': 'Expected 5 but got 6',
      'other test': 'nope',
    })
  })

  it('returns an empty object when there are no failures', () => {
    expect(failureMessages('all good\nno failures here')).toEqual({})
  })
})

describe('parseSummary', () => {
  const block = (extra = '') => [
    '[START TEST REPORT]',
    '  Total: 5',
    '  Passed: 4',
    '  Crashed: 0',
    '  Failed: 1',
    '  Ignored: 0',
    '  Time: 46ms',
    extra,
    ' RESULT: Fail',
    '[END TEST REPORT]',
  ].join('\n')

  it('reads the authoritative totals', () => {
    expect(parseSummary(block())).toEqual({ total: 5, passed: 4, crashed: 0, failed: 1, ignored: 0 })
  })

  it('counts crashes separately (caller treats them as failures)', () => {
    const s = parseSummary('Total: 3\nPassed: 1\nCrashed: 2\nFailed: 0\nIgnored: 0')
    expect(s.crashed).toBe(2)
    expect(s.failed + s.crashed).toBe(2)
  })

  it('does not mistake "Total Coverage:" for the totals block', () => {
    expect(parseSummary('Total Coverage: 46.15385% (18/39)')).toBeNull()
  })

  it('returns null when there is no summary block', () => {
    expect(parseSummary('some output\nno report here')).toBeNull()
  })

  it('takes the last (grand total) block when several appear', () => {
    const out = 'Total: 2\nPassed: 2\nFailed: 0\n---\nTotal: 9\nPassed: 7\nFailed: 2'
    expect(parseSummary(out)).toMatchObject({ total: 9, passed: 7, failed: 2 })
  })
})

describe('makeReporter', () => {
  it('accumulates pass/fail counts and cases as lines stream in', () => {
    const cfg = { rootDir: '/proj' }
    const { onLine, state } = makeReporter(cfg, false)
    const lines = [
      '> SUITE: math >>>>',
      'Location: file:///proj/source/math.spec.bs:1',
      '>>>>>> It: adds',
      'Location: file:///proj/source/math.spec.bs:10',
      '<<<< END It: adds (PASS)',
      '>>>>>> It: subtracts',
      'Location: file:///proj/source/math.spec.bs:20',
      '<<<< END It: subtracts (FAIL)',
    ]
    for (const l of lines) onLine(l)
    expect(state.passed).toBe(1)
    expect(state.failed).toBe(1)
    expect(state.cases).toHaveLength(2)
    expect(state.cases[0]).toMatchObject({ suite: 'math', name: 'adds', ok: true })
    expect(state.cases[1]).toMatchObject({ name: 'subtracts', ok: false, loc: 'source/math.spec.bs:20' })
  })
})
