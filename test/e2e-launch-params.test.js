import { createRequire } from 'module'
import { describe, it, expect } from 'vitest'
const require = createRequire(import.meta.url)
const { parseFlow } = require('../lib/e2e/flow')
const { execStep } = require('../lib/e2e/run')

const flow = (launch) => `steps:\n  - launch: ${launch}\n`

describe('launch param validation (flow)', () => {
  it('rejects an object value and names the key and the fix', () => {
    expect(() => parseFlow(flow('{ params: { netdiag: x } }'))).toThrow(/launch param "params" must be a string, number or boolean \(got object\); use the flat form/)
  })
  it('rejects arrays and null', () => {
    expect(() => parseFlow(flow('{ a: [1] }'))).toThrow(/"a".*got array/)
    expect(() => parseFlow(flow('{ a: null }'))).toThrow(/"a".*got null/)
  })
  it('accepts string, number and boolean', () => {
    const f = parseFlow(flow('{ a: x, b: 3, c: true }'))
    expect(f.steps[0].params).toEqual({ a: 'x', b: 3, c: true })
  })
})

describe('launch param guard (runner)', () => {
  const mk = (launched) => ({
    keypress: async () => {}, launch: async (id, params) => { launched.push(params); return {} },
  })
  it('rejects a hand-built step that bypasses flow validation, before any device call', async () => {
    const calls = []
    const device = { keypress: async () => calls.push('key'), launch: async () => calls.push('launch') }
    const err = await execStep({ op: 'launch', line: 4, params: { k: { x: 1 } } }, { device, opts: {}, flow: {}, stepTimeoutMs: 100 }).catch((e) => e)
    expect(String(err.message)).toMatch(/launch param "k" must be a string, number or boolean \(got object\)/)
    expect(calls).toEqual([])
  })
  it('flat form still reaches device.launch with the same params', async () => {
    const launched = []
    await execStep({ op: 'launch', line: 1, params: { a: 'x', b: 3 } }, { device: mk(launched), opts: {}, flow: {}, stepTimeoutMs: 100 }).catch(() => {})
    expect(launched[0]).toEqual({ a: 'x', b: 3 })
  })
})
