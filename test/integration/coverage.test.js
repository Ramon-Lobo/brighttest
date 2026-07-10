import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeProject, runCli, readFile, exists, cleanupTemp } from './helpers.js'

afterAll(cleanupTemp)

describe('headless coverage lane (--coverage, no device)', () => {
  let dir, res
  beforeAll(() => {
    dir = makeProject()
    res = runCli(dir, ['--coverage', '--lcov', 'coverage/lcov.info', '--junit', 'reports/junit.xml'])
  })

  it('exits 0', () => {
    expect(res.status).toBe(0)
  })

  it('writes an LCOV report with the source and the @SGNode component (framework records filtered)', () => {
    expect(exists(dir, 'coverage/lcov.info')).toBe(true)
    const lcov = readFile(dir, 'coverage/lcov.info')
    expect(lcov).toContain('SF:source/Math.bs')
    expect(lcov).toContain('SF:components/Widget.bs')
    expect(lcov).toContain('DA:') // line-hit records present
    expect(lcov).not.toContain('rooibos/generated') // internal records stripped
  })

  it('prints the coverage table with an overall line percentage', () => {
    expect(res.output).toContain('Coverage — lines/statements')
    expect(res.output).toContain('All files')
    expect(res.output).toMatch(/lines \d+\.\d+%/)
  })

  it('also writes JUnit when requested', () => {
    expect(exists(dir, 'reports/junit.xml')).toBe(true)
    expect(readFile(dir, 'reports/junit.xml')).toContain('<testsuite name="brighttest"')
  })
})
