import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Shape and content checks for the hand-written feature tree ground truth and the cycles fixture.
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

// Kind-specific content checks. Returns a list of problems, so the mutation tests below can prove it catches errors.
const CONF_BY_KIND = {
  extends: ['builtin'], script: ['exact'], import: ['exact'], registry: ['exact'], 'global-read': ['exact'], 'global-write': ['exact'],
  child: ['name', 'builtin'], creates: ['name', 'dynamic'], 'runs-task': ['name'], entry: ['name'],
  calls: ['name'], callfunc: ['ambiguous', 'unresolved'], observes: ['name', 'builtin', 'unresolved'], 'spec-covers': ['name'],
}
const lineAt = (root, at) => {
  const i = at.lastIndexOf(':')
  return (fs.readFileSync(path.join(root, at.slice(0, i)), 'utf8').split('\n')[Number(at.slice(i + 1)) - 1] || '')
}
// Resolve a script uri or import path, written in the file `fromRel`, to a root-relative path.
const resolveUri = (uri, fromRel) => (uri.startsWith('pkg:/') ? uri.slice('pkg:/'.length) : path.posix.join(path.posix.dirname(fromRel), uri))
const compName = (id) => id.slice('comp:'.length)

function checkEdges(g, root) {
  const bad = []
  const fileNode = new Map(g.nodes.filter((n) => n.kind === 'file').map((n) => [n.id, n]))
  for (const e of g.edges) {
    const where = `${e.kind} ${e.from} -> ${e.to} at ${e.at}`
    const fail = (why) => bad.push(`${where}: ${why}`)
    const text = lineAt(root, e.at)
    const has = (tok) => { if (!text.includes(tok)) fail(`line "${text.trim()}" lacks "${tok}"`) }
    if (!CONF_BY_KIND[e.kind].includes(e.conf)) fail(`conf ${e.conf} not allowed for ${e.kind}`)
    if ((e.conf === 'builtin') !== Boolean(e.to && e.to.startsWith('builtin:'))) fail('conf builtin must go with a builtin target')
    if (e.kind === 'extends') has(`extends="${e.to.slice('builtin:'.length)}"`)
    else if (e.kind === 'script' || e.kind === 'import') {
      const m = e.kind === 'script' ? /uri="([^"]+)"/.exec(text) : /import\s+"([^"]+)"/.exec(text)
      const fromRel = e.from.slice('file:'.length)
      if (!m) fail(`no ${e.kind === 'script' ? 'uri' : 'import path'} on the line`)
      else if ('file:' + resolveUri(m[1], fromRel) !== e.to) fail(`${m[1]} resolves to ${resolveUri(m[1], fromRel)}`)
      if (e.kind === 'import') has('import')
    } else if (e.kind === 'child') has('<' + (e.to.startsWith('comp:') ? compName(e.to) : e.to.slice('builtin:'.length)))
    else if (e.kind === 'creates') { has('CreateObject('); if (e.to) has(`"${compName(e.to)}"`) }
    else if (e.kind === 'runs-task') { has('control'); has('RUN') }
    else if (e.kind === 'entry') has(`CreateScene("${compName(e.to)}")`)
    else if (e.kind === 'global-read' || e.kind === 'global-write') has(e.to.slice('global:'.length))
    else if (e.kind === 'registry') has('roRegistrySection')
    else if (e.kind === 'calls') {
      has(e.detail + '(')
      if (!fileNode.get(e.to).functions.some((f) => f.name === e.detail)) fail(`target does not define ${e.detail}`)
    } else if (e.kind === 'callfunc') { has('callFunc('); has(`"${e.detail.split(':')[0]}"`) }
    else if (e.kind === 'observes') has('observeField(')
    else if (e.kind === 'spec-covers') {
      if (e.to.startsWith('comp:')) has(`@SGNode("${compName(e.to)}")`)
      else has(e.detail + '(')
    }
  }
  return bad
}

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

  it('every edge "at" line holds a token of its kind, a script or import target resolves from its uri, and conf fits the kind', () => {
    expect(checkEdges(g, APP)).toEqual([])
  })

  describe('the edge check catches a wrong ground truth (mutations of a copy)', () => {
    const clone = () => JSON.parse(JSON.stringify(g))
    const find = (c, kind, to) => c.edges.find((e) => e.kind === kind && e.to === to)

    it('fails when an edge line is moved', () => {
      const c = clone()
      const e = find(c, 'script', 'file:source/lib/Logger.brs')
      e.at = e.at.replace(/:\d+$/, ':5')
      expect(checkEdges(c, APP).length).toBeGreaterThan(0)
    })

    it('fails when an edge is retargeted', () => {
      const c = clone()
      find(c, 'script', 'file:source/lib/Logger.brs').to = 'file:source/lib/Config.brs'
      expect(checkEdges(c, APP).length).toBeGreaterThan(0)
      const c2 = clone()
      find(c2, 'child', 'comp:HomeScreen').to = 'comp:PosterCard'
      expect(checkEdges(c2, APP).length).toBeGreaterThan(0)
    })

    it('fails when two conf values are swapped', () => {
      const c = clone()
      const a = find(c, 'script', 'file:source/lib/Logger.brs')
      const b = find(c, 'child', 'comp:HomeScreen')
      ;[a.conf, b.conf] = [b.conf, a.conf]
      expect(checkEdges(c, APP).length).toBeGreaterThan(0)
      const c2 = clone()
      const o1 = find(c2, 'observes', 'comp:HomeScreen')
      const o2 = find(c2, 'observes', 'builtin:Timer')
      ;[o1.conf, o2.conf] = [o2.conf, o1.conf]
      expect(checkEdges(c2, APP).length).toBeGreaterThan(0)
    })
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

  it('every file node is in exactly one feature, members exist, and a component sits with its XML file', () => {
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

  it('the ambiguous call, unresolved import and call, dynamic and unresolved callfunc and dynamic global are on their lines', () => {
    const read = (r) => lineAt(CYCLES, r)
    for (const a of e.ambiguousCalls) expect(read(a.at)).toContain(a.name + '(')
    for (const u of e.unresolvedImports) {
      expect(read(u.at)).toContain(`import "${u.uri}"`)
      expect(fs.existsSync(path.join(CYCLES, resolveUri(u.uri, u.at.split(':')[0])))).toBe(false)
    }
    for (const u of e.unresolvedCalls) expect(read(u.at)).toContain(u.name + '(')
    for (const u of e.dynamicCallfuncs) expect(read(u.at)).toContain(u.token)
    for (const u of e.unresolvedCallfuncs) expect(read(u.at)).toContain(`callFunc("${u.name}")`)
    for (const u of e.dynamicGlobals) expect(read(u.at)).toContain(u.token)
    const everyDeclared = fs.readdirSync(path.join(CYCLES, 'components'), { recursive: true }).filter((f) => f.endsWith('.xml'))
      .map((f) => fs.readFileSync(path.join(CYCLES, 'components', f), 'utf8')).join('\n')
    expect(everyDeclared).not.toContain(`function name="${e.unresolvedCallfuncs[0].name}"`)
    expect(fs.readFileSync(path.join(CYCLES, e.unresolvedCalls[0].at.split(':')[0]), 'utf8')).not.toContain('function ' + e.unresolvedCalls[0].name)
  })

  it('the diamond has no cycle and the utility is scripted by four components and called from the shared file', () => {
    const d = e.diamond
    for (const x of d.edges) expect(lineAt(CYCLES, x.at)).toContain('<' + x.tag + ' ')
    expect(d.edges.filter((x) => x.to === d.bottom).map((x) => x.from).sort()).toEqual([d.left, d.right].sort())
    expect(d.edges.filter((x) => x.from === d.top).map((x) => x.to).sort()).toEqual([d.left, d.right].sort())
    const u = e.sharedUtility
    expect(u.usedBy.length).toBe(4)
    for (const c of u.usedBy) {
      const line = lineAt(CYCLES, u.scriptAt[c])
      expect(line).toContain('uri="pkg:/' + u.file.slice('file:'.length) + '"')
      expect(fs.readFileSync(path.join(CYCLES, 'components', 'diamond', compName(c) + '.xml'), 'utf8')).toContain(`name="${compName(c)}"`)
    }
    expect(lineAt(CYCLES, u.call.at)).toContain(u.call.name + '(')
    expect(fs.readFileSync(path.join(CYCLES, u.file.slice('file:'.length)), 'utf8')).toContain('function ' + u.call.name)
  })

  it('the hostile names are present escaped in the sources', () => {
    expect(e.hostile.length).toBeGreaterThanOrEqual(5)
    for (const h of e.hostile) expect(lineAt(CYCLES, h.at)).toContain(h.contains)
    expect(fs.existsSync(path.join(CYCLES, 'components', 'hostile', 'Fish&Chips.brs'))).toBe(true)
  })

  it('the symlink named in EXPECTED.json can be created in a temp copy and points at the secret file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-cyc-'))
    try {
      fs.cpSync(CYCLES, d, { recursive: true })
      for (const s of e.symlinks) {
        expect(fs.existsSync(path.join(CYCLES, s.link))).toBe(false)
        fs.symlinkSync(s.target, path.join(d, s.link))
        expect(fs.lstatSync(path.join(d, s.link)).isSymbolicLink()).toBe(true)
        expect(fs.realpathSync(path.join(d, s.link))).toBe(fs.realpathSync(path.join(d, e.neverOpened[0])))
      }
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('the call cycle is closed (Ping -> Pong -> Pang -> Ping)', () => {
    const read = (r) => fs.readFileSync(path.join(CYCLES, 'source', r), 'utf8')
    expect(read('ping.brs')).toContain('Pong(')
    expect(read('pong.brs')).toContain('Pang(')
    expect(read('pang.brs')).toContain('Ping(')
  })
})
