import { describe, it, expect } from 'vitest'
import sg from '../lib/e2e/sgnodes.js'
import { matchOne } from '../lib/e2e/select.js'

const treeXml = (n) => {
  let kids = ''
  for (let i = 0; i < n - 1; i++) kids += `<Label name="n${i}" text="t"/>`
  return `<sgnodes><All_Nodes node-count="${n}"><Default/><Scene name="s">${kids}</Scene></All_Nodes><status>OK</status></sgnodes>`
}
function fakeDevice(n) {
  const calls = []
  const xml = treeXml(n)
  return {
    calls,
    ecpGet: async (p) => {
      calls.push(p)
      if (p.startsWith('/query/sgnodes/nodes?')) return { status: 200, text: `<sgnodes><All_Nodes node-count="1"><Default/><Label name="n100" text="t"/></All_Nodes><status>OK</status></sgnodes>` }
      return { status: 200, text: xml }
    },
  }
}
const clock = () => { let t = 1000; return { now: () => t, sleepFn: async (ms) => { t += ms; clock.slept.push(ms) } } }
clock.slept = []

describe('large-tree policy (ROB-11)', () => {
  it('documents the constants', () => {
    expect(sg.LARGE_TREE_NODES).toBe(3000)
    expect(sg.LARGE_TREE_MIN_INTERVAL_MS).toBe(2000)
  })

  it('selector with an id uses nodes?node-id= and never fetches the full tree', async () => {
    const d = fakeDevice(10)
    const t = await sg.fetchTreeFor(d, { id: 'n100' })
    expect(d.calls).toEqual(['/query/sgnodes/nodes?node-id=n100'])
    expect(t.fastPath).toBe(true)
    expect(matchOne(t.roots, { id: 'n100' })).not.toBeNull()
  })

  it('falls back to the full tree on a miss or when the selector needs the whole tree', async () => {
    const d = fakeDevice(10)
    await sg.fetchTreeFor(d, { id: 'missing' })
    expect(d.calls).toEqual(['/query/sgnodes/nodes?node-id=missing', '/query/sgnodes/all'])
    const d2 = fakeDevice(10)
    await sg.fetchTreeFor(d2, { id: 'n1', index: 0 })
    await sg.fetchTreeFor(d2, { subtype: 'Label' })
    expect(d2.calls).toEqual(['/query/sgnodes/all', '/query/sgnodes/all'])
  })

  it('rate-limits full reads of trees above 3,000 nodes', async () => {
    const d = fakeDevice(3001)
    const c = clock(); clock.slept = []
    await sg.fetchTree(d, c)
    await sg.fetchTree(d, c)
    expect(d.calls).toHaveLength(2)
    expect(clock.slept).toEqual([2000])
  })

  it('does not limit trees at or below 3,000 nodes', async () => {
    const d = fakeDevice(3000)
    const c = clock(); clock.slept = []
    await sg.fetchTree(d, c)
    await sg.fetchTree(d, c)
    expect(clock.slept).toEqual([])
  })

  it('serveCached returns the last large tree inside the interval, refetches after', async () => {
    const d = fakeDevice(3500)
    let t = 5000
    const o = { now: () => t, sleepFn: async () => { throw new Error('should not sleep') }, serveCached: true }
    const a = await sg.fetchTree(d, o)
    t += 300
    const b = await sg.fetchTree(d, o)
    expect(b).toBe(a)
    expect(d.calls).toHaveLength(1)
    t += 2000
    const c2 = await sg.fetchTree(d, o)
    expect(c2).not.toBe(a)
    expect(d.calls).toHaveLength(2)
  })
})
