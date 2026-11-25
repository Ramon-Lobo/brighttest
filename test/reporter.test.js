import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { palette, relLoc, lineSplitter, parseSummary, laneFailures, treeFailures, treeCases, droppedCases, engineCrash, failureMessages, makeReporter } from '../lib/reporter.js'

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

// An @async case in an @SGNode suite that never calls m.done(): Rooibos stops running the suite, prints `Total: 0 /
// RESULT: Success`, and lists every case as PASS in the tree even though the later ones never ran.
describe('droppedCases (async timeout in a node suite)', () => {
  const tree = (names) => names.map((n) => `  | |--${n} : ....................PASS (0ms)\n  |   |--Test : file:///p/a.spec.bs:1`).join('\n')
  const end = (n) => `<<<< END It: ${n} (PASS) <<<<<<<<<<`
  const stopped = [
    '>>>>>> It: a>>>>>>', end('a'), '>>>>>> It: b>>>>>>', end('b'), '>>>>>> It: slow>>>>>>',
    ' [START TEST REPORT]', '  |-g1', tree(['a', 'b', 'slow', 'c', 'd']),
    ' Total: 0', '   Passed: 0', '   Crashed: 0', '   Failed: 0', '   Ignored: 0', ' RESULT: Success', ' [END TEST REPORT]',
  ].join('\n')

  it('parses every test line of the report tree, not group or Test lines', () => {
    expect(treeCases(stopped).map((t) => t.name)).toEqual(['a', 'b', 'slow', 'c', 'd'])
  })

  it('returns the unfinished case and the cases after it, each with a reason', () => {
    const d = droppedCases(stopped)
    expect(d.map((x) => x.name)).toEqual(['slow', 'c', 'd'])
    expect(d[0].reason).toMatch(/m\.done\(\)/)
    expect(d[1].reason).toMatch(/stopped at "slow"/)
  })

  it('counts them as failures so the lane cannot pass', () => {
    expect(laneFailures(stopped, 0).failed).toBe(3)
  })

  it('returns nothing when the summary total matches the tree', () => {
    const ok = stopped.replace(' Total: 0', ' Total: 5').replace('   Passed: 0', '   Passed: 5').replace('>>>>>> It: slow>>>>>>', '>>>>>> It: slow>>>>>>\n' + [end('slow'), end('c'), end('d')].join('\n'))
    expect(droppedCases(ok)).toEqual([])
  })

  it('ignores a PASS case that streamed an END marker even when other suites ran (status skip)', () => {
    const withFail = stopped.replace('| |--slow : ....................PASS (0ms)', '| |--slow : ....................FAIL (0ms)')
    expect(droppedCases(withFail).map((x) => x.name)).toEqual(['c', 'd'])
  })

  it('does not double count a duplicated case name: each END marker consumes one tree entry', () => {
    const dup = [
      '>>>>>> It: same>>>>', end('same'), '>>>>>> It: same>>>>',
      ' [START TEST REPORT]', tree(['same', 'same', 'x']), ' Total: 9', ' RESULT: Success',
    ].join('\n')
    expect(droppedCases(dup).map((x) => x.name)).toEqual(['same', 'x'])
  })

  it('opens the gate on an unfinished It: marker even when ignored tests lift Total to the tree size', () => {
    const lifted = stopped.replace(' Total: 0', ' Total: 20').replace('   Ignored: 0', '   Ignored: 17')
    expect(droppedCases(lifted).map((x) => x.name)).toEqual(['slow', 'c', 'd'])
    expect(laneFailures(lifted, 0).failed).toBe(3)
  })

  it('returns nothing without a summary (null-summary guard)', () => {
    expect(droppedCases(stopped.replace(' Total: 0', ' Nope: 0'))).toEqual([])
    expect(droppedCases('')).toEqual([])
  })

  it('does not report a started-and-ended case as open when its END has no status', () => {
    const t = 'a'.repeat(66)
    const out = [
      `>>>>>> It: ${t}>>>>`, `<<<< END It: ${t.slice(0, 56)}...<<`, '>>>>>> It: b>>>>', end('b'),
      ' [START TEST REPORT]', tree([t.slice(0, 49), 'b']), ' Total: 2', ' RESULT: Success',
    ].join('\n')
    expect(droppedCases(out)).toEqual([])
  })

  it('names the true stalled case when a 66-character name before it was truncated', () => {
    const t = 'a'.repeat(66)
    const out = [
      `>>>>>> It: ${t}>>>>`, `<<<< END It: ${t.slice(0, 56)}...<<`, '>>>>>> It: slow>>>>',
      ' [START TEST REPORT]', tree([t.slice(0, 49), 'slow', 'after']), ' Total: 0', ' RESULT: Success',
    ].join('\n')
    const d = droppedCases(out)
    expect(d.map((x) => x.name)).toEqual(['slow', 'after'])
    expect(d[0].reason).toMatch(/started but never finished/)
    expect(d[1].reason).toMatch(/stopped at "slow"/)
  })

  it('does not match a short name as the prefix of a longer one', () => {
    const out = [
      '>>>>>> It: sync 10>>>>', end('sync 10'), '>>>>>> It: slow>>>>',
      ' [START TEST REPORT]', tree(['sync 1', 'sync 10', 'slow']), ' Total: 0', ' RESULT: Success',
    ].join('\n')
    expect(droppedCases(out).map((x) => x.name)).toEqual(['sync 1', 'slow'])
  })

  it('matches @params cases by position: streamed `params 0` ends cover tree `[1,2]` entries', () => {
    const out = [
      '>>>>>> It: params 0>>>>', end('params 0'), '>>>>>> It: params 1>>>>', end('params 1'),
      '>>>>>> It: slow>>>>',
      ' [START TEST REPORT]', tree(['[1,2]', '[3,4]', 'slow', '[5,6]']), ' Total: 0', ' RESULT: Success',
    ].join('\n')
    const d = droppedCases(out)
    expect(d.map((x) => x.name)).toEqual(['slow', '[5,6]'])
    expect(d[0].reason).toMatch(/started but never finished/)
  })

  it('names a stalled @params case as the stop point', () => {
    const out = [
      '>>>>>> It: params 0>>>>', end('params 0'), '>>>>>> It: params 1>>>>',
      ' [START TEST REPORT]', tree(['[1,2]', '[3,4]', 'after']), ' Total: 0', ' RESULT: Success',
    ].join('\n')
    const d = droppedCases(out)
    expect(d.map((x) => x.name)).toEqual(['[3,4]', 'after'])
    expect(d[0].reason).toMatch(/started but never finished/)
  })

  it('names the actually stalled case when an @ignore\'d case sits before it', () => {
    const out = [
      '>>>>>> It: b>>>>', end('b'), '>>>>>> It: slow>>>>',
      ' [START TEST REPORT]', tree(['ignored', 'b', 'slow', 'after']), ' Total: 0', ' RESULT: Success',
    ].join('\n')
    const d = droppedCases(out)
    expect(d.map((x) => x.name)).toEqual(['ignored', 'slow', 'after'])
    expect(d.filter((x) => /started but never finished/.test(x.reason)).map((x) => x.name)).toEqual(['slow'])
    expect(d[0].reason).toMatch(/stopped at "slow".*@ignore/)
  })

  it('does not claim a stalled case when the open one is not in the tree', () => {
    const out = [
      '>>>>>> It: mystery>>>>',
      ' [START TEST REPORT]', tree(['x', 'y']), ' Total: 0', ' RESULT: Success',
    ].join('\n')
    const d = droppedCases(out)
    expect(d.map((x) => x.name)).toEqual(['x', 'y'])
    expect(d.some((x) => /started but never finished/.test(x.reason))).toBe(false)
  })

  it('strips ANSI colour from the report tree', () => {
    const colored = stopped.split('\n').map((l) => `\x1b[32m${l}\x1b[39m`).join('\n')
    expect(treeCases(colored).map((t) => t.name)).toEqual(['a', 'b', 'slow', 'c', 'd'])
  })

  it('adds the dropped count to the streamed failures rather than taking the larger', () => {
    expect(laneFailures(stopped, 2).failed).toBe(5)
  })
})

