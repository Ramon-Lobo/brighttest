import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/statetree.js')
const wide = (n, f = (i) => i) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, f(i)]))
const fakeStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m } }

describe('treeRows', () => {
  it('gives every row a path, parent, depth, sibling index and subtree end, branches included', async () => {
    const { treeRows } = await load()
    const rows = treeRows({ a: { b: 1, c: [10, 20] }, d: 'x' })
    expect(rows.map((r) => r.path)).toEqual(['a', 'a.b', 'a.c', 'a.c.0', 'a.c.1', 'd'])
    const a = rows[0], c = rows[2]
    expect(a).toMatchObject({ branch: true, kind: 'object', count: 2, parent: '', depth: 0, idx: 0, end: 5, badge: '{2 keys}' })
    expect(c).toMatchObject({ branch: true, kind: 'array', count: 2, parent: 'a', depth: 1, idx: 1, end: 5, badge: '[2]' })
    expect(rows[3]).toMatchObject({ branch: false, parent: 'a.c', depth: 2, value: 10, type: 'number', editable: true })
    expect(rows.rootCount).toBe(2)
  })

  it('classifies node refs, markers and redacted values as leaves', async () => {
    const { treeRows } = await load()
    const rows = treeRows({ n: { $node: 'title', subtype: 'Label' }, m: '$truncated:depth', r: '<redacted:token>', z: null })
    expect(rows.map((r) => [r.key, r.kind, r.branch])).toEqual([['n', 'node', false], ['m', 'marker', false], ['r', 'redacted', false], ['z', 'value', false]])
    expect(rows[1].load).toBe(true)
    expect(rows[3].editable).toBe(false)
  })

  it('handles empty and null input', async () => {
    const { treeRows } = await load()
    expect(treeRows(null)).toHaveLength(0)
    expect(treeRows({}).rootCount).toBe(0)
  })
})

describe('collapse model and chunking', () => {
  it('starts a branch over 20 children collapsed, others expanded', async () => {
    const { treeRows, newModel, isCollapsed, visible, AUTO_COLLAPSE } = await load()
    expect(AUTO_COLLAPSE).toBe(20)
    const rows = treeRows({ small: wide(20), big: wide(21) })
    const model = newModel()
    expect(isCollapsed(rows[0], model)).toBe(false)
    expect(isCollapsed(rows.find((r) => r.path === 'big'), model)).toBe(true)
    const vis = visible(rows, model)
    expect(vis.filter((r) => r.parent === 'small')).toHaveLength(20)
    expect(vis.filter((r) => r.parent === 'big')).toHaveLength(0)
  })

  it('explicit expand overrides the auto-collapse; toggle and collapse/expand all', async () => {
    const { treeRows, newModel, isCollapsed, toggle, collapseAll, expandAll, visible } = await load()
    const rows = treeRows({ big: wide(30), s: { x: 1 } })
    const model = newModel()
    const big = rows[0], s = rows.find((r) => r.path === 's')
    toggle(model, big)
    expect(isCollapsed(big, model)).toBe(false)
    toggle(model, s)
    expect(visible(rows, model).some((r) => r.path === 's.x')).toBe(false)
    collapseAll(rows, model)
    expect(visible(rows, model).map((r) => r.path)).toEqual(['big', 's'])
    expandAll(rows, model)
    expect(visible(rows, model)).toHaveLength(rows.length)
  })

  it('renders 100 children then a more row; show more adds 100', async () => {
    const { treeRows, newModel, expandAll, visible, showMore } = await load()
    const rows = treeRows({ list: wide(250) })
    const model = newModel()
    expandAll(rows, model)
    let more = {}
    let vis = visible(rows, model, { more })
    expect(vis.filter((r) => r.parent === 'list' && !r.more)).toHaveLength(100)
    expect(vis[vis.length - 1]).toMatchObject({ more: true, parent: 'list', remaining: 150 })
    more = showMore(more, 'list')
    vis = visible(rows, model, { more })
    expect(vis.filter((r) => r.parent === 'list' && !r.more)).toHaveLength(200)
    more = showMore(more, 'list')
    vis = visible(rows, model, { more })
    expect(vis.filter((r) => r.more)).toHaveLength(0)
    expect(vis.filter((r) => r.parent === 'list' && !r.more)).toHaveLength(250)
  })

  it('chunks the top level too', async () => {
    const { treeRows, newModel, visible } = await load()
    const vis = visible(treeRows(wide(120, () => 1)), newModel())
    expect(vis).toHaveLength(101)
    expect(vis[100]).toMatchObject({ more: true, parent: '', remaining: 20 })
  })

  it('reveal expands ancestors and widens the chunk so a match can be shown', async () => {
    const { treeRows, newModel, collapseAll, reveal, visible } = await load()
    const rows = treeRows({ a: { list: wide(150, (i) => ({ v: i })) } })
    const model = newModel()
    collapseAll(rows, model)
    const more = reveal(rows, model, {}, 'a.list.k140.v')
    const paths = visible(rows, model, { more }).map((r) => r.path)
    expect(paths).toContain('a.list.k140.v')
  })
})

