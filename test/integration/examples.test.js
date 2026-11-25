import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runCli, cleanupTemp } from './helpers.js'

// Runs the generic example fixture apps through the real CLI (headless lane) and smoke-tests the legacy
// app's scale generator. Each app is copied to a temp dir so no staging output lands in the repo.
const require = createRequire(import.meta.url)
const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples')
const tmp = []
function copyApp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ex-'))
  tmp.push(d)
  fs.cpSync(path.join(EXAMPLES, name), d, { recursive: true, filter: (s) => !/[\\/](\.brighttest|coverage)$/.test(s) })
  return d
}
afterAll(() => { cleanupTemp(); for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }) })

describe('greenfield-app', () => {
  it('passes headless with pure and @SGNode suites; ignored suites do not run', () => {
    const res = runCli(copyApp('greenfield-app'))
    expect(res.status).toBe(0)
    expect(res.output).toContain('30 passed, 0 failed')
    expect(res.output).toContain('6 suites')
  })
})

describe('legacy-app', () => {
  it('passes headless', () => {
    const res = runCli(copyApp('legacy-app'))
    expect(res.status).toBe(0)
    expect(res.output).toContain('15 passed, 0 failed')
  })

  it('census matches EXPECTED-CENSUS.json', () => {
    const { census } = require(path.join(EXAMPLES, 'legacy-app', 'tools', 'scale.js'))
    const expected = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'legacy-app', 'EXPECTED-CENSUS.json'), 'utf8'))
    expect(census(path.join(EXAMPLES, 'legacy-app'))).toEqual(expected)
  })

  it('scale.js emits N component copies with unique names', () => {
    const { scale, census } = require(path.join(EXAMPLES, 'legacy-app', 'tools', 'scale.js'))
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-scale-')), 'out')
    tmp.push(path.dirname(out))
    const c = scale(3, out)
    const base = census(path.join(EXAMPLES, 'legacy-app'))
    expect(c.components).toBe(base.components * 3)
    expect(c.brsFiles).toBe(base.brsFiles + (base.brsFiles - 3 /* source-level .brs */) * 2)
    const names = []
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.xml')) names.push(/<component\s+name="(\w+)"/.exec(fs.readFileSync(p, 'utf8'))[1])
    })
    walk(path.join(out, 'components'))
    expect(new Set(names).size).toBe(names.length)
  }, 30000)
})
