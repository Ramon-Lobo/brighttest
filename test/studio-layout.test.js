import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/layout.js')
const reg = () => import('../lib/studio/web/src/lib/tiles.js')

const mini = (version = 1, extra = {}) => ({
  version,
  tiles: {
    a: { title: 'A', minW: 2, minH: 2, default: { x: 0, y: 0, w: 6, h: 4 }, newState: 'open' },
    b: { title: 'B', minW: 2, minH: 2, default: { x: 6, y: 0, w: 6, h: 4 }, newState: 'open' },
    c: { title: 'C', minW: 3, minH: 3, default: { x: 0, y: 4, w: 12, h: 3 }, newState: 'open' },
    ...extra,
  },
  presets: { wide: { a: { x: 0, y: 0, w: 12, h: 5, state: 'open' } } },
})
const by = (l, id) => l.find((t) => t.id === id)
const fake = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }
}
const overlap = (l) => {
  const v = l.filter((t) => t.state !== 'hidden')
  for (const p of v) for (const q of v) if (p !== q && p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) return true
  return false
}

describe('studio layout engine', () => {
  it('default layout has no overlap, is in bounds and is already compact', async () => {
    const L = await load(); const { inspectRegistry: R } = await reg()
    const d = L.defaultLayout(R)
    expect(d.map((t) => t.id).sort()).toEqual(['actions', 'flow', 'monitor', 'network', 'node', 'remote', 'selector', 'state', 'tree'])
    expect(overlap(d)).toBe(false)
    expect(d.every((t) => t.x >= 0 && t.x + t.w <= L.COLS && t.w >= R.tiles[t.id].minW && t.h >= R.tiles[t.id].minH)).toBe(true)
    expect(L.normalize(d, R)).toEqual(d)
    expect(d.every((t) => t.state === 'open')).toBe(true)
  })

  it('registry lists every inspector panel as its own tile (no tabs)', async () => {
    const { inspectRegistry: R } = await reg()
    for (const id of ['node', 'tree', 'selector', 'state', 'actions', 'network', 'monitor', 'flow', 'remote']) expect(R.tiles[id].title).toBeTruthy()
    expect(R.tiles.inspector).toBeUndefined()
  })

  it('move snaps to whole cells, clamps x at the right edge and y at the top', async () => {
    const L = await load(); const R = mini()
    const l = L.defaultLayout(R)
    const m = L.move(l, 'a', 99.4, -5, R)
    expect(by(m, 'a')).toMatchObject({ x: 6, y: 0 })
    expect(l).toEqual(L.defaultLayout(R)) // input untouched
  })

  it('move pushes overlapped tiles down and cascades, then compacts', async () => {
    const L = await load(); const R = mini()
    const l = L.defaultLayout(R) // a,b on row 0..4, c at 4..7
    const m = L.move(l, 'a', 6, 0, R) // lands on b
    expect(by(m, 'a')).toMatchObject({ x: 6, y: 0 })
    expect(by(m, 'b').y).toBe(4) // pushed under a
    expect(by(m, 'c').y).toBe(8) // cascaded below b
    expect(overlap(m)).toBe(false)
  })

  it('compaction pulls tiles up when space opens', async () => {
    const L = await load(); const R = mini()
    const l = L.defaultLayout(R)
    const m = L.move(l, 'b', 6, 20, R)
    expect(by(m, 'b').y).toBe(7) // compacted up until it rests under the full-width c (rows 4..7)
  })

  it('resize clamps to min sizes and to the right edge, and pushes down', async () => {
    const L = await load(); const R = mini()
    const l = L.defaultLayout(R)
    const small = L.resize(l, 'a', 1, 1, R)
    expect(by(small, 'a')).toMatchObject({ w: 2, h: 2 })
    const wide = L.resize(l, 'b', 20, 4, R)
    expect(by(wide, 'b')).toMatchObject({ x: 0, w: 12 })
    expect(overlap(wide)).toBe(false)
    const grown = L.resize(l, 'a', 6, 8, R)
    expect(by(grown, 'c').y).toBe(8)
  })

  it('bounds: a tile cannot be placed outside 12 columns', async () => {
    const L = await load(); const R = mini()
    const n = L.normalize([{ id: 'a', x: 11, y: 0, w: 6, h: 4, state: 'open' }, { id: 'b', x: -3, y: -2, w: 99, h: 0, state: 'open' }], R)
    expect(by(n, 'a').x + by(n, 'a').w).toBeLessThanOrEqual(12)
    expect(by(n, 'b')).toMatchObject({ x: 0, w: 12 })
    expect(by(n, 'b').h).toBeGreaterThanOrEqual(2)
    expect(overlap(n)).toBe(false)
  })

  it('minimize keeps place and width, takes one row, and frees space below', async () => {
    const L = await load(); const R = mini()
    const l = L.defaultLayout(R)
    const m = L.setState(l, 'a', 'min', R)
    expect(by(m, 'a')).toMatchObject({ x: 0, w: 6, h: 1, hOpen: 4, state: 'min' })
    expect(by(m, 'c').y).toBe(4) // c is full width, b is still 4 tall: c stays under b
  })

  it('open from minimized restores the last height and pushes tiles below', async () => {
    const L = await load(); const R = mini()
    const m = L.setState(L.defaultLayout(R), 'a', 'min', R)
    const o = L.setState(m, 'a', 'open', R)
    expect(by(o, 'a')).toMatchObject({ h: 4, state: 'open' })
    expect(by(o, 'a').hOpen).toBeUndefined()
    expect(overlap(o)).toBe(false)
  })

  it('hide removes the tile from collision; restore goes back to the last slot when free', async () => {
    const L = await load(); const R = mini()
    const h = L.setState(L.defaultLayout(R), 'a', 'hidden', R)
    expect(by(h, 'a').state).toBe('hidden')
    expect(by(h, 'c').y).toBe(4) // b still above c
    const back = L.setState(h, 'a', 'open', R)
    expect(by(back, 'a')).toMatchObject({ x: 0, y: 0, w: 6, h: 4 })
  })

  it('restore takes the first free slot of the last size when the old place is taken', async () => {
    const L = await load(); const R = mini()
    let l = L.setState(L.defaultLayout(R), 'a', 'hidden', R)
    l = L.move(l, 'b', 0, 0, R) // b takes a's old place
    const back = L.setState(l, 'a', 'open', R)
    expect(by(back, 'a')).toMatchObject({ w: 6, h: 4, x: 6, y: 0 })
    expect(overlap(back)).toBe(false)
  })

  it('hidden to min restores into a free slot as one row', async () => {
    const L = await load(); const R = mini()
    const l = L.setState(L.defaultLayout(R), 'a', 'hidden', R)
    const m = L.setState(l, 'a', 'min', R)
    expect(by(m, 'a')).toMatchObject({ state: 'min', h: 1, hOpen: 4 })
    expect(overlap(m)).toBe(false)
  })

  it('stackOrder lists shown tiles by y then x and skips hidden ones', async () => {
    const L = await load(); const R = mini()
    const l = L.setState(L.defaultLayout(R), 'b', 'hidden', R)
    expect(L.stackOrder(l)).toEqual(['a', 'c'])
    expect(L.stackOrder(L.defaultLayout(R))).toEqual(['a', 'b', 'c'])
  })

  it('migrate drops unknown ids, adds new ones per newState and clamps to new minimums', async () => {
    const L = await load()
    const old = L.defaultLayout(mini(1))
    const next = mini(2, { d: { title: 'D', minW: 2, minH: 2, default: { x: 0, y: 7, w: 4, h: 3 }, newState: 'open' }, e: { title: 'E', minW: 2, minH: 2, default: { x: 4, y: 7, w: 4, h: 3 }, newState: 'hidden' } })
    next.tiles.a.minW = 8
    const saved = [...old, { id: 'gone', x: 0, y: 0, w: 2, h: 2, state: 'open' }]
    const m = L.migrate({ v: 1, reg: 1, tiles: saved }, next)
    expect(m.map((t) => t.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(by(m, 'a').w).toBe(8)
    expect(by(m, 'd').state).toBe('open')
    expect(by(m, 'e').state).toBe('hidden')
    expect(overlap(m)).toBe(false)
    const dropped = L.migrate(old, { version: 3, tiles: { a: next.tiles.a } })
    expect(dropped.map((t) => t.id)).toEqual(['a'])
  })

  it('load: missing, corrupt, unknown schema and non-array storage give the default', async () => {
    const L = await load(); const R = mini()
    const def = L.defaultLayout(R)
    expect(L.load(fake(), 'k', R)).toEqual(def)
    expect(L.load(fake({ k: '{nope' }), 'k', R)).toEqual(def)
    expect(L.load(fake({ k: JSON.stringify({ v: 9, reg: 1, tiles: [] }) }), 'k', R)).toEqual(def)
    expect(L.load(fake({ k: JSON.stringify({ v: 1, reg: 1, tiles: 'x' }) }), 'k', R)).toEqual(def)
    expect(L.load(fake({ k: 'null' }), 'k', R)).toEqual(def)
    expect(L.load({ getItem() { throw new Error('denied') } }, 'k', R)).toEqual(def)
  })

  it('save then load round trips; an older registry version is migrated and re-saved', async () => {
    const L = await load(); const R = mini()
    const st = fake()
    const l = L.move(L.defaultLayout(R), 'a', 6, 0, R)
    expect(L.save(st, 'k', l, R)).toBe(true)
    expect(JSON.parse(st.m.get('k'))).toMatchObject({ v: 1, reg: 1 })
    expect(L.load(st, 'k', R)).toEqual(l)
    const R2 = mini(2, { d: { title: 'D', minW: 2, minH: 2, default: { x: 0, y: 9, w: 4, h: 3 }, newState: 'open' } })
    const got = L.load(st, 'k', R2)
    expect(got.map((t) => t.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(JSON.parse(st.m.get('k')).reg).toBe(2)
    expect(L.save({ setItem() { throw new Error('quota') } }, 'k', l, R)).toBe(false)
  })

  it('presets are valid layouts; unknown name gives the default; unlisted tiles are hidden', async () => {
    const L = await load(); const R = mini()
    const p = L.preset('wide', R)
    expect(by(p, 'a')).toMatchObject({ w: 12, state: 'open' })
    expect(by(p, 'b').state).toBe('hidden')
    expect(overlap(p)).toBe(false)
    expect(L.preset('nope', R)).toEqual(L.defaultLayout(R))
    const { inspectRegistry: IR } = await reg()
    const mi = L.preset('monitor-info', IR)
    expect(overlap(mi)).toBe(false)
    expect(by(mi, 'monitor').state).toBe('open')
    expect(by(mi, 'flow').state).toBe('hidden')
    expect(by(mi, 'remote').state).toBe('hidden')
    expect(L.preset('default', IR)).toEqual(L.defaultLayout(IR))
  })
})
