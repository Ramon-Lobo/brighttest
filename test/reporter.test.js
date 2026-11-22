import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { palette, relLoc, lineSplitter, parseSummary, laneFailures, treeFailures, failureMessages, makeReporter } from '../lib/reporter.js'

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

// file:// URLs and the project root are built per platform (win32 resolves '/proj' against a drive); the
// expected paths are compared with separators folded to '/'.
const PROJ = path.resolve('/proj')
const fileUrl = (...p) => pathToFileURL(path.resolve('/', ...p)).href
const fwd = (s) => s.replace(/\\/g, '/')

describe('relLoc', () => {
  const cfg = { rootDir: PROJ }

  it('strips file:// and makes the path project-relative with its line', () => {
    expect(fwd(relLoc(cfg, fileUrl('proj/source/a.spec.bs') + ':12'))).toBe('source/a.spec.bs:12')
  })

  it('falls back to the absolute path when outside rootDir', () => {
    expect(fwd(relLoc(cfg, fileUrl('other/b.spec.bs') + ':3'))).toBe(fwd(path.resolve('/other/b.spec.bs')) + ':3')
  })

  it('returns the path without a suffix when there is no line number', () => {
    expect(fwd(relLoc(cfg, fileUrl('proj/source/a.spec.bs')))).toBe('source/a.spec.bs')
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
    const cfg = { rootDir: PROJ }
    const { onLine, state } = makeReporter(cfg, false)
    const spec = fileUrl('proj/source/math.spec.bs')
    const lines = [
      '> SUITE: math >>>>',
      'Location: ' + spec + ':1',
      '>>>>>> It: adds',
      'Location: ' + spec + ':10',
      '<<<< END It: adds (PASS)',
      '>>>>>> It: subtracts',
      'Location: ' + spec + ':20',
      '<<<< END It: subtracts (FAIL)',
    ]
    for (const l of lines) onLine(l)
    expect(state.passed).toBe(1)
    expect(state.failed).toBe(1)
    expect(state.cases).toHaveLength(2)
    expect(state.cases[0]).toMatchObject({ suite: 'math', name: 'adds', ok: true })
    expect(state.cases[1]).toMatchObject({ name: 'subtracts', ok: false })
    expect(fwd(state.cases[1].loc)).toBe('source/math.spec.bs:20')
  })
})

describe('crashed test line', () => {
  const CRASH_OUT = [
    '> SUITE: Boom suite one>>>>',
    '>>>>>> It: raises>>>>>>>>>>',
    '  Location: file:///proj/source/Boom.spec.bs:8',
    '<<<< END It: raises (CRASH) <<<<<<<<<<<<<<<<',
    '> SUITE: Boom suite two>>>>',
    '<<<< END It: still passes (PASS) <<<<<<<<<<<<',
    ' [START TEST REPORT]',
    '  Boom suite one file:///proj/source/Boom.spec.bs:3',
    '  | |--raises : .............................................CRASH (-1ms)',
    '  |   |--Crashed at: file:///proj/source/Boom.spec.bs:8',
    "  |   |--Message: 'Dot' Operator attempted with invalid reference. (runtime error &hec)",
    ' Total: 2', '   Passed: 1', '   Crashed: 1', '   Failed: 0', '   Ignored: 0', ' RESULT: Fail',
  ].join('\n')

  it('streams a crashed test as a failed case and keeps the failed tally', () => {
    const write = process.stdout.write
    let printed = ''
    process.stdout.write = (s) => { printed += s; return true }
    let rep
    try {
      rep = makeReporter({ rootDir: '/proj' }, false)
      for (const l of CRASH_OUT.split('\n')) rep.onLine(l)
    } finally { process.stdout.write = write }
    expect(rep.state.cases[0]).toMatchObject({ suite: 'Boom suite one', name: 'raises', ok: false, crashed: true })
    expect(rep.state.failed).toBe(1)
    expect(printed).toContain('✗ raises')
  })

  it('collects the crash message without the runtime error code', () => {
    expect(failureMessages(CRASH_OUT)).toEqual({ raises: "'Dot' Operator attempted with invalid reference." })
  })
})

describe('laneFailures report-tree guard', () => {
  const summary = (t, p, f, c) => `Total:   ${t}\nPassed:  ${p}\nCrashed: ${c}\nFailed:  ${f}\nIgnored: 0\nRESULT: Success\n`
  const crashTree = '|--Suite\n|  |--first test : CRASH\n|  |  Message: boom (runtime error &h02)\n'

  it('counts a tree-only CRASH when the summary says Total 0 / Success', () => {
    const out = crashTree + summary(0, 0, 0, 0)
    expect(treeFailures(out)).toEqual(['first test'])
    expect(laneFailures(out, 0).failed).toBe(1)
  })

  it('does not double count a tree failure the summary already counted', () => {
    const out = '|--Suite\n|  |--t : FAIL\n' + summary(1, 0, 1, 0)
    expect(laneFailures(out, 1).failed).toBe(1)
    expect(laneFailures(out, 0).failed).toBe(1)
  })

  it('catches a truncated long-name crash line and ignores a passing name containing CRASH', () => {
    const name = 'skips markers, built-ins, invalid values and type mismatches'
    const out = `|--Suite : ... PASS\n|  |--${name}.....CRASH\n|  |  Message: boom\n|  |--maps state: CRASH to error screen : ... PASS\n`
    expect(treeFailures(out)).toEqual([name])
    expect(failureMessages(out)[name]).toBe('boom')
    expect(treeFailures('|--maps state: CRASH to error screen : ... PASS\r\n\x1b[31m|--x : FAIL\x1b[0m\r\n')).toEqual(['x'])
  })

  it('does not trigger for empty or all-ignored groups', () => {
    expect(laneFailures(summary(0, 0, 0, 0), 0).failed).toBe(0)
    expect(laneFailures('|--Suite\n|  |--t : IGNORE\n' + summary(1, 0, 0, 0), 0).failed).toBe(0)
    expect(treeFailures('no tree here')).toEqual([])
  })
})
