import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { execStep } = require('../lib/e2e/run')
const { getPathCI } = require('../lib/e2e/appstate')

const agentXml = (layers) => {
  const doc = JSON.stringify({ v: 1, seq: 1, snapshot: { layers }, truncated: [] }).replace(/"/g, '&quot;')
  return `<sgnodes><All_Nodes><Default name="" /><Scene name="root"><Label name="__bt_agent" text="${doc}" /></Scene></All_Nodes><status>OK</status></sgnodes>`
}
const ctx = (layers, ms = 300) => ({ device: { async ecpGet() { return { status: 200, text: agentXml(layers) } } }, stepTimeoutMs: ms })

describe('assertState path matching ignores case', () => {
  it('matches a differently cased path against a lowercased wire key', async () => {
    const c = ctx({ global: { titlecount: 12, nested: { itemid: 'a' } } })
    await expect(execStep({ op: 'assertState', layer: 'global', path: 'titleCount', equals: 12 }, c)).resolves.toBeTruthy()
    await expect(execStep({ op: 'assertState', layer: 'global', path: 'Nested.itemId', equals: 'a' }, c)).resolves.toBeTruthy()
    await expect(execStep({ op: 'assertState', layer: 'Global', path: 'titlecount', equals: 12 }, c)).resolves.toBeTruthy()
  })
  it('exact case wins when both cases exist', () => {
    expect(getPathCI({ a: 1, A: 2 }, 'A').value).toBe(2)
    expect(getPathCI({ a: 1, A: 2 }, 'a').value).toBe(1)
    expect(getPathCI({ a: 1 }, 'A').value).toBe(1)
  })
  it('lists available keys (no values) when nothing matches', async () => {
    const c = ctx({ global: { titlecount: 12, secret: 'hunter2' } })
    const err = await execStep({ op: 'assertState', layer: 'global', path: 'nope', equals: 1 }, c).catch((e) => e)
    expect(err.message).toMatch(/path "nope" not found \(have: titlecount, secret\)/)
    expect(err.message).not.toMatch(/hunter2/)
  })
})

describe('launch op presses Home first when params are set', () => {
  afterEach(() => { vi.useRealTimers() })
  const run = async (step, launchParams) => {
    vi.useFakeTimers()
    const calls = []
    const device = {
      async keypress(k) { calls.push(['keypress', k, Date.now()]) },
      async launch(app, params) { calls.push(['launch', params, Date.now()]); throw new Error('stop') },
    }
    const p = execStep(step, { device, opts: {}, flow: {}, launchParams, stepTimeoutMs: 100 }).catch(() => {})
    await vi.advanceTimersByTimeAsync(2000)
    await p
    return calls
  }
  it('non-empty params: Home, wait 800 ms, then launch', async () => {
    const calls = await run({ op: 'launch', params: { contentId: 'x' } })
    expect(calls.map((c) => c[0] + (c[1] === 'Home' ? ':Home' : ''))).toEqual(['keypress:Home', 'launch'])
    expect(calls[1][2] - calls[0][2]).toBe(800)
    expect(calls[1][1]).toEqual({ contentId: 'x' })
  })
  it('matrix params also trigger Home', async () => {
    const calls = await run({ op: 'launch' }, { contentId: 'y' })
    expect(calls.map((c) => c[0])).toEqual(['keypress', 'launch'])
  })
  it('empty params: no Home press', async () => {
    const calls = await run({ op: 'launch' })
    expect(calls.map((c) => c[0])).toEqual(['launch'])
  })
})
