import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { STEP_CATALOG, stepKeys, entry } = require('../lib/e2e/step-catalog.js')
const { parseFlow } = require('../lib/e2e/flow.js')
const netSteps = require('../lib/e2e/net-steps.js')
const stateSteps = require('../lib/e2e/state-steps.js')

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const parse = (line) => parseFlow(`appId: dev\nsteps:\n  ${line}\n`)
const caseKeys = (src) => [...src.matchAll(/case '([A-Za-z]+)'/g)].map((m) => m[1])

describe('step catalog (ADR 0047)', () => {
  it('has unique keys, valid groups and a lookup', () => {
    const keys = stepKeys()
    expect(new Set(keys).size).toBe(keys.length)
    const groups = ['app', 'input', 'wait', 'assert', 'state', 'net', 'flow']
    for (const e of STEP_CATALOG) {
      expect(groups).toContain(e.group)
      expect(e.detail).toBeTruthy()
      expect(e.snippet).toBeTruthy()
      expect([null, 'hub', 'logs']).toContain(e.needs)
      expect(entry(e.key)).toBe(e)
    }
    expect(entry('nope')).toBeUndefined()
    expect(Object.isFrozen(STEP_CATALOG)).toBe(true)
  })

  it('every example parses and yields the expected op', () => {
    for (const e of STEP_CATALOG) {
      const f = parse(e.example)
      expect(f.steps, e.key).toHaveLength(1)
      expect(f.steps[0].op, e.key).toBe(e.aliasOf || e.key)
    }
  })

  it('a bare entry parses as a bare step', () => {
    for (const e of STEP_CATALOG.filter((x) => x.bare)) {
      expect(() => parse(`- ${e.key}`), e.key).not.toThrow()
    }
  })

  it('the parser rejects a key that is not in the catalog', () => {
    expect(() => parse('- frobnicate: 1')).toThrow(/unknown step "frobnicate"/)
  })

  it('every step the parser or runner handles is in the catalog', () => {
    const known = new Set([...stepKeys(), 'assertMedia'])
    const flowSrc = read('../lib/e2e/flow.js')
    const runSrc = read('../lib/e2e/run.js')
    const handled = new Set([
      ...caseKeys(flowSrc.slice(flowSrc.indexOf('function normalizeStep'))),
      ...caseKeys(runSrc.slice(runSrc.indexOf('async function execStep'))),
      ...netSteps.NET_OPS, ...stateSteps.STATE_OPS,
      ...Object.keys(eval('(' + /const BARE_OPS = (\{[^}]*\})/.exec(flowSrc)[1] + ')')),
    ])
    const missing = [...handled].filter((k) => !known.has(k))
    expect(missing, `steps handled by the parser or runner but missing from lib/e2e/step-catalog.js: ${missing.join(', ')}`).toEqual([])
    // and the reverse: a catalog key the parser does not know is dead weight
    for (const k of stepKeys()) expect(handled.has(k), `${k} is in the catalog but the parser does not handle it`).toBe(true)
  })

  it('every catalog key appears in the flows doc and the flow-reference skill', () => {
    const docs = read('../docs/e2e/flows.md')
    const skill = read('../skills/writing-e2e-flows/references/flow-reference.md')
    for (const k of stepKeys()) {
      expect(docs, `docs/e2e/flows.md lacks ${k}`).toMatch(new RegExp(`\\b${k}\\b`))
      expect(skill, `flow-reference.md lacks ${k}`).toMatch(new RegExp(`\\b${k}\\b`))
    }
  })

  // Minimal valid samples per op with map keys the normalizers validate; each catalog key must be accepted
  // (an error about something else is fine), and a key outside the catalog must be rejected as unknown.
  const samples = {
    waitForAgent: {},
    setState: { path: 'a.b', value: 1 },
    snapshot: { name: 'x' },
    restore: { name: 'x' },
    callFunc: { node: { id: 'n' }, fn: 'f' },
    mockHttp: { url: '**/x', status: 200 },
    waitForRequest: { url: '**/x' },
    assertRequest: { url: '**/x' },
  }
  const run = (op, map) => {
    const mod = netSteps.NET_OPS.has(op) ? netSteps : stateSteps
    return mod.normalizeStep(op, map, 1, Error)
  }
  for (const [op, base] of Object.entries(samples)) {
    it(`${op}: catalog keys equal the keys the normalizer accepts`, () => {
      expect(() => run(op, { ...base, zzzUnknown: 1 })).toThrow(/unknown key "zzzUnknown"/)
      for (const k of entry(op).keys) {
        try { run(op, { ...base, [k]: base[k] === undefined ? 1 : base[k] }) } catch (e) {
          expect(String(e.message), `${op}.${k}`).not.toMatch(/unknown key/)
        }
      }
    })
  }
})
