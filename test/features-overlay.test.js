import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const overlay = require('../lib/features/overlay')
const render = require('../lib/features/render')
const features = require('../lib/features')
const { mk } = require('./features-synth-helper.cjs')

const CI_NONE = { systems: [], nodeVersions: [], nodeOk: null, selfHosted: false, runsBrighttest: false }

// A synthetic graph with one source file covered by one spec.
function graphWithSpec() {
  const g = mk({ files: ['source/Resume.brs', 'source/Other.brs'] })
  g.nodes.push({ id: 'file:source/tests/Resume.spec.bs', kind: 'file', lang: 'bs', vendor: false, spec: true })
  g.edges.push({ from: 'file:source/tests/Resume.spec.bs', to: 'file:source/Resume.brs', kind: 'spec-covers', conf: 'name', at: 'x:1' })
  const tree = {
    schema: 'brighttest-feature-tree/v1', graph: { hash: g.hash, treeHash: 't' }, provenance: { author: 'agent', createdFrom: 'x' },
    features: [{ id: 'f0', name: 'Feature zero', kind: 'screen', summary: 's', risk: 'low', members: g.nodes.filter((n) => n.kind !== 'builtin' && n.kind !== 'entry').map((n) => n.id) }],
    ignored: [], paths: { recommended: 'leaf-first', reason: 'because' },
  }
  return { g, tree }
}
const junit = (cases, extra = '') => `<?xml version="1.0"?>\n<testsuites>${extra}<testsuite name="brighttest">${cases}</testsuite></testsuites>`
const tc = (cls, name, body = '') => `<testcase classname="${cls}" name="${name}"${body ? `>${body}</testcase>` : '/>'}`
const evidence = (html, id) => {
  const row = html.split('<tr').find((r) => r.includes(`>${id}</code>`) && r.includes('id="n-'))
  return row || ''
}

describe('overlay parsing', () => {
  it('parseJunit: reads cases and statuses, defaults to the headless lane', () => {
    const j = overlay.parseJunit(junit(tc('source/tests/Resume.spec.bs', 'a') + tc('x', 'b', '<failure message="m"/>') + tc('x', 'c', '<skipped/>') + tc('x', 'd', '<error/>')))
    expect(j.lane).toBe('headless')
    expect(j.cases.map((c) => c.status)).toEqual(['passed', 'failed', 'skipped', 'failed'])
    expect(j.cases[0].suite).toBe('brighttest')
  })
  it('parseJunit: a brighttest.lane=device property or the e2e suite marks a device run, nothing else does', () => {
    expect(overlay.parseJunit(junit(tc('a', 'b'), '<properties><property name="brighttest.lane" value="device"/></properties>')).lane).toBe('device')
    expect(overlay.parseJunit('<testsuites name="brighttest e2e"><testsuite name="s"><testcase classname="s" name="n"/></testsuite></testsuites>').lane).toBe('device')
    expect(overlay.parseJunit(junit(tc('a', 'b'), '<properties><property name="brighttest.lane" value="headless"/></properties>')).lane).toBe('headless')
    expect(overlay.parseJunit(junit(tc('a', 'b'), '<properties><property name="other" value="device"/></properties>')).lane).toBe('headless')
  })
  it('parseJunit: rejects text that is not JUnit', () => {
    expect(() => overlay.parseJunit('hello')).toThrow(/not a JUnit/)
  })
  it('parseLcov: reads LF/LH and falls back to DA lines', () => {
    const r = overlay.parseLcov('SF:source/a.brs\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\nSF:source/b.brs\nDA:1,3\nDA:2,2\nend_of_record\n')
    expect(r).toEqual([{ file: 'source/a.brs', lf: 2, lh: 1 }, { file: 'source/b.brs', lf: 2, lh: 2 }])
  })
})

