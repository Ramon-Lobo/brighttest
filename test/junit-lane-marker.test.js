import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { buildJunit, caseFile, xmlEsc } = require('../lib/reporter.js')
const { parseJunit } = require('../lib/features/overlay.js')
const device = require('../lib/device.js')
const { loadConfig } = require('../lib/config.js')

describe('buildJunit', () => {
  const cases = [
    { name: 'adds', suite: 'MathTests', file: 'source/tests/Math.spec.bs', ok: true },
    { name: 'breaks', suite: 'MathTests', file: 'source/tests/Math.spec.bs', ok: false, message: 'expected 1' },
  ]
  for (const lane of ['headless', 'device']) {
    it(`writes the ${lane} lane property, classname and file`, () => {
      const xml = buildJunit({ lane, cases, extras: [{ name: 'run did not complete', reason: 'x' }] })
      expect(xml).toContain(`<property name="brighttest.lane" value="${lane}"/>`)
      expect(xml).toContain('<testsuite name="brighttest" tests="3" failures="2">')
      expect(xml).toContain('<testcase name="adds" classname="MathTests" file="source/tests/Math.spec.bs"/>')
      expect(xml).toContain('<testcase name="run did not complete"><failure>x</failure></testcase>')
      const p = parseJunit(xml)
      expect(p.lane).toBe(lane)
      expect(p.cases.map((c) => [c.name, c.status, c.file, c.classname])).toEqual([
        ['adds', 'passed', 'source/tests/Math.spec.bs', 'MathTests'],
        ['breaks', 'failed', 'source/tests/Math.spec.bs', 'MathTests'],
        ['run did not complete', 'failed', '', ''],
      ])
    })
  }

  it('omits file and classname when unknown', () => {
    expect(buildJunit({ lane: 'headless', cases: [{ name: 'a', ok: true }] })).toContain('<testcase name="a"/>')
  })

  it('escapes quotes, angle brackets and control characters, and the result still parses', () => {
    const name = 'a "q" <b> & \'c\' \u0001\u0007 end'
    const xml = buildJunit({ lane: 'device', cases: [{ name, suite: 'S<"1">', file: 'a"b<c>.spec.bs', ok: false, message: 'm <x> \u0000 "y"' }] })
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
    expect(xml).toContain('name="a &quot;q&quot; &lt;b&gt; &amp; &apos;c&apos; �� end"')
    const c = parseJunit(xml).cases[0]
    expect(c.name).toBe('a "q" <b> & \'c\' �� end')
    expect(c.classname).toBe('S<"1">')
    expect(c.file).toBe('a"b<c>.spec.bs')
    expect(c.status).toBe('failed')
  })

  it('replaces lone surrogates and keeps valid pairs', () => {
    expect(xmlEsc('x\uD800y')).toBe('x�y')
    expect(xmlEsc('ok \u{1F600}')).toBe('ok \u{1F600}')
  })

  it('caseFile drops the line number and normalises separators', () => {
    expect(caseFile('source/tests/A.spec.bs:12')).toBe('source/tests/A.spec.bs')
    expect(caseFile('source\\tests\\A.spec.bs:3')).toBe('source/tests/A.spec.bs')
    expect(caseFile(null)).toBe('')
  })
})

describe('device lane JUnit (injected runner result, no device)', () => {
  let dir, cfg
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-junit-dev-'))
    cfg = loadConfig(dir, null)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

  const fakeChild = (out, code = 0) => {
    const c = new EventEmitter()
    c.pid = 4243
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
    c.kill = () => setTimeout(() => c.emit('close', null, 'SIGKILL'), 1)
    setTimeout(() => { c.stdout.emit('data', Buffer.from(out)); c.emit('close', code) }, 5)
    return c
  }
  const lease = { leaseId: 'x', reentrant: false, addChild: () => {}, release: () => {} }
  const deps = (out) => ({ homeBeforeDeploy: async () => null, acquireForLane: async () => ({ lease }), spawn: () => fakeChild(out) })
  const rooibos = (ok) => [
    '> SUITE: MathTests>>>>',
    '>>>>>> It: adds>>>>>>',
    `Location: file://${dir}/source/tests/Math.spec.bs:7`,
    '<<<< END It: adds (PASS) <<<<',
    '>>>>>> It: breaks>>>>>>',
    `Location: file://${dir}/source/tests/Math.spec.bs:15`,
    `<<<< END It: breaks (${ok ? 'PASS' : 'FAIL'}) <<<<`,
    `[Rooibos Result]: ${ok ? 'PASS' : 'FAIL'}`,
    `Total  = 2`,
    '',
  ].join('\n')

  it('writes a device-lane JUnit with classname and file when --junit is given', async () => {
    const junit = path.join(dir, 'reports', 'device.xml')
    const code = await device.run(cfg, { host: '127.0.0.1', password: 'pw', junit }, deps(rooibos(true)))
    expect(code).toBe(0)
    const xml = fs.readFileSync(junit, 'utf8')
    expect(xml).toContain('<property name="brighttest.lane" value="device"/>')
    expect(xml).toContain('<testcase name="adds" classname="MathTests" file="source/tests/Math.spec.bs"/>')
    expect(parseJunit(xml).lane).toBe('device')
  })

  it('records a failing case and still writes the file when the run fails', async () => {
    const junit = path.join(dir, 'd.xml')
    const code = await device.run(cfg, { host: '127.0.0.1', password: 'pw', junit }, deps(rooibos(false)))
    expect(code).toBe(1)
    const xml = fs.readFileSync(junit, 'utf8')
    expect(xml).toMatch(/<testcase name="breaks" classname="MathTests" file="source\/tests\/Math.spec.bs"><failure>/)
    expect(xml).toContain('failures="1"')
  })

  it('writes a failing "run did not complete" case when no result was printed', async () => {
    const junit = path.join(dir, 'e.xml')
    const code = await device.run(cfg, { host: '127.0.0.1', password: 'pw', junit }, deps('nothing useful\n'))
    expect(code).toBe(1)
    expect(fs.readFileSync(junit, 'utf8')).toContain('name="run did not complete"')
  })

  it('writes nothing without --junit', async () => {
    await device.run(cfg, { host: '127.0.0.1', password: 'pw' }, deps(rooibos(true)))
    expect(fs.existsSync(path.join(dir, 'reports'))).toBe(false)
  })
})
