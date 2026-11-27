import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ss = require('../lib/e2e/state-steps.js')

// A fake hub records hold (watch) and release calls; state reads must pair them, also when the read throws.
function fakeHub() {
  const calls = []
  return {
    calls, hellos: 1,
    hold() { calls.push('hold'); let done = false; return () => { if (!done) { done = true; calls.push('release') } } },
    stateOps: { prepare() { throw new Error('boom') }, getSnapshot() { return {} } },
    push() { throw new Error('unused') },
  }
}
const ctxFor = (hub) => ({ state: { hub, helloBase: 0, snapshots: new Set(), scope: 's' }, stepTimeoutMs: 100 })

describe('state reads hold a hub watch', () => {
  it('execStep: one hold and one release around a read', async () => {
    const hub = fakeHub()
    await ss.execStep({ op: 'waitForAgent' }, ctxFor(hub))
    expect(hub.calls).toEqual(['hold', 'release'])
  })
  it('execStep: a step that throws still releases', async () => {
    const hub = fakeHub()
    await expect(ss.execStep({ op: 'setState', layer: 'registry', path: 'a.b', value: 1 }, ctxFor(hub))).rejects.toThrow()
    expect(hub.calls).toEqual(['hold', 'release'])
  })
  it('assertNode: a failing read releases', async () => {
    const hub = fakeHub(); hub.hellos = 0
    await expect(ss.assertNode({ layer: 'node', node: { id: 'x' }, path: 'p', equals: 1 }, ctxFor(hub))).rejects.toThrow()
    expect(hub.calls).toEqual(['hold', 'release'])
  })
  it('withWatch: no hold() on the hub runs the read as-is; nested holds each release', async () => {
    expect(await ss.withWatch({ hub: {} }, async () => 7)).toBe(7)
    const hub = fakeHub()
    await ss.withWatch({ hub }, () => ss.withWatch({ hub }, async () => 1))
    expect(hub.calls).toEqual(['hold', 'hold', 'release', 'release'])
  })
})