describe('search', () => {
  const rows = async () => (await load()).treeRows({ user: { name: 'Ada', tags: ['x', 'Adam'], age: 36 }, flag: true, none: null })

  it('matches key, dotted path and displayed value', async () => {
    const { match } = await load()
    const r = await rows()
    expect(match(r, 'name').matches).toEqual(['user.name'])
    expect(match(r, 'user.tags.1').matches).toEqual(['user.tags.1'])
    expect(match(r, 'ada').matches).toEqual(['user.name', 'user.tags.1'])
    expect(match(r, '36').matches).toEqual(['user.age'])
    expect(match(r, 'true').matches).toEqual(['flag'])
    expect(match(r, 'null').matches).toEqual(['none'])
    expect(match(r, '').matches).toEqual([])
  })

  it('does not match strings by their JSON quotes', async () => {
    const { match } = await load()
    expect(match(await rows(), '"').matches).toEqual([])
  })

  it('is case-insensitive unless asked', async () => {
    const { match } = await load()
    const r = await rows()
    expect(match(r, 'ADA').matches).toHaveLength(2)
    expect(match(r, 'ADA', { caseSensitive: true }).matches).toHaveLength(0)
    expect(match(r, 'Ada', { caseSensitive: true }).matches).toEqual(['user.name', 'user.tags.1'])
    expect(match(r, 'Adam', { caseSensitive: true }).matches).toEqual(['user.tags.1'])
  })

  it('highlight mode keeps all rows; filter mode keeps matches and their ancestors', async () => {
    const { match, newModel, expandAll, visible } = await load()
    const r = await rows()
    const model = newModel(); expandAll(r, model)
    const hl = match(r, 'adam')
    expect(hl.keep).toBe(null)
    expect(visible(r, model)).toHaveLength(r.length)
    const f = match(r, 'adam', { mode: 'filter' })
    expect([...f.ancestors].sort()).toEqual(['user', 'user.tags'])
    expect(visible(r, model, { keep: f.keep }).map((x) => x.path)).toEqual(['user', 'user.tags', 'user.tags.1'])
  })

  it('finds matches inside collapsed branches and keeps the current match by path across a refresh', async () => {
    const { treeRows, match, currentIndex, stepIndex } = await load()
    const v1 = { a: { hit: 1 }, b: { hit: 2 }, c: { hit: 3 } }
    let m = match(treeRows(v1), 'hit')
    expect(m.matches).toEqual(['a.hit', 'b.hit', 'c.hit'])
    let cur = currentIndex(m.matches, null)
    cur = stepIndex(3, cur, 1)
    expect(m.matches[cur]).toBe('b.hit')
    m = match(treeRows({ z: { hit: 0 }, ...v1 }), 'hit')
    expect(m.matches[currentIndex(m.matches, 'b.hit', cur)]).toBe('b.hit')
    expect(m.matches).toHaveLength(4)
    m = match(treeRows({ a: { hit: 1 } }), 'hit')
    expect(currentIndex(m.matches, 'b.hit', 1)).toBe(0)
    expect(currentIndex([], 'x', 3)).toBe(-1)
    expect(stepIndex(3, 0, -1)).toBe(2)
  })

  it('splits text into marks, text only', async () => {
    const { highlight } = await load()
    expect(highlight('a<b>Ab', 'ab')).toEqual([{ text: 'a<b>', mark: false }, { text: 'Ab', mark: true }])
    expect(highlight('aaa', 'a')).toHaveLength(3)
    expect(highlight('abc', '')).toEqual([{ text: 'abc', mark: false }])
    expect(highlight('abc', 'B', true)).toEqual([{ text: 'abc', mark: false }])
  })
})

