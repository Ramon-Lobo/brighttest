import { describe, it, expect } from 'vitest'
import { palette, relLoc, lineSplitter, failureMessages, makeReporter } from '../lib/reporter.js'

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
