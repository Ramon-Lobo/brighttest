import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { report } = require('../lib/coverage-headless.js')

function junitFor(out, killReason, timeout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-junit-'))
  const file = path.join(dir, 'junit.xml')
  const write = process.stdout.write.bind(process.stdout)
  const werr = process.stderr.write.bind(process.stderr)
  process.stdout.write = () => true
  process.stderr.write = () => true
  let code
  try {
    code = report(out, {}, { junit: file, timeout }, [], killReason, false, { cases: [], passed: 0, failed: 0 }, false)
  } finally {
    process.stdout.write = write
    process.stderr.write = werr
  }
  const xml = fs.readFileSync(file, 'utf8')
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, xml }
}

describe('JUnit for a run that did not complete', () => {
  it('writes one failing testcase when the run timed out', () => {
    const { code, xml } = junitFor('', 'timeout', 30)
    expect(code).toBe(1)
    expect(xml).toContain('tests="1" failures="1"')
    expect(xml).toMatch(/<testcase name="run did not complete"><failure>timed out after 30s<\/failure>/)
  })

  it('writes one failing testcase when no result was printed', () => {
    const { code, xml } = junitFor('', undefined)
    expect(code).toBe(1)
    expect(xml).toMatch(/<testcase name="run did not complete"><failure>no test result was printed/)
  })
})
