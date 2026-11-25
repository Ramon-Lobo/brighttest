import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { report } = require('../lib/coverage-headless.js')

const SHUTDOWN = '[Rooibos Shutdown]\n'
const summary = (total, passed, failed = 0) =>
  `Total:   ${total}\nPassed:  ${passed}\nCrashed: 0\nFailed:  ${failed}\nIgnored: 0\nRESULT: ${failed ? 'Fail' : 'Success'}\n`

function run(out, exit, state = { cases: [], passed: 0, failed: 0 }) {
  const write = process.stdout.write.bind(process.stdout)
  const werr = process.stderr.write.bind(process.stderr)
  let err = ''
  process.stdout.write = () => true
  process.stderr.write = (s) => { err += s; return true }
  try {
    return { code: report(out, {}, {}, [], null, false, state, false, exit), err }
  } finally {
    process.stdout.write = write
    process.stderr.write = werr
  }
}

describe('exit status and declared-vs-run count', () => {
  it('counts a non-zero exit before the Shutdown marker as a crash', () => {
    const r = run(summary(1, 1), { code: 3, signal: null })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/RUN CRASHED \(process exited with code 3\)/)
  })

  it('counts a signal exit before the Shutdown marker as a crash', () => {
    const r = run(summary(1, 1), { code: null, signal: 'SIGSEGV' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/RUN CRASHED \(process killed by SIGSEGV\)/)
  })

  it('counts fewer results than declared as a crash and names both numbers', () => {
    const r = run('Total:   5\nPassed:  3\nCrashed: 0\nFailed:  0\nIgnored: 0\n' + SHUTDOWN, { code: 0, signal: null })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/RUN CRASHED \(3 of 5 declared tests ran\)/)
  })

  it('leaves a normal run unchanged', () => {
    expect(run(summary(2, 2) + SHUTDOWN, { code: null, signal: 'SIGKILL' }).code).toBe(0)
    expect(run(summary(2, 2) + SHUTDOWN, undefined).code).toBe(0)
  })

  it('does not treat a non-zero exit after the Shutdown marker as a crash', () => {
    expect(run(summary(1, 1) + SHUTDOWN, { code: 1, signal: null }).code).toBe(0)
  })

  it('still fails a normal run that has a failing test', () => {
    expect(run(summary(2, 1, 1) + SHUTDOWN, { code: 0, signal: null }).code).toBe(1)
  })
})
