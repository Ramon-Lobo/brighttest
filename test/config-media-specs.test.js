import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { writeBsConfig, findMediaSpecs, findNetSpecs } = require('../lib/config.js')
const crossCheck = require('../lib/cross-check.js')

// COV-16: the BTMedia_* headless media-state driver: detection, staging, device-lane skip, cross-check line.
let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-media-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }) })

const cfgAt = (root, over = {}) => ({
  rootDir: root, sourceGlobs: ['manifest', 'source/**/*'], testsFilePattern: '**/*.spec.bs', stagingDir: path.join(root, '.brighttest'), ...over,
})
const put = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const bs = (p) => JSON.parse(fs.readFileSync(p.bsconfigPath, 'utf8'))
const logs = (fn) => { const out = []; const o = console.log; console.log = (m) => out.push(m); try { fn() } finally { console.log = o } return out.join('\n') }
const STAGE = (f) => f && typeof f === 'object' && f.dest === 'source/bt/BTMedia.brs'

describe('findMediaSpecs', () => {
  it('finds specs that use BTMedia_ and their suite names, and only those', () => {
    put('source/tests/A.spec.bs', '@suite("alpha")\nBTMedia_load(v)\n')
    put('source/tests/B.spec.bs', '@suite("beta")\nBTNet_reset()\n')
    put('source/tests/C.spec.bs', '@suite("gamma")\n')
    expect(findMediaSpecs(cfgAt(tmp))).toEqual([{ path: 'source/tests/A.spec.bs', suites: ['alpha'] }])
    expect(findNetSpecs(cfgAt(tmp)).map((x) => x.path)).toEqual(['source/tests/B.spec.bs'])
  })
  it('skips node_modules and the staging dir', () => {
    put('node_modules/x/A.spec.bs', 'BTMedia_load(v)\n')
    put('.brighttest/A.spec.bs', 'BTMedia_load(v)\n')
    expect(findMediaSpecs(cfgAt(tmp))).toEqual([])
  })
})

describe('writeBsConfig with BTMedia_ specs', () => {
  beforeEach(() => { put('manifest', 'title=x\n'); put('source/tests/A.spec.bs', '@suite("alpha")\nBTMedia_load(v)\n') })

  it.each(['headless', 'headless-scene', 'headless-coverage'])('stages the driver on the %s lane', (lane) => {
    let p
    logs(() => { p = writeBsConfig(cfgAt(tmp), lane) })
    const entry = bs(p).files.find(STAGE)
    expect(entry.src).toBe(path.join(__dirname, '..', 'lib', 'spec-api', 'BTMedia.brs'))
    expect(fs.existsSync(entry.src)).toBe(true)
    expect(bs(p).files).not.toContain('!source/tests/A.spec.bs')
  })

  it('the device lane negates the spec, prints the reason and stages nothing', () => {
    let p
    const out = logs(() => { p = writeBsConfig(cfgAt(tmp), 'device') })
    expect(bs(p).files).toContain('!source/tests/A.spec.bs')
    expect(bs(p).files.find(STAGE)).toBeUndefined()
    expect(out).toContain('skipped (headless-only media driver): source/tests/A.spec.bs')
  })

  it('the plain headless lane notes that it has no roSGNode', () => {
    expect(logs(() => writeBsConfig(cfgAt(tmp), 'headless'))).toContain('no roSGNode')
    expect(logs(() => writeBsConfig(cfgAt(tmp), 'headless-scene'))).not.toContain('no roSGNode')
  })

  it('without a BTMedia_ spec the bsconfig has no media entry and prints nothing', () => {
    fs.rmSync(path.join(tmp, 'source', 'tests', 'A.spec.bs'))
    put('source/tests/B.spec.bs', '@suite("beta")\n')
    for (const lane of ['headless', 'headless-scene', 'device']) {
      let p
      const out = logs(() => { p = writeBsConfig(cfgAt(tmp), lane) })
      expect(bs(p).files).toEqual(['manifest', 'source/**/*'])
      expect(out).toBe('')
    }
  })
})

describe('driver source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'spec-api', 'BTMedia.brs'), 'utf8')
  it('defines every documented BTMedia_ function', () => {
    const defined = [...src.matchAll(/^\s*function\s+(BTMedia_\w+)/gim)].map((m) => m[1])
    for (const f of ['load', 'play', 'tick', 'pause', 'resume', 'stop', 'finish', 'fail', 'next', 'sync']) expect(defined).toContain(`BTMedia_${f}`)
  })
  it('has no timers, wall clock, hub or network use', () => {
    expect(src).not.toMatch(/roTimespan|roUrlTransfer|createObject\(\s*"roDateTime"|\bsleep\(/i)
  })
})

describe('cross-check with BTMedia_ suites', () => {
  it('counts them as headless-only by design, not as unexpected or divergent', async () => {
    put('manifest', 'title=x\n')
    put('source/tests/A.spec.bs', '@suite("alpha")\nBTMedia_load(v)\n')
    const HL = '> SUITE: alpha\nDescribe: g\n<<<< END It: a (PASS)\n> SUITE: S\nDescribe: G\n<<<< END It: t (PASS)\n'
    const DEV = '> SUITE: S\nDescribe: G\n<<<< END It: t (PASS)\n'
    const lines = []
    vi.spyOn(console, 'log').mockImplementation((m) => lines.push(String(m)))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = {
      headless: async () => ({ built: true, output: HL }),
      acquireForLane: async () => ({ lease: null }),
      buildAndRun: async () => ({ output: DEV, status: 0, timedOut: false }),
    }
    const code = await crossCheck.run(cfgAt(tmp), { host: '127.0.0.1', password: 'pw' }, deps)
    const text = lines.join('\n')
    expect(code).toBe(0)
    expect(text).toContain('headless-only    : 1  (BTMedia_ media-driver specs, skipped on the device by design)')
    expect(text).not.toContain('unexpected')
    expect(text).toContain('DIVERGENT        : 0')
  })
})
