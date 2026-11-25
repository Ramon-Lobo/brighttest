import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph } = require('../lib/features/graph')
const { suggest } = require('../lib/features/cluster')
const { buildSkeleton } = require('../lib/features/digest')
const { validate } = require('../lib/features/check')
const schema = require('../lib/features/schema')
const features = require('../lib/features')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')
const CLI = path.join(ROOT, 'bin', 'cli.js')

let graph; let skeleton
beforeAll(async () => {
  graph = await buildGraph(APP)
  skeleton = buildSkeleton(graph, suggest(graph))
})

const clone = (x) => JSON.parse(JSON.stringify(x))
// Validates a mutated copy of the skeleton tree and returns the findings of one rule.
function mutate(fn, opts) {
  const t = clone(skeleton)
  fn(t)
  const r = validate(t, graph, opts)
  return { r, of: (rule) => r.findings.filter((f) => f.rule === rule) }
}
const featureWith = (t, id) => t.features.find((f) => f.members.includes(id))

describe('features check: the baseline', () => {
  it('accepts the skeleton tree of the example app', () => {
    const r = validate(clone(skeleton), graph)
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(r.ok).toBe(true)
  })
  it('never throws on garbage', () => {
    for (const bad of [null, 5, 'x', [], {}, { features: 'no' }, { features: [null, 3, { members: 7 }] }]) {
      expect(() => validate(bad, graph)).not.toThrow()
      expect(validate(bad, graph).ok).toBe(false)
    }
  })
})

describe('V1 shape, types, enums and caps', () => {
  it('rejects a wrong schema id, enum and type', () => {
    expect(mutate((t) => { t.schema = 'other/v1' }).of('V1')[0].pointer).toBe('/schema')
    expect(mutate((t) => { t.features[0].kind = 'page' }).of('V1')[0].pointer).toBe('/features/0/kind')
    expect(mutate((t) => { t.features[0].risk = 3 }).of('V1')[0].pointer).toBe('/features/0/risk')
  })
  it('rejects an unknown key, and says dependsOn is computed', () => {
    const m = mutate((t) => { t.features[0].dependsOn = ['x'] })
    expect(m.of('V1')[0].message).toContain('computed')
  })
  it('enforces the text and count caps', () => {
    expect(mutate((t) => { t.features[0].name = 'n'.repeat(61) }).of('V1')[0].code).toBe('too-long')
    expect(mutate((t) => { t.features[0].summary = 's'.repeat(401) }).of('V1')[0].code).toBe('too-long')
    expect(mutate((t) => { t.features[0].notes = 'n '.repeat(151) }).of('V1')[0].code).toBe('too-long')
    const tests = Array.from({ length: 21 }, () => ({ target: 'comp:Badge', lane: 'headless-scene', title: 't', why: 'w' }))
    expect(mutate((t) => { t.features[0].proposedTests = tests }).of('V1').some((f) => f.code === 'too-many')).toBe(true)
    expect(mutate((t) => { t.features = Array.from({ length: 401 }, (_, i) => ({ ...t.features[0], id: `f${i}` })) }).of('V1').some((f) => f.pointer === '/features' && f.code === 'too-many')).toBe(true)
  })
  it('does not accept unknown as a lane', () => {
    const m = mutate((t) => { t.features[0].proposedTests = [{ target: 'comp:Badge', lane: 'unknown', title: 't', why: 'w' }] })
    expect(m.of('V1')[0].pointer).toBe('/features/0/proposedTests/0/lane')
  })
})

describe('V2 binding to the graph', () => {
  it('reports a stale graph hash and a different treeHash', () => {
    const a = mutate((t) => { t.graph.hash = '0'.repeat(64) })
    expect(a.of('V2')[0]).toMatchObject({ code: 'stale-graph', pointer: '/graph/hash', severity: 'error' })
    expect(mutate((t) => { t.graph.treeHash = 'abc' }).of('V2')[0].pointer).toBe('/graph/treeHash')
  })
  it('reports a graph edited after it was written', () => {
    const g = clone(graph); g.nodes.pop()
    const r = validate(clone(skeleton), g)
    expect(r.findings.some((f) => f.rule === 'V2' && f.code === 'graph-hash')).toBe(true)
  })
})

