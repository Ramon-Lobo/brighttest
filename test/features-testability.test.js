import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph, hashGraph, loadBuiltinCallables } = require('../lib/features/graph')
const { computePurity, classify } = require('../lib/features/testability')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CYCLES = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'cycles')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')

// Build a graph over a synthetic project written from { relpath: text }.
async function mk(files, opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-tb-'))
  try {
    for (const [rel, text] of Object.entries({ manifest: 'title=Synthetic\nmajor_version=1\n', ...files })) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
      fs.writeFileSync(path.join(tmp, rel), Array.isArray(text) ? text.join('\n') + '\n' : text)
    }
    return await buildGraph(tmp, opts)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}
const xml = (name, ext, body, scripts = []) => ['<?xml version="1.0" encoding="UTF-8"?>', `<component name="${name}" extends="${ext}">`, ...scripts.map((s) => `  <script type="text/brightscript" uri="${s}" />`), body || '', '</component>']
const edges = (g, kind, at) => g.edges.filter((e) => e.kind === kind && (!at || e.at === at))
const node = (g, id) => g.nodes.find((n) => n.id === id)
const fn = (g, id, name) => node(g, id).functions.find((f) => f.name === name)
const items = (g, kind) => g.uncertainty.items.filter((i) => i.kind === kind)

describe('purity fixed point (U1, U2)', () => {
  it('two functions that call each other and are otherwise pure are both pure', () => {
    const r = computePurity(new Map([
      ['a', { why: [], clock: false, calls: [{ name: 'B', ids: ['b'] }] }],
      ['b', { why: [], clock: false, calls: [{ name: 'A', ids: ['a'] }] }],
    ]))
    expect(r.get('a').pure).toBe(true)
    expect(r.get('b').pure).toBe(true)
  })
  it('one impure member makes the whole cycle impure, and the reason names the callee', () => {
    const r = computePurity(new Map([
      ['a', { why: [], clock: false, calls: [{ name: 'B', ids: ['b'] }] }],
      ['b', { why: [], clock: false, calls: [{ name: 'C', ids: ['c'] }, { name: 'A', ids: ['a'] }] }],
      ['c', { why: ['uses m.'], clock: false, calls: [] }],
    ]))
    expect(r.get('a')).toMatchObject({ pure: false, why: ['calls impure B'] })
    expect(r.get('b').pure).toBe(false)
  })
  it('an ambiguous call needs every candidate to be pure', () => {
    const r = computePurity(new Map([
      ['a', { why: [], clock: false, calls: [{ name: 'F', ids: ['p', 'q'] }] }],
      ['p', { why: [], clock: false, calls: [] }],
      ['q', { why: ['uses m.'], clock: false, calls: [] }],
    ]))
    expect(r.get('a').pure).toBe(false)
  })
  it('the clock flag travels from a pure callee to its pure caller (U2)', () => {
    const r = computePurity(new Map([
      ['a', { why: [], clock: false, calls: [{ name: 'T', ids: ['t'] }] }],
      ['t', { why: [], clock: true, calls: [] }],
    ]))
    expect(r.get('a')).toMatchObject({ pure: true, clock: true })
  })
  it('U1 on a graph: pure, unresolved callee, m use, clock, platform object, and a mutually recursive pair', async () => {
    const g = await mk({
      'source/util.brs': ['function Helper(x as integer) as integer', '  return x + 1', 'end function',
        'function UsesMissing() as integer', '  return Missing_fn()', 'end function',
        'function ReadsM() as integer', '  return m.count', 'end function',
        'function Caller() as integer', '  return Helper(1)', 'end function',
        'function Even(n as integer) as boolean', '  if n = 0 then return true', '  return Odd(n - 1)', 'end function',
        'function Odd(n as integer) as boolean', '  if n = 0 then return false', '  return Even(n - 1)', 'end function',
        'function Ucase2(s as string) as string', '  return UCase(s)', 'end function'],
      'source/clock.brs': ['function Stamp() as string', '  d = CreateObject("roDateTime")', '  return d.ToISOString()', 'end function'],
      'source/info.brs': ['function Model() as string', '  di = CreateObject("roDeviceInfo")', '  return di.GetModel()', 'end function'],
    })
    const u = 'file:source/util.brs'
    expect(fn(g, u, 'Helper').pure).toBe(true)
    expect(fn(g, u, 'Caller').pure).toBe(true)
    expect(fn(g, u, 'UsesMissing')).toMatchObject({ pure: false })
    expect(fn(g, u, 'UsesMissing').why.join()).toContain('unresolved callee Missing_fn')
    expect(fn(g, u, 'ReadsM').why).toContain('uses m.')
    expect(fn(g, u, 'Even').pure).toBe(true)
    expect(fn(g, u, 'Odd').pure).toBe(true)
    expect(fn(g, u, 'Ucase2').pure).toBe(true) // a built-in callee is fine
    expect(fn(g, 'file:source/clock.brs', 'Stamp')).toMatchObject({ pure: true, clock: true })
    expect(node(g, 'file:source/clock.brs').testability.primary).toMatchObject({ class: 'headless-unit', rule: 'U2' })
    expect(node(g, 'file:source/clock.brs').testability.notes.map((n) => n.text).join()).toContain('inject the clock')
    expect(fn(g, 'file:source/info.brs', 'Model').pure).toBe(false)
    expect(node(g, u).testability.primary).toMatchObject({ class: 'headless-unit', rule: 'U1', at: 'source/util.brs:1' })
  })
  it('a function that calls Sleep, Wait, GetGlobalAA or sets a node field is not pure', async () => {
    const g = await mk({ 'source/x.brs': ['sub A()', '  Sleep(10)', 'end sub', 'function B()', '  return GetGlobalAA()', 'end function', 'sub C(n as object)', '  n.setField("a", 1)', 'end sub'] })
    for (const f of ['A', 'B', 'C']) expect(fn(g, 'file:source/x.brs', f).pure, f).toBe(false)
  })
})

