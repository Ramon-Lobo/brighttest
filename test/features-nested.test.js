import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph } = require('../lib/features/graph')
const { nestedManifests, nestedHint } = require('../lib/features/nested')
const assess = require('../lib/assess')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NESTED = path.join(ROOT, 'test/fixtures/nested-manifests')
const SINGLE = path.join(ROOT, 'test/fixtures/feature-graph/cycles')

describe('nested manifest folders', () => {
  it('nestedManifests needs a manifest plus a source/ or src/ tree', () => {
    expect(nestedManifests(['app-a/manifest', 'app-a/source/main.brs', 'lib-b/manifest', 'lib-b/src/x.brs', 'c/manifest', 'c/readme.md'])).toEqual(['app-a', 'lib-b'])
    expect(nestedManifests(['manifest', 'source/main.brs'])).toEqual([])
    expect(nestedHint([])).toBe('')
  })

  it('features graph at a root with no manifest names the nested folders', async () => {
    const g = await buildGraph(NESTED)
    expect(g.nodes.filter((n) => n.kind === 'component')).toHaveLength(0)
    expect(g.uncertainty.counts['nested-manifests']).toBe(1)
    const item = g.uncertainty.items.find((i) => i.kind === 'nested-manifests')
    expect(item.detail).toContain('app-a, lib-b')
  })

  it('features graph on a nested folder itself has no hint', async () => {
    const g = await buildGraph(path.join(NESTED, 'app-a'))
    expect(g.uncertainty.counts['nested-manifests']).toBeUndefined()
    expect(g.nodes.some((n) => n.id === 'file:manifest')).toBe(true)
  })

  it('assess stays not-a-roku-app but names the nested folders in a blocker and next step', async () => {
    let out = ''
    const code = await assess.run([NESTED, '--json'], { stdout: (t) => { out += t }, stderr: () => {} })
    expect(code).toBe(0)
    const r = JSON.parse(out)
    expect(r.recommendation.path).toBe('not-a-roku-app')
    expect(r.recommendation.blockers.join(' ')).toContain('app-a, lib-b')
    expect(r.recommendation.nextSteps.join(' ')).toContain('app-a, lib-b')
  })

  it('a normal single-app root gets no hint', async () => {
    const g = await buildGraph(SINGLE)
    expect(g.uncertainty.counts['nested-manifests']).toBeUndefined()
  })
})
