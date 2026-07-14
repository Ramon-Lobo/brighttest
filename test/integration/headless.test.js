import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeProject, runCli, readFile, exists, cleanupTemp } from './helpers.js'

afterAll(cleanupTemp)

describe('default headless lane (compiles + runs on the simulator, incl. @SGNode)', () => {
  let res
  beforeAll(() => { res = runCli(makeProject()) })

  it('exits 0 when all suites pass', () => {
    expect(res.status).toBe(0)
  })

  it('runs the pure suite and the @SGNode scene suite headless', () => {
    // 3 = 2 math tests + the Widget node test; 2 suites = math + Widget.
    expect(res.output).toContain('3 passed, 0 failed')
    expect(res.output).toContain('2 suites')
  })

  it('exercises the onChange cascade with a seeded global (Widget test passed)', () => {
    // This line only prints as a pass if the node ran headless, read the seeded multiplier,
    // and the onChange observer fired (3 * 2 = 6).
    expect(res.output).toContain('✓ doubles count via seeded multiplier')
  })
})

describe('a failing spec fails the run', () => {
  let res
  beforeAll(() => {
    const dir = makeProject()
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'Broken.spec.bs'), [
      'namespace tests',
      '  @suite("broken")',
      '  class BrokenTests extends rooibos.BaseTestSuite',
      '    @describe("fail")',
      '    @it("fails on purpose")',
      '    function _()',
      '      m.assertEqual(1, 2)',
      '    end function',
      '  end class',
      'end namespace',
      '',
    ].join('\n'))
    res = runCli(dir, ['--no-sgnode'])
  })

  it('exits non-zero', () => {
    expect(res.status).not.toBe(0)
  })

  it('reports the failure with its reason', () => {
    expect(res.output).toContain('Failures')
    expect(res.output).toContain('fails on purpose')
    expect(res.output).toContain('1 failed')
  })
})

describe('a long-named failing test is still counted (scene lane, no false green)', () => {
  let res
  beforeAll(() => {
    const dir = makeProject()
    // A test name long enough that Rooibos truncates its END-It marker's (FAIL). The tally must still
    // come out as a failure — this is the regression guard for the reporter's authoritative summary.
    const longName = 'this is a very long failing test name that definitely exceeds the eighty one character marker width'
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'LongFail.spec.bs'), [
      'namespace tests',
      '  @suite("longfail")',
      '  class LongFailTests extends rooibos.BaseTestSuite',
      '    @describe("long")',
      `    @it("${longName}")`,
      '    function _()',
      '      m.assertEqual(1, 2)',
      '    end function',
      '  end class',
      'end namespace',
      '',
    ].join('\n'))
    // Default lane → scene runner (project has @SGNode specs), which is where the truncation bug lived.
    res = runCli(dir)
  })

  it('exits non-zero and reports the failure in the tally', () => {
    expect(res.status).not.toBe(0)
    expect(res.output).toContain('1 failed')
  })
})

describe('--no-sgnode skips @SGNode suites', () => {
  let res
  beforeAll(() => { res = runCli(makeProject(), ['--no-sgnode']) })

  it('exits 0 and skips the node suite', () => {
    expect(res.status).toBe(0)
    expect(res.output).toContain('@SGNode skipped')
    // Only the 2 pure math tests run when node suites are skipped.
    expect(res.output).toContain('2 passed, 0 failed')
  })
})

describe('--junit writes a report', () => {
  let dir, res
  beforeAll(() => {
    dir = makeProject()
    res = runCli(dir, ['--no-sgnode', '--junit', 'reports/junit.xml'])
  })

  it('exits 0 and writes valid-looking JUnit XML', () => {
    expect(res.status).toBe(0)
    expect(exists(dir, 'reports/junit.xml')).toBe(true)
    const xml = readFile(dir, 'reports/junit.xml')
    expect(xml).toContain('<?xml')
    expect(xml).toContain('<testsuite name="brighttest"')
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="0"')
  })
})