describe('scope resolution and calls', () => {
  it('component closure through extends: a call resolves to a file the component inherits', async () => {
    const g = await mk({
      'components/Base.xml': xml('Base', 'Group', '', ['Base.brs']),
      'components/Base.brs': ['sub BaseFn()', 'end sub'],
      'components/Kid.xml': xml('Kid', 'Base', '', ['Kid.brs']),
      'components/Kid.brs': ['sub init()', '  BaseFn()', 'end sub'],
    })
    const e = edges(g, 'calls')[0]
    expect(e).toMatchObject({ from: 'file:components/Kid.brs', to: 'file:components/Base.brs', conf: 'name', at: 'components/Kid.brs:2', scopes: ['Kid'] })
  })
  it('the source scope is source/**; a component scope does not see it', async () => {
    const g = await mk({
      'source/util.brs': ['sub Helper()', 'end sub'],
      'source/main.brs': ['sub Main()', '  Helper()', 'end sub'],
      'components/C.xml': xml('C', 'Group', '', ['C.brs']),
      'components/C.brs': ['sub init()', '  Helper()', 'end sub'],
    })
    expect(edges(g, 'calls', 'source/main.brs:2')[0]).toMatchObject({ conf: 'name', to: 'file:source/util.brs', scopes: ['source'] })
    expect(edges(g, 'calls', 'components/C.brs:2')[0]).toMatchObject({ conf: 'unresolved', to: null, detail: 'Helper' })
    expect(items(g, 'unresolved-call').map((i) => i.at)).toEqual(['components/C.brs:2'])
  })
  it('built-ins through globalCallables give no edge and no uncertainty', async () => {
    const g = await mk({ 'source/main.brs': ['sub Main()', '  x = UCase("a")', '  y = Left("abc", 1)', 'end sub'] })
    expect(edges(g, 'calls')).toEqual([])
    expect(items(g, 'unresolved-call')).toEqual([])
  })
  it('a component function shadows a source/ function of the same name, without ambiguity', async () => {
    const g = await mk({
      'source/lib.brs': ['sub Dup()', 'end sub', 'sub FromSource()', '  Dup()', 'end sub'],
      'components/C.xml': xml('C', 'Group', '', ['C.brs']),
      'components/C.brs': ['sub Dup()', 'end sub', 'sub init()', '  Dup()', 'end sub'],
    })
    expect(edges(g, 'calls', 'components/C.brs:4')).toEqual([expect.objectContaining({ conf: 'name', to: 'file:components/C.brs', scopes: ['C'] })])
    expect(edges(g, 'calls', 'source/lib.brs:4')).toEqual([expect.objectContaining({ conf: 'name', to: 'file:source/lib.brs', scopes: ['source'] })])
    expect(items(g, 'ambiguous-call')).toEqual([])
  })
  it('two definitions at the same level (a component that scripts a source file defining the same name) are ambiguous', async () => {
    const g = await mk({
      'source/lib.brs': ['sub Dup()', 'end sub'],
      'components/C.xml': xml('C', 'Group', '', ['C.brs', 'pkg:/source/lib.brs']),
      'components/C.brs': ['sub Dup()', 'end sub', 'sub init()', '  Dup()', 'end sub'],
    })
    const e = edges(g, 'calls', 'components/C.brs:4')
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ conf: 'ambiguous', candidates: ['file:components/C.brs', 'file:source/lib.brs'] })
    expect(items(g, 'ambiguous-call')).toHaveLength(1)
  })
  it('a child component function shadows the extended component function (nearer level wins)', async () => {
    const g = await mk({
      'components/Base.xml': xml('Base', 'Group', '', ['Base.brs']),
      'components/Base.brs': ['sub Dup()', 'end sub'],
      'components/Kid.xml': xml('Kid', 'Base', '', ['Kid.brs']),
      'components/Kid.brs': ['sub Dup()', 'end sub', 'sub init()', '  Dup()', 'end sub'],
    })
    const e = edges(g, 'calls', 'components/Kid.brs:4')
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ conf: 'name', to: 'file:components/Kid.brs' })
    expect(items(g, 'ambiguous-call')).toEqual([])
  })
  it('.bs namespaced names and new Foo() through newExpressions', async () => {
    const g = await mk({
      'source/lib.bs': ['namespace Util', '  function Fmt(x as integer) as integer', '    return x', '  end function', '  function Twice(x as integer) as integer', '    return Fmt(x) * 2', '  end function', 'end namespace',
        'class Foo', '  sub new()', '  end sub', 'end class',
        'sub Run()', '  Util.Fmt(1)', '  f = new Foo()', '  g = new Missing()', 'end sub'],
    })
    const at = (n) => edges(g, 'calls', `source/lib.bs:${n}`)
    expect(at(14)[0]).toMatchObject({ conf: 'name', to: 'file:source/lib.bs', detail: 'Util.Fmt' })
    expect(at(6)[0]).toMatchObject({ conf: 'name', to: 'file:source/lib.bs', detail: 'Fmt' }) // namespace-relative
    expect(at(15)[0]).toMatchObject({ conf: 'name', detail: 'new Foo' })
    expect(at(16)[0]).toMatchObject({ conf: 'unresolved', detail: 'new Missing' })
    expect(items(g, 'unresolved-call').map((i) => i.at)).toEqual(['source/lib.bs:16'])
  })
  it('a call through a local variable or parameter is not a call to a named function', async () => {
    const g = await mk({ 'source/x.brs': ['sub A(cb as function)', '  cb()', '  f = Foo', '  f()', 'end sub'] })
    expect(edges(g, 'calls')).toEqual([])
  })
  it('ambiguous-call: one item for a name defined twice in one scope, none where the scope holds one definition (cycles fixture)', async () => {
    const g = await buildGraph(CYCLES)
    const amb = items(g, 'ambiguous-call')
    expect(amb).toHaveLength(1)
    expect(amb[0]).toMatchObject({ at: 'source/main.brs:3', detail: 'Dup_name', candidates: ['file:source/dup1.brs', 'file:source/dup2.brs'] })
    expect(edges(g, 'calls', 'components/a/CycleA.brs:7')[0]).toMatchObject({ conf: 'name', to: 'file:source/dup1.brs' })
    expect(edges(g, 'calls', 'components/b/CycleB.brs:7')[0]).toMatchObject({ conf: 'name', to: 'file:source/dup2.brs' })
  })
  it('cycles fixture: unresolved call, dynamic and unresolved callFunc, and the call cycle stays pure', async () => {
    const g = await buildGraph(CYCLES)
    expect(items(g, 'unresolved-call').map((i) => i.at)).toEqual(['source/imports.bs:4'])
    expect(edges(g, 'callfunc', 'source/imports.bs:5')[0]).toMatchObject({ conf: 'dynamic', to: null })
    expect(items(g, 'dynamic-callfunc').map((i) => i.at)).toEqual(['source/imports.bs:5'])
    expect(edges(g, 'callfunc', 'source/imports.bs:6')[0]).toMatchObject({ conf: 'unresolved', detail: 'no_such_fn' })
    expect(edges(g, 'callfunc', 'components/a/CycleA.brs:3')).toHaveLength(1)
    for (const f of ['Ping', 'Pong', 'Pang']) expect(g.nodes.flatMap((n) => n.functions || []).find((x) => x.name === f).pure, f).toBe(true)
  })
  it('callFunc: unique name, ambiguous name with candidates, dynamic name', async () => {
    const g = await mk({
      'components/W.xml': xml('W', 'Group', '<interface><function name="run" /><function name="shared" /></interface>'),
      'components/O.xml': xml('O', 'Group', '<interface><function name="shared" /></interface>'),
      'source/main.brs': ['sub Main(n as object, k as string)', '  n.callFunc("run")', '  n.callFunc("shared")', '  n.callFunc(k)', 'end sub'],
    })
    expect(edges(g, 'callfunc', 'source/main.brs:2')[0]).toMatchObject({ conf: 'name', to: 'comp:W' })
    expect(edges(g, 'callfunc', 'source/main.brs:3')[0]).toMatchObject({ conf: 'ambiguous', to: null, candidates: ['comp:O', 'comp:W'] })
    expect(items(g, 'ambiguous-callfunc')[0]).toMatchObject({ at: 'source/main.brs:3', candidates: ['comp:O', 'comp:W'] })
    expect(edges(g, 'callfunc', 'source/main.brs:4')[0].conf).toBe('dynamic')
    expect(items(g, 'dynamic-callfunc')).toHaveLength(1)
  })
})

