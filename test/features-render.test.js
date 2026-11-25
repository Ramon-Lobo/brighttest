import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph } = require('../lib/features/graph')
const { suggest } = require('../lib/features/cluster')
const { buildSkeleton } = require('../lib/features/digest')
const render = require('../lib/features/render')
const features = require('../lib/features')
const { mk } = require('./features-synth-helper.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'features-render', 'report.golden.html')

const CI_NONE = { systems: [], nodeVersions: [], nodeOk: null, selfHosted: false, runsBrighttest: false }
const FIXED = { version: '0.0.0-test', ci: CI_NONE, assess: { path: 'brownfield', blockers: [] } }

let graph; let skeleton; let golden
beforeAll(async () => {
  graph = await buildGraph(APP)
  skeleton = buildSkeleton(graph, suggest(graph))
  golden = render.renderReport(skeleton, graph, FIXED)
})

// A one-feature tree over a synthetic graph (every node in the feature).
function synth(spec, over = {}) {
  const g = mk(spec)
  const tree = {
    schema: 'brighttest-feature-tree/v1', graph: { hash: g.hash, treeHash: 't' }, provenance: { author: 'agent', createdFrom: 'x' },
    features: [{ id: 'f0', name: 'Feature zero', kind: 'screen', summary: 'summary', risk: 'low', members: g.nodes.filter((n) => n.kind !== 'builtin').map((n) => n.id), ...over }],
    ignored: [], paths: { recommended: 'leaf-first', reason: 'because' },
  }
  return { g, tree }
}
const between = (html, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html); return m && m[1] }
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64')
const count = (html, re) => (html.match(re) || []).length

describe('render golden', () => {
  it('golden: the example app report is byte-identical to the golden file', () => {
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, golden.html)
    expect(golden.html).toBe(fs.readFileSync(GOLDEN, 'utf8'))
  })
  it('golden: is deterministic', () => {
    expect(render.renderReport(skeleton, graph, FIXED).html).toBe(golden.html)
  })
  it('golden: has every feature name and both path sections', () => {
    for (const f of skeleton.features) expect(golden.html).toContain(render.esc(f.name))
    expect(golden.html).toContain('id="path-leaf-first"')
    expect(golden.html).toContain('id="path-base-first"')
  })
  it('golden: contains the nine sections with their headings', () => {
    const head = ['<h1>Feature tree:', '>Summary</h2>', '>Feature tree</h2>', '>Feature details</h2>', '>Test paths</h2>', '>Headless versus device</h2>', '>CI checklist</h2>', 'What cannot be known without a device', '>Method and provenance</h2>']
    for (const h of head) expect(golden.html).toContain(h)
  })
  it('golden: shows a staleness banner only in the header when the project tree hash differs', () => {
    const stale = render.renderReport(skeleton, graph, { ...FIXED, currentTreeHash: 'other' }).html
    expect(stale).toContain('The code changed since the graph')
    const a = golden.html.split('</header>'); const b = stale.split('</header>')
    expect(b[1]).toBe(a[1])
    expect(b[0]).not.toBe(a[0])
  })
})

describe('render with a node that is not classified', () => {
  it('shows the badge, its own last column, the summary line, the classify-first row and no total that counts it', () => {
    const { g, tree } = synth({ files: ['lib/a.brs', 'lib/b.brs'], classes: { 'lib/a.brs': 'unknown', 'lib/b.brs': 'headless-unit', S: 'e2e' } })
    const html = render.renderReport(tree, g, { ...FIXED }).html
    expect(html).toContain('not classified')
    expect(html).toContain('1 nodes not classified: the agent or a human must classify them')
    expect(html).toContain('classify first')
    const th = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])
    const cols = th.slice(th.indexOf('Headless total'))
    expect(cols.slice(0, 8)).toEqual(['Headless total', 'Device total', 'headless-unit', 'headless-scene', 'headless-fixtures', 'device', 'e2e', 'Not classified'])
    expect(cols.indexOf('Not classified')).toBeGreaterThan(cols.indexOf('e2e'))
    // the matrix row of the feature: headless total counts b (and main.brs unit), never a
    const row = /<th scope="row"><a href="#f-f0">Feature zero<\/a><\/th>((?:<td class="n">\d+<\/td>)+)/.exec(html)
    const cells = [...row[1].matchAll(/>(\d+)</g)].map((m) => Number(m[1]))
    expect(cells[7]).toBe(1) // not classified
    expect(cells[0]).toBe(cells[2] + cells[3] + cells[4])
    expect(cells[1]).toBe(cells[5] + cells[6])
  })
  it('does not show the summary line when every node is classified', () => {
    const { g, tree } = synth({ files: ['lib/a.brs'] })
    expect(render.renderReport(tree, g, FIXED).html).not.toContain('nodes not classified')
  })
})

