import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
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
    expect(item.detail.indexOf('app-a')).toBeLessThan(80)
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

  it('control characters in folder names are replaced in the graph and in assess', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-esc-'))
    try {
      const dir = path.join(tmp, 'app\u001b[31m-x')
      fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'manifest'), 'title=X\n')
      fs.writeFileSync(path.join(dir, 'source/main.brs'), 'sub main()\nend sub\n')
      const g = await buildGraph(tmp)
      const detail = g.uncertainty.items.find((i) => i.kind === 'nested-manifests').detail
      expect(detail).toContain('app?[31m-x')
      expect(detail).not.toMatch(/[\u0000-\u001f]/)
      let out = ''
      await assess.run([tmp, '--json'], { stdout: (t) => { out += t }, stderr: () => {} })
      const rec = JSON.parse(out).recommendation
      expect(rec.blockers.concat(rec.nextSteps).join('\n')).not.toMatch(/\u001b/)
      expect(rec.nextSteps.join(' ')).toContain('app?[31m-x')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  it('a refused (symlinked) root manifest gets no hint, and a long list is capped', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-ref-'))
    try {
      fs.writeFileSync(path.join(tmp, 'elsewhere'), 'title=X\n')
      fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(tmp, 'manifest'))
      for (let i = 0; i < 7; i++) { fs.mkdirSync(path.join(tmp, `a${i}/src`), { recursive: true }); fs.writeFileSync(path.join(tmp, `a${i}/manifest`), 't=1\n'); fs.writeFileSync(path.join(tmp, `a${i}/src/m.brs`), 'sub m()\nend sub\n') }
      const g = await buildGraph(tmp)
      expect(g.uncertainty.counts['nested-manifests']).toBeUndefined()
      expect(nestedHint(nestedManifests(['a/manifest', 'a/src/x', 'b/manifest', 'b/source/x', 'c/manifest', 'c/src/x', 'd/manifest', 'd/src/x', 'e/manifest', 'e/src/x', 'f/manifest', 'f/src/x', 'g/manifest', 'g/src/x']))).toMatch(/\(and 2 more\)$/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})
