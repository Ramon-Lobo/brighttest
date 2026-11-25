'use strict'
// Run-evidence overlays for `features render`: JUnit and LCOV files turned into per-node evidence levels.
//
//   ran-headless  a JUnit from a headless lane (or an LCOV file) shows the node's spec passing, or its lines executing
//   ran-device    a JUnit marked as a device run shows the node's spec passing
//
// A device level is never produced by rules or by an unmarked file: only a JUnit that says it is a device run
// (a `brighttest.lane` property with the value `device`, or the e2e reporter's `brighttest e2e` suite name).
// Pure functions over strings; reading the files stays in render.js. No network, device or subprocess.

const LEVELS = ['ran-headless', 'ran-device']
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const unxml = (s) => String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (m, e) => {
  if (e === 'lt') return '<'
  if (e === 'gt') return '>'
  if (e === 'amp') return '&'
  if (e === 'quot') return '"'
  if (e === 'apos') return "'"
  const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '?'
})
function attrs(tag) {
  const out = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(tag))) out[m[1]] = unxml(m[3] !== undefined ? m[3] : m[4])
  return out
}

// Parses a JUnit document. Returns { lane: 'headless'|'device', cases: [{ suite, classname, name, file, status }] }.
// status is passed, failed (failure or error element) or skipped. Throws Error('not a JUnit report') without a testsuite.
function parseJunit(xml) {
  const text = String(xml).replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  if (!/<testsuite[\s>]/.test(text)) throw new Error('not a JUnit report (no testsuite element)')
  let lane = 'headless'
  const root = /<testsuites\b[^>]*>/.exec(text)
  if (root && attrs(root[0]).name === 'brighttest e2e') lane = 'device'
  const re = /<property\b[^>]*>/g
  let pm
  while ((pm = re.exec(text))) {
    const a = attrs(pm[0])
    if (a.name === 'brighttest.lane') lane = a.value === 'device' ? 'device' : 'headless'
  }
  const cases = []
  const suiteRe = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/?)>([\s\S]*?)(?=<testcase\b|<\/testsuite>|<testsuite\b|$)/g
  const stack = []
  let m
  while ((m = suiteRe.exec(text))) {
    if (m[0] === '</testsuite>') { stack.pop(); continue }
    if (m[0].startsWith('<testsuite')) { if (m[2] !== '/') stack.push(attrs(m[1]).name || ''); continue }
    const a = attrs(m[3])
    const body = m[4] === '/' ? '' : m[5].replace(/<\/testcase>[\s\S]*$/, '')
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed'
    cases.push({ suite: stack[stack.length - 1] || '', classname: a.classname || '', name: a.name || '', file: a.file || '', status })
  }
  return { lane, cases }
}

// Parses LCOV text into [{ file, lf, lh }] (SF/LF/LH; DA lines when LF/LH are absent).
function parseLcov(text) {
  const out = []
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('SF:')) { cur = { file: line.slice(3), lf: null, lh: null, da: 0, dh: 0 }; continue }
    if (!cur) continue
    if (line.startsWith('LF:')) cur.lf = parseInt(line.slice(3), 10) || 0
    else if (line.startsWith('LH:')) cur.lh = parseInt(line.slice(3), 10) || 0
    else if (line.startsWith('DA:')) { cur.da++; if ((parseInt(line.slice(3).split(',')[1], 10) || 0) > 0) cur.dh++ } else if (line === 'end_of_record') { out.push(finish(cur)); cur = null }
  }
  if (cur) out.push(finish(cur))
  return out
}
const finish = (c) => ({ file: c.file, lf: c.lf === null ? c.da : c.lf, lh: c.lh === null ? c.dh : c.lh })

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
const stripExt = (p) => p.replace(/\.(brs|bs|xml)$/i, '')
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1)
const relOf = (id) => (id.startsWith('file:') ? id.slice(5) : id)
// True when a and b name the same file by whole trailing path segments (extension ignored, either side may be longer).
function samePath(a, b) {
  const x = stripExt(norm(a)); const y = stripExt(norm(b))
  if (!x || !y) return false
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x)
}