describe('overlay evidence levels', () => {
  it('ran-headless: a passing mapped spec marks the spec and the nodes it covers, and nothing else', () => {
    const { g } = graphWithSpec()
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...overlay.parseJunit(junit(tc('source/tests/Resume.spec', 'one') + tc('source/tests/Resume.spec', 'two'))) }])
    expect(overlay.evidenceText(ov, 'file:source/Resume.brs')).toBe('ran-headless (2 cases passed)')
    expect(overlay.evidenceText(ov, 'file:source/tests/Resume.spec.bs')).toBe('ran-headless (2 cases passed)')
    expect(overlay.evidenceText(ov, 'file:source/Other.brs')).toBe('')
  })
  it('ran-device: only from a JUnit marked as a device run', () => {
    const { g } = graphWithSpec()
    const marked = overlay.parseJunit(junit(tc('Resume.spec', 'one'), '<properties><property name="brighttest.lane" value="device"/></properties>'))
    expect(overlay.evidenceText(overlay.buildOverlay(g, [{ file: 'j', ...marked }]), 'file:source/Resume.brs')).toBe('ran-device (1 case passed)')
    const unmarked = overlay.parseJunit(junit(tc('Resume.spec', 'one')))
    expect(overlay.evidenceText(overlay.buildOverlay(g, [{ file: 'j', ...unmarked }]), 'file:source/Resume.brs')).not.toContain('ran-device')
  })
  it('both levels show together when both runs pass', () => {
    const { g } = graphWithSpec()
    const h = overlay.parseJunit(junit(tc('Resume.spec', 'one')))
    const d = overlay.parseJunit(junit(tc('Resume.spec', 'one'), '<properties><property name="brighttest.lane" value="device"/></properties>'))
    expect(overlay.evidenceText(overlay.buildOverlay(g, [{ file: 'a', ...h }, { file: 'b', ...d }]), 'file:source/Resume.brs')).toBe('ran-headless (1 case passed); ran-device (1 case passed)')
  })
  it('a failing or skipped-only spec gives no evidence', () => {
    const { g } = graphWithSpec()
    const bad = overlay.parseJunit(junit(tc('Resume.spec', 'one') + tc('Resume.spec', 'two', '<failure message="x"/>')))
    expect(overlay.buildOverlay(g, [{ file: 'j', ...bad }]).nodes.size).toBe(0)
    const skipped = overlay.parseJunit(junit(tc('Resume.spec', 'one', '<skipped/>')))
    expect(overlay.buildOverlay(g, [{ file: 'j', ...skipped }]).nodes.size).toBe(0)
  })
  it('cases that map to no spec are counted and ignored', () => {
    const { g } = graphWithSpec()
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...overlay.parseJunit(junit(tc('Nope.spec', 'one'))) }])
    expect(ov.stats).toMatchObject({ cases: 1, mapped: 0, unmapped: 1 })
    expect(ov.nodes.size).toBe(0)
  })
  it('lcov: labels executed files lane-neutrally (never a ran level) with a coverage percentage, and not an unexecuted file', () => {
    const { g } = graphWithSpec()
    const ov = overlay.buildOverlay(g, [], [{ file: 'l', records: overlay.parseLcov('SF:source/Resume.brs\nLF:4\nLH:3\nend_of_record\nSF:source/Other.brs\nLF:4\nLH:0\nend_of_record\n') }])
    expect(overlay.evidenceText(ov, 'file:source/Resume.brs')).toBe('executed (lcov 75% of 4 lines)')
    expect(overlay.evidenceText(ov, 'file:source/Other.brs')).toBe('')
  })
})

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'feature-tree-app')
const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'features-render')
const suiteGraph = (suites) => {
  const g = mk({ files: ['source/a/main.brs', 'source/b/main.brs'] })
  for (const id of Object.keys(suites)) g.nodes.push({ id, kind: 'file', lang: 'bs', vendor: false, spec: true })
  g.specSuites = suites
  return g
}
const fileG = (files, specs = []) => {
  const g = mk({ files })
  for (const f of specs) g.nodes.push({ id: `file:${f}`, kind: 'file', lang: 'bs', vendor: false, spec: true })
  return g
}
const lc = (file, lf, lh) => ({ file: 'l', records: [{ file, lf, lh }] })