describe('engineCrash: a run the engine killed must not read as green', () => {
  const head = '> SUITE: S>>>>>>>>>>\n>>>>>> It: a>>>>>>\n<<<< END It: a (PASS) <<<<\n>>>>>> It: b>>>>>>\n<<<< END It: b (PASS) <<<<\n'
  const fin = "pkg:/components/W.brs(4,4-6): 'Dot' Operator attempted with invalid BrightScript Component or interface reference.\n------ Finished 'x.zip' execution [EXIT_BRIGHTSCRIPT_CRASH] ------\n"

  it('is null for a clean run, and for a test name that merely mentions the exit reason', () => {
    expect(engineCrash(head + 'RESULT: Success\n')).toBeNull()
    expect(engineCrash(head + '>>>>>> It: EXIT_BRIGHTSCRIPT_CRASH handling>>>>>>\n<<<< END It: EXIT_BRIGHTSCRIPT_CRASH handling (PASS) <<<<\n')).toBeNull()
  })

  it('treats any exit reason except EXIT_USER_NAV as abnormal', () => {
    const line = (r) => `------ Finished 'x.zip' execution [${r}] ------\n`
    expect(engineCrash(head + line('EXIT_USER_NAV'))).toBeNull()
    expect(laneFailures(head + line('EXIT_USER_NAV'), 0).failed).toBe(0)
    expect(engineCrash(head + line('EXIT_BRIGHTSCRIPT_STOP')).reason).toBe('EXIT_BRIGHTSCRIPT_STOP')
    expect(laneFailures(head + line('EXIT_BRIGHTSCRIPT_STOP'), 0).failed).toBe(1)
    expect(engineCrash(head + '  ' + line('EXIT_USER_NAV').replace('USER_NAV', 'USER_NAV_X')).reason).toBe('EXIT_USER_NAV_X')
  })

  it('names the case that was running when the engine died', () => {
    const c = engineCrash(head + '>>>>>> It: c>>>>>>\n' + fin)
    expect(c.reason).toBe('EXIT_BRIGHTSCRIPT_CRASH')
    expect(c.cases).toHaveLength(1)
    expect(c.cases[0].name).toBe('c')
    expect(c.cases[0].reason).toMatch(/crashed \(EXIT_BRIGHTSCRIPT_CRASH\)/)
  })

  it('falls back to one "run crashed" entry when no case was open', () => {
    expect(engineCrash(head + fin).cases.map((x) => x.name)).toEqual(['run crashed'])
  })

  it('counts the crash as a failure even though every streamed case passed and there is no summary', () => {
    expect(laneFailures(head + '>>>>>> It: c>>>>>>\n' + fin, 0).failed).toBe(1)
    expect(laneFailures(head + fin, 0).failed).toBe(1)
    expect(laneFailures(head + 'Total: 2\n  Passed: 2\nRESULT: Success\n' + fin, 0).failed).toBe(1)
  })
})