describe('V3 every file in exactly one feature', () => {
  it('reports an unassigned file, and --partial relaxes it', () => {
    const drop = (t) => { const f = featureWith(t, 'file:source/lib/Config.brs'); f.members = f.members.filter((m) => m !== 'file:source/lib/Config.brs') }
    const m = mutate(drop)
    expect(m.of('V3')[0]).toMatchObject({ code: 'unassigned-file', severity: 'error' })
    expect(m.of('V3')[0].message).toContain('file:source/lib/Config.brs')
    expect(mutate(drop, { partial: true }).of('V3')).toEqual([])
  })
  it('reports a file in two features, and in a feature and ignored', () => {
    expect(mutate((t) => { t.features[1].members.push('file:source/lib/Config.brs') }).of('V3').some((f) => f.code === 'duplicate-member')).toBe(true)
    expect(mutate((t) => { t.ignored.push({ members: ['file:source/lib/Config.brs'], reason: 'vendor' }) }).of('V3').some((f) => f.code === 'duplicate-member')).toBe(true)
  })
  it('--partial still rejects duplicates', () => {
    expect(mutate((t) => { t.features[1].members.push('file:source/lib/Config.brs') }, { partial: true }).of('V3').length).toBeGreaterThan(0)
  })
})

describe('V4 members exist; component and XML together', () => {
  it('reports a member that is not in the graph', () => {
    const m = mutate((t) => { t.features[0].members.push('file:source/nope.brs') })
    expect(m.of('V4')[0]).toMatchObject({ code: 'unknown-member', pointer: `/features/0/members/${skeleton.features[0].members.length}` })
  })
  it('reports a component split from its XML file', () => {
    const m = mutate((t) => {
      const from = featureWith(t, 'comp:Badge'); const to = t.features.find((f) => f !== from)
      from.members = from.members.filter((x) => x !== 'comp:Badge'); to.members.push('comp:Badge')
    })
    expect(m.of('V4').some((f) => f.code === 'split-component')).toBe(true)
  })
})

describe('V5 feature ids', () => {
  it('rejects a bad slug and a duplicate id', () => {
    expect(mutate((t) => { t.features[0].id = 'Bad_Id' }).of('V5')[0].code).toBe('bad-id')
    expect(mutate((t) => { t.features[0].id = '-x' }).of('V5')[0].code).toBe('bad-id')
    expect(mutate((t) => { t.features[0].id = 'a'.repeat(49) }).of('V5')[0].code).toBe('bad-id')
    expect(mutate((t) => { t.features[1].id = t.features[0].id }).of('V5')[0]).toMatchObject({ code: 'duplicate-id', pointer: '/features/1/id' })
  })
})

describe('V6 testability overrides', () => {
  const withOverride = (o) => (t) => { const f = featureWith(t, o.node) || t.features[0]; f.testability = { overrides: [o] } }
  it('rejects an override of a node that does not exist', () => {
    expect(mutate(withOverride({ node: 'file:source/nope.brs', class: 'headless-unit', reason: 'r' }), {}).of('V6')[0].code).toBe('bad-override')
  })
  it('a cheaper class than the rule needs evidence', () => {
    const o = { node: 'file:components/widgets/Badge.brs', class: 'headless-unit', reason: 'pure helpers' }
    expect(mutate(withOverride(o)).of('V6')[0].pointer).toMatch(/\/evidence$/)
    expect(mutate(withOverride({ ...o, evidence: 'source/tests/Nope.spec.bs' })).of('V6').length).toBe(1)
    expect(mutate(withOverride({ ...o, evidence: 'source/tests/Badge.spec.bs' })).of('V6')).toEqual([])
    expect(mutate(withOverride({ ...o, evidence: 'run:reports/junit.xml' })).of('V6')).toEqual([])
  })
  it('a dearer class than the rule needs no evidence', () => {
    expect(mutate(withOverride({ node: 'file:components/widgets/Badge.brs', class: 'device', reason: 'real timing' })).of('V6')).toEqual([])
  })
  it('an override of an unknown node needs a reason only and is labelled agent judgement', () => {
    const m = mutate(withOverride({ node: 'file:source/lib/Logger.brs', class: 'headless-unit', reason: 'plain wrapper' }))
    expect(m.of('V6')).toEqual([])
    expect(m.r.agentJudgement).toEqual(['file:source/lib/Logger.brs'])
  })
  it('an override cannot set unknown, and needs a reason', () => {
    const f = featureWith(skeleton, 'file:source/lib/Logger.brs')
    expect(f).toBeTruthy()
    expect(mutate(withOverride({ node: 'file:source/lib/Logger.brs', class: 'unknown', reason: 'r' })).of('V1')[0].pointer).toMatch(/overrides\/0\/class$/)
    expect(mutate(withOverride({ node: 'file:source/lib/Logger.brs', class: 'headless-unit' })).of('V1')[0].pointer).toMatch(/overrides\/0\/reason$/)
  })
})