describe('overlay: real reporter output', () => {
  it('suite-title matching maps the headless reporter fixture onto the example app and marks nodes ran-headless', async () => {
    const { buildGraph, hashGraph } = require('../lib/features/graph')
    const g = await buildGraph(EX)
    expect(g.specSuites['file:source/tests/Badge.spec.bs']).toEqual(['Badge component'])
    expect(hashGraph({ ...g, specSuites: undefined })).toBe(g.hash)
    const j = overlay.parseJunit(fs.readFileSync(path.join(FX, 'headless-reporter.junit.xml'), 'utf8'))
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...j }], [{ file: 'l', records: overlay.parseLcov(fs.readFileSync(path.join(FX, 'headless-reporter.lcov.info'), 'utf8')) }], { root: EX })
    expect(ov.stats).toMatchObject({ cases: 3, mapped: 3, unmapped: 0, specsPassed: 2 })
    expect(overlay.evidenceText(ov, 'file:source/tests/Badge.spec.bs')).toBe('ran-headless (1 case passed)')
    expect(overlay.evidenceText(ov, 'file:source/tests/StringUtils.spec.bs')).toBe('ran-headless (2 cases passed)')
    const covered = [...g.edges].filter((e) => e.kind === 'spec-covers' && e.to).map((e) => e.to)
    expect(covered.length).toBeGreaterThan(0)
    for (const id of covered) expect(overlay.evidenceText(ov, id)).toContain('ran-headless')
    expect(overlay.evidenceText(ov, 'file:components/widgets/Badge.brs')).toContain('executed (lcov 100% of 2 lines)')
  })
  it('an @suite title shared by two specs is unmapped and counted', () => {
    const g = suiteGraph({ 'file:t/A.spec.bs': ['Same'], 'file:t/B.spec.bs': ['Same'], 'file:t/C.spec.bs': ['Only C'] })
    const j = overlay.parseJunit(junit(tc('Same', 'x') + tc('Only C', 'y')))
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...j }])
    expect(ov.stats).toMatchObject({ mapped: 1, unmapped: 1, ambiguous: 1 })
    expect(overlay.evidenceText(ov, 'file:t/C.spec.bs')).toBe('ran-headless (1 case passed)')
    expect(overlay.evidenceText(ov, 'file:t/A.spec.bs')).toBe('')
  })
})

describe('overlay: lanes per suite', () => {
  it('a merged JUnit with a headless suite and a device suite keeps each lane on its own cases', () => {
    const g = fileG([], ['t/H.spec.bs', 't/D.spec.bs'])
    const xml = '<testsuites><testsuite name="h"><properties><property name="brighttest.lane" value="headless"/></properties>' + tc('t/H.spec', 'a') +
      '</testsuite><testsuite name="d"><properties><property name="brighttest.lane" value="device"/></properties>' + tc('t/D.spec', 'b') + '</testsuite></testsuites>'
    const j = overlay.parseJunit(xml)
    expect(j.lane).toBe('mixed')
    expect(j.cases.map((c) => c.lane)).toEqual(['headless', 'device'])
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...j }])
    expect(overlay.evidenceText(ov, 'file:t/H.spec.bs')).toBe('ran-headless (1 case passed)')
    expect(overlay.evidenceText(ov, 'file:t/D.spec.bs')).toBe('ran-device (1 case passed)')
  })
  it('a property outside every testsuite applies to the whole file; a suite-level one wins', () => {
    const xml = '<testsuites><properties><property name="brighttest.lane" value="device"/></properties><testsuite name="a">' + tc('x', '1') + '</testsuite>' +
      '<testsuite name="b"><properties><property name="brighttest.lane" value="headless"/></properties>' + tc('x', '2') + '</testsuite></testsuites>'
    expect(overlay.parseJunit(xml).cases.map((c) => c.lane)).toEqual(['device', 'headless'])
  })
})

