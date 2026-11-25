import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8')
const facts = JSON.parse(read('skills', 'facts.json'))
const FORMAT = read('skills', 'mapping-a-roku-app', 'references', 'feature-tree-format.md')

describe('mapping-a-roku-app skill', () => {
  test('is in facts, the manifest, the CLI help and the guide table', () => {
    expect(facts.skills).toContain('mapping-a-roku-app')
    const m = JSON.parse(read('skills', 'manifest.json'))
    expect(m.skills.map(s => s.name)).toContain('mapping-a-roku-app')
    expect(read('bin', 'cli.js')).toContain('instrumenting-a-roku-app, mapping-a-roku-app, mocking-network-and-store')
    expect(read('docs', 'guide', 'agent-skills.md')).toMatch(/^\| `mapping-a-roku-app` \|/m)
  })

  test('format reference states every enum, cap and schema from facts.featureTree', () => {
    const f = facts.featureTree
    expect(FORMAT).toContain(f.schema)
    for (const k of [...f.kinds, ...f.lanes, ...f.needs, ...f.paths, ...f.risks]) expect(FORMAT).toContain(k)
    for (const r of f.rules) expect(FORMAT).toContain('| ' + r + ' |')
    expect(FORMAT).toContain(f.idPattern)
    for (const n of [f.caps.features, f.caps.name, f.caps.summary, f.caps.proposedTestsPerFeature]) expect(FORMAT).toContain(String(n))
    expect(f.caps.why).toBe(300)
    expect(f.caps.notes).toBe(300)
    expect(f.caps.reason).toBe(300)
    expect(f.exitCodes.invalid).toBe(3)
  })

  test('router, assessing, brownfield and CI skills point at it', () => {
    for (const s of ['adopting-brighttest', 'assessing-a-roku-app', 'adopting-brighttest-brownfield', 'wiring-brighttest-into-ci']) {
      expect(read('skills', s, 'SKILL.md')).toContain('mapping-a-roku-app')
    }
  })

  test('agents: assessor preloads the skill and may write only tree.json; test-author follows the path', () => {
    const a = read('skills', '_agents', 'adoption-assessor.md')
    expect(a).toMatch(/^skills: \[.*mapping-a-roku-app.*\]$/m)
    expect(a).toContain('features graph')
    expect(a).toContain('`tree.json`')
    expect(read('skills', '_agents', 'test-author.md')).toContain('tree.json')
  })
})
