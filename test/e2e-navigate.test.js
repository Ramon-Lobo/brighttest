import { describe, it, expect } from 'vitest'
import { focusTo, center, distance, sameNode, subtreeFocused } from '../lib/e2e/navigate.js'
import { parseFlow } from '../lib/e2e/flow.js'

// An in-memory 3x3 grid "device" that mimics the nav fixture: keypress moves a clamped focus cursor,
// and ecpGet returns a synthetic sgnodes tree with the focused cell flagged. This exercises the focus
// path-finding algorithm (geometry, axis choice, edges, convergence, termination) with no hardware.
function makeGridDevice(startRow = 1, startCol = 1) {
  const state = { row: startRow, col: startCol, presses: 0 }
  const cellBounds = (r, c) => ({ x: 100 + c * 260, y: 160 + r * 160, w: 220, h: 60 })
  const treeXml = () => {
    let cells = ''
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const b = cellBounds(r, c)
        const foc = r === state.row && c === state.col ? ' focused="true"' : ''
        cells += `<Button name="cell${r}${c}" bounds="{${b.x}, ${b.y}, ${b.w}, ${b.h}}"${foc} />`
      }
    }
    return `<sgnodes><All_Nodes node-count="10"><Default name="" />` +
      `<NavScene name="root" bounds="{0, 0, 1920, 1080}">${cells}</NavScene>` +
      `</All_Nodes><status>OK</status></sgnodes>`
  }
  return {
    state,
    async keypress(key) {
      state.presses++
      if (key === 'Right') state.col = Math.min(state.col + 1, 2)
      else if (key === 'Left') state.col = Math.max(state.col - 1, 0)
      else if (key === 'Down') state.row = Math.min(state.row + 1, 2)
      else if (key === 'Up') state.row = Math.max(state.row - 1, 0)
      return 200
    },
    async ecpGet() { return { status: 200, text: treeXml() } },
  }
}

const FAST = { settle: { intervalMs: 0, stableReads: 2, timeoutMs: 200 } }

describe('navigate helpers', () => {
  it('center and distance', () => {
    expect(center({ x: 0, y: 0, w: 10, h: 20 })).toEqual({ x: 5, y: 10 })
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })
  it('sameNode compares by id then geometry', () => {
    expect(sameNode({ id: 'a' }, { id: 'a' })).toBe(true)
    expect(sameNode({ id: 'a' }, { id: 'b' })).toBe(false)
    const g = { bounds: { x: 0, y: 0, w: 2, h: 2 }, subtype: 'X' }
    expect(sameNode({ ...g, id: null }, { ...g, id: null })).toBe(true)
  })
  it('subtreeFocused walks descendants', () => {
    const tree = { focused: false, children: [{ focused: true, children: [] }] }
    expect(subtreeFocused(tree)).toBe(true)
  })
})

describe('focusTo path-finding (simulated grid)', () => {
  it('no-op when already focused', async () => {
    const d = makeGridDevice(1, 1)
    const r = await focusTo(d, { id: 'cell11' }, FAST)
    expect(r.presses).toBe(0)
    expect(d.state.presses).toBe(0)
  })
  it('navigates diagonally center→corner in 4 presses', async () => {
    const d = makeGridDevice(1, 1)
    const r = await focusTo(d, { id: 'cell00' }, FAST) // up 1 + left 1 = 2
    expect(r.presses).toBe(2)
    expect(d.state).toMatchObject({ row: 0, col: 0 })
  })
  it('navigates corner→opposite corner (4 presses)', async () => {
    const d = makeGridDevice(0, 0)
    const r = await focusTo(d, { id: 'cell22' }, FAST)
    expect(r.presses).toBe(4)
    expect(d.state).toMatchObject({ row: 2, col: 2 })
  })
  it('reaches an edge-only target requiring both axes', async () => {
    const d = makeGridDevice(2, 0)
    await focusTo(d, { id: 'cell02' }, FAST) // up 2, right 2
    expect(d.state).toMatchObject({ row: 0, col: 2 })
  })
  it('throws a clear error when the target is not on screen', async () => {
    const d = makeGridDevice(1, 1)
    await expect(focusTo(d, { id: 'nonexistent' }, FAST)).rejects.toThrow(/not found on screen/)
  })
})