describe('observeField', () => {
  let g
  beforeAll(async () => {
    g = await mk({
      'components/Home.xml': xml('Home', 'Group', ''),
      'components/Main.xml': xml('Main', 'Scene', '<children>\n    <Home id="home" />\n    <Timer id="tick" />\n    <Labell id="typo" />\n  </children>', ['Main.brs']),
      'components/Main.brs': ['sub init(node as object)', '  m.home = m.top.findNode("home")', '  m.home.observeField("a", "cb")', '  m.top.observeField("b", "cb")',
        '  m.tick = m.top.findNode("tick")', '  m.tick.observeField("fire", "cb")', '  m.top.findNode("home").observeField("c", "cb")',
        '  m.typo = m.top.findNode("typo")', '  m.typo.observeField("d", "cb")', '  m.top.findNode("nope").observeField("e", "cb")',
        '  node.observeField("f", "cb")', 'end sub'],
    })
  })
  it('resolves through findNode and <children>, m.top, and a built-in child', () => {
    expect(edges(g, 'observes', 'components/Main.brs:3')[0]).toMatchObject({ to: 'comp:Home', conf: 'name' })
    expect(edges(g, 'observes', 'components/Main.brs:4')[0]).toMatchObject({ to: 'comp:Main', conf: 'name' })
    expect(edges(g, 'observes', 'components/Main.brs:6')[0]).toMatchObject({ to: 'builtin:timer', conf: 'builtin' })
    expect(edges(g, 'observes', 'components/Main.brs:7')[0]).toMatchObject({ to: 'comp:Home', conf: 'name' })
  })
  it('a receiver that is not m.top or a findNode result is unresolved with the receiver text and a dynamic-observe item', () => {
    expect(edges(g, 'observes', 'components/Main.brs:11')[0]).toMatchObject({ to: null, conf: 'unresolved' })
    expect(edges(g, 'observes', 'components/Main.brs:11')[0].detail).toContain('node')
    expect(items(g, 'dynamic-observe').find((i) => i.at === 'components/Main.brs:11').detail).toBe('node')
  })
  it('an id that matches no child is dynamic-observe; an unresolved child tag adds no second item', () => {
    expect(items(g, 'dynamic-observe').map((i) => i.at)).toContain('components/Main.brs:10')
    expect(edges(g, 'observes', 'components/Main.brs:9')[0]).toMatchObject({ to: null, conf: 'unresolved' })
    expect(items(g, 'dynamic-observe').map((i) => i.at)).not.toContain('components/Main.brs:9')
    expect(items(g, 'unresolved-component').map((i) => i.detail)).toEqual(['Labell'])
  })
  it('feature-tree-app: the m.api receiver is dynamic-observe, the Timer child is observed', async () => {
    const a = await buildGraph(APP)
    expect(items(a, 'dynamic-observe')).toEqual([expect.objectContaining({ at: 'components/shell/MainScene.brs:4', detail: 'm.api' })])
    expect(items(a, 'ambiguous-callfunc')[0].candidates).toEqual(['comp:DetailsScreen', 'comp:SettingsScreen'])
  })
})

