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
// built-in ids are lower-case in the graph; EXPECTED-GRAPH.json keeps the source casing, so compare case-insensitively on those
const bid = (id) => (typeof id === 'string' && id.startsWith('builtin:') ? id.toLowerCase() : id)
const ek = (e) => [e.kind, e.from, bid(e.to), e.conf, e.at].join('|')

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
    expect(app.nodes.map((n) => n.id).sort()).toEqual(expected.nodes.map((n) => bid(n.id)).sort())
  })
  it('matches the structural edges of EXPECTED-GRAPH.json exactly', () => {
    expect(app.edges.map(ek).sort()).toEqual(expected.edges.map(ek).sort())
  })
  it('matches the scopes and candidates of the calls, callfunc and observes edges', () => {
    for (const e of expected.edges.filter((x) => ['calls', 'callfunc', 'observes'].includes(x.kind))) {
      const got = app.edges.find((x) => ek(x) === ek(e))
      expect([...(got.scopes || [])].sort(), ek(e)).toEqual([...(e.scopes || [])].sort())
      expect(got.candidates, ek(e)).toEqual(e.candidates)
    }
    expect(app.resolution.edgesTotal).toBe(expected.resolution.edgesTotal)
    expect(app.resolution.byConf).toEqual(expected.resolution.byConf)
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
      expect((got.functions || []).map((f) => [f.name, f.line]), `${n.id}.functions`).toEqual((n.functions || []).map((f) => [f.name, f.line]))
      for (const f of n.functions || []) if (f.pure !== undefined) expect(got.functions.find((x) => x.name === f.name).pure, `${n.id} ${f.name} pure`).toBe(f.pure)
      if (n.scope) expect([...got.scope].sort(), `${n.id}.scope`).toEqual([...n.scope].sort())
      const facts = { ...(n.facts || {}) }
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
    expect(find(app, 'extends', 'components/shell/MainScene.xml:2')[0]).toMatchObject({ to: 'builtin:scene', conf: 'builtin' })
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
      expect(find(g, 'extends').map(ek).sort()).toEqual(['extends|comp:Base|builtin:group|builtin|components/Base.xml:1', 'extends|comp:Kid|comp:Base|exact|components/Kid.xml:1'])
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
    expect(find(app, 'child', 'components/shell/MainScene.xml:8')[0]).toMatchObject({ to: 'builtin:timer', conf: 'builtin' })
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
    expect(seen.some((d) => d.creates.some((c) => typeof c.fn === 'string' && /^\w+@\d+$/.test(c.fn)))).toBe(true)
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

describe('feature graph: runs-task targeting, keys, builtin ids, ambiguity', () => {
  const build = async (files) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text) }
      return await buildGraph(tmp)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }
  const taskXml = (n) => `<component name="${n}" extends="Task">\n</component>\n`
  const runs = (g) => find(g, 'runs-task').map((e) => `${e.to}@${e.at}`)

  it('a run on an unresolved receiver emits nothing, and the next receiver maps to its own Task', async () => {
    const g = await build({
      'components/T.xml': taskXml('T'),
      'components/Host.xml': '<component name="Host" extends="Group">\n<script uri="Host.brs" />\n</component>\n',
      'components/Host.brs': 'sub init()\n  t = CreateObject("roSGNode", "NoSuchTask")\n  t.control = "run"\n  r = CreateObject("roSGNode", "T")\n  r.control = "RUN"\nend sub\n',
    })
    expect(runs(g)).toEqual(['comp:T@components/Host.brs:5'])
  })
  it('a run on a receiver created as a non-Task app component emits nothing', async () => {
    const g = await build({
      'components/T.xml': taskXml('T'),
      'components/Plain.xml': '<component name="Plain" extends="Group">\n</component>\n',
      'components/Host.xml': '<component name="Host" extends="Group">\n<script uri="Host.brs" />\n</component>\n',
      'components/Host.brs': 'sub init()\n  t = CreateObject("roSGNode", "T")\n  p = CreateObject("roSGNode", "Plain")\n  p.control = "run"\nend sub\n',
    })
    expect(runs(g)).toEqual([])
  })
  it('a Task created in one function and run in another gives no edge', async () => {
    const g = await build({
      'components/T.xml': taskXml('T'),
      'components/Host.xml': '<component name="Host" extends="Group">\n<script uri="Host.brs" />\n</component>\n',
      'components/Host.brs': 'sub f1()\n  t = CreateObject("roSGNode", "T")\nend sub\nsub f2()\n  t.control = "run"\nend sub\n',
    })
    expect(runs(g)).toEqual([])
  })
  it('two Tasks with different receivers in one function: each run maps to its own Task', async () => {
    const g = await build({
      'components/A.xml': taskXml('A'),
      'components/B.xml': taskXml('B'),
      'components/Host.xml': '<component name="Host" extends="Group">\n<script uri="Host.brs" />\n</component>\n',
      'components/Host.brs': 'sub init()\n  a = CreateObject("roSGNode", "A")\n  b = CreateObject("roSGNode", "B")\n  b.control = "run"\n  a.control = "run"\nend sub\n',
    })
    expect(runs(g)).toEqual(['comp:A@components/Host.brs:5', 'comp:B@components/Host.brs:4'].sort())
  })
  it('a run receiver matches its create case-insensitively: A.control with creates a and b gives one edge to A only', async () => {
    const g = await build({
      'components/A.xml': taskXml('A'),
      'components/B.xml': taskXml('B'),
      'components/Host.xml': '<component name="Host" extends="Group">\n<script uri="Host.brs" />\n</component>\n',
      'components/Host.brs': 'sub init()\n  a = CreateObject("roSGNode", "A")\n  b = CreateObject("roSGNode", "B")\n  A.control = "run"\nend sub\n',
    })
    expect(runs(g)).toEqual(['comp:A@components/Host.brs:4'])
  })
  it('a receiver that matches no create in the function falls back to every Task created there', async () => {
    const g = await build({
      'components/A.xml': taskXml('A'),
      'components/B.xml': taskXml('B'),
      'components/Host.xml': '<component name="Host" extends="Group">\n<script uri="Host.brs" />\n</component>\n',
      'components/Host.brs': 'sub init()\n  a = CreateObject("roSGNode", "A")\n  b = CreateObject("roSGNode", "B")\n  m.other.control = "run"\nend sub\n',
    })
    expect(runs(g).sort()).toEqual(['comp:A@components/Host.brs:4', 'comp:B@components/Host.brs:4'])
  })
  it('two same-named functions in one file get different keys that carry the real name and line', async () => {
    const seen = []
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-graph-'))
    try {
      fs.mkdirSync(path.join(tmp, 'source'))
      fs.writeFileSync(path.join(tmp, 'source', 'a.brs'), 'sub dup()\n  a = CreateObject("roSGNode", "X")\nend sub\n\nsub dup()\n  b = CreateObject("roSGNode", "Y")\nend sub\n')
      await census.census(tmp, { onFile: (pkg, ctx) => { if (ctx.kind !== 'xml') seen.push(collectBrs(pkg, ctx.text, ctx)) } })
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    const fns = seen[0].creates.map((c) => c.fn)
    expect(fns).toEqual(['dup@1', 'dup@5'])
  })
  it('one spec call name defined in two non-spec files is ambiguous with sorted candidates', async () => {
    const g = await build({
      'source/a.brs': 'function Shared()\n  return 1\nend function\n',
      'source/b.brs': 'function Shared()\n  return 2\nend function\n',
      'source/tests/x.spec.brs': 'sub t()\n  v = Shared()\nend sub\n',
    })
    const e = find(g, 'spec-covers', 'source/tests/x.spec.brs:2')
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ to: null, conf: 'ambiguous', detail: 'Shared', candidates: ['file:source/a.brs', 'file:source/b.brs'] })
  })
  it('built-in node ids are one lower-case id regardless of source casing', async () => {
    const g = await build({
      'components/Real.xml': '<component name="Real" extends="Group">\n<children>\n<Label id="a" />\n<label id="b" />\n<LABEL id="c" />\n</children>\n</component>\n',
    })
    expect(g.nodes.filter((n) => n.kind === 'builtin').map((n) => n.id)).toEqual(['builtin:group', 'builtin:label'])
    expect(find(g, 'child').map((e) => e.to)).toEqual(['builtin:label', 'builtin:label', 'builtin:label'])
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

describe('feature graph: spec roots outside source/ and components/', () => {
  const SR = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'spec-roots')
  const coversOf = (g, file) => g.edges.filter((e) => e.kind === 'spec-covers' && e.from === `file:${file}`)
  const hasNode = (g, id) => g.nodes.some((n) => n.id === id)
  const win = process.platform === 'win32'
  const mk = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-specroots-'))
    const all = { manifest: 'title=T\n', 'source/util.brs': 'function SrUtilAdd(a, b)\n return a + b\nend function\n', ...files }
    for (const [rel, text] of Object.entries(all)) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
    return dir
  }
  const SPEC = 'sub S()\n x = SrUtilAdd(1, 2)\nend sub\n'
  const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true })

  it('finds specs under conventional test/ and specs/ dirs', async () => {
    const g = await buildGraph(SR)
    expect(coversOf(g, 'test/RootSpec.bs').map((e) => e.to).sort()).toEqual(['comp:SrWidget', 'file:source/util.brs'])
    expect(coversOf(g, 'specs/Plain.brs').map((e) => e.to)).toEqual(['file:source/util.brs'])
    expect(g.nodes.find((n) => n.id === 'file:test/RootSpec.bs').spec).toBe(true)
  })
  it('does not walk a dir that neither the conventions nor the config pattern name', async () => {
    expect(coversOf(await buildGraph(SR), 'qa/unit/Pattern.spec.bs')).toEqual([])
  })
  it('adds the leading directory of testsFilePattern from the config', async () => {
    const g = await buildGraph(SR, { config: { testsFilePattern: 'qa/unit/**/*.spec.bs' } })
    expect(coversOf(g, 'qa/unit/Pattern.spec.bs').map((e) => e.to)).toEqual(['file:source/util.brs'])
    expect(coversOf(g, 'test/RootSpec.bs').length).toBeGreaterThan(0)
  })
  it('keeps the default layout: source/ and components/ specs still resolve', () => {
    expect(find(app, 'spec-covers').length).toBeGreaterThan(0)
  })
  it('ignores patterns with no static leading dir (wildcard, brace, absolute, .., Windows absolute)', async () => {
    for (const pat of ['**/qa/*.bs', '{qa,zz}/**/*.bs', '/qa/unit/*.bs', '../qa/*.bs', 'C:\\qa\\unit\\*.bs', '*/unit/*.bs']) {
      const g = await buildGraph(SR, { config: { testsFilePattern: pat } })
      expect(coversOf(g, 'qa/unit/Pattern.spec.bs'), pat).toEqual([])
    }
  })
  it('accepts a Windows-style relative pattern', async () => {
    const g = await buildGraph(SR, { config: { testsFilePattern: 'qa\\unit\\*.spec.bs' } })
    expect(coversOf(g, 'qa/unit/Pattern.spec.bs').length).toBe(1)
  })
  it('prunes vendor dirs under spec roots and applies the vendor matcher to files', async () => {
    const d = mk({ 'tests/Real.spec.bs': SPEC, 'tests/e2e/node_modules/rooibos/dist/lib.brs': SPEC, 'tests/roku_modules/x/y.brs': SPEC, 'tests/lib/rooibos-helper.brs': SPEC, 'tests/skipme/z.brs': SPEC })
    try {
      const g = await buildGraph(d, { config: { instrument: { exclude: ['tests/skipme/**'] } } })
      expect(hasNode(g, 'file:tests/Real.spec.bs')).toBe(true)
      for (const id of ['file:tests/e2e/node_modules/rooibos/dist/lib.brs', 'file:tests/roku_modules/x/y.brs', 'file:tests/lib/rooibos-helper.brs', 'file:tests/skipme/z.brs']) expect(hasNode(g, id), id).toBe(false)
    } finally { cleanup(d) }
  })
  it('matches convention dirs case-insensitively and uses the real dir name in ids, without double counting', async () => {
    const d = mk({ 'Tests/A.spec.bs': SPEC })
    try {
      const g = await buildGraph(d, { config: { testsFilePattern: 'tests/**/*.bs' } })
      expect(hasNode(g, 'file:Tests/A.spec.bs')).toBe(true)
      expect(hasNode(g, 'file:tests/A.spec.bs')).toBe(false)
      expect(coversOf(g, 'Tests/A.spec.bs').length).toBe(1)
      const g2 = await buildGraph(d, { config: { testsFilePattern: 'Tests/**/*.bs' } })
      expect(coversOf(g2, 'Tests/A.spec.bs').length).toBe(1)
      expect(g2.nodes.filter((n) => lcId(n.id) === 'file:tests/a.spec.bs').length).toBe(1)
    } finally { cleanup(d) }
  })
  const lcId = (s) => s.toLowerCase()
  it('treats a spec file in source/ the same as before even if testsFilePattern matches every file', async () => {
    const d = mk({ 'source/Helper.brs': 'sub H()\nend sub\n', 'test/T.spec.bs': SPEC })
    try {
      const g = await buildGraph(d, { config: { testsFilePattern: '**/*.brs' } })
      expect(g.nodes.find((n) => n.id === 'file:source/Helper.brs').spec).toBe(false)
      expect(g.edges.filter((e) => e.kind === 'spec-covers' && e.from === 'file:source/util.brs')).toEqual([])
      expect(coversOf(g, 'test/T.spec.bs').length).toBe(1)
    } finally { cleanup(d) }
  })
  it('adds no not-read items for non-brs symlinks in a spec root', async () => {
    if (win) return
    const d = mk({ 'test/T.spec.bs': SPEC, 'test/data.json': '{}' })
    try {
      fs.symlinkSync(path.join(d, 'test', 'data.json'), path.join(d, 'test', 'link.json'))
      fs.symlinkSync(path.join(d, 'test', 'T.spec.bs'), path.join(d, 'test', 'link.bs'))
      const g = await buildGraph(d)
      const nr = g.uncertainty.items.filter((u) => u.kind === 'not-read').map((u) => u.at)
      expect(nr).toEqual(['test/link.bs'])
    } finally { cleanup(d) }
  })
  it('rejects spec roots that are symlinks to the project root, to source/, or outside; survives symlink loops', async () => {
    if (win) return
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-specroots-out-'))
    fs.writeFileSync(path.join(out, 'O.spec.bs'), SPEC)
    const d = mk({ 'components/W.brs': 'sub W()\nend sub\n', 'real/R.spec.bs': SPEC })
    try {
      fs.symlinkSync(d, path.join(d, 'tests'))
      fs.symlinkSync(path.join(d, 'source'), path.join(d, 'spec'))
      fs.symlinkSync(out, path.join(d, 'specs'))
      let g = await buildGraph(d)
      for (const n of g.nodes) expect(/^file:(tests|spec|specs)\//.test(n.id), n.id).toBe(false)
      for (const n of ['tests', 'spec', 'specs']) fs.unlinkSync(path.join(d, n))
      fs.mkdirSync(path.join(d, 'test'))
      fs.symlinkSync(path.join(d, 'test'), path.join(d, 'test', 'loop'))
      fs.writeFileSync(path.join(d, 'test', 'T.spec.bs'), SPEC)
      g = await buildGraph(d)
      expect(coversOf(g, 'test/T.spec.bs').length).toBe(1)
    } finally { cleanup(d); cleanup(out) }
  })
  it('does not double count a spec root reached through two names', async () => {
    if (win) return
    const d = mk({ 'real/R.spec.bs': SPEC })
    try {
      fs.symlinkSync(path.join(d, 'real'), path.join(d, 'tests'))
      const g = await buildGraph(d, { config: { testsFilePattern: 'real/**/*.bs' } })
      expect(g.nodes.filter((n) => /^file:(real|tests)\/R\.spec\.bs$/.test(n.id)).length).toBe(1)
    } finally { cleanup(d) }
  })
})