// Fake device with a focused node that does not move for `still` presses, then (optionally) goes via `mid`
// to the target. Target runSearch sits down-right of the start so both axes are wanted.
function makeStaticDevice({ subtype, still, mid = false }) {
  const state = { presses: 0 }
  const box = (b) => `bounds="{${b.x}, ${b.y}, ${b.w}, ${b.h}}"`
  const start = { x: 100, y: 100, w: 400, h: 200 }
  const midB = { x: 300, y: 500, w: 100, h: 50 }
  const tgt = { x: 800, y: 900, w: 200, h: 60 }
  const treeXml = () => {
    let f
    if (state.presses < still) f = `<${subtype} name="kb" ${box(start)} focused="true" />`
    else if (mid && state.presses === still) f = `<Button name="mid" ${box(midB)} focused="true" />`
    else f = ''
    const hit = !(state.presses < still) && !(mid && state.presses === still)
    return `<sgnodes><All_Nodes node-count="4"><Default name="" />` +
      `<Scene name="root" bounds="{0, 0, 1920, 1080}">${f}` +
      `<Button name="mid" ${box(midB)}${mid && state.presses === still ? ' focused="true"' : ''} />` +
      `<Button name="runSearch" ${box(tgt)}${hit && !(mid && state.presses === still) ? ' focused="true"' : ''} />` +
      `</Scene></All_Nodes><status>OK</status></sgnodes>`
  }
  return {
    state,
    async keypress() { state.presses++; return 200 },
    async ecpGet() { return { status: 200, text: treeXml() } },
  }
}

describe('focusTo composite focus', () => {
  for (const n of [3, 5]) {
    it(`presses through a non-moving keyboard (${n} static presses)`, async () => {
      const d = makeStaticDevice({ subtype: 'Keyboard', still: n })
      const r = await focusTo(d, { id: 'runSearch' }, FAST)
      expect(r.presses).toBe(n)
      expect(d.state.presses).toBe(n)
    })
  }
  it('gives up past the cap with an edge error and bounded presses', async () => {
    const d = makeStaticDevice({ subtype: 'Keyboard', still: 13 }) // cap is per axis (6 v + 6 h = 12), so 13 static presses can never get through
    await expect(focusTo(d, { id: 'runSearch' }, FAST)).rejects.toMatchObject({
      code: 'FOCUS_FAILED', message: expect.stringMatching(/reached an edge/),
    })
    expect(d.state.presses).toBeLessThanOrEqual(12)
  })
  it('ordinary node still hits the edge after one press per axis', async () => {
    const d = makeStaticDevice({ subtype: 'Button', still: 99 })
    await expect(focusTo(d, { id: 'runSearch' }, FAST)).rejects.toThrow(/reached an edge .* after 2 press/)
    expect(d.state.presses).toBe(2)
  })
  it('a composite that never moves terminates with an error', async () => {
    const d = makeStaticDevice({ subtype: 'VKBGrid', still: 1e9 })
    await expect(focusTo(d, { id: 'runSearch' }, FAST)).rejects.toMatchObject({ code: 'FOCUS_FAILED' })
    expect(d.state.presses).toBeLessThanOrEqual(12)
  })
  it('composite that moves to a new node on press 2 keeps converging', async () => {
    const d = makeStaticDevice({ subtype: 'Keyboard', still: 2, mid: true })
    const r = await focusTo(d, { id: 'runSearch' }, FAST)
    expect(r.presses).toBe(3)
  })
})

describe('flow parser — focus step', () => {
  it('parses focus with a selector and optional maxPresses', () => {
    const flow = parseFlow('steps:\n  - focus: { id: tile, maxPresses: 12 }\n')
    expect(flow.steps[0]).toMatchObject({ op: 'focus', selector: { id: 'tile' }, maxPresses: 12 })
  })
  it('requires a selector on focus', () => {
    expect(() => parseFlow('steps:\n  - focus: { maxPresses: 5 }\n')).toThrow(/focus needs a selector/)
  })
})