describe('bsc globalCallables feature detection', () => {
  it('globalCallables: the supported brighterscript range is pinned', () => {
    const { version } = require('brighterscript/package.json')
    const range = require('../package.json').dependencies.brighterscript
    expect(range).toBe('^0.73.8')
    expect(version.split('.').slice(0, 2).join('.')).toBe('0.73')
    expect(loadBuiltinCallables().has('ucase')).toBe(true)
  })
  it('globalCallables missing: calls come out unresolved, nothing throws, the graph is still written', async () => {
    const files = { 'source/main.brs': ['sub Main()', '  x = UCase("a")', 'end sub'] }
    const g = await mk(files, { builtinCallables: null })
    expect(edges(g, 'calls', 'source/main.brs:2')[0]).toMatchObject({ conf: 'unresolved', detail: 'UCase' })
    expect(items(g, 'unresolved-call')).toHaveLength(1)
    expect(g.hash).toBe(hashGraph(g))
  })
})

describe('uncertainty counts', () => {
  it('the cap is per kind and counts stay exact when more than 200 items arise', async () => {
    const lines = ['sub Main()']
    for (let i = 0; i < 250; i++) lines.push(`  No_such_${i}()`)
    lines.push('end sub')
    const g = await mk({ 'source/main.brs': lines })
    expect(g.uncertainty.counts['unresolved-call']).toBe(250)
    expect(items(g, 'unresolved-call')).toHaveLength(200)
    expect(g.uncertainty.total).toBe(250)
    expect(g.resolution.edgesTotal).toBe(g.edges.length)
    expect(Object.values(g.resolution.byConf).reduce((a, b) => a + b, 0)).toBe(g.edges.length)
    expect(g.resolution.callSitesResolvedPct).toBe(0)
  })
  it('the graph is deterministic with calls, callFunc and observes edges', async () => {
    const a = await buildGraph(APP); const b = await buildGraph(APP)
    expect(a.hash).toBe(b.hash)
    expect(JSON.parse(JSON.stringify(a))).toEqual(a)
  })
})

