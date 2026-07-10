import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { makeProject, makeEmptyDir, runCli, exists, cleanupTemp } from './helpers.js'

afterAll(cleanupTemp)

describe('brighttest init', () => {
  let dir, initRes, runRes
  beforeAll(() => {
    dir = makeEmptyDir()
    initRes = runCli(dir, ['init'])
    // The scaffolded project should be runnable as-is.
    runRes = runCli(dir)
  })

  it('scaffolds config, an example spec, and .gitignore', () => {
    expect(initRes.status).toBe(0)
    expect(exists(dir, 'brighttest.json')).toBe(true)
    expect(exists(dir, 'source/tests/Example.spec.bs')).toBe(true)
    expect(exists(dir, '.gitignore')).toBe(true)
  })

  it('produces a project whose example suite passes', () => {
    expect(runRes.status).toBe(0)
    expect(runRes.output).toContain('passed')
  })
})

describe('brighttest skills export', () => {
  let dir, res
  beforeAll(() => {
    dir = makeEmptyDir()
    res = runCli(dir, ['skills', 'export', '--out', 'exported'])
  })

  it('dumps the bundled skill folders', () => {
    expect(res.status).toBe(0)
    expect(exists(dir, 'exported/writing-rooibos-tests')).toBe(true)
    expect(exists(dir, 'exported/setting-up-brighttest')).toBe(true)
    expect(exists(dir, 'exported/debugging-failing-tests')).toBe(true)
  })
})

describe('brighttest --help', () => {
  it('prints usage and exits 0', () => {
    const res = runCli(makeProject(), ['--help'])
    expect(res.status).toBe(0)
    expect(res.output).toContain('brighttest')
    expect(res.output).toContain('Usage:')
  })
})