// Builds the overlay. junits: [{ file, lane, cases }], lcovs: [{ file, records }].
// Returns { nodes: Map(nodeId -> { 'ran-headless': n, 'ran-device': n, lcov: { lf, lh } | null }), junit: {...}, lcov: {...} }.
function buildOverlay(graph, junits = [], lcovs = []) {
  const nodes = new Map()
  const slot = (id) => { if (!nodes.has(id)) nodes.set(id, { 'ran-headless': 0, 'ran-device': 0, lcov: null }); return nodes.get(id) }
  const specs = (Array.isArray(graph.nodes) ? graph.nodes : []).filter((n) => isObj(n) && n.spec && typeof n.id === 'string').map((n) => n.id).sort(cmp)
  const byBase = new Map()
  for (const s of specs) { const b = stripExt(baseOf(norm(relOf(s)))); byBase.set(b, [...(byBase.get(b) || []), s]) }
  const covers = new Map()
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) if (isObj(e) && e.kind === 'spec-covers' && typeof e.from === 'string' && typeof e.to === 'string') { if (!covers.has(e.from)) covers.set(e.from, new Set()); covers.get(e.from).add(e.to) }
  const stats = { junitFiles: junits.length, cases: 0, mapped: 0, unmapped: 0, specsPassed: 0, specsFailed: 0 }

  const specOf = (c) => {
    const cands = [c.file, c.classname, c.suite].filter((x) => x)
    for (const cand of cands) { const hit = specs.find((s) => samePath(relOf(s), cand)); if (hit) return hit }
    for (const cand of cands) { // a bare spec name (no folder) matches only when exactly one spec has it
      const hits = byBase.get(stripExt(baseOf(norm(cand))))
      if (hits && hits.length === 1) return hits[0]
    }
    return null
  }
  for (const j of junits) {
    const per = new Map() // spec id -> { passed, failed }
    for (const c of j.cases) {
      stats.cases++
      const s = specOf(c)
      if (!s) { stats.unmapped++; continue }
      stats.mapped++
      if (!per.has(s)) per.set(s, { passed: 0, failed: 0 })
      if (c.status === 'passed') per.get(s).passed++
      else if (c.status === 'failed') per.get(s).failed++
    }
    for (const [s, r] of per) {
      if (r.failed > 0 || r.passed === 0) { if (r.failed > 0) stats.specsFailed++; continue }
      stats.specsPassed++
      for (const id of [s, ...(covers.get(s) || [])]) slot(id)[`ran-${j.lane}`] += r.passed
    }
  }
  let lcovFiles = 0
  const fileNodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter((n) => isObj(n) && n.kind === 'file' && typeof n.id === 'string').map((n) => n.id).sort(cmp)
  for (const l of lcovs) {
    lcovFiles++
    for (const r of l.records) {
      const id = fileNodes.find((n) => samePath(relOf(n), r.file) && stripExt(norm(r.file)) !== '')
      if (!id) continue
      const s = slot(id)
      s.lcov = { lf: (s.lcov ? s.lcov.lf : 0) + r.lf, lh: (s.lcov ? s.lcov.lh : 0) + r.lh }
    }
  }
  return { nodes, stats: { ...stats, lcovFiles } }
}

// The evidence text for one node, or '' when the overlay says nothing about it.
// Both levels can show at once; the level text is exactly ran-headless / ran-device.
function evidenceText(overlay, id) {
  const s = overlay && overlay.nodes.get(id)
  if (!s) return ''
  const parts = []
  if (s['ran-headless'] > 0 || (s.lcov && s.lcov.lh > 0)) {
    const d = []
    if (s['ran-headless'] > 0) d.push(`${s['ran-headless']} ${s['ran-headless'] === 1 ? 'case' : 'cases'} passed`)
    if (s.lcov) d.push(`lcov ${s.lcov.lf ? Math.round((s.lcov.lh / s.lcov.lf) * 100) : 0}% of ${s.lcov.lf} lines`)
    parts.push(`ran-headless (${d.join(', ')})`)
  }
  if (s['ran-device'] > 0) parts.push(`ran-device (${s['ran-device']} ${s['ran-device'] === 1 ? 'case' : 'cases'} passed)`)
  return parts.join('; ')
}

module.exports = { LEVELS, parseJunit, parseLcov, buildOverlay, evidenceText }
