import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { report, flushUnread } = require('../lib/coverage-headless.js')

const { lineSplitter } = require('../lib/reporter.js')

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

describe('JUnit for a crashed run', () => {
  it('has one crash entry and no extra "did not complete" entry', () => {
    const out = ">>>>>> It: a>>>>>>\n<<<< END It: a (PASS) <<<<\n------ Finished 'x.zip' execution [EXIT_BRIGHTSCRIPT_CRASH] ------\n"
    const { code, xml } = junitFor(out, undefined)
    expect(code).toBe(1)
    expect(xml).toContain('name="run crashed"')
    expect(xml).not.toContain('run did not complete')
    expect(xml).toContain('failures="1"')
  })
})

describe('flushUnread (end-of-run flush by byte offset)', () => {
  it('streams the unread tail when earlier output has multibyte characters, and the unterminated last line', () => {
    const first = 'a \u2014 b\n'
    const lines = []
    const sp = lineSplitter((l) => lines.push(l))
    const raw = Buffer.from(first + 'last chunk before exit')
    sp.push(first)
    flushUnread(raw, Buffer.byteLength(first), sp)
    expect(lines).toEqual(['a \u2014 b', 'last chunk before exit'])
  })

  it('still flushes a pending partial line when no new bytes arrived', () => {
    const lines = []
    const sp = lineSplitter((l) => lines.push(l))
    sp.push('partial \u2014 line')
    flushUnread(Buffer.from('partial \u2014 line'), Buffer.byteLength('partial \u2014 line'), sp)
    expect(lines).toEqual(['partial \u2014 line'])
  })
})

describe('crash and missing LCOV are loud', () => {
  const quiet = (fn) => {
    const w = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr)
    let err = ''
    process.stdout.write = () => true
    process.stderr.write = (s) => { err += s; return true }
    try { return { code: fn(), err } } finally { process.stdout.write = w; process.stderr.write = e }
  }
  const ok = '[Rooibos Result]: PASS\nRESULT: Success\n'
  const st = { cases: [], passed: 1, failed: 0 }

  it('fails a coverage run with no LCOV block', () => {
    const { code, err } = quiet(() => report(ok, {}, {}, [], undefined, true, st, false))
    expect(code).toBe(1)
    expect(err).toContain('coverage requested but no LCOV in output')
  })

  it('leaves a normal run alone', () => {
    const { code, err } = quiet(() => report(ok, {}, {}, [], undefined, false, st, false))
    expect(code).toBe(0)
    expect(err).not.toContain('LCOV')
  })

  it('fails a run that ends in a native FATAL ERROR', () => {
    const out = ok + 'FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw\n'
    const { code, err } = quiet(() => report(out, {}, {}, [], undefined, false, st, false))
    expect(code).toBe(1)
    expect(err).toContain('RUN CRASHED')
  })
})