describe('overlay: path matching', () => {
  it('a bare shorter path needs exactly one match; a longer-or-equal one matches by trailing segments', () => {
    const g = fileG([], ['a/tests/Format.spec.bs', 'b/tests/Format.spec.bs'])
    const run = (cls) => overlay.buildOverlay(g, [{ file: 'j', ...overlay.parseJunit(junit(tc(cls, 'x'))) }]).nodes.size
    expect(run('Format.spec')).toBe(0)
    expect(run('tests/Format.spec')).toBe(0)
    expect(run('a/tests/Format.spec')).toBe(1)
    expect(run('pkg:/a/tests/Format.spec.brs')).toBe(1)
    expect(run('/ci/work/b/tests/Format.spec.bs')).toBe(1)
  })
  it('lcov: SF:main.brs with two main.brs files is ambiguous; the xml file does not count as a match', () => {
    const g = fileG(['source/main.brs', 'components/main.brs'])
    expect(overlay.buildOverlay(g, [], [lc('main.brs', 4, 4)]).nodes.size).toBe(0)
    const g2 = fileG(['source/main.brs'])
    g2.nodes.push({ id: 'file:components/main.xml', kind: 'file', lang: 'xml', vendor: false, spec: false })
    expect(overlay.buildOverlay(g2, [], [lc('main.brs', 4, 4)]).nodes.has('file:source/main.brs')).toBe(true)
  })
  it('lcov: pkg:/ and the project root are stripped; paths that climb out are dropped and counted', () => {
    const g = fileG(['source/main.brs'])
    const ov = overlay.buildOverlay(g, [], [{ file: 'l', records: [{ file: 'pkg:/source/main.brs', lf: 2, lh: 1 }, { file: '../../other/source/main.brs', lf: 9, lh: 9 }, { file: '/proj/source/../../x/source/main.brs', lf: 9, lh: 9 }] }], { root: '/proj' })
    expect(ov.nodes.get('file:source/main.brs').lcov).toEqual({ lf: 2, lh: 1 })
    expect(ov.stats.lcovDropped).toBe(2)
  })
  it('lcov: LH is clamped to LF and several records for one source merge by the larger total', () => {
    expect(overlay.parseLcov('SF:a.brs\nLF:2\nLH:7\nend_of_record\n')[0]).toEqual({ file: 'a.brs', lf: 2, lh: 2 })
    const g = fileG(['source/main.brs'])
    const ov = overlay.buildOverlay(g, [], [{ file: 'l', records: [{ file: 'source/main.brs', lf: 10, lh: 4 }, { file: 'source/main.brs', lf: 10, lh: 6 }] }])
    expect(ov.nodes.get('file:source/main.brs').lcov).toEqual({ lf: 10, lh: 6 })
  })
})

