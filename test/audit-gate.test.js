import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { evaluate, ALLOWED } = require('../scripts/audit-gate.js')

const adv = (id, name, severity = 'high') => ({ name, severity, url: `https://github.com/advisories/${id}`, source: 1 })

describe('audit gate', () => {
  it('allows listed advisories and the packages that only depend on them', () => {
    const report = { vulnerabilities: {
      'decode-uri-component': { severity: 'high', via: [adv('GHSA-vcc3-ghjq-m6fr', 'decode-uri-component'), adv('GHSA-qr28-fpjm-wq7f', 'decode-uri-component')] },
      'source-map-resolve': { severity: 'high', via: ['decode-uri-component'] },
    } }
    const r = evaluate(report)
    expect(r.failing).toEqual([])
    expect(r.allowed.map((a) => a.pkg).sort()).toEqual(['decode-uri-component', 'source-map-resolve'])
  })
  it('fails on an unlisted high advisory, even next to a listed one', () => {
    const report = { vulnerabilities: {
      'decode-uri-component': { severity: 'high', via: [adv('GHSA-vcc3-ghjq-m6fr', 'decode-uri-component'), adv('GHSA-new-new-new', 'decode-uri-component')] },
    } }
    expect(evaluate(report).failing.map((f) => f.pkg)).toEqual(['decode-uri-component'])
  })
  it('ignores moderate and low advisories', () => {
    expect(evaluate({ vulnerabilities: { qs: { severity: 'moderate', via: [adv('GHSA-x', 'qs', 'moderate')] } } }).failing).toEqual([])
  })
  it('every allowed entry has a reason and a review date', () => {
    for (const a of ALLOWED) { expect(a.reason.length).toBeGreaterThan(20); expect(a.review).toMatch(/^\d{4}-\d{2}-\d{2}$/) }
  })
})
