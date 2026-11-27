import { describe, it, expect } from 'vitest'

const load = async () => ({ ...(await import('../lib/studio/web/src/lib/drag.js')), ...(await import('../lib/studio/web/src/lib/layout.js')), ...(await import('../lib/studio/web/src/lib/tiles.js')) })

describe('studio tile drag maths', () => {
  it('maps grid width to cell pitch and pointer travel to whole cells', async () => {
    const { metrics, cellDelta } = await load()
    const m = metrics(1188) // 12 columns of 88 px and 11 gaps of 12 px
    expect(m.colW).toBe(88)
    expect(m.stepX).toBe(100)
    expect(m.stepY).toBe(44)
    expect(cellDelta(m, 149, -23)).toEqual({ cx: 1, cy: -1 })
    expect(cellDelta(m, 51, 21)).toEqual({ cx: 1, cy: 0 })
    expect(cellDelta(m, 0, 0)).toEqual({ cx: 0, cy: 0 })
  })

  it('separates a click from a drag at 4 px and switches to one column under 960 px', async () => {
    const { pastThreshold, isNarrow } = await load()
    expect(pastThreshold(3, 0)).toBe(false)
    expect(pastThreshold(3, 3)).toBe(true)
    expect(isNarrow(959)).toBe(true)
    expect(isNarrow(960)).toBe(false)
    expect(isNarrow(0)).toBe(false) // a hidden page measures 0 wide: not narrow
  })

  it('previews a move and clamps it to the grid', async () => {
    const { dragPreview, metrics, defaultLayout, inspectRegistry } = await load()
    const L = defaultLayout(inspectRegistry)
    const m = metrics(1188)
    const mon = L.find((t) => t.id === 'monitor')
    const start = { x: mon.x, y: mon.y, w: mon.w, h: mon.h }
    const right = dragPreview(L, 'monitor', start, 'move', m, 1000, 0, inspectRegistry)
    expect(right.find((t) => t.id === 'monitor').x).toBe(12 - mon.w)
    const left = dragPreview(L, 'monitor', start, 'move', m, -1000, 0, inspectRegistry)
    expect(left.find((t) => t.id === 'monitor').x).toBe(0)
    expect(L.find((t) => t.id === 'monitor').x).toBe(mon.x) // input untouched
  })

  it('previews a resize and never goes below the minimum size', async () => {
    const { dragPreview, metrics, defaultLayout, inspectRegistry } = await load()
    const L = defaultLayout(inspectRegistry)
    const m = metrics(1188)
    const mon = L.find((t) => t.id === 'monitor')
    const start = { x: mon.x, y: mon.y, w: mon.w, h: mon.h }
    const small = dragPreview(L, 'monitor', start, 'resize', m, -5000, -5000, inspectRegistry).find((t) => t.id === 'monitor')
    expect([small.w, small.h]).toEqual([3, 5])
    const big = dragPreview(L, 'monitor', start, 'resize', m, 200, 88, inspectRegistry).find((t) => t.id === 'monitor')
    expect([big.w, big.h]).toEqual([mon.w + 2, mon.h + 2])
  })

  it('keyboard and menu steps move one cell, Shift resizes', async () => {
    const { keyStep, stepTile, defaultLayout, inspectRegistry } = await load()
    expect(keyStep('a')).toBe(null)
    expect(keyStep('ArrowRight', false)).toEqual({ dx: 1, dy: 0, dw: 0, dh: 0 })
    expect(keyStep('ArrowDown', true)).toEqual({ dx: 0, dy: 0, dw: 0, dh: 1 })
    const L = defaultLayout(inspectRegistry)
    const s = L.find((t) => t.id === 'state')
    const wider = stepTile(L, 'state', keyStep('ArrowRight', true), inspectRegistry).find((t) => t.id === 'state')
    expect(wider.w).toBe(s.w + 1)
    expect(wider.x + wider.w).toBeLessThanOrEqual(12)
    const taller = stepTile(L, 'state', keyStep('ArrowDown', true), inspectRegistry).find((t) => t.id === 'state')
    expect(taller.h).toBe(s.h + 1)
    expect(stepTile(L, 'nope', keyStep('ArrowDown'), inspectRegistry)).toBe(L)
  })

  it('the registry gives every inspector panel its own tile and keeps the flow mounted', async () => {
    const { inspectRegistry, defaultLayout, preset } = await load()
    expect(Object.keys(inspectRegistry.tiles)).toEqual(['monitor', 'flow', 'remote', 'node', 'tree', 'selector', 'state', 'actions', 'network'])
    expect(inspectRegistry.tiles.flow.keepMounted).toBe(true)
    expect(defaultLayout(inspectRegistry).every((t) => t.state === 'open')).toBe(true)
    const p = preset('monitor-info', inspectRegistry)
    expect(p.filter((t) => t.state === 'open').map((t) => t.id).sort()).toEqual(['monitor', 'node', 'state'])
  })
})
