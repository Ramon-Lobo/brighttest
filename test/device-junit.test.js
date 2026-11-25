import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { finishDevice } = require('../lib/device.js')
const { makeReporter, lineSplitter } = require('../lib/reporter.js')
const overlay = require('../lib/features/overlay.js')

const ROOT = path.resolve('/proj')
const abs = (p) => 'file://' + path.join(ROOT, p).replace(/\\/g, '/')

const PASS_OUT = [
  '> SUITE: Resume Suite >>>>',
  '>>>>>> It: restores >>>>>>',
  '   Location: ' + abs('source/tests/Resume.spec.bs') + ':10',
  '<<<< END It: restores (PASS) <<<<',
  '>>>>>> It: saves >>>>>>',
  '   Location: ' + abs('source/tests/Resume.spec.bs') + ':20',
  '<<<< END It: saves (FAIL) <<<<',
  '[START TEST REPORT]',
  'Total  = 2',
  '[Rooibos Result]: FAIL',
  '',
].join('\n')

function run(out, { didTimeout = false, didIdle = false, junit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dj-'))
  const file = path.join(dir, 'sub', 'junit.xml')
  const w = process.stdout.write.bind(process.stdout)
  const we = process.stderr.write.bind(process.stderr)
  process.stdout.write = () => true
  process.stderr.write = () => true
  const cfg = { rootDir: ROOT }
  const rep = makeReporter(cfg, false)
  const sp = lineSplitter(rep.onLine)
  let code
  try {
    sp.push(out)
    sp.flush()
    code = finishDevice(cfg, junit ? { junit: file, timeout: 30 } : {}, out, rep.state, false, didTimeout, null, didIdle)
  } finally {
    process.stdout.write = w
    process.stderr.write = we
  }
  const xml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, xml }
}

describe('device lane JUnit', () => {
  it('writes the device marker, classname and a project-relative file attribute', () => {
    const { code, xml } = run(PASS_OUT)
    expect(code).toBe(1)
    expect(xml).toContain('<property name="brighttest.lane" value="device"/>')
    expect(xml).toContain('classname="Resume Suite" file="source/tests/Resume.spec.bs"')
    expect(xml).toContain('tests="2"')
    expect(xml).toMatch(/name="saves"[^>]*><failure>/)
    const j = overlay.parseJunit(xml)
    expect(j.lane).toBe('device')
    expect(j.cases.every((c) => c.lane === 'device')).toBe(true)
  })
  it('writes no file when --junit is not set', () => {
    expect(run(PASS_OUT, { junit: false }).xml).toBeNull()
  })
  it('omits the file attribute for a location outside the project', () => {
    const out = PASS_OUT.split(abs('source/tests/Resume.spec.bs')).join('file:///elsewhere/X.spec.bs')
    const { xml } = run(out)
    expect(xml).not.toContain(' file=')
  })
  it('a run with no result is a failing marked file, never green', () => {
    const { code, xml } = run('deploy error\n')
    expect(code).toBe(1)
    expect(xml).toContain('value="device"')
    expect(xml).toMatch(/<testcase name="run did not complete"><failure>no test result was printed/)
  })
  it('a timed-out run is a failing marked file', () => {
    const { code, xml } = run(PASS_OUT.replace('[Rooibos Result]: FAIL', ''), { didTimeout: true })
    expect(code).toBe(1)
    expect(xml).toContain('value="device"')
    expect(xml).toMatch(/<failure>timed out after 30s<\/failure>/)
  })
  it('an idle-killed run is a failing marked file even if a result streamed', () => {
    const { code, xml } = run(PASS_OUT, { didIdle: true })
    expect(code).toBe(1)
    expect(xml).toContain('run did not complete')
  })
})
