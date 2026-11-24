import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ADOPT-TREE-FX: shape checks for the hand-written feature tree ground truth (design: brownfield-feature-tree 3.3, 3.4).
// The headless run of the fixture lives in test/integration/features-fixtures.test.js.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')
const CYCLES = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'cycles')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

const NODE_KINDS = ['file', 'component', 'builtin', 'global', 'registry', 'entry']
const EDGE_KINDS = ['extends', 'script', 'import', 'child', 'creates', 'runs-task', 'calls', 'callfunc', 'observes',
  'global-read', 'global-write', 'registry', 'spec-covers', 'entry']
const CONFS = ['exact', 'name', 'ambiguous', 'dynamic', 'unresolved', 'builtin']
const FEATURE_KINDS = ['app-shell', 'screen', 'flow', 'service', 'widget', 'shared', 'platform', 'vendor']
const RISKS = ['low', 'medium', 'high']
const PATHS = ['leaf-first', 'screen-first']

describe('feature-tree-app EXPECTED-GRAPH.json', () => {
  const g = readJson(path.join(APP, 'EXPECTED-GRAPH.json'))
  const ids = new Set(g.nodes.map((n) => n.id))

  it('has the schema, non-empty nodes, edges and uncertainty', () => {
    expect(g.schema).toBe('brighttest-feature-graph/v1')
    for (const k of ['nodes', 'edges']) expect(g[k].length).toBeGreaterThan(0)
    expect(g.uncertainty.items.length).toBeGreaterThan(0)
    expect(g.suggested.entry).toBe('comp:MainScene')
  })

  it('nodes have unique ids with a valid kind and matching id prefix', () => {
    expect(ids.size).toBe(g.nodes.length)
    for (const n of g.nodes) {
      expect(NODE_KINDS).toContain(n.kind)
      expect(n.id.startsWith(n.kind === 'component' ? 'comp:' : n.kind + ':')).toBe(true)
    }
  })

  it('edges have valid kind, conf and at, and reference known nodes (null target only when not exact)', () => {
    for (const e of g.edges) {
      expect(EDGE_KINDS).toContain(e.kind)
      expect(CONFS).toContain(e.conf)
      expect(e.at).toMatch(/^[^:]+:\d+$/)
      expect(ids.has(e.from)).toBe(true)
      if (e.to === null) expect(['dynamic', 'ambiguous', 'unresolved']).toContain(e.conf)
      else expect(ids.has(e.to)).toBe(true)
      if (e.conf === 'ambiguous') expect(e.candidates.length).toBeGreaterThan(1)
    }
  })

  it('covers every edge kind the fixture is meant to exercise', () => {
    const kinds = new Set(g.edges.map((e) => e.kind))
    expect([...kinds].sort()).toEqual([...EDGE_KINDS].sort())
  })

  it('every "at" points at a real line of a real file, and files exist', () => {
    for (const e of g.edges) {
      const [rel, line] = [e.at.slice(0, e.at.lastIndexOf(':')), Number(e.at.slice(e.at.lastIndexOf(':') + 1))]
      const lines = fs.readFileSync(path.join(APP, rel), 'utf8').split('\n')
      expect(line).toBeGreaterThanOrEqual(1)
      expect(line).toBeLessThanOrEqual(lines.length)
    }
    for (const n of g.nodes.filter((x) => x.kind === 'file')) {
      expect(fs.existsSync(path.join(APP, n.id.slice('file:'.length)))).toBe(true)
    }
  })

  it('resolution totals match the edge list and uncertainty counts match the items', () => {
    const by = {}
    for (const e of g.edges) by[e.conf] = (by[e.conf] || 0) + 1
    expect(g.resolution.edgesTotal).toBe(g.edges.length)
    expect(g.resolution.byConf).toEqual(by)
    const counts = {}
    for (const i of g.uncertainty.items) counts[i.kind] = (counts[i.kind] || 0) + 1
    expect(g.uncertainty.counts).toEqual(counts)
  })

  it('lists every source file of the app as a file node', () => {
    const onDisk = []
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name)
        if (f.isDirectory()) walk(p)
        else if (/\.(brs|bs|xml)$/.test(f.name) || f.name === 'manifest') onDisk.push('file:' + path.relative(APP, p).split(path.sep).join('/'))
      }
    }
    walk(APP)
    const nodes = g.nodes.filter((n) => n.kind === 'file').map((n) => n.id)
    expect(nodes.sort()).toEqual(onDisk.sort())
  })
})