// ---- the rule table ----------------------------------------------------------------------------------------------
describe('testability rules', () => {
  let g
  const t = (id) => node(g, id).testability
  const also = (id, rule) => t(id).alsoNeeds.filter((a) => a.rule === rule)
  beforeAll(async () => {
    g = await mk({
      'source/main.brs': ['sub Main(args as dynamic)', '  screen = CreateObject("roSGScreen")', '  id = args.contentId', '  scene = screen.CreateScene("Main")', 'end sub'],
      'source/store.brs': ['function Owned()', '  st = CreateObject("roChannelStore")', '  return st', 'end function'],
      'source/info.brs': ['function Model() as string', '  di = CreateObject("roDeviceInfo")', '  return di.GetModel()', 'end function'],
      'source/wait.brs': ['sub Pause()', '  Sleep(100)', 'end sub'],
      'components/Home.xml': xml('Home', 'Group', '<interface><field id="title" type="string" onChange="onT" /></interface>', ['Home.brs']),
      'components/Home.brs': ['sub onT()', 'end sub'],
      'components/Widget.xml': xml('Widget', 'Group', '<interface><function name="run" /></interface>', ['Widget.brs']),
      'components/Widget.brs': ['function onKeyEvent(key as string, press as boolean) as boolean', '  return false', 'end function', 'sub init()', '  m.top.setFocus(true)', 'end sub'],
      'components/Main.xml': xml('Main', 'Scene', '<interface><field id="x" type="string" /></interface>\n  <children>\n    <Video id="vid" />\n    <Timer id="tick" />\n    <ComponentLibrary id="lib" uri="http://example.invalid/lib.zip" />\n  </children>', ['Main.brs']),
      'components/Main.brs': ['sub init()', '  print m.global.token', '  r = CreateObject("roRegistrySection", "s")', 'end sub'],
      'components/Loader.xml': xml('Loader', 'Task', '', ['Loader.brs']),
      'components/Loader.brs': ['sub init()', '  u = CreateObject("roUrlTransfer")', '  u.setUrl("https://example.invalid")', '  u.SetCertificatesFile("common:/certs/ca-bundle.crt")', 'end sub'],
      'components/Plain.xml': xml('Plain', 'Task', '', ['Plain.brs']),
      'components/Plain.brs': ['sub init()', '  m.top.x = 1', 'end sub'],
      'components/Inline.xml': ['<?xml version="1.0" encoding="UTF-8"?>', '<component name="Inline" extends="Group">', '  <script type="text/brightscript"><![CDATA[', '  sub init()', '  end sub', '  ]]></script>', '</component>'],
      'components/Typo.xml': xml('Typo', 'Group', '<children>\n    <Labell id="a" />\n    <Video id="v" />\n  </children>'),
      'components/Lost.xml': xml('Lost', 'NoSuchBase', '<interface><field id="x" type="string" /></interface>'),
    })
  })
  it('U1: a file with a pure function is headless-unit at that function', async () => {
    const g2 = await mk({ 'source/u.brs': ['sub Impure()', '  print m.x', 'end sub', 'function Pure(a as integer) as integer', '  return a', 'end function'] })
    expect(node(g2, 'file:source/u.brs').testability.primary).toMatchObject({ class: 'headless-unit', rule: 'U1', at: 'source/u.brs:4' })
  })
  it('S1: a non-Task component with interface fields is headless-scene', () => {
    expect(t('comp:Home').primary).toMatchObject({ class: 'headless-scene', rule: 'S1' })
    expect(t('comp:Widget').primary).toMatchObject({ class: 'headless-scene', rule: 'S1' })
  })
  it('S2: a scene that reads m.global in init needs state; an unseeded field also needs the device', () => {
    expect(t('comp:Main').primary.needs.map((n) => n.need)).toContain('state')
    expect(also('comp:Main', 'S2')[0]).toMatchObject({ class: 'device', aspect: 'unseeded-global', at: 'components/Main.brs:2' })
  })
  it('S2: a global seeded in brighttest.json adds no device need', async () => {
    const g2 = await mk({
      'brighttest.json': JSON.stringify({ globalFields: { token: 'x' } }),
      'components/Main.xml': xml('Main', 'Scene', '<interface><field id="x" type="string" /></interface>', ['Main.brs']),
      'components/Main.brs': ['sub init()', '  print m.global.token', 'end sub'],
    })
    expect(node(g2, 'comp:Main').testability.primary.needs.map((n) => n.rule)).toEqual(['S2'])
    expect(node(g2, 'comp:Main').testability.alsoNeeds.filter((a) => a.rule === 'S2')).toEqual([])
  })
  it('F1: a covered roUrlTransfer.setUrl needs net fixtures', () => {
    expect(t('comp:Loader').primary).toMatchObject({ class: 'headless-fixtures', rule: 'T1' })
    expect(t('comp:Loader').primary.needs).toEqual([{ need: 'net', rule: 'F1', at: 'components/Loader.brs:3' }])
  })
  it('F2: a setUrl the census cannot cover needs the device and is uncertain', async () => {
    const g2 = await mk({
      'components/T.xml': xml('T', 'Task', '', ['T.brs']),
      'components/T.brs': ['sub init(cls as string)', '  u = CreateObject(cls)', 'end sub'],
    })
    const r = node(g2, 'comp:T').testability
    expect(r.alsoNeeds).toContainEqual({ class: 'device', aspect: 'network', rule: 'F2', at: 'components/T.brs:2' })
    expect(r.uncertainty.find((u) => u.rule === 'F2')).toMatchObject({ detail: 'dynamic CreateObject' })
    expect(r.primary.needs.map((n) => n.rule)).not.toContain('F1')
  })
  it('F3: net fixtures in a scene (render thread) carry the config-fixtures note', async () => {
    const g2 = await mk({
      'components/S.xml': xml('S', 'Group', '', ['S.brs']),
      'components/S.brs': ['sub init()', '  u = CreateObject("roUrlTransfer")', '  u.setUrl("https://example.invalid")', 'end sub'],
    })
    expect(node(g2, 'comp:S').testability.notes.map((n) => n.rule)).toContain('F3')
  })
  it('F4: roChannelStore needs the store fixture', () => {
    expect(t('file:source/store.brs').primary).toMatchObject({ class: 'headless-fixtures', rule: 'F4', at: 'source/store.brs:2' })
    expect(t('file:source/store.brs').primary.needs[0]).toMatchObject({ need: 'store' })
  })
  it('F5: a Video child needs media fixtures and the device for playback', () => {
    expect(t('comp:Main').primary).toMatchObject({ class: 'headless-fixtures', rule: 'F5', at: 'components/Main.xml:6' })
    expect(also('comp:Main', 'F5')[0]).toMatchObject({ class: 'device', aspect: 'playback' })
  })
  it('F6: roRegistrySection needs the registry fixture', () => {
    expect(t('comp:Main').primary.needs).toContainEqual({ need: 'registry', rule: 'F6', at: 'components/Main.brs:3' })
  })
  it('T1: a Task is predicted from its functions and also needs the device for task timing', () => {
    expect(also('comp:Loader', 'T1')[0]).toMatchObject({ class: 'device', aspect: 'task-timing' })
    expect(t('comp:Plain').primary).toMatchObject({ class: 'headless-scene', rule: 'T1' })
  })
  it('D1: a Timer child or a Sleep needs the device for wall-clock behaviour', () => {
    expect(also('comp:Main', 'D1')[0]).toMatchObject({ class: 'device', aspect: 'wall-clock', at: 'components/Main.xml:7' })
    expect(also('file:source/wait.brs', 'D1')[0]).toMatchObject({ aspect: 'wall-clock', at: 'source/wait.brs:2' })
  })
  it('D2: certificate calls need the device for TLS', () => {
    expect(also('comp:Loader', 'D2')[0]).toMatchObject({ class: 'device', aspect: 'tls', at: 'components/Loader.brs:4' })
  })
  it('D3: platform objects need the device for platform values', () => {
    expect(also('file:source/info.brs', 'D3')[0]).toMatchObject({ class: 'device', aspect: 'platform-values', at: 'source/info.brs:2' })
    expect(t('file:source/info.brs').primary.class).not.toBe('device')
  })
  it('D4: inline CDATA is an uncertainty and needs the device for instrumentation', () => {
    expect(t('comp:Inline').uncertainty.find((u) => u.rule === 'D4')).toMatchObject({ at: 'components/Inline.xml:3' })
    expect(also('comp:Inline', 'D4')[0].class).toBe('device')
  })
  it('D5: a ComponentLibrary is an uncertainty and needs e2e', () => {
    expect(t('comp:Main').uncertainty.find((u) => u.rule === 'D5')).toMatchObject({ at: 'components/Main.xml:8' })
    expect(also('comp:Main', 'D5')[0].class).toBe('e2e')
  })
  it('E1: a key handler or setFocus needs e2e for focus and key routing', () => {
    expect(also('comp:Widget', 'E1')[0]).toMatchObject({ class: 'e2e', aspect: 'focus-and-keys', at: 'components/Widget.brs:1' })
  })
  it('E2: the root scene named by CreateScene needs an e2e launch, and the entry node is e2e', () => {
    expect(also('comp:Main', 'E2')[0]).toMatchObject({ class: 'e2e', aspect: 'launch' })
    expect(t('entry:main').primary).toMatchObject({ class: 'e2e', rule: 'E2' })
  })
  it('E3: launch args in Main are recorded on the entry node', () => {
    expect(t('entry:main').alsoNeeds).toContainEqual({ class: 'e2e', aspect: 'launch-params', rule: 'E3', at: 'source/main.brs:3' })
  })
  it('X1: an unknown base type or child name is uncertain, never cheaper than headless-scene, and infers no alsoNeeds', () => {
    expect(t('comp:Lost').uncertainty.find((u) => u.rule === 'X1').detail).toContain('NoSuchBase')
    expect(t('comp:Lost').primary.class).toBe('headless-scene')
    expect(t('comp:Typo').uncertainty.find((u) => u.rule === 'X1')).toMatchObject({ detail: 'Labell' })
  })
  it('D7: no node gets device as its primary class from rules alone', () => {
    for (const n of g.nodes) if (n.testability) expect(n.testability.primary.class, n.id).not.toBe('device')
  })
  it('classify is a pure function of its input (no node means no record)', () => {
    expect(classify({ nodes: [], edges: [], sites: new Map(), compFiles: new Map() }).size).toBe(0)
  })
  it('feature-tree-app: record for every component and a cheapest primary class', async () => {
    const a = await buildGraph(APP)
    for (const n of a.nodes.filter((x) => x.kind === 'component')) expect(n.testability, n.id).toBeTruthy()
    expect(node(a, 'comp:PlayerScreen').testability.primary).toMatchObject({ class: 'headless-fixtures', rule: 'F5' })
    expect(node(a, 'file:components/services/ContentParser.brs').testability.primary).toMatchObject({ class: 'headless-unit', rule: 'U1' })
    expect(node(a, 'comp:EntitlementGate').testability.primary.needs[0]).toMatchObject({ need: 'store', rule: 'F4' })
    expect(node(a, 'comp:ApiTask').testability.primary.rule).toBe('T1')
  })
})

