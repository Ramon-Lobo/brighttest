import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph, canonicalJson, hashGraph, parseXml, collectBrs } = require('../lib/features/graph')
const census = require('../lib/instrument/census')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')
const CYCLES = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'cycles')
const STRUCTURAL = ['extends', 'script', 'import', 'child', 'creates', 'runs-task', 'entry', 'global-read', 'global-write', 'registry', 'spec-covers']
// Facts that EXPECTED-GRAPH.json lists but the T1a graph does not produce yet (deferred to T1b); everything else must match.
const DEFERRED = {
  'file:components/player/PlayerScreen.brs': { platformObjects: ['Video'] }, // a component-child platform class, not a CreateObject
  'file:components/shell/MainScene.brs': { timers: true }, // Timer-node detection comes with scope resolution
}
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
      for (const k of ['file', 'extends', 'isScene', 'isTask', 'thread', 'interface', 'inlineCdata', 'children']) expect(got[k], `${n.id}.${k}`).toEqual(n[k])
    }
  })
  it('matches file node data (lang, spec, vendor, functions, facts) and byte sizes', () => {
    for (const n of expected.nodes.filter((x) => x.kind === 'file')) {
      const got = app.nodes.find((x) => x.id === n.id)
      for (const k of ['lang', 'spec', 'vendor']) expect(got[k], `${n.id}.${k}`).toEqual(n[k])
      expect(got.functions, `${n.id}.functions`).toEqual(n.functions ? n.functions.map((f) => ({ name: f.name, line: f.line })) : undefined)
      const facts = { ...(n.facts || {}) }
      for (const k of Object.keys(DEFERRED[n.id] || {})) delete facts[k]
      expect(got.facts, `${n.id}.facts`).toEqual(Object.keys(facts).length ? facts : undefined)
      const real = fs.statSync(path.join(APP, n.id.slice(5))).size
      expect(got.bytes, `${n.id}.bytes`).toBe(real)
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
    expect(find(cyc, 'extends', 'components/loop/Loop.xml:2')[0]).toMatchObject({ from: 'comp:Loop', to: 'comp:Loop', conf: 'exact' })
  })
  it('extends: a component that extends another component is exact, and its builtinRoot is the end of the chain', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.mkdirSync(path.join(tmp, 'components'))
      fs.writeFileSync(path.join(tmp, 'manifest'), 'title=t\n')
      fs.writeFileSync(path.join(tmp, 'components', 'Base.xml'), '<component name="Base" extends="Group"></component>\n')
      fs.writeFileSync(path.join(tmp, 'components', 'Kid.xml'), '<component name="Kid" extends="Base"></component>\n')
      const g = await buildGraph(tmp)
      expect(find(g, 'extends').map(ek).sort()).toEqual(['extends|comp:Base|builtin:Group|builtin|components/Base.xml:1', 'extends|comp:Kid|comp:Base|exact|components/Kid.xml:1'])
      expect(g.nodes.find((n) => n.id === 'comp:Kid').builtinRoot).toBe('Group')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
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
  it('a symlinked top-level source/ pointing outside the root is never read, walked or hashed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    const rootDir = path.join(tmp, 'app'); const outside = path.join(tmp, 'outside')
    const write = (marker) => {
      fs.mkdirSync(path.join(outside, 'source'), { recursive: true })
      fs.writeFileSync(path.join(outside, 'source', 'leak.brs'), `sub ${marker}()\n  x = CreateObject("roSGNode", "${marker}Node")\nend sub\n`)
    }
    try {
      write('OutsideMarkerAAA')
      fs.mkdirSync(path.join(rootDir, 'components'), { recursive: true })
      fs.writeFileSync(path.join(rootDir, 'manifest'), 'title=t\n')
      fs.writeFileSync(path.join(rootDir, 'components', 'C.xml'), '<component name="C" extends="Group">\n<script type="text/brightscript" uri="pkg:/source/leak.brs" />\n</component>\n')
      fs.symlinkSync(path.join(outside, 'source'), path.join(rootDir, 'source'))
      const reads = []
      const realSafeRead = census.safeRead
      const spy = vi.spyOn(census, 'safeRead').mockImplementation((f, o) => { reads.push(f); return realSafeRead(f, o) })
      const realOpen = fs.openSync
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((f, ...a) => { reads.push(String(f)); return realOpen(f, ...a) })
      let g
      try { g = await buildGraph(rootDir) } finally { spy.mockRestore(); openSpy.mockRestore() }
      expect(reads.filter((f) => f.includes('outside'))).toEqual([])
      const txt = JSON.stringify(g)
      expect(txt).not.toContain('OutsideMarker')
      expect(g.nodes.some((n) => n.id.startsWith('file:source/'))).toBe(false)
      expect(g.edges.some((e) => e.kind === 'script' && e.conf === 'exact')).toBe(false)
      expect(g.uncertainty.items.some((i) => i.kind === 'not-read' && i.at === 'source')).toBe(true)
      fs.rmSync(path.join(outside, 'source'), { recursive: true }); write('OutsideMarkerBBB')
      expect((await buildGraph(rootDir)).hash).toBe(g.hash)
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

describe('feature graph: literals, parsing cost and caps', () => {
  it('unescapes "" in string literals for component, global and registry ids', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.mkdirSync(path.join(tmp, 'source'))
      fs.writeFileSync(path.join(tmp, 'source', 'main.brs'), [
        'sub Main()',
        '  n = CreateObject("roSGNode", "Q""u\'o&te<")',
        '  m.global.addFields({ "k""ey": 1 })',
        '  r = CreateObject("roRegistrySection", "se""c")',
        'end sub', ''].join('\n'))
      const g = await buildGraph(tmp)
      const ids = g.nodes.map((n) => n.id)
      expect(find(g, 'creates')[0]).toMatchObject({ to: null, conf: 'unresolved', detail: "Q\"u'o&te<" })
      expect(ids).toContain('global:k"ey')
      expect(ids).toContain('registry:se"c')
      expect(ids.some((i) => i.includes('""'))).toBe(false)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  it('unresolved component names: typo child, unknown CreateObject, unknown extends, ropm-style prefix', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.mkdirSync(path.join(tmp, 'components')); fs.mkdirSync(path.join(tmp, 'source'))
      fs.writeFileSync(path.join(tmp, 'manifest'), 'title=  Synthetic App  \n')
      fs.writeFileSync(path.join(tmp, 'components', 'Real.xml'), '<component name="Real" extends="Group">\n<script uri="Real.brs" />\n<children>\n<Labell id="typo" />\n<roku_modules_acme_Card id="lib" />\n<label id="ok" />\n</children>\n</component>\n')
      fs.writeFileSync(path.join(tmp, 'components', 'Real.brs'), 'sub init()\n  a = CreateObject("roSGNode", "NoSuchTask")\n  a.control = "run"\n  b = CreateObject("roSGNode", "Real")\nend sub\n')
      fs.writeFileSync(path.join(tmp, 'components', 'Odd.xml'), '<component name="Odd" extends="acme_Widget"></component>\n')
      const g = await buildGraph(tmp)
      const tup = (e) => [e.kind, e.from, String(e.to), e.conf, e.at, e.detail].join('|')
      expect(g.app).toBe('Synthetic App')
      expect(g.edges.filter((e) => e.conf === 'unresolved' && e.kind !== 'script').map(tup).sort()).toEqual([
        'child|comp:Real|null|unresolved|components/Real.xml:4|Labell',
        'child|comp:Real|null|unresolved|components/Real.xml:5|roku_modules_acme_Card',
        'creates|file:components/Real.brs|null|unresolved|components/Real.brs:2|NoSuchTask',
        'extends|comp:Odd|null|unresolved|components/Odd.xml:1|acme_Widget',
      ])
      expect(find(g, 'child', 'components/Real.xml:6')[0]).toMatchObject({ to: 'builtin:label', conf: 'builtin' })
      expect(find(g, 'runs-task')).toHaveLength(0)
      expect(g.uncertainty.counts['unresolved-component']).toBe(4)
      const odd = g.nodes.find((n) => n.id === 'comp:Odd')
      expect(odd).toMatchObject({ unresolvedRoot: 'acme_Widget', isScene: false, isTask: false })
      expect(odd.builtinRoot).toBeNull()
      expect(g.nodes.find((n) => n.id === 'comp:Real')).not.toHaveProperty('unresolvedRoot')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  it('hook data survives a JSON round trip unchanged (no AST objects retained)', async () => {
    const seen = []
    await census.census(APP, { onFile: (pkg, ctx) => { if (ctx.kind !== 'xml') seen.push(collectBrs(pkg, ctx.text, ctx)) } })
    expect(seen.length).toBeGreaterThan(0)
    for (const d of seen) expect(JSON.parse(JSON.stringify(d))).toEqual(d)
    expect(seen.some((d) => d.creates.some((c) => typeof c.fn === 'string' && c.fn.includes('@')))).toBe(true)
  })
  it('parseXml stays linear: 20000 script tags parse in well under a second', () => {
    const xml = '<component name="Big" extends="Group">\n' + '<script uri="a.brs"></script>\n'.repeat(20000) + '</component>\n'
    const t0 = Date.now()
    const x = parseXml(xml)
    expect(x.scripts).toHaveLength(20000)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('parseXml scopes the CDATA check to each script body', () => {
    const x = parseXml('<component name="S" extends="Group">\n<script uri="a.brs"></script>\n<script><![CDATA[\nsub x()\nend sub\n]]></script>\n</component>\n')
    expect(x.scripts.map((sc) => sc.cdata)).toEqual([false, true])
  })
  it('uncertainty items cap per kind: a noisy kind cannot hide a later kind, counts stay exact', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.mkdirSync(path.join(tmp, 'components'))
      fs.writeFileSync(path.join(tmp, 'components', 'Big.xml'), '<component name="Big" extends="Group">\n<script type="text/brightscript" uri="Nope.brs" />\n<children>\n' + '<ComponentLibrary id="l" />\n'.repeat(2100) + '</children>\n</component>\n')
      const g = await buildGraph(tmp)
      expect(g.uncertainty.counts['component-library']).toBe(2100)
      expect(g.uncertainty.items.filter((i) => i.kind === 'component-library')).toHaveLength(200)
      expect(g.uncertainty.items.filter((i) => i.kind === 'unresolved-script')).toHaveLength(1)
      expect(g.uncertainty.total).toBe(2101)
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
  it('the same tree in two differently named folders has the same hash', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-a-')); const b = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-bb-'))
    try {
      fs.cpSync(CYCLES, a, { recursive: true }); fs.cpSync(CYCLES, b, { recursive: true })
      fs.rmSync(path.join(a, 'manifest'), { force: true }); fs.rmSync(path.join(b, 'manifest'), { force: true }) // no title: app falls back to the folder name
      const ga = await buildGraph(a); const gb = await buildGraph(b)
      expect(ga.app).not.toBe(gb.app)
      expect(ga.hash).toBe(gb.hash)
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }) }
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