describe('V7 proposed tests', () => {
  const addTest = (tst) => (t) => { t.features[0].proposedTests = [{ title: 't', why: 'w', ...tst }] }
  it('rejects a target that is not in the graph or not a file or component', () => {
    expect(mutate(addTest({ target: 'file:nope.brs', lane: 'headless-unit' })).of('V7')[0].code).toBe('bad-test')
    expect(mutate(addTest({ target: 'entry:main', lane: 'headless-scene' })).of('V7')[0].message).toContain('entry node')
  })
  it('rejects headless-unit on a component with inline CDATA script only', () => {
    expect(mutate(addTest({ target: 'comp:InlineBanner', lane: 'headless-unit' })).of('V7')[0].pointer).toMatch(/lane$/)
    expect(mutate(addTest({ target: 'comp:InlineBanner', lane: 'headless-scene' })).of('V7')).toEqual([])
  })
  it('warns, not errors, on a node no rule classified', () => {
    const m = mutate(addTest({ target: 'file:source/lib/Logger.brs', lane: 'headless-unit' }))
    expect(m.of('V7')[0]).toMatchObject({ severity: 'warning', code: 'not-classified' })
    expect(m.r.ok).toBe(true)
    const o = mutate((t) => { addTest({ target: 'file:source/lib/Logger.brs', lane: 'headless-unit' })(t); featureWith(t, 'file:source/lib/Logger.brs').testability = { overrides: [{ node: 'file:source/lib/Logger.brs', class: 'headless-unit', reason: 'r' }] } })
    expect(o.of('V7')).toEqual([])
  })
})

describe('V8 text hygiene', () => {
  const bad = {
    'a control character': 'line\u0007bell',
    'an absolute path': 'see /Users/someone/app/main.brs',
    'a windows path': 'see C:\\work\\app\\main.brs',
    'a URL with credentials': 'fetch https://user:pw@example.com/x',
    'a Bearer token': 'sends Bearer abcdef123456',
    'a long token': 'key 0123456789abcdef0123456789abcdef0123',
    'HTML': 'click <b>here</b>',
  }
  for (const [label, text] of Object.entries(bad)) {
    it(`rejects ${label}`, () => {
      const m = mutate((t) => { t.features[0].summary = text })
      expect(m.of('V8')[0]).toMatchObject({ code: 'unsafe-text', pointer: '/features/0/summary', severity: 'error' })
    })
  }
  it('checks every text field, and an absolute run: evidence', () => {
    expect(mutate((t) => { t.paths.reason = 'in /etc/passwd' }).of('V8')[0].pointer).toBe('/paths/reason')
    expect(mutate((t) => { t.ignored.push({ members: [], reason: 'x\u0000' }) }).of('V8')[0].pointer).toBe('/ignored/0/reason')
    const m = mutate((t) => { featureWith(t, 'file:components/widgets/Badge.brs').testability = { overrides: [{ node: 'file:components/widgets/Badge.brs', class: 'device', reason: 'r', evidence: 'run:/tmp/junit.xml' }] } })
    expect(m.of('V8')[0].pointer).toMatch(/evidence$/)
  })
  it('accepts ordinary prose', () => {
    expect(mutate((t) => { t.features[0].summary = 'Plays and/or pauses a title (v1.2), see components/player/PlayerScreen.brs.' }).of('V8')).toEqual([])
  })
})