describe('render hostile strings', () => {
  const HOSTILE = '<img src=x onerror=alert(1)> & "q" \'a\' </script><script>alert(2)</script>'
  function hostile() {
    const { g, tree } = synth({ comps: ['Evil'], files: ['lib/<b>x</b>.brs'] }, {
      name: '<b>x</b>', summary: HOSTILE, notes: HOSTILE,
      proposedTests: [{ target: 'comp:Evil', lane: 'headless-scene', title: HOSTILE, why: '[link](javascript:alert(3))' }],
    })
    g.nodes.find((n) => n.id === 'comp:Evil').id = 'comp:<img src=x onerror=alert(9)>'
    g.edges.push({ from: 'comp:<img src=x onerror=alert(9)>', to: 'file:lib/<b>x</b>.brs', kind: 'calls', conf: 'name', at: 'x:"1"' })
    tree.features[0].members = g.nodes.filter((n) => n.kind !== 'builtin').map((n) => n.id)
    tree.features[0].proposedTests[0].target = 'comp:<img src=x onerror=alert(9)>'
    tree.paths.reason = HOSTILE
    g.app = '<script>alert(5)</script>'
    return render.renderReport(tree, g, { ...FIXED, ci: { ...CI_NONE, systems: ['<i>ci</i>'] } }).html
  }
  it('contains none of the raw strings and the escaped forms are present', () => {
    const html = hostile()
    expect(html).not.toMatch(/<[^>]*onerror/i)
    for (const raw of ['<b>x</b>', '<img', '<script>alert', 'javascript:alert(3)</a>', '<i>ci</i>']) expect(html).not.toContain(raw)
    for (const e of ['&lt;', '&gt;', '&amp;', '&quot;', '&#39;']) expect(html).toContain(e)
  })
  it('keeps exactly one script and one style element and quotes every attribute', () => {
    const html = hostile()
    expect(count(html, /<script/gi)).toBe(1)
    expect(count(html, /<style/gi)).toBe(1)
    const markup = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '')
    expect(markup.replace(/="[^"]*"/g, '=Q')).not.toMatch(/<[a-zA-Z][^>]*\s[a-zA-Z-]+=[^Q"'\s>]/)
  })
  it('only uses slug or hash anchors and the template ids', () => {
    const html = hostile()
    const fixed = new Set(['main', 'summary', 'tree', 'panels', 'paths', 'matrix', 'ci', 'uncertainty', 'method', 'tools', 'path-leaf-first', 'path-base-first'])
    for (const m of html.matchAll(/\sid="([^"]*)"/g)) {
      const v = m[1]
      expect(/^(f-[a-z0-9-]+|n-[0-9a-f]{10})$/.test(v) || fixed.has(v) || /^h-[a-z0-9-]+$/.test(v)).toBe(true)
    }
  })
  it('esc covers the five characters', () => {
    expect(render.esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(render.esc(5)).toBe('5')
  })
})