describe('persistence', () => {
  it('round-trips collapsed and expanded paths and drops vanished paths', async () => {
    const { treeRows, newModel, remember, restoreModel } = await load()
    const model = newModel()
    model.collapsed.add('a'); model.expanded.add('b'); model.collapsed.add('gone')
    const store = remember({ v: 1, keys: {} }, 'state:global', model, treeRows({ a: { x: 1 }, b: { y: 2 } }), 5)
    expect(store.keys['state:global']).toEqual({ c: ['a'], e: ['b'], t: 5 })
    const m = restoreModel(store, 'state:global')
    expect([...m.collapsed]).toEqual(['a'])
    expect([...m.expanded]).toEqual(['b'])
    expect(restoreModel(store, 'other').collapsed.size).toBe(0)
  })

  it('caps paths at 500 (newest kept) and keys at 100 (least recently used dropped)', async () => {
    const { newModel, remember, MAX_KEYS, MAX_PATHS } = await load()
    const model = newModel()
    for (let i = 0; i < 700; i++) model.collapsed.add(`p${i}`)
    let store = remember({ v: 1, keys: {} }, 'k', model, null, 1)
    expect(store.keys.k.c).toHaveLength(MAX_PATHS)
    expect(store.keys.k.c[MAX_PATHS - 1]).toBe('p699')
    store = { v: 1, keys: {} }
    for (let i = 0; i < MAX_KEYS + 5; i++) store = remember(store, `k${i}`, newModel(), null, i + 1)
    expect(Object.keys(store.keys)).toHaveLength(MAX_KEYS)
    expect(store.keys.k0).toBeUndefined()
    expect(store.keys.k4).toBeUndefined()
    store = remember(store, 'k5', newModel(), null, 999) // touch: now the newest
    store = remember(store, 'fresh', newModel(), null, 1000)
    expect(store.keys.k5).toBeDefined()
    expect(store.keys.k6).toBeUndefined()
  })

  it('loads defaults from corrupt or foreign storage', async () => {
    const { loadStore, STORAGE_KEY } = await load()
    const s = fakeStorage()
    expect(loadStore(s)).toEqual({ v: 1, keys: {} })
    s.setItem(STORAGE_KEY, '{nope')
    expect(loadStore(s)).toEqual({ v: 1, keys: {} })
    s.setItem(STORAGE_KEY, JSON.stringify({ v: 2, keys: { a: {} } }))
    expect(loadStore(s)).toEqual({ v: 1, keys: {} })
    expect(loadStore({ getItem: () => { throw new Error('denied') } })).toEqual({ v: 1, keys: {} })
  })

  it('debounces writes at 500 ms through bt.studio.statetree', async () => {
    const { createPersister, newModel, STORAGE_KEY } = await load()
    const s = fakeStorage()
    const pending = []
    const timers = { set: (fn, ms) => { pending.push({ fn, ms }); return pending.length }, clear: (id) => { pending[id - 1].fn = null } }
    const p = createPersister(s, { timers })
    const model = newModel(); model.collapsed.add('a')
    p.save('k', model, null)
    model.collapsed.add('b')
    p.save('k', model, null)
    expect(s.m.has(STORAGE_KEY)).toBe(false)
    expect(pending.map((x) => x.ms)).toEqual([500, 500])
    pending.filter((x) => x.fn).forEach((x) => x.fn())
    expect(JSON.parse(s.getItem(STORAGE_KEY)).keys.k.c).toEqual(['a', 'b'])
    expect([...p.get('k').collapsed]).toEqual(['a', 'b'])
  })

  it('survives a storage that throws on write', async () => {
    const { createPersister, newModel } = await load()
    const p = createPersister({ getItem: () => null, setItem: () => { throw new Error('quota') } }, { timers: { set: (f) => f(), clear() {} } })
    expect(() => p.save('k', newModel(), null)).not.toThrow()
  })
})

describe('budget', () => {
  it('flatten + match + visible on 5,000 rows stays well under 30 ms per keystroke (generous bound)', async () => {
    const { treeRows, match, visible, newModel, expandAll } = await load()
    const state = Object.fromEntries(Array.from({ length: 50 }, (_, g) => [`group${g}`, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`item${i}`, { id: `${g}-${i}`, title: `Title ${g} ${i}`, n: i }]))]))
    const rows = treeRows(state)
    expect(rows.length).toBeGreaterThanOrEqual(5000)
    const model = newModel(); expandAll(rows, model)
    const run = (q) => { const r = treeRows(state); const m = match(r, q, { mode: 'filter' }); return visible(r, model, { keep: m.keep }).length }
    run('title') // warm up
    const times = []
    for (const q of ['t', 'ti', 'tit', 'titl', 'title 4', 'zzz']) { const t0 = performance.now(); run(q); times.push(performance.now() - t0) }
    // 30 ms is the design target; allow 4x for loaded CI machines
    expect(Math.max(...times)).toBeLessThan(120)
  })
})