describe('V9 recommended path', () => {
  it('rejects a value outside the enum, a missing reason and missing paths', () => {
    expect(mutate((t) => { t.paths.recommended = 'sideways' }).of('V9')[0].pointer).toBe('/paths/recommended')
    expect(mutate((t) => { t.paths.reason = ' ' }).of('V9')[0].pointer).toBe('/paths/reason')
    expect(mutate((t) => { delete t.paths }).of('V9')[0].pointer).toBe('/paths')
    expect(mutate((t) => { t.paths.recommended = 'base-first' }).of('V9')).toEqual([])
  })
})

describe('schema facts', () => {
  it('exposes the featureTree block that skills/facts.json carries', () => {
    const f = schema.facts()
    expect(f.exitCodes).toEqual({ ok: 0, internal: 1, usage: 2, invalid: 3 })
    expect(f.lanes).not.toContain('unknown')
    expect(f.rules).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'])
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'facts.json'), 'utf8'))
    expect(onDisk.featureTree).toEqual(JSON.parse(JSON.stringify(f)))
  })
})

describe('features check command', () => {
  let tmp
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fcheck-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  const put = (tree, g = graph) => {
    fs.writeFileSync(path.join(tmp, 'tree.json'), JSON.stringify(tree))
    fs.writeFileSync(path.join(tmp, 'graph.json'), JSON.stringify(g))
  }
  async function run(args) {
    let out = ''; let err = ''
    const code = await features.run(args, { stdout: (s) => { out += s }, stderr: (s) => { err += s } })
    return { code, out, err }
  }

  it('exits 0 on a valid tree, with the graph next to it by default', async () => {
    put(skeleton)
    const r = await run(['check', path.join(tmp, 'tree.json')])
    expect(r.code).toBe(0)
    expect(r.out).toContain('ok:')
  })
  it('exits 3 on an invalid tree and prints findings as JSON', async () => {
    const t = clone(skeleton); t.graph.hash = 'f'.repeat(64)
    put(t)
    const r = await run(['check', path.join(tmp, 'tree.json'), '--json'])
    expect(r.code).toBe(3)
    const j = JSON.parse(r.out)
    expect(j).toMatchObject({ schema: 'brighttest-feature-check/v1', ok: false })
    expect(j.findings[0]).toMatchObject({ severity: 'error', rule: 'V2', code: 'stale-graph' })
  })
  it('exits 2 on a missing or malformed input', async () => {
    expect((await run(['check', path.join(tmp, 'nope.json')])).code).toBe(2)
    fs.writeFileSync(path.join(tmp, 'tree.json'), '{nope')
    fs.writeFileSync(path.join(tmp, 'graph.json'), JSON.stringify(graph))
    expect((await run(['check', path.join(tmp, 'tree.json')])).code).toBe(2)
    put(skeleton, { schema: 'something-else' })
    expect((await run(['check', path.join(tmp, 'tree.json')])).code).toBe(2)
  })
  it('honours --graph and --partial, and rejects graph-only flags misuse', async () => {
    const t = clone(skeleton); t.features[0].members.pop()
    fs.writeFileSync(path.join(tmp, 'tree.json'), JSON.stringify(t))
    fs.writeFileSync(path.join(tmp, 'g.json'), JSON.stringify(graph))
    const args = ['check', path.join(tmp, 'tree.json'), '--graph', path.join(tmp, 'g.json')]
    expect((await run(args)).code).toBe(3)
    expect((await run([...args, '--partial'])).code).toBe(0)
    expect((await run(['graph', '--partial'])).code).toBe(2)
    expect((await run(['check', '--bogus'])).code).toBe(2)
  })
  it('works through the CLI and appears in its help', () => {
    put(skeleton)
    const c = spawnSync(process.execPath, [CLI, 'features', 'check', path.join(tmp, 'tree.json')], { encoding: 'utf8', timeout: 60000 })
    expect(c.status).toBe(0)
    const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 60000 })
    expect(h.stdout).toContain('brighttest features check')
  })
})
