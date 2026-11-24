import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { mk } = require('./features-synth-helper.cjs')
const { buildGraph } = require('../lib/features/graph')
const { suggest } = require('../lib/features/cluster')
const { buildDigest, focusSlice, buildSkeleton } = require('../lib/features/digest')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')

function wide(n) {
  const comps = []; const edges = []
  for (let i = 0; i < n; i++) { comps.push({ name: `Screen${i}`, dir: `components/area${i % 7}/s${i}` }); edges.push(['comp:S', `comp:Screen${i}`, 'child']) }
  return mk({ comps, edges })
}

describe('digest budget (TP-TREE-15)', () => {
  it('feature-tree-app: default budget holds, the table is full, and nothing is claimed truncated', async () => {
    const g = await buildGraph(APP); const s = suggest(g)
    const d = buildDigest(g, s)
    expect(d.length).toBeLessThanOrEqual(48000)
    expect(d).toContain('| id | name | kind |'); expect(d).not.toMatch(/truncat/i)
    for (const c of s.clusters) expect(d).toContain(c.id)
    expect(d).toContain('Entry: entry:main')
  })
  it('a small budget is honoured, states the truncation, and names every cluster id', () => {
    const g = wide(300); const s = suggest(g)
    for (const budget of [4000, 1200, 500]) {
      const d = buildDigest(g, s, { budget })
      expect(d.length).toBeLessThanOrEqual(budget)
      expect(d).toMatch(/truncat|rolled up/i)
    }
    const d = buildDigest(g, s, { budget: 20000 })
    expect(d.length).toBeLessThanOrEqual(20000)
    for (const c of s.clusters) expect(d).toContain(c.id)
  })
  it('switches the cluster table to folder rollups when the full table does not fit', () => {
    const g = wide(300); const s = suggest(g)
    const d = buildDigest(g, s, { budget: 20000 })
    expect(d).toContain('| folder | clusters | files |'); expect(d).toContain('rolled up')
  })
  it('lists at most 20 uncertainty items and the "N more" line', () => {
    const g = wide(3); g.uncertainty = { counts: { 'unresolved-call': 50 }, total: 50, items: Array.from({ length: 50 }, (_, i) => ({ kind: 'unresolved-call', at: `source/a.brs:${i + 1}`, detail: 'x' })), blindSpots: [] }
    const d = buildDigest(g, suggest(g))
    expect((d.match(/^- unresolved-call at /gm) || []).length).toBe(20)
    expect(d).toContain('30 more, see graph.json')
  })
  it('is deterministic', () => {
    const g = wide(40); const s = suggest(g)
    expect(buildDigest(g, s, { budget: 3000 })).toBe(buildDigest(g, s, { budget: 3000 }))
  })
})

describe('--focus slice', () => {
  it('describes one cluster, stays under 8,000 characters, and does not change its inputs', async () => {
    const g = await buildGraph(APP); const s = suggest(g)
    const before = JSON.stringify([g, s])
    const t = focusSlice(g, s, 'home-screen')
    expect(t).toContain('# Focus: home-screen'); expect(t).toContain('comp:HomeScreen'); expect(t).toContain('Edges leaving the cluster')
    expect(t.length).toBeLessThanOrEqual(8000)
    expect(JSON.stringify([g, s])).toBe(before)
  })
  it('caps a huge cluster at 8,000 characters and says so; unknown id throws with the known ids', () => {
    const comps = Array.from({ length: 800 }, (_, i) => `Leaf${i}`)
    const edges = [['comp:S', 'comp:Leaf0', 'child'], ...comps.slice(1).map((c) => ['comp:Leaf0', `comp:${c}`, 'child'])]
    const g = mk({ comps, edges }); const s = suggest(g)
    const t = focusSlice(g, s, 'leaf0')
    expect(t.length).toBeLessThanOrEqual(8000); expect(t).toMatch(/Truncated at 8000/)
    expect(() => focusSlice(g, s, 'nope')).toThrow(/unknown cluster: nope.*leaf0/)
    expect(focusSlice(g, s, 'leaf0', { max: 500 }).length).toBeLessThanOrEqual(500)
  })
})

describe('skeleton tree', () => {
  it('is a brighttest-feature-tree/v1 document with every file node in exactly one feature or ignored', async () => {
    const g = await buildGraph(APP); const s = suggest(g)
    const t = buildSkeleton(g, s)
    expect(t.schema).toBe('brighttest-feature-tree/v1')
    expect(t.graph).toEqual({ hash: g.hash, treeHash: g.scan.treeHash })
    expect(t.provenance.author).toBe('brighttest')
    const members = [...t.features.flatMap((f) => f.members), ...t.ignored.flatMap((i) => i.members)]
    const files = g.nodes.filter((n) => n.kind === 'file').map((n) => n.id)
    for (const f of files) expect(members.filter((m) => m === f).length).toBe(1)
    const seen = new Set()
    for (const f of t.features) {
      expect(f.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/); expect(seen.has(f.id)).toBe(false); seen.add(f.id)
      expect(f.name.length).toBeLessThanOrEqual(60); expect(f.summary.length).toBeLessThanOrEqual(400)
      expect(['low', 'medium', 'high']).toContain(f.risk)
      expect(f.proposedTests).toBeUndefined(); expect(f.dependsOn).toBeUndefined()
    }
    expect(t.features.find((f) => f.kind === 'app-shell')).toBeTruthy()
    expect(JSON.stringify(t)).not.toMatch(/\/Users\/|[A-Za-z]:\\/)
  })
  it('vendor files go to ignored; shared:<dir> ids become slugs; colliding slugs stay unique', () => {
    const g = mk({ comps: ['A', 'B'], files: ['source/lib/u.brs', { rel: 'source/roku_modules/v/x.brs', vendor: true }], edges: [['comp:S', 'comp:A', 'child'], ['comp:S', 'comp:B', 'child'], ['comp:A', 'file:source/lib/u.brs', 'calls'], ['comp:B', 'file:source/lib/u.brs', 'calls']] })
    const t = buildSkeleton(g, suggest(g))
    expect(t.ignored).toEqual([{ members: ['file:source/roku_modules/v/x.brs'], reason: 'vendor' }])
    expect(t.features.map((f) => f.id)).toContain('shared-source-lib')
    expect(new Set(t.features.map((f) => f.id)).size).toBe(t.features.length)
  })
})