describe('feature-tree-app EXPECTED-FEATURES.json', () => {
  const f = readJson(path.join(APP, 'EXPECTED-FEATURES.json'))
  const g = readJson(path.join(APP, 'EXPECTED-GRAPH.json'))

  it('has the schema, provenance, paths and a non-empty feature list', () => {
    expect(f.schema).toBe('brighttest-feature-tree/v1')
    expect(f.provenance.author).toBeTruthy()
    expect(f.features.length).toBeGreaterThan(0)
    expect(PATHS).toContain(f.paths.recommended)
    expect(f.paths.reason).toBeTruthy()
    expect(Array.isArray(f.ignored)).toBe(true)
  })

  it('each feature has valid id, kind, risk, text caps and non-empty members and coreFiles', () => {
    const seen = new Set()
    for (const x of f.features) {
      expect(x.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
      expect(seen.has(x.id)).toBe(false)
      seen.add(x.id)
      expect(FEATURE_KINDS).toContain(x.kind)
      expect(RISKS).toContain(x.risk)
      expect(x.name.length).toBeGreaterThan(0)
      expect(x.name.length).toBeLessThanOrEqual(60)
      expect(x.summary.length).toBeLessThanOrEqual(400)
      expect(x.members.length).toBeGreaterThan(0)
      expect(x.coreFiles.length).toBeGreaterThan(0)
      for (const c of x.coreFiles) expect(x.members).toContain('file:' + c)
    }
  })

  it('every file node is in exactly one feature, members exist, and a component sits with its XML file (V3, V4)', () => {
    const ids = new Set(g.nodes.map((n) => n.id))
    const owner = new Map()
    for (const x of f.features) {
      for (const m of x.members) {
        expect(ids.has(m)).toBe(true)
        expect(owner.has(m)).toBe(false)
        owner.set(m, x.id)
      }
    }
    for (const n of g.nodes.filter((n) => n.kind === 'file')) expect(owner.has(n.id)).toBe(true)
    for (const n of g.nodes.filter((n) => n.kind === 'component')) {
      expect(owner.get(n.id)).toBe(owner.get('file:' + n.file))
    }
  })
})

describe('feature-graph cycles fixture', () => {
  const e = readJson(path.join(CYCLES, 'EXPECTED.json'))

  it('EXPECTED.json lists non-empty cases and the files it names exist', () => {
    for (const k of ['componentCycles', 'selfExtends', 'fileCallCycles', 'ambiguousCalls', 'unresolvedScripts', 'parseErrors', 'neverOpened', 'uncertaintyKinds']) {
      expect(e[k].length).toBeGreaterThan(0)
    }
    for (const cyc of e.fileCallCycles) {
      expect(cyc.length).toBeGreaterThanOrEqual(3)
      for (const id of cyc) expect(fs.existsSync(path.join(CYCLES, id.slice('file:'.length)))).toBe(true)
    }
    for (const rel of [...e.parseErrors, ...e.neverOpened]) expect(fs.existsSync(path.join(CYCLES, rel))).toBe(true)
    for (const a of e.ambiguousCalls) {
      expect(a.candidates.length).toBeGreaterThan(1)
      for (const c of a.candidates) expect(fs.readFileSync(path.join(CYCLES, c.slice('file:'.length)), 'utf8')).toContain('function ' + a.name)
    }
  })

  it('the component cycle, self-extends and unresolved script are present in the sources', () => {
    const read = (r) => fs.readFileSync(path.join(CYCLES, r), 'utf8')
    expect(read('components/a/CycleA.brs')).toContain('createChild("CycleB")')
    expect(read('components/b/CycleB.brs')).toContain('createChild("CycleA")')
    expect(read('components/loop/Loop.xml')).toContain('name="Loop" extends="Loop"')
    const u = e.unresolvedScripts[0]
    const [rel, line] = u.at.split(':')
    expect(read(rel).split('\n')[Number(line) - 1]).toContain(u.uri)
    expect(fs.existsSync(path.join(CYCLES, 'components', 'b', u.uri))).toBe(false)
  })

  it('the call cycle is closed (Ping -> Pong -> Pang -> Ping)', () => {
    const read = (r) => fs.readFileSync(path.join(CYCLES, 'source', r), 'utf8')
    expect(read('ping.brs')).toContain('Pong(')
    expect(read('pong.brs')).toContain('Pang(')
    expect(read('pang.brs')).toContain('Ping(')
  })
})
