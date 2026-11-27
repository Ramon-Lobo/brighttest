import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const load = () => import('../lib/studio/web/src/lib/statetree.js')
const lib = join(__dirname, '../lib/studio/web/src/lib')

describe('search across layers', () => {
  const layers = { global: { user: { name: 'Ada', mail: 'ada@x' } }, scene: { title: 'Adagio', n: 1 }, registry: { ada: { k: 'v' } } }
  const order = ['global', 'scene', 'registry']
  const byKey = async (q, opts) => {
    const { treeRows, match } = await load()
    return Object.fromEntries(order.map((k) => [k, match(treeRows(layers[k]), q, opts).matches]))
  }

  it('lists matches layer after layer in display order', async () => {
    const { combineMatches } = await load()
    const all = combineMatches(order, await byKey('ada'))
    expect(all.map((m) => `${m.key}:${m.path}`)).toEqual(['global:user.name', 'global:user.mail', 'scene:title', 'registry:ada', 'registry:ada.k'])
  })

  it('ignores layers that are not in the order and layers without a report', async () => {
    const { combineMatches } = await load()
    expect(combineMatches(['scene', 'gone'], { scene: ['title'], global: ['x'] })).toEqual([{ key: 'scene', path: 'title' }])
  })

  it('next and previous wrap around the whole list', async () => {
    const { combineMatches, locateCurrent, stepIndex } = await load()
    const all = combineMatches(order, await byKey('ada'))
    let i = locateCurrent(all, null)
    expect(all[i]).toEqual({ key: 'global', path: 'user.name' })
    i = stepIndex(all.length, i, -1)
    expect(all[i]).toEqual({ key: 'registry', path: 'ada.k' })
    i = stepIndex(all.length, i, 1)
    expect(all[i]).toEqual({ key: 'global', path: 'user.name' })
    i = stepIndex(all.length, 2, 1)
    expect(all[i]).toEqual({ key: 'registry', path: 'ada' })
  })

  it('keeps the current match by layer and path across a refresh, else clamps', async () => {
    const { combineMatches, locateCurrent } = await load()
    const all = combineMatches(order, await byKey('ada'))
    expect(locateCurrent(all, { key: 'scene', path: 'title' }, 0)).toBe(2)
    const fewer = combineMatches(order, { global: ['user.name'], scene: [], registry: [] })
    expect(locateCurrent(fewer, { key: 'scene', path: 'title' }, 2)).toBe(0)
    expect(locateCurrent([], { key: 'scene', path: 'title' }, 2)).toBe(-1)
    // the same path in another layer is another match
    expect(locateCurrent(all, { key: 'registry', path: 'user.name' }, 1)).toBe(1)
  })

  it('case toggle changes the match list; filter keeps matches and their ancestors only', async () => {
    const { treeRows, match, visible, newModel, expandAll } = await load()
    expect((await byKey('ADA'))).toEqual(await byKey('ada'))
    expect(Object.values(await byKey('ADA', { caseSensitive: true })).flat()).toEqual([])
    const rows = treeRows(layers.global)
    const m = match(rows, 'mail', { mode: 'filter' })
    const model = newModel(); expandAll(rows, model)
    expect(visible(rows, model, { keep: m.keep }).map((r) => r.path)).toEqual(['user', 'user.mail'])
  })

  it('sameList compares by value', async () => {
    const { sameList } = await load()
    expect(sameList(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameList(['a'], ['a', 'b'])).toBe(false)
    expect(sameList([], [])).toBe(true)
  })
})

describe('collapse all and expand all over several layers', () => {
  it('collapse all folds every branch, expand all opens the auto-collapsed ones too', async () => {
    const { treeRows, newModel, collapseAll, expandAll, visible } = await load()
    const big = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]))
    const rows = treeRows({ a: { b: { c: 1 } }, big })
    const model = newModel()
    collapseAll(rows, model)
    expect(visible(rows, model).map((r) => r.path)).toEqual(['a', 'big'])
    expandAll(rows, model)
    expect(visible(rows, model, { more: { big: 100 } })).toHaveLength(rows.length)
  })
})

describe('wiring', () => {
  const src = (f) => readFileSync(join(lib, f), 'utf8')
  it('the State tab, the published-state fallback and the node State view render through StateTree with the search bar', () => {
    for (const f of ['StateInspector.svelte', 'AppState.svelte', 'NodeState.svelte']) {
      const s = src(f)
      expect(s, f).toContain("import StateTree from './StateTree.svelte'")
      expect(s, f).toContain('<StateSearch')
      expect(s, f).toContain('<StateTree')
      expect(s, f).not.toContain('rowsOf')
    }
  })
  it('the search bar carries the agreed test ids', () => {
    const s = src('StateSearch.svelte')
    for (const id of ['state-search', 'state-search-prev', 'state-search-next', 'state-search-count', 'state-search-case', 'state-search-filter', 'state-collapse-all', 'state-expand-all']) {
      expect(s).toContain(`data-testid="${id}"`)
    }
  })
})