describe('classify indexes its input once', () => {
  // a counting array: every pass over it is recorded, so a per-component scan shows up deterministically
  const counted = (list) => { const a = list.slice(); a.passes = 0; a[Symbol.iterator] = function* () { a.passes++; yield* Array.prototype[Symbol.iterator].call(this) }; return a }
  it('walks edges and uncertainty a constant number of times, and never searches nodes per component', () => {
    const N = 300
    const nodes = []; const edgeList = []; const sites = new Map(); const compFiles = new Map()
    for (let i = 0; i < N; i++) {
      nodes.push({ id: `comp:C${i}`, kind: 'component', file: `components/C${i}.xml`, extends: 'Task', builtinRoot: 'Task', isTask: true })
      nodes.push({ id: `file:components/C${i}.brs`, kind: 'file', lang: 'brs', functions: [{ name: 'F', line: 1, pure: true }] })
      compFiles.set(`comp:C${i}`, { xml: `components/C${i}.xml`, files: [`components/C${i}.brs`] })
      edgeList.push({ from: `file:components/C${i}.brs`, to: null, kind: 'calls', conf: 'unresolved', at: `components/C${i}.brs:2` })
    }
    nodes.find = () => { throw new Error('nodes.find per component') }
    const edgesIn = counted(edgeList); const uncIn = counted([{ kind: 'inline-cdata', at: 'components/C0.xml:3', detail: 'x' }])
    const out = classify({ nodes, edges: edgesIn, sites, compFiles, uncertainty: uncIn })
    expect(out.size).toBe(2 * N) // N components plus N file records
    expect(edgesIn.passes).toBeLessThanOrEqual(2)
    expect(uncIn.passes).toBeLessThanOrEqual(2)
  })
})

describe('F5 and D1 follow the base type', () => {
  const view = (g, id) => node(g, id).testability
  it('a component extending Video needs media fixtures and playback on the device', async () => {
    const g = await mk({ 'components/MyPlayer.xml': xml('MyPlayer', 'Video', '') })
    expect(view(g, 'comp:MyPlayer').primary).toMatchObject({ class: 'headless-fixtures', rule: 'F5' })
    expect(view(g, 'comp:MyPlayer').alsoNeeds).toContainEqual(expect.objectContaining({ class: 'device', aspect: 'playback', rule: 'F5' }))
  })
  it('a child whose tag is an app component extending Video counts, case-insensitively', async () => {
    const g = await mk({
      'components/MyPlayer.xml': xml('MyPlayer', 'Video', ''),
      'components/Shell.xml': xml('Shell', 'Group', '<children>\n    <myplayer id="p" />\n  </children>'),
    })
    expect(view(g, 'comp:Shell').primary).toMatchObject({ class: 'headless-fixtures', rule: 'F5', at: 'components/Shell.xml:4' })
  })
  it('a component extending Timer or Animation, or having such a child through an app component, needs the device for wall-clock', async () => {
    const g = await mk({
      'components/Tm.xml': xml('Tm', 'Timer', ''),
      'components/An.xml': xml('An', 'Animation', ''),
      'components/Host.xml': xml('Host', 'Group', '<children>\n    <Tm id="t" />\n  </children>'),
    })
    for (const id of ['comp:Tm', 'comp:An', 'comp:Host']) expect(view(g, id).alsoNeeds, id).toContainEqual(expect.objectContaining({ aspect: 'wall-clock', rule: 'D1' }))
  })
  it('<children> inherited through extends count for the extending component', async () => {
    const g = await mk({
      'components/P.xml': xml('P', 'Group', '<children>\n    <Video id="v" />\n  </children>'),
      'components/Q.xml': xml('Q', 'P', ''),
    })
    expect(view(g, 'comp:Q').primary).toMatchObject({ class: 'headless-fixtures', rule: 'F5', at: 'components/P.xml:4' })
  })
  it('a findNode that resolves to an app component extending Video records the platform object and Timer-based ones the timers fact', async () => {
    const g = await mk({
      'components/MyPlayer.xml': xml('MyPlayer', 'Video', ''),
      'components/Tm.xml': xml('Tm', 'Timer', ''),
      'components/Host.xml': xml('Host', 'Group', '<children>\n    <MyPlayer id="p" />\n    <Tm id="t" />\n  </children>', ['Host.brs']),
      'components/Host.brs': ['sub init()', '  m.p = m.top.findNode("p")', '  m.t = m.top.findNode("t")', 'end sub'],
    })
    expect(node(g, 'file:components/Host.brs').facts).toMatchObject({ platformObjects: ['Video'], timers: true })
  })
})