describe('overlay: parser', () => {
  it('an attribute value containing > does not truncate the tag', () => {
    const j = overlay.parseJunit(junit('<testcase classname="a" name="x > y" file="t/H.spec.bs"><failure message="a>b"/></testcase>' + tc('t/H.spec', 'ok')))
    expect(j.cases.map((c) => [c.name, c.status])).toEqual([['x > y', 'failed'], ['ok', 'passed']])
  })
  it('40k unclosed tags finish quickly', () => {
    const t0 = Date.now()
    const junk = '<testcase classname="x '.repeat(40000) + '<!-- '.repeat(10000)
    const j = overlay.parseJunit(junit(tc('t/H.spec', 'ok')) + junk)
    expect(j.cases.length).toBe(1)
    const g = fileG([], ['t/H.spec.bs'])
    overlay.buildOverlay(g, [{ file: 'j', ...j }])
    expect(Date.now() - t0).toBeLessThan(10000)
  })
  it('runRender turns a read failure into a usage error for both flags', async () => {
    const Usage = require('../lib/assess').UsageError
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ov-'))
    try {
      const { buildGraph } = require('../lib/features/graph')
      const gf = path.join(dir, 'graph.json')
      fs.writeFileSync(gf, JSON.stringify(await buildGraph(EX)))
      fs.writeFileSync(path.join(dir, 'a.xml'), junit(tc('x', 'y')))
      fs.writeFileSync(path.join(dir, 'a.info'), 'SF:x\nend_of_record\n')
      const readFile = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e }
      const ctx = { root: dir, stagingDir: path.join(dir, '.brighttest'), baseRel: '.', stdout: () => {}, stderr: () => {}, readFile }
      for (const bad of [{ junit: [path.join(dir, 'a.xml')] }, { lcov: [path.join(dir, 'a.info')] }]) {
        await expect(render.runRender({ auto: true, graph: gf, junit: [], lcov: [], out: path.join(dir, 'x.html'), ...bad }, ctx, Usage)).rejects.toThrow(/cannot read .*: EACCES/)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('render with overlays', () => {
  it('without an overlay the evidence text is unchanged', () => {
    const { g, tree } = graphWithSpec()
    const html = render.renderReport(tree, g, { version: 't', ci: CI_NONE }).html
    expect(html).not.toContain('ran-headless')
    expect(html).not.toContain('ran-device')
    expect(html).not.toContain('Run evidence')
  })
  it('shows both level labels in the member table and the summary', () => {
    const { g, tree } = graphWithSpec()
    const h = overlay.parseJunit(junit(tc('Resume.spec', 'one')))
    const d = overlay.parseJunit(junit(tc('Resume.spec', 'one'), '<properties><property name="brighttest.lane" value="device"/></properties>'))
    const ov = overlay.buildOverlay(g, [{ file: 'a', ...h }, { file: 'b', ...d }])
    const html = render.renderReport(tree, g, { version: 't', ci: CI_NONE, overlay: ov }).html
    expect(html).toContain('ran-headless (1 case passed)')
    expect(html).toContain('ran-device (1 case passed)')
    expect(html).toContain('<dt>Run evidence</dt>')
    expect(html).toContain('2 JUnit files')
    expect(render.renderReport(tree, g, { version: 't', ci: CI_NONE, overlay: ov }).html).toBe(html)
  })
})

describe('features render --junit/--lcov', () => {
  const Usage = require('../lib/assess').UsageError
  it('parseArgs collects repeated flags and refuses them outside render', async () => {
    expect(features.parseArgs(['render', '--junit', 'a.xml', '--junit=b.xml', '--lcov', 'l.info']).junit).toEqual(['a.xml', 'b.xml'])
    expect(features.parseArgs(['render', '--lcov=l.info']).lcov).toEqual(['l.info'])
    expect(() => features.parseArgs(['render', '--junit'])).toThrow(Usage)
    let err = ''
    expect(await features.run(['check', '--junit', 'a.xml'], { stderr: (s) => { err += s } })).toBe(2)
    expect(err).toMatch(/check does not take/)
    err = ''
    expect(await features.run(['graph', '--lcov', 'a'], { stderr: (s) => { err += s } })).toBe(2)
    expect(err).toMatch(/belong to features render/)
  })
  it('runRender writes the overlay into the report, and refuses a missing or invalid file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ov-'))
    try {
      const { buildGraph } = require('../lib/features/graph')
      const graph = await buildGraph(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'feature-tree-app'))
      const gf = path.join(dir, 'graph.json')
      fs.writeFileSync(gf, JSON.stringify(graph))
      fs.writeFileSync(path.join(dir, 'unit.xml'), junit(tc('source/tests/StringUtils.spec', 'one') + tc('nowhere', 'two')))
      fs.writeFileSync(path.join(dir, 'dev.xml'), junit(tc('source/tests/Badge.spec', 'one'), '<properties><property name="brighttest.lane" value="device"/></properties>'))
      fs.writeFileSync(path.join(dir, 'lcov.info'), 'SF:source/lib/StringUtils.brs\nLF:10\nLH:5\nend_of_record\n')
      fs.writeFileSync(path.join(dir, 'bad.xml'), 'nope')
      let err = ''
      const ctx = { root: dir, stagingDir: path.join(dir, '.brighttest'), baseRel: '.', stdout: () => {}, stderr: (s) => { err += s } }
      const base = { auto: true, graph: gf, junit: [], lcov: [] }
      const out = path.join(dir, 'r.html')
      expect(await render.runRender({ ...base, out, junit: [path.join(dir, 'unit.xml'), path.join(dir, 'dev.xml')], lcov: [path.join(dir, 'lcov.info')] }, ctx, Usage)).toBe(0)
      const html = fs.readFileSync(out, 'utf8')
      expect(html).toContain('ran-headless (1 case passed)')
      expect(html).toContain('executed (lcov 50% of 10 lines)')
      expect(html).toContain('ran-device (1 case passed)')
      expect(err).toMatch(/1 of 3 JUnit cases map to no spec/)
      for (const bad of [{ junit: [path.join(dir, 'missing.xml')] }, { junit: [path.join(dir, 'bad.xml')] }, { lcov: [path.join(dir, 'bad.xml')] }]) {
        await expect(render.runRender({ ...base, out: path.join(dir, 'x.html'), ...bad }, ctx, Usage)).rejects.toThrow(Usage)
      }
      expect(fs.existsSync(path.join(dir, 'x.html'))).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('device JUnit from the reporter builder', () => {
  const { buildRooibosJunit } = require('../lib/reporter')
  const build = (lane, cases) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bj-'))
    try {
      const f = path.join(dir, 'j.xml')
      buildRooibosJunit({ junit: f, cases, out: '[Rooibos Result]', failed: 0, crash: null, killReason: undefined, sawResult: true, lane })
      return fs.readFileSync(f, 'utf8')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const cases = [{ suite: 'Some Title', name: 'one', ok: true, loc: 'source/tests/Resume.spec.bs:12' }]

  it('renders ran-device from a graph without specSuites by the file attribute', () => {
    const { g, tree } = graphWithSpec()
    expect(g.specSuites).toBeUndefined()
    const xml = build('device', cases)
    expect(xml).toContain('file="source/tests/Resume.spec.bs"')
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...overlay.parseJunit(xml) }])
    expect(ov.stats.unmapped).toBe(0)
    const html = render.renderReport(tree, g, { version: 't', ci: CI_NONE, overlay: ov }).html
    expect(html).toContain('ran-device (1 case passed)')
    expect(html).not.toContain('ran-headless (')
  })
  it('a headless build marks ran-headless', () => {
    const { g } = graphWithSpec()
    const ov = overlay.buildOverlay(g, [{ file: 'j', ...overlay.parseJunit(build('headless', cases)) }])
    expect(ov.nodes.get('file:source/tests/Resume.spec.bs')['ran-headless']).toBe(1)
  })
  it('prints the old-graph hint once, only when cases are unmapped, never as an error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hint-'))
    try {
      const { buildGraph } = require('../lib/features/graph')
      const g = await buildGraph(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'feature-tree-app'))
      delete g.specSuites // a graph saved before @suite titles were recorded
      const gf = path.join(dir, 'graph.json')
      fs.writeFileSync(gf, JSON.stringify(g))
      fs.writeFileSync(path.join(dir, 'a.xml'), junit(tc('Some Title', 'one') + tc('Other Title', 'two')))
      fs.writeFileSync(path.join(dir, 'b.xml'), junit(tc('source/tests/StringUtils.spec', 'one')))
      const run = async (j) => {
        let err = ''
        const ctx = { root: dir, stagingDir: path.join(dir, '.brighttest'), baseRel: '.', stdout: () => {}, stderr: (s) => { err += s } }
        const code = await render.runRender({ auto: true, graph: gf, junit: [path.join(dir, j)], lcov: [], out: path.join(dir, 'r.html') }, ctx, require('../lib/assess').UsageError)
        return { code, err }
      }
      const a = await run('a.xml')
      expect(a.code).toBe(0)
      expect(a.err.match(/graph has no @suite titles; run bt features build to refresh; the graph hash does not change/g)).toHaveLength(1)
      expect((await run('b.xml')).err).not.toContain('@suite titles')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
