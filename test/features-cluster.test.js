import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph } = require('../lib/features/graph')
const { mk } = require('./features-synth-helper.cjs')
const { tarjan, dominators, suggest, orderFeatures, orderSuggested } = require('../lib/features/cluster')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CYCLES = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'cycles')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')

const cl = (s, id) => s.clusters.find((c) => c.id === id)
const where = (s, nodeId) => s.clusters.find((c) => c.members.includes(nodeId)).id

describe('Tarjan SCC (TP-TREE-12)', () => {
  const adj = (o) => new Map(Object.entries(o).map(([k, v]) => [k, v]))
  it('finds a 2-cycle and a 3-cycle, leaves singles alone, lists dependencies first', () => {
    const a = adj({ a: ['b'], b: ['a', 'c'], c: [], d: ['e'], e: ['f'], f: ['d'], g: ['g'] })
    const { sccs, of } = tarjan(['a', 'b', 'c', 'd', 'e', 'f', 'g'], a)
    const multi = sccs.filter((s) => s.length > 1)
    expect(multi).toEqual([['a', 'b'], ['d', 'e', 'f']])
    expect(of.get('c')).toBeLessThan(of.get('a'))
    expect(sccs.find((s) => s.includes('g'))).toEqual(['g'])
  })
  it('does not overflow the stack on a 20,000 node chain and is deterministic', () => {
    const o = {}; const ids = []
    for (let i = 0; i < 20000; i++) { ids.push(`n${i}`); o[`n${i}`] = i < 19999 ? [`n${i + 1}`] : [] }
    const r1 = tarjan(ids, adj(o)); const r2 = tarjan([...ids].reverse(), adj(o))
    expect(r1.sccs.length).toBe(20000)
    expect(r2.sccs).toEqual(r1.sccs)
  })
  it('cycles fixture: exactly the A<->B component cycle and the 3-file call cycle; the self-extends loop does not hang', async () => {
    const g = await buildGraph(CYCLES)
    const s = suggest(g)
    expect(s.cycles).toEqual([['comp:CycleA', 'comp:CycleB'], ['file:source/pang.brs', 'file:source/ping.brs', 'file:source/pong.brs']])
    expect(s.unreached).toContain('comp:Loop')
  })
})

describe('dominators', () => {
  it('a diamond: the bottom is dominated by the top, not by either side', () => {
    const succ = new Map([['top', ['l', 'r']], ['l', ['b']], ['r', ['b']], ['b', []]])
    const d = dominators(succ, 'top')
    expect(d.get('b')).toBe('top'); expect(d.get('l')).toBe('top'); expect(d.get('r')).toBe('top'); expect(d.get('top')).toBe('top')
  })
  it('a chain and a bypass', () => {
    const succ = new Map([['r', ['a', 'c']], ['a', ['b']], ['b', ['c']], ['c', []]])
    const d = dominators(succ, 'r')
    expect(d.get('b')).toBe('a'); expect(d.get('c')).toBe('r')
  })
})