describe('purity: function values, closures and the built-in allow-list', () => {
  const pureOf = async (body, extra) => {
    const g = await mk({ 'source/x.brs': [...body, ...(extra || [])] })
    return Object.fromEntries(node(g, 'file:source/x.brs').functions.map((f) => [f.name, f]))
  }
  it('a call through a local variable or a parameter makes the function impure', async () => {
    const f = await pureOf(['function Bad()', '  return 1', 'end function', 'function ViaLocal()', '  f = Bad', '  return f()', 'end function', 'function ViaParam(cb as function)', '  return cb()', 'end function'])
    expect(f.ViaLocal).toMatchObject({ pure: false })
    expect(f.ViaLocal.why).toContain('calls a function value')
    expect(f.ViaParam.why).toContain('calls a function value')
    expect(f.Bad.pure).toBe(true)
  })
  it('an anonymous function inside a named function attributes its body to the named function', async () => {
    const f = await pureOf(['function Outer()', '  inner = function()', '    return m.count', '  end function', '  return 1', 'end function', 'function Fine()', '  g = function(a)', '    return a', '  end function', '  return 2', 'end function'])
    expect(f.Outer.why).toContain('uses m.')
    expect(f.Fine.pure).toBe(true)
  })
  it('a call inside an anonymous function counts for the enclosing function', async () => {
    const f = await pureOf(['function Outer()', '  inner = function()', '    Sleep(1)', '  end function', '  return 1', 'end function'])
    expect(f.Outer.pure).toBe(false)
  })
  it('built-ins outside the allow-list are impure: random, files, drive, reboot, ads, translation, last-run errors', async () => {
    const names = ['Rnd(5)', 'DeleteDirectory("tmp:/a")', 'FormatDrive("ext1:/", "EXT3")', 'RebootSystem()', 'Roku_Ads()', 'Tr("x")', 'GetLastRunCompileError()', 'GetLastRunRuntimeError()', 'Eval("1")', 'Run("x")', 'GetGlobalAA()']
    const src = names.flatMap((c, i) => [`function F${i}()`, `  return ${c}`, 'end function'])
    const f = await pureOf(src)
    names.forEach((c, i) => { expect(f[`F${i}`].pure, c).toBe(false); expect(f[`F${i}`].why, c).toEqual([`calls ${c.split('(')[0]}`]) })
  })
  it('allow-listed built-ins keep a function pure, and UpTime only marks the clock', async () => {
    const f = await pureOf(['function A(s as string)', '  return UCase(s) + Left(s, 1) + Str(Len(s)) + Substitute("{0}", s) + FormatJson({}) + Abs(-1).toStr()', 'end function', 'function B()', '  return UpTime(0)', 'end function'])
    expect(f.A.pure).toBe(true)
    expect(f.B).toMatchObject({ pure: true, clock: true })
  })
  it('a user function with a built-in name resolves to the user function', async () => {
    const f = await pureOf(['function Rnd(n as integer)', '  return n', 'end function', 'function Caller()', '  return Rnd(3)', 'end function'])
    expect(f.Caller.pure).toBe(true)
  })
})

describe('files without a pure function', () => {
  const primary = (g, rel) => node(g, `file:${rel}`).testability.primary
  it('a source file with only impure functions has no unit class and no rule', async () => {
    const g = await mk({ 'source/loop.brs': ['sub Run()', '  print m.count', 'end sub'] })
    expect(primary(g, 'source/loop.brs')).toMatchObject({ class: 'unknown', rule: null })
  })
  it('a source file that creates a screen or a scene node is headless-scene', async () => {
    const g = await mk({
      'source/main.brs': ['sub Main()', '  s = CreateObject("roSGScreen")', '  print m.x', 'end sub'],
      'source/mk.brs': ['sub Make()', '  n = CreateObject("roSGNode", "Group")', '  print m.x', 'end sub'],
    })
    expect(primary(g, 'source/main.brs')).toMatchObject({ class: 'headless-scene', rule: null })
    expect(primary(g, 'source/mk.brs')).toMatchObject({ class: 'headless-scene', rule: null })
  })
  it('a component script with no pure function stays headless-scene, and needs still lift an unknown file', async () => {
    const g = await mk({
      'components/C.xml': xml('C', 'Group', '', ['C.brs']),
      'components/C.brs': ['sub init()', '  print m.x', 'end sub'],
      'source/store.brs': ['sub Open()', '  st = CreateObject("roChannelStore")', '  print m.x', 'end sub'],
    })
    expect(primary(g, 'components/C.brs')).toMatchObject({ class: 'headless-scene', rule: null })
    expect(primary(g, 'source/store.brs')).toMatchObject({ class: 'headless-fixtures', rule: 'F4' })
  })
})

