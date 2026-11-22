import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'
import { buildJunit, esc } from '../lib/e2e/junit.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

let dir, cfg
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-junit-'))
  cfg = loadConfig(dir, null)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const acquire = async () => ({ lease: { release() {} } })
const flowFile = (name, head, steps) => {
  const f = path.join(dir, name + '.e2e.yaml')
  fs.writeFileSync(f, `appId: dev\nconfig: { timeout: 1 }\n${head}steps:\n${steps.map((s) => '  - ' + s).join('\n')}\n`)
  return f
}
async function runWith(flows, extra = {}) {
  const stub = createFakeRoku({ scenario: 'replay-then-live' })
  const a = await stub.start()
  const junit = path.join(dir, 'out', 'junit.xml')
  try {
    const code = await e2e.run(cfg, { e2eAction: 'run', flows, host: a.host, ecpPort: a.ecpPort, logPort: a.debugPort,
      screenshots: path.join(dir, 'shots'), screenshotsMode: 'off', junit, ...extra }, { acquireForLane: acquire })
    return { code, xml: fs.readFileSync(junit, 'utf8') }
  } finally { await stub.stop() }
}
// Minimal well-formedness check: tags nest, attributes are quoted, no raw < or & inside values.
function assertWellFormed(xml) {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
  xml = xml.slice(xml.indexOf('\n') + 1)
  const stack = []
  const tagRe = /<(\/?)([A-Za-z?][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos|#\d+);[^"<&]*)*")*)\s*(\/?)>/g
  let last = 0, m
  while ((m = tagRe.exec(xml))) {
    const between = xml.slice(last, m.index)
    expect(between).not.toMatch(/<|&(?!(amp|lt|gt|quot|apos|#\d+);)/)
    last = tagRe.lastIndex
    if (m[1]) expect(stack.pop()).toBe(m[2])
    else if (!m[4]) stack.push(m[2])
  }
  expect(xml.slice(last).trim()).toBe('')
  expect(stack).toEqual([])
}
const attr = (s, k) => (new RegExp(`${k}="([^"]*)"`).exec(s) || [])[1]

describe('e2e run --junit', () => {
  it('passing, failing and skipped flows give the right suites, counts and codes', async () => {
    const pass = flowFile('a-pass', '', ['launch'])
    const fail = flowFile('b-fail', '', ['launch', `assertLog: 'never <seen> & "quoted"'`])
    const skip = flowFile('c-skip', 'requires: { firmware: ">=999" }\n', ['launch'])
    const { code, xml } = await runWith([pass, fail, skip])
    expect(code).toBe(1)
    assertWellFormed(xml)
    expect(xml.match(/<testsuite /g)).toHaveLength(3)
    const top = /<testsuites [^>]*>/.exec(xml)[0]
    expect([attr(top, 'tests'), attr(top, 'failures'), attr(top, 'skipped')]).toEqual(['3', '1', '1'])
    const suite = (n) => new RegExp(`<testsuite name="[^"]*${n}[^"]*"[^>]*>[\\s\\S]*?</testsuite>`).exec(xml)[0]
    expect(xml).toContain('<testsuite name="a-pass.e2e.yaml"')
    expect(suite('a-pass')).toMatch(/failures="0" skipped="0"/)
    expect(suite('a-pass')).not.toMatch(/<failure|<skipped/)
    expect(suite('b-fail')).toMatch(/failures="1" skipped="0"/)
    expect(suite('b-fail')).toMatch(/<failure message="step 2 \(assertLog\): [^"]*&lt;seen&gt; &amp; /)
    expect(suite('c-skip')).toMatch(/failures="0" skipped="1"/)
    expect(suite('c-skip')).toMatch(/<skipped message="requires firmware/)
  }, 20000)

  it('is deterministic for the same results', async () => {
    const f = flowFile('d-pass', '', ['launch'])
    const one = await runWith([f])
    const two = await runWith([f])
    expect(one.xml).toBe(two.xml)
  }, 20000)

  it('a passing run still exits 0 and a failing one exits 1 (same as without --junit)', async () => {
    const ok = await runWith([flowFile('e-pass', '', ['launch'])])
    expect(ok.code).toBe(0)
    const bad = await runWith([flowFile('f-fail', '', ['launch', 'assertLog: "never printed"'])])
    expect(bad.code).toBe(1)
  }, 20000)

  it('--fail-on-skip keeps its exit 1 and the skip stays a skip in the file', async () => {
    const { code, xml } = await runWith([flowFile('g-pass', '', ['launch']), flowFile('h-skip', 'requires: { firmware: ">=999" }\n', ['launch'])], { failOnSkip: true })
    expect(code).toBe(1)
    expect(xml).toMatch(/<testsuites [^>]*tests="2" failures="0" skipped="1"/)
  }, 20000)
})

describe('junit builder', () => {
  it('escapes special characters in names and messages', () => {
    expect(esc('a<b>&"c\'')).toBe('a&lt;b&gt;&amp;&quot;c&apos;')
    const xml = buildJunit([
      { suite: 'x<y.e2e.yaml', name: 'n&"', status: 'failed', step: '1 (press)', code: 'KEY_NOT_ALLOWED', message: 'bad <key> & "more"' },
      { suite: 'x<y.e2e.yaml', name: 'z', status: 'skipped', message: 'needs <12 & "up"' },
    ])
    assertWellFormed(xml)
    expect(xml).toContain('type="KEY_NOT_ALLOWED"')
    expect(xml).toContain('step 1 (press): KEY_NOT_ALLOWED: bad &lt;key&gt; &amp; &quot;more&quot;')
  })
  it('drops characters XML cannot carry', () => {
    expect(esc('a\u0000b\u001bc')).toBe('abc')
  })
})