describe('dominator clusters, app-shell, shared, unreached, vendor (TP-TREE-13)', () => {
  it('a node dominated by a screen joins that screen; the diamond below a screen stays in one cluster', () => {
    const g = mk({ comps: ['Top', 'Left', 'Right', 'Bottom'], edges: [['comp:S', 'comp:Top', 'child'], ['comp:Top', 'comp:Left', 'child'], ['comp:Top', 'comp:Right', 'child'], ['comp:Left', 'comp:Bottom', 'child'], ['comp:Right', 'comp:Bottom', 'child']] })
    const s = suggest(g)
    for (const n of ['Left', 'Right', 'Bottom']) expect(where(s, `comp:${n}`)).toBe('top')
    expect(cl(s, 'top').reason).toBe('dominated-by comp:Top')
  })
  it('app-shell rule: nodes dominated only by the root and the Scene go to app-shell', () => {
    const g = mk({ comps: [{ name: 'Api', task: true }, 'Home'], files: ['source/boot.brs'], edges: [['comp:S', 'comp:Home', 'child'], ['comp:S', 'comp:Api', 'runs-task'], ['file:source/main.brs', 'file:source/boot.brs', 'calls']] })
    const s = suggest(g)
    expect(where(s, 'comp:S')).toBe('app-shell'); expect(where(s, 'comp:Api')).toBe('app-shell'); expect(where(s, 'file:source/boot.brs')).toBe('app-shell')
    expect(where(s, 'file:manifest')).toBe('app-shell'); expect(where(s, 'entry:main')).toBe('app-shell')
    expect(cl(s, 'app-shell').reason).toMatch(/entry/)
  })
  it('shared: a utility reached from 2 screens is in a shared:<dir> cluster with the reason', () => {
    const g = mk({ comps: ['A', 'B'], files: ['source/lib/u.brs'], edges: [['comp:S', 'comp:A', 'child'], ['comp:S', 'comp:B', 'child'], ['comp:A', 'file:source/lib/u.brs', 'calls'], ['comp:B', 'file:source/lib/u.brs', 'calls']] })
    const s = suggest(g)
    expect(where(s, 'file:source/lib/u.brs')).toBe('shared:source/lib')
    expect(cl(s, 'shared:source/lib').reason).toBe('shared: used by 2 clusters')
    expect(s.shared.map((x) => x.id)).toEqual(['file:source/lib/u.brs'])
    expect(where(s, 'comp:A')).toBe('a')
  })
  it('shared: in-degree threshold is max(3, 10% of components)', () => {
    const mkApp = (n, inbound) => {
      const comps = ['Home', 'W', ...Array.from({ length: n }, (_, i) => `U${i}`)]
      const edges = [['comp:S', 'comp:Home', 'child']]
      for (let i = 0; i < inbound; i++) edges.push([`comp:U${i}`, 'comp:W', 'child'])
      for (let i = 0; i < n; i++) edges.push(['comp:Home', `comp:U${i}`, 'child'])
      return suggest(mk({ comps, edges }))
    }
    expect(mkApp(5, 3).shared.map((x) => x.id)).toEqual(['comp:W']) // 3 >= max(3, 1)
    expect(mkApp(5, 2).shared).toEqual([])
    expect(mkApp(50, 4).shared).toEqual([]) // 52 comps -> threshold 6
    expect(mkApp(50, 6).shared.map((x) => x.id)).toEqual(['comp:W'])
  })
  it('shared: a source file called from 2+ scopes is shared even inside one screen', () => {
    const g = mk({ comps: ['A', 'A1', 'A2'], files: ['source/h.brs'], edges: [['comp:S', 'comp:A', 'child'], ['comp:A', 'comp:A1', 'child'], ['comp:A', 'comp:A2', 'child'], ['comp:A1', 'file:source/h.brs', 'script'], ['comp:A2', 'file:source/h.brs', 'script']] })
    const s = suggest(g)
    expect(where(s, 'file:source/h.brs')).toBe('shared:source')
    expect(cl(s, 'shared:source').reason).toBe('shared: used by 2 scopes')
  })
  it('unreached: no path from the entry (dead code, dynamic edges); reported as uncertainty, not dropped', () => {
    const g = mk({ comps: ['Home', 'Dead', 'Dyn'], files: ['source/dead.brs'], edges: [['comp:S', 'comp:Home', 'child'], ['comp:S', 'comp:Dyn', 'creates', 'dynamic'], ['comp:Dead', 'file:source/dead.brs', 'calls']] })
    const s = suggest(g)
    expect(where(s, 'comp:Dead')).toBe('unreached'); expect(where(s, 'comp:Dyn')).toBe('unreached'); expect(where(s, 'file:source/dead.brs')).toBe('unreached')
    expect(s.uncertainty.unreached).toBe(s.unreached.length)
    expect(cl(s, 'unreached').reason).toMatch(/^unreached/)
  })
  it('vendor nodes go to the vendor cluster and do not take part in clustering', () => {
    const g = mk({ comps: ['Home'], files: [{ rel: 'source/roku_modules/v/lib.brs', vendor: true }], edges: [['comp:S', 'comp:Home', 'child'], ['comp:Home', 'file:source/roku_modules/v/lib.brs', 'calls']] })
    const s = suggest(g)
    expect(where(s, 'file:source/roku_modules/v/lib.brs')).toBe('vendor')
    expect(cl(s, 'vendor').kind).toBe('vendor')
    expect(s.shared).toEqual([])
  })
  it('with no entry the roots are the nodes with in-degree 0 and every cluster has a reason', () => {
    const g = mk({ entry: null, comps: ['A', 'B'], edges: [['comp:A', 'comp:B', 'child']] })
    const s = suggest(g)
    expect(s.entry).toBe(null)
    for (const c of s.clusters) expect(c.reason).toBeTruthy()
  })
  it('feature-tree-app: every cluster has a reason and every graph file and component is in exactly one cluster', async () => {
    const g = await buildGraph(APP)
    const s = suggest(g)
    const all = s.clusters.flatMap((c) => c.members)
    expect(new Set(all).size).toBe(all.length)
    for (const n of g.nodes.filter((x) => x.kind === 'file' || x.kind === 'component')) expect(all).toContain(n.id)
    for (const c of s.clusters) expect(c.reason).toBeTruthy()
    expect(JSON.parse(JSON.stringify(suggest(g)))).toEqual(s) // plain data, deterministic
  })
})