describe('scripts that no scope covers', () => {
  it('a call in an orphan script is resolved against its imports or reported, never dropped', async () => {
    const g = await mk({
      'components/orphan.brs': ['sub Go()', '  Missing_one()', '  Known()', 'end sub', 'sub Known()', 'end sub', 'function Impure()', '  return Missing_two()', 'end function'],
    })
    expect(edges(g, 'calls', 'components/orphan.brs:2')[0]).toMatchObject({ conf: 'unresolved', detail: 'Missing_one', scopes: ['components/orphan.brs'] })
    expect(edges(g, 'calls', 'components/orphan.brs:3')[0]).toMatchObject({ conf: 'name', to: 'file:components/orphan.brs' })
    expect(items(g, 'unresolved-call').map((i) => i.at)).toEqual(['components/orphan.brs:2', 'components/orphan.brs:8'])
    expect(fn(g, 'file:components/orphan.brs', 'Impure').pure).toBe(false)
    expect(g.resolution.callSitesResolvedPct).toBe(33)
  })
  it('an orphan script sees the files it imports', async () => {
    const g = await mk({
      'components/o.bs': ['import "lib.bs"', 'sub Go()', '  Lib_fn()', 'end sub'],
      'components/lib.bs': ['sub Lib_fn()', 'end sub'],
    })
    expect(edges(g, 'calls', 'components/o.bs:3')[0]).toMatchObject({ conf: 'name', to: 'file:components/lib.bs' })
  })
})

describe('name lookup details', () => {
  it('observeField receivers match their findNode assignment case-insensitively', async () => {
    const g = await mk({
      'components/Home.xml': xml('Home', 'Group', ''),
      'components/Main.xml': xml('Main', 'Scene', '<children>\n    <Home id="home" />\n  </children>', ['Main.brs']),
      'components/Main.brs': ['sub init()', '  m.Home = m.top.findNode("home")', '  M.HOME.observeField("a", "cb")', '  w = CreateObject("roSGNode", "Group")', '  W.observeField("b", "cb")', 'end sub'],
    })
    expect(edges(g, 'observes', 'components/Main.brs:3')[0]).toMatchObject({ to: 'comp:Home', conf: 'name' })
    expect(edges(g, 'observes', 'components/Main.brs:5')[0].detail).toContain('CreateObject')
  })
  it('a namespace-relative name in an inherited file beats a nearer plain definition', async () => {
    const g = await mk({
      'components/Base.xml': xml('Base', 'Group', '', ['Base.bs']),
      'components/Base.bs': ['namespace N', '  function Fmt()', '    return 1', '  end function', '  function Use()', '    return Fmt()', '  end function', 'end namespace'],
      'components/Kid.xml': xml('Kid', 'Base', '', ['Kid.bs']),
      'components/Kid.bs': ['function Fmt()', '  return 2', 'end function'],
    })
    // from Base's own scope the call is N.Fmt; the Kid scope sees both levels and must keep N.Fmt first
    const e = edges(g, 'calls', 'components/Base.bs:6')
    expect(e.map((x) => x.to)).toEqual(['file:components/Base.bs'])
    expect(e.every((x) => x.conf === 'name')).toBe(true)
    expect(e[0].scopes).toEqual(['Base', 'Kid'])
  })
})

describe('launch arguments (E3) and Eval', () => {
  const e3 = (g) => node(g, 'entry:main').testability.alsoNeeds.filter((a) => a.rule === 'E3').map((a) => a.at)
  const mainWith = (body) => mk({ 'source/main.brs': ['sub Main(args as dynamic)', '  s = CreateObject("roSGScreen")', '  s.CreateScene("S")', ...body, 'end sub'], 'components/S.xml': xml('S', 'Scene', '') })
  it('a dotted read of the first parameter of Main is recorded', async () => {
    expect(e3(await mainWith(['  id = args.contentId']))).toEqual(['source/main.brs:4'])
  })
  it('an indexed read args["key"] is recorded too', async () => {
    expect(e3(await mainWith(['  id = args["contentId"]']))).toEqual(['source/main.brs:4'])
  })
  it('RunUserInterface(args) in any source file is recorded, and the first parameter name does not matter', async () => {
    const g = await mk({
      'source/main.brs': ['sub Main(args as dynamic)', '  s = CreateObject("roSGScreen")', '  s.CreateScene("S")', '  RunUserInterface(args)', 'end sub'],
      'source/ui.brs': ['sub RunUserInterface(launch as dynamic)', '  z = other.field', '  y = launch["contentId"]', 'end sub'],
      'components/S.xml': xml('S', 'Scene', ''),
    })
    expect(e3(g)).toEqual(['source/ui.brs:3']) // the earliest site is kept; other.field is not a launch argument
  })
  it('a read of some other function parameter is not a launch argument, and the record never gates the class', async () => {
    const g = await mk({ 'source/main.brs': ['sub Main()', '  s = CreateObject("roSGScreen")', '  s.CreateScene("S")', 'end sub', 'sub Other(a as dynamic)', '  x = a.b', '  y = a["c"]', 'end sub'], 'components/S.xml': xml('S', 'Scene', '') })
    expect(e3(g)).toEqual([])
    expect(node(g, 'entry:main').testability.primary).toMatchObject({ class: 'e2e', rule: 'E2' })
  })
  it('an anonymous function inside Main does not replace the launch parameter', async () => {
    expect(e3(await mainWith(['  f = function(z)', '    return z', '  end function', '  id = args.x']))).toEqual(['source/main.brs:7'])
  })
  it('Eval is an uncertainty item of kind eval at its line; a method named eval and a user eval-free file give none', async () => {
    const g = await mk({ 'source/impure.brs': ['sub Run()', '  Eval("print 1")', '  o.eval()', 'end sub'], 'source/clean.brs': ['sub Fine()', 'end sub'] })
    expect(items(g, 'eval')).toEqual([expect.objectContaining({ at: 'source/impure.brs:2' })])
    expect(g.uncertainty.counts.eval).toBe(1)
  })
})