describe('render CSP and resources', () => {
  it('has a CSP whose hashes equal the inline style and script', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(golden.html)[1].replace(/&#39;/g, "'")
    const dirs = csp.split('; ')
    expect(dirs.map((d) => d.split(' ')[0])).toEqual(['default-src', 'style-src', 'script-src', 'img-src', 'base-uri', 'form-action'])
    expect(dirs[0]).toBe("default-src 'none'")
    expect(dirs[1]).toBe(`style-src 'sha256-${sha(between(golden.html, 'style'))}'`)
    expect(dirs[2]).toBe(`script-src 'sha256-${sha(between(golden.html, 'script'))}'`)
    expect(dirs.slice(3)).toEqual(['img-src data:', "base-uri 'none'", "form-action 'none'"])
  })
  it('loads nothing external', () => {
    const html = golden.html
    expect(html).not.toMatch(/\ssrc=/)
    for (const bad of ['<link', '<iframe', '<object', '<embed', '@import', 'url(http', 'http://', 'https://']) expect(html).not.toContain(bad)
    for (const m of html.matchAll(/\shref="([^"]*)"/g)) expect(m[1].startsWith('#')).toBe(true)
    expect(html).not.toContain('runs-on:')
  })
  it('has the same CSP for two different trees', () => {
    const a = synth({ files: ['lib/a.brs'] }); const b = synth({ files: ['lib/z.brs', 'lib/y.brs'] })
    const get = (h) => /Content-Security-Policy" content="([^"]*)"/.exec(h)[1]
    expect(get(render.renderReport(a.tree, a.g, FIXED).html)).toBe(get(golden.html))
    expect(get(render.renderReport(b.tree, b.g, FIXED).html)).toBe(get(golden.html))
  })
  it('keeps "<" out of the script so it cannot close early', () => {
    expect(render.JS).not.toContain('<')
  })
})

describe('render contrast in both themes', () => {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const vars = (sel) => {
    const i = render.CSS.indexOf(`${sel}{`)
    expect(i).toBeGreaterThanOrEqual(0)
    const body = render.CSS.slice(i + sel.length + 1, render.CSS.indexOf('}', i))
    return Object.fromEntries(body.split(';').map((p) => p.split(':')))
  }
  it('contrast: every text and background pair reaches 4.5:1 from the generated CSS custom properties', () => {
    const themes = { light: vars(':root[data-theme=light]'), dark: vars(':root[data-theme=dark]') }
    const media = vars(':root:not([data-theme=light])')
    expect(media).toEqual(themes.dark)
    expect(vars(':root')).toEqual(themes.light)
    const kinds = new Set(render.CONTRAST_PAIRS.map((p) => p[0]))
    for (const k of ['--fg', '--muted', '--link', '--c-unknown-fg', '--c-e2e-fg', '--r-high-fg', '--rec-fg', '--warn-fg']) expect(kinds.has(k)).toBe(true)
    for (const [name, t] of Object.entries(themes)) {
      for (const [fg, bg] of render.CONTRAST_PAIRS) {
        expect(t[fg], `${name} ${fg}`).toMatch(/^#[0-9a-f]{6}$/)
        expect(ratio(t[fg], t[bg]), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('render accessibility structure and no-JS completeness', () => {
  const nojs = () => golden.html.replace(/<script>[\s\S]*?<\/script>/, '')
  it('has the landmarks, skip link, heading order and labelled tables', () => {
    const h = golden.html
    for (const t of ['header', 'nav', 'main']) expect(count(h, new RegExp(`<${t}[ >]`, 'g'))).toBe(1)
    expect(/<body>\s*<a class="skip" href="#main">/.test(h)).toBe(true)
    const levels = [...h.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]))
    expect(levels[0]).toBe(1)
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
    expect(count(h, /<th(?=[ >])(?![^>]*scope=)/g)).toBe(0)
    expect(count(h, /<table>/g)).toBe(count(h, /<caption>/g))
    expect(h).not.toContain('role="tree"')
    expect(h).toContain('@media (prefers-reduced-motion')
    expect(h).toContain('@media print')
    expect(h).toContain('prefers-color-scheme')
    expect(render.JS).toContain('theme=(dark|light)')
  })
  it('puts every feature in a nested list with details and a summary', () => {
    const h = golden.html
    expect(count(h, /<details/g)).toBe(count(h, /<summary>/g))
    expect(h).toContain('<ul class="tree">')
  })
  it('reads completely with scripts removed', () => {
    const h = nojs()
    expect(h).not.toContain('<script')
    for (const f of skeleton.features) expect(h).toContain(render.esc(f.name))
    for (const m of ['leaf-first', 'base-first']) expect(h).toContain(`id="path-${m}"`)
    expect(h).toContain('What cannot be known without a device')
    expect(count(h, /Step \d+<\/strong>/g)).toBeGreaterThanOrEqual(2 * skeleton.features.length)
    expect(h).not.toMatch(/data-path="[^"]*" hidden/)
  })
})

describe('render CI checklist', () => {
  const ciText = (ci) => { const { g, tree } = synth({ files: ['lib/a.brs'], classes: { S: 'device' } }); const h = render.renderReport(tree, g, { ...FIXED, ci }).html; return /<section id="ci"[\s\S]*?<\/section>/.exec(h)[0] }
  it('CI: with no CI configuration points at the headless gate section', () => {
    const t = ciText(CI_NONE)
    expect(t).toContain('No CI configuration found')
    expect(t).toContain('GitHub Actions — headless gate')
    expect(t).toContain('add the nightly device job only when you have a self-hosted runner')
  })
  it('CI: GitHub Actions on Node 20 says to set node-version 22', () => {
    const t = ciText({ systems: ['github-actions'], nodeVersions: ['20'], nodeOk: false, selfHosted: false, runsBrighttest: false })
    expect(t).toContain('github-actions found')
    expect(t).toContain("set `node-version: &#39;22&#39;`")
    expect(t).toContain('nothing runs brighttest')
  })
  it('CI: a self-hosted runner makes the device job a concrete step', () => {
    const t = ciText({ systems: ['github-actions'], nodeVersions: ['22'], nodeOk: true, selfHosted: true, runsBrighttest: true })
    expect(t).toContain('a self-hosted runner is already configured')
    expect(t).toContain('already runs brighttest')
    expect(t).not.toContain('runs-on:')
  })
  it('CI: lists the class table with a classify-first row', () => {
    const t = ciText(CI_NONE)
    expect(t).toContain('npx brighttest --no-sgnode --junit reports/unit.xml')
    expect(t).toContain('classify first')
  })
})

describe('render size caps', () => {
  it('holds the member and edge tables at 500 rows with the exact remainder', () => {
    const files = Array.from({ length: 620 }, (_, i) => `lib/f${String(i).padStart(3, '0')}.brs`)
    const { g, tree } = synth({ files })
    for (const f of files.slice(0, 560)) g.edges.push({ from: 'file:lib/f600.brs', to: `file:${f}`, kind: 'calls', conf: 'name', at: 'x:1' })
    tree.features.push({ id: 'f1', name: 'Other', kind: 'screen', summary: 's', risk: 'low', members: [] })
    tree.features[0].members = g.nodes.filter((n) => n.kind === 'file' && n.id !== 'file:lib/f600.brs').map((n) => n.id).concat(['comp:S'])
    tree.features[1].members = ['file:lib/f600.brs']
    const h = render.renderReport(tree, g, FIXED).html
    const art = /<article id="f-f0"[\s\S]*?<\/article>/.exec(h)[0]
    const rows = (cap) => { const t = new RegExp(`<caption>${cap}[^<]*</caption>[\\s\\S]*?</table>`).exec(art)[0]; return count(t, /<tr>/g) - 1 }
    expect(rows('Members of')).toBe(500)
    const total = tree.features[0].members.length
    expect(art).toContain(`${total - 500} more in graph.json`)
    expect(rows('Dependencies of')).toBe(500)
    expect(art).toMatch(/\d+ more in graph\.json/)
  })
  it('warns when the page is over the size threshold and still renders', () => {
    const r = render.renderReport(skeleton, graph, { ...FIXED, maxBytes: 1000 })
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain('MB')
    expect(r.html.length).toBeGreaterThan(1000)
    expect(golden.warnings).toEqual([])
  })
})

describe('features render command', () => {
  function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-render-'))
    fs.cpSync(APP, dir, { recursive: true })
    return dir
  }
  async function run(argv, cwd) {
    const prev = process.cwd(); process.chdir(cwd)
    let out = ''; let err = ''
    try { const code = await features.run(argv, { stdout: (s) => { out += s }, stderr: (s) => { err += s } }); return { code, out, err } } finally { process.chdir(prev) }
  }
  it('--auto writes report.html next to the graph and exits 0', async () => {
    const dir = project()
    try {
      expect((await run(['graph'], dir)).code).toBe(0)
      const r = await run(['render', '--auto'], dir)
      expect(r.code).toBe(0)
      const out = path.join(dir, '.brighttest', 'features', 'report.html')
      expect(fs.readFileSync(out, 'utf8')).toContain('<h1>Feature tree: Feature Probe</h1>')
      const again = fs.readFileSync(out, 'utf8')
      expect((await run(['render', '--auto'], dir)).code).toBe(0)
      expect(fs.readFileSync(out, 'utf8')).toBe(again)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('renders a tree.json and refuses an invalid one without touching an existing report', async () => {
    const dir = project()
    try {
      await run(['graph'], dir)
      const fdir = path.join(dir, '.brighttest', 'features')
      const g = JSON.parse(fs.readFileSync(path.join(fdir, 'graph.json'), 'utf8'))
      const t = buildSkeleton(g, suggest(g))
      fs.writeFileSync(path.join(fdir, 'tree.json'), JSON.stringify(t))
      expect((await run(['render'], dir)).code).toBe(0)
      const out = path.join(fdir, 'report.html')
      const before = fs.readFileSync(out)
      t.graph.hash = 'bad'
      fs.writeFileSync(path.join(fdir, 'tree.json'), JSON.stringify(t))
      const r = await run(['render'], dir)
      expect(r.code).toBe(3)
      expect(r.err).toContain('stale-graph')
      expect(fs.readFileSync(out).equals(before)).toBe(true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('exits 2 for a missing tree, --out inside source/ and --auto with a tree', async () => {
    const dir = project()
    try {
      await run(['graph'], dir)
      expect((await run(['render'], dir)).code).toBe(2)
      const r = await run(['render', '--auto', '--out', path.join(dir, 'source', 'report.html')], dir)
      expect(r.code).toBe(2)
      expect(fs.existsSync(path.join(dir, 'source', 'report.html'))).toBe(false)
      expect((await run(['render', '--auto', 'tree.json'], dir)).code).toBe(2)
      expect((await run(['check', '--auto'], dir)).code).toBe(2)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