// ---- ordering -----------------------------------------------------------------------------------------------------------
const F = (id, cls, extra) => ({ id, shared: false, files: 1, nodes: [{ id: `file:${id}.brs`, class: cls }], ...(extra || {}) })
const ids = (steps) => steps.map((s) => s.features.join('+'))

describe('orderings (TP-TREE-14)', () => {
  it('leaf-first is a reverse topological order of the condensed feature DAG', () => {
    const input = { features: ['app', 'home', 'details', 'lib'].map((i) => F(i, 'headless-scene')), deps: [{ from: 'app', to: 'home' }, { from: 'home', to: 'details' }, { from: 'home', to: 'lib' }, { from: 'details', to: 'lib' }], entry: 'app' }
    const o = ids(orderFeatures(input, 'leaf-first'))
    expect(o).toEqual(['lib', 'details', 'home', 'app'])
  })
  it('base-first starts with the app shell and orders by distance from the entry', () => {
    const input = { features: ['zzz', 'shell', 'a', 'b', 'far'].map((i) => F(i, 'headless-scene')), deps: [{ from: 'shell', to: 'b' }, { from: 'shell', to: 'a' }, { from: 'a', to: 'far' }], entry: 'shell' }
    const steps = orderFeatures(input, 'base-first')
    expect(ids(steps)).toEqual(['shell', 'a', 'b', 'far', 'zzz'])
    expect(steps[0].launchSmoke.primary).toBe('e2e')
    expect(steps[0].stubbed).toEqual(['a', 'b'])
  })
  const level = (fs) => ({ features: fs, deps: [], entry: null })
  it('tie 1: shared first', () => {
    const o = ids(orderFeatures(level([F('a', 'headless-unit'), F('s', 'e2e', { shared: true })]), 'leaf-first'))
    expect(o).toEqual(['s', 'a'])
  })
  it('tie 2: cheaper primary class by classRank', () => {
    const o = ids(orderFeatures(level([F('a', 'headless-fixtures'), F('b', 'headless-scene'), F('c', 'headless-unit')]), 'leaf-first'))
    expect(o).toEqual(['c', 'b', 'a'])
  })
  it('a feature class is its cheapest member class other than unknown', () => {
    const mixed = { id: 'm', shared: false, files: 1, nodes: [{ id: 'x', class: 'unknown' }, { id: 'y', class: 'headless-scene' }] }
    const o = ids(orderFeatures(level([F('a', 'headless-fixtures'), mixed]), 'leaf-first'))
    expect(o).toEqual(['m', 'a'])
  })
  it('tie 3: fewer files', () => {
    const o = ids(orderFeatures(level([F('a', 'headless-unit', { files: 5 }), F('b', 'headless-unit', { files: 2 })]), 'leaf-first'))
    expect(o).toEqual(['b', 'a'])
  })
  it('tie 4: id', () => {
    expect(ids(orderFeatures(level([F('b', 'headless-unit'), F('a', 'headless-unit')]), 'leaf-first'))).toEqual(['a', 'b'])
  })
  it('an all-unknown feature sorts after a headless-unit feature at the same level, in both paths (TP-TREE-14 tie-break)', () => {
    const input = { features: [F('aaa-unknown', 'unknown'), F('zzz-unit', 'headless-unit')], deps: [], entry: null }
    expect(ids(orderFeatures(input, 'leaf-first'))).toEqual(['zzz-unit', 'aaa-unknown'])
    expect(ids(orderFeatures(input, 'base-first'))).toEqual(['zzz-unit', 'aaa-unknown'])
    // and even when it is also an unclassified shared-less single: never ranks as cheapest
    const three = { features: [F('a', 'unknown'), F('b', 'e2e')], deps: [], entry: null }
    expect(ids(orderFeatures(three, 'leaf-first'))).toEqual(['b', 'a'])
  })
  it('unknown nodes are listed under notClassified, never in firstTests or proposedTests, in both paths; an override moves them in', () => {
    const f = { id: 'f', shared: false, files: 2, nodes: [{ id: 'u', class: 'unknown', alsoNeeds: ['device'] }, { id: 'p', class: 'headless-unit' }] }
    for (const mode of ['leaf-first', 'base-first']) {
      const [st] = orderFeatures({ features: [f], deps: [], entry: 'f' }, mode)
      expect(st.notClassified).toEqual([{ id: 'u', alsoNeeds: ['device'] }])
      expect(st.firstTests).toEqual(['p'])
      expect(st.proposedTests.map((t) => t.target)).toEqual(['p'])
      const [ov] = orderFeatures({ features: [f], deps: [], entry: 'f' }, mode, { overrides: { u: 'headless-scene' } })
      expect(ov.notClassified).toEqual([]); expect(ov.firstTests).toEqual(['p', 'u'])
    }
  })
  it('a feature SCC becomes one step labelled "test together"', () => {
    const input = { features: ['a', 'b', 'c'].map((i) => F(i, 'headless-scene')), deps: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'c' }], entry: 'a' }
    for (const mode of ['leaf-first', 'base-first']) {
      const steps = orderFeatures(input, mode)
      const tog = steps.filter((s) => s.label === 'test together')
      expect(tog.length).toBe(1); expect(tog[0].features).toEqual(['a', 'b'])
      expect(steps.flatMap((s) => s.features).sort()).toEqual(['a', 'b', 'c'])
    }
    expect(ids(orderFeatures(input, 'leaf-first'))).toEqual(['c', 'a+b'])
  })
  it('suggested deps: builtin, unresolved and dynamic edges add no dependency; ambiguous edges do and flag the step', () => {
    const base = { comps: ['A', 'B'], edges: [['comp:S', 'comp:A', 'child'], ['comp:S', 'comp:B', 'child']] }
    for (const conf of ['builtin', 'unresolved', 'dynamic']) {
      const s = suggest(mk({ ...base, edges: [...base.edges, ['comp:A', 'comp:B', 'callfunc', conf]] }))
      expect(s.deps.some((d) => d.from === 'a' && d.to === 'b')).toBe(false)
    }
    const g = mk({ ...base, edges: [...base.edges, ['comp:A', 'comp:B', 'callfunc', 'ambiguous']] })
    const s = suggest(g)
    expect(s.deps.find((d) => d.from === 'a' && d.to === 'b').ambiguous).toBe(true)
    const steps = orderSuggested(g, s, 'leaf-first')
    expect(steps.find((x) => x.features.includes('a')).flags).toEqual(['ambiguous'])
    expect(steps.find((x) => x.features.includes('b')).flags).toBeUndefined()
  })
  it('the same input gives the same order on 3 repeated calls; every feature appears exactly once in each path', async () => {
    const g = await buildGraph(APP); const s = suggest(g)
    for (const mode of ['leaf-first', 'base-first']) {
      const runs = [0, 1, 2].map(() => JSON.stringify(orderSuggested(g, s, mode)))
      expect(runs[1]).toBe(runs[0]); expect(runs[2]).toBe(runs[0])
      const seen = JSON.parse(runs[0]).flatMap((x) => x.features).sort()
      expect(seen).toEqual(s.clusters.filter((c) => c.kind !== 'vendor').map((c) => c.id).sort())
    }
    expect(orderSuggested(g, s, 'base-first')[0].features).toEqual(['app-shell'])
  })
  it('uses classRank, not indexOf: an unknown class and a bad class are handled', () => {
    expect(() => orderFeatures({ features: [F('a', 'bogus')], deps: [], entry: null }, 'leaf-first')).toThrow(/unknown testability class/)
    expect(() => orderFeatures({ features: [], deps: [], entry: null }, 'sideways')).toThrow()
  })
})
