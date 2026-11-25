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
  it('lcov: marks executed files ran-headless with a coverage percentage, and not an unexecuted file', () => {
    const { g } = graphWithSpec()
    const ov = overlay.buildOverlay(g, [], [{ file: 'l', records: overlay.parseLcov('SF:source/Resume.brs\nLF:4\nLH:3\nend_of_record\nSF:source/Other.brs\nLF:4\nLH:0\nend_of_record\n') }])
    expect(overlay.evidenceText(ov, 'file:source/Resume.brs')).toBe('ran-headless (lcov 75% of 4 lines)')
    expect(overlay.evidenceText(ov, 'file:source/Other.brs')).toBe('')
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
      expect(html).toContain('ran-headless (1 case passed, lcov 50% of 10 lines)')
      expect(html).toContain('ran-device (1 case passed)')
      expect(err).toMatch(/1 of 3 JUnit cases map to no spec/)
      for (const bad of [{ junit: [path.join(dir, 'missing.xml')] }, { junit: [path.join(dir, 'bad.xml')] }, { lcov: [path.join(dir, 'bad.xml')] }]) {
        await expect(render.runRender({ ...base, out: path.join(dir, 'x.html'), ...bad }, ctx, Usage)).rejects.toThrow(Usage)
      }
      expect(fs.existsSync(path.join(dir, 'x.html'))).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
