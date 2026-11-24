import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph, canonicalJson, hashGraph } = require('../lib/features/graph')
const census = require('../lib/instrument/census')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')
const CYCLES = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'cycles')
const STRUCTURAL = ['extends', 'script', 'import', 'child', 'creates', 'runs-task', 'entry', 'global-read', 'global-write', 'registry', 'spec-covers']
const ek = (e) => [e.kind, e.from, e.to, e.conf, e.at].join('|')

let app; let cyc; let expected
beforeAll(async () => {
  app = await buildGraph(APP)
  cyc = await buildGraph(CYCLES)
  expected = JSON.parse(fs.readFileSync(path.join(APP, 'EXPECTED-GRAPH.json'), 'utf8'))
})
const find = (g, kind, at) => g.edges.filter((e) => e.kind === kind && (!at || e.at === at))

describe('feature graph: ground truth', () => {
  it('has the contract shape', () => {
    expect(app.schema).toBe('brighttest-feature-graph/v1')
    expect(app.scan.treeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(app.hash).toBe(hashGraph(app))
    expect(app.uncertainty.blindSpots.length).toBeGreaterThan(0)
  })
  it('matches the node ids of EXPECTED-GRAPH.json', () => {
    expect(app.nodes.map((n) => n.id).sort()).toEqual(expected.nodes.map((n) => n.id).sort())
  })
  it('matches the structural edges of EXPECTED-GRAPH.json exactly', () => {
    const want = expected.edges.filter((e) => STRUCTURAL.includes(e.kind)).map(ek).sort()
    expect(app.edges.map(ek).sort()).toEqual(want)
  })
  it('matches component data (extends, task, interface, scene) of EXPECTED-GRAPH.json', () => {
    for (const n of expected.nodes.filter((x) => x.kind === 'component')) {
      const got = app.nodes.find((x) => x.id === n.id)
      for (const k of ['file', 'extends', 'isScene', 'isTask', 'thread', 'interface', 'inlineCdata']) expect(got[k], `${n.id}.${k}`).toEqual(n[k])
    }
  })
  it('reports the census-derivable uncertainty kinds with their places', () => {
    const at = (k) => app.uncertainty.items.filter((i) => i.kind === k).map((i) => i.at)
    expect(at('dynamic-createobject')).toEqual(['components/shell/MainScene.brs:20'])
    expect(at('component-library')).toEqual(['components/widgets/LibLoader.xml:4'])
    expect(at('inline-cdata')).toEqual(['components/widgets/InlineBanner.xml:3'])
    expect(at('bs-const-branch')).toEqual(['source/lib/Logger.brs:3'])
    expect(app.uncertainty.items.find((i) => i.kind === 'bs-const-branch').detail).toContain('(false)')
  })
})

describe('feature graph: one case per edge kind', () => {
  it('extends: builtin and component targets', () => {
    expect(find(app, 'extends', 'components/shell/MainScene.xml:2')[0]).toMatchObject({ to: 'builtin:Scene', conf: 'builtin' })
  })
  it('script: exact and unresolved', () => {
    expect(find(app, 'script', 'components/shell/MainScene.xml:4')[0]).toMatchObject({ to: 'file:source/lib/Logger.brs', conf: 'exact' })
    expect(find(cyc, 'script', 'components/b/CycleB.xml:8')[0]).toMatchObject({ to: null, conf: 'unresolved' })
    expect(cyc.uncertainty.items).toContainEqual({ kind: 'unresolved-script', at: 'components/b/CycleB.xml:8', detail: 'Missing.brs' })
  })
  it('import: exact and unresolved', () => {
    expect(find(app, 'import')[0]).toMatchObject({ from: 'file:source/lib/Greeting.bs', to: 'file:source/lib/StringUtils.brs', conf: 'exact' })
    expect(find(cyc, 'import')[0]).toMatchObject({ to: null, conf: 'unresolved', at: 'source/imports.bs:1' })
    expect(cyc.uncertainty.counts['unresolved-import']).toBe(1)
  })
  it('child: component and builtin', () => {
    expect(find(app, 'child', 'components/shell/MainScene.xml:7')[0]).toMatchObject({ to: 'comp:HomeScreen', conf: 'name' })
    expect(find(app, 'child', 'components/shell/MainScene.xml:8')[0]).toMatchObject({ to: 'builtin:Timer', conf: 'builtin' })
  })
  it('creates: literal createChild, literal and dynamic CreateObject', () => {
    expect(find(cyc, 'creates', 'components/a/CycleA.brs:2')[0]).toMatchObject({ to: 'comp:CycleB', conf: 'name' })
    expect(find(app, 'creates', 'components/shell/MainScene.brs:3')[0]).toMatchObject({ to: 'comp:ApiTask', conf: 'name' })
    expect(find(app, 'creates', 'components/shell/MainScene.brs:20')[0]).toMatchObject({ to: null, conf: 'dynamic' })
  })
  it('runs-task: a Task created and run in the same function', () => {
    expect(find(app, 'runs-task')).toHaveLength(1)
    expect(find(app, 'runs-task')[0]).toMatchObject({ to: 'comp:ApiTask', at: 'components/shell/MainScene.brs:5' })
  })
  it('entry: CreateScene target', () => {
    expect(find(app, 'entry')[0]).toMatchObject({ from: 'entry:main', to: 'comp:MainScene', at: 'source/main.brs:5' })
    expect(app.nodes.find((n) => n.id === 'entry:main')).toMatchObject({ kind: 'entry', file: 'source/main.brs' })
  })
  it('global-read and global-write, including addFields and a dynamic key', () => {
    expect(find(app, 'global-write', 'components/shell/MainScene.brs:2')[0]).toMatchObject({ to: 'global:analyticsCount', detail: 'addFields' })
    expect(find(app, 'global-read', 'source/lib/Logger.brs:7')).toHaveLength(1)
    expect(find(cyc, 'global-read', 'source/imports.bs:7')[0]).toMatchObject({ to: null, conf: 'dynamic' })
    expect(cyc.uncertainty.counts['dynamic-global']).toBe(1)
  })
  it('registry: literal section', () => {
    expect(find(app, 'registry')[0]).toMatchObject({ to: 'registry:settings', conf: 'exact', at: 'components/settings/SettingsScreen.brs:2' })
  })
  it('spec-covers: @SGNode and called names', () => {
    expect(find(app, 'spec-covers', 'source/tests/Badge.spec.bs:3')[0]).toMatchObject({ to: 'comp:Badge', conf: 'name' })
    expect(find(app, 'spec-covers', 'source/tests/StringUtils.spec.bs:9')[0]).toMatchObject({ to: 'file:source/lib/StringUtils.brs', detail: 'Str_trim' })
  })
  it('keeps spec files out of the vendor class', () => {
    expect(app.nodes.find((n) => n.id === 'file:source/tests/Badge.spec.bs')).toMatchObject({ spec: true, vendor: false })
  })
  it('decodes XML entities in names', () => {
    const n = cyc.nodes.find((x) => x.id === 'comp:Fish&Chips')
    expect(n.interface.functions).toEqual(['a<b"c'])
    expect(find(cyc, 'script', 'components/hostile/Fish&Chips.xml:7')[0].to).toBe('file:components/hostile/Fish&Chips.brs')
  })
})

describe('feature graph: uncertainty from census facts', () => {
  it('parse-error and not-read', () => {
    expect(cyc.uncertainty.items.find((i) => i.kind === 'parse-error').at).toBe('source/broken.brs')
    expect(cyc.uncertainty.items.find((i) => i.kind === 'not-read').at).toBe('source/secret.key')
  })
  it('a symlink is reported not-read and never opened; secret file content never appears', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.cpSync(CYCLES, tmp, { recursive: true })
      fs.symlinkSync('secret.key', path.join(tmp, 'source', 'link.brs'))
      const g = await buildGraph(tmp)
      const nr = g.uncertainty.items.filter((i) => i.kind === 'not-read').map((i) => i.at)
      expect(nr).toContain('source/link.brs')
      expect(g.nodes.some((n) => n.id === 'file:source/link.brs')).toBe(false)
      expect(JSON.stringify(g)).not.toContain(fs.readFileSync(path.join(CYCLES, 'source', 'secret.key'), 'utf8').trim())
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  it('truncated: the size cap is reported', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.cpSync(APP, tmp, { recursive: true })
      fs.writeFileSync(path.join(tmp, 'source', 'big.brs'), 'x'.repeat(2 * 1024 * 1024 + 10))
      const g = await buildGraph(tmp)
      expect(g.scan.truncated).toBe(true)
      expect(g.uncertainty.counts.truncated).toBe(1)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('feature graph: census hook and hash', () => {
  it.each([['feature-tree-app', APP], ['cycles', CYCLES]])('census output is byte-identical with and without onFile (%s)', async (_n, dir) => {
    const plain = JSON.stringify(await census.census(dir))
    let calls = 0
    const hooked = JSON.stringify(await census.census(dir, { onFile: () => { calls++ } }))
    expect(hooked).toBe(plain)
    expect(calls).toBeGreaterThan(0)
  })
  it('the hash is deterministic across runs and ignores key order', async () => {
    const again = await buildGraph(APP)
    expect(again.hash).toBe(app.hash)
    expect(canonicalJson(again)).toBe(canonicalJson(app))
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}')
  })
  it('the hash changes when the tree changes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.cpSync(APP, tmp, { recursive: true })
      fs.appendFileSync(path.join(tmp, 'source', 'lib', 'Config.brs'), "\n' changed\n")
      const g = await buildGraph(tmp)
      expect(g.scan.treeHash).not.toBe(app.scan.treeHash)
      expect(g.hash).not.toBe(app.hash)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})
