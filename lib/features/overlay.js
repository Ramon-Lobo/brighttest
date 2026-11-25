'use strict'
// Run-evidence overlays for `features render`: JUnit and LCOV files turned into per-node evidence levels.
//
//   ran-headless  a JUnit from a headless lane shows the node's spec passing
//   executed      an LCOV file shows the node's lines executing (lane-neutral: LCOV carries no lane marker, so it gives no level)
//   ran-device    a JUnit marked as a device run shows the node's spec passing
//
// A device level is never produced by rules or by an unmarked file: only a JUnit that says it is a device run
// (a `brighttest.lane` property with the value `device`, or the e2e reporter's `brighttest e2e` suite name).
// Pure functions over strings; reading the files stays in render.js. No network, device or subprocess.

const path = require('path')

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
const MAX_TAG = 4096 // a tag longer than this is treated as text, so unclosed tags cannot make the scan quadratic

// Reads attributes from the inside of a tag. Quote aware: a '>' inside a value does not end the tag.
function attrsOf(inner) {
  const out = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(inner))) out[m[1]] = unxml(m[3] !== undefined ? m[3] : m[4])
  return out
}

// One linear tokenizer: calls onOpen(name, attrs, selfClosing) / onClose(name) for each element.
// Comments, CDATA and processing instructions are skipped. A '<' that starts no well-formed tag within MAX_TAG chars is text.
function tokenize(text, onOpen, onClose) {
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) return
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt + 9); i = e < 0 ? n : e + 3; continue }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue }
    const closing = text[lt + 1] === '/'
    const ns = lt + (closing ? 2 : 1)
    let j = ns
    while (j < n && /[\w:.-]/.test(text[j])) j++
    if (j === ns) { i = lt + 1; continue }
    const name = text.slice(ns, j)
    let q = null
    let k = j
    const limit = Math.min(n, lt + MAX_TAG)
    let end = -1
    for (; k < limit; k++) {
      const ch = text[k]
      if (q) { if (ch === q) q = null } else if (ch === '"' || ch === "'") q = ch
      else if (ch === '>') { end = k; break }
    }
    if (end < 0) { i = lt + 1; continue }
    if (closing) onClose(name)
    else {
      const inner = text.slice(j, end)
      const self = inner.endsWith('/')
      onOpen(name, attrsOf(self ? inner.slice(0, -1) : inner), self)
    }
    i = end + 1
  }
}

// Parses a JUnit document.
// Returns { lane, cases: [{ suite, classname, name, file, status, lane }] }. status is passed, failed (failure or error
// element) or skipped. The lane is per suite: a brighttest.lane property applies to its enclosing <testsuite> (or to the
// whole file when it sits outside every testsuite); the e2e reporter's `brighttest e2e` root name marks a device run.
// `lane` of the result is the common lane of the cases, or 'mixed'. Throws Error('not a JUnit report') without a testsuite.
function parseJunit(xml) {
  const text = String(xml)
  const suiteStack = []
  const root = { lane: null }
  const cases = []
  let cur = null
  let sawSuite = false
  const laneVal = (v) => (v === 'device' ? 'device' : 'headless')
  tokenize(text, (name, a, self) => {
    if (name === 'testsuites') { if (a.name === 'brighttest e2e') root.lane = 'device' } else if (name === 'testsuite') {
      sawSuite = true
      if (!self) suiteStack.push({ name: a.name || '', lane: null })
    } else if (name === 'property' && a.name === 'brighttest.lane' && !cur) {
      (suiteStack[suiteStack.length - 1] || root).lane = laneVal(a.value)
    } else if (name === 'testcase') {
      cur = { suite: suiteStack.length ? suiteStack[suiteStack.length - 1].name : '', classname: a.classname || '', name: a.name || '', file: a.file || '', status: 'passed', scope: suiteStack.slice() }
      cases.push(cur)
      if (self) cur = null
    } else if (cur && (name === 'failure' || name === 'error')) cur.status = 'failed'
    else if (cur && name === 'skipped' && cur.status === 'passed') cur.status = 'skipped'
  }, (name) => {
    if (name === 'testsuite') suiteStack.pop()
    else if (name === 'testcase') cur = null
  })
  if (!sawSuite) throw new Error('not a JUnit report (no testsuite element)')
  const out = cases.map((c) => {
    let lane = null
    for (let i = c.scope.length - 1; i >= 0 && !lane; i--) lane = c.scope[i].lane
    delete c.scope
    c.lane = lane || root.lane || 'headless'
    return c
  })
  const lanes = new Set(out.map((c) => c.lane))
  return { lane: lanes.size === 1 ? [...lanes][0] : lanes.size ? 'mixed' : root.lane || 'headless', cases: out }
}

// Parses LCOV text into [{ file, lf, lh }] (SF/LF/LH; DA lines when LF/LH are absent). lh is clamped to lf.
function parseLcov(text) {
  const out = []
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('SF:')) { if (cur) out.push(finish(cur)); cur = { file: line.slice(3), lf: null, lh: null, da: 0, dh: 0 }; continue }
    if (!cur) continue
    if (line.startsWith('LF:')) cur.lf = parseInt(line.slice(3), 10) || 0
    else if (line.startsWith('LH:')) cur.lh = parseInt(line.slice(3), 10) || 0
    else if (line.startsWith('DA:')) { cur.da++; if ((parseInt(line.slice(3).split(',')[1], 10) || 0) > 0) cur.dh++ } else if (line === 'end_of_record') { out.push(finish(cur)); cur = null }
  }
  if (cur) out.push(finish(cur))
  return out
}
const finish = (c) => {
  const lf = Math.max(0, c.lf === null ? c.da : c.lf)
  const lh = Math.max(0, c.lh === null ? c.dh : c.lh)
  return { file: c.file, lf, lh: Math.min(lh, lf) }
}

// ---- path matching ----
const stripExt = (p) => p.replace(/\.(brs|bs|xml)$/i, '')
const extClass = (p) => { const m = /\.(brs|bs|xml)$/i.exec(p); return m ? (m[1].toLowerCase() === 'xml' ? 'xml' : 'code') : null }
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1)
const relOf = (id) => (id.startsWith('file:') ? id.slice(5) : id)
// Normalises a reported path: forward slashes, no pkg:/ prefix, no project root, no ./ or leading /, dot segments resolved.
// Returns null when it still climbs out (a leftover .. segment).
function normPath(p, root) {
  let x = String(p).replace(/\\/g, '/').trim()
  x = x.replace(/^pkg:\/+/i, '')
  const r = root ? String(root).replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (r && (x === r || x.startsWith(r + '/'))) x = x.slice(r.length)
  x = path.posix.normalize(x.replace(/^\/+/, '') || '.')
  if (x === '.' || x === '..' || x.startsWith('../') || x.split('/').includes('..')) return null
  return x
}
// Index of nodes by basename without extension: Map(base -> [{ rel, key, cls, id }]).
function indexByBase(all) {
  const ids = [...new Set(all)]
  const m = new Map()
  for (const id of ids) {
    const rel = relOf(id)
    const key = stripExt(rel)
    const b = baseOf(key)
    if (!m.has(b)) m.set(b, [])
    m.get(b).push({ rel, key, cls: extClass(rel), id })
  }
  return m
}
// Finds the node a reported path names. A candidate as long as the node path (or longer) matches it by whole trailing
// segments; the longest node path wins. A shorter candidate is a bare name and matches only when exactly one node has it.
function lookup(index, cand) {
  if (!cand) return null
  const key = stripExt(cand)
  const cls = extClass(cand)
  const list = (index.get(baseOf(key)) || []).filter((e) => !cls || !e.cls || e.cls === cls)
  let best = null
  for (const e of list) if (key === e.key || key.endsWith('/' + e.key)) if (!best || e.key.length > best.key.length) best = e
  if (best) return best.id
  const shorter = list.filter((e) => e.key.endsWith('/' + key))
  return shorter.length === 1 ? shorter[0].id : null
}

// Builds the overlay. junits: [{ file, lane, cases }], lcovs: [{ file, records }], opts.root: the project root (stripped from paths).
// Returns { nodes: Map(nodeId -> { 'ran-headless': n, 'ran-device': n, lcov: { lf, lh } | null }), stats }.
// A case maps to a spec by its file attribute, then by its classname (or suite name) equal to exactly one spec's @suite
// title (graph.specSuites), then by path. A title shared by several specs is ambiguous: the case is unmapped and counted.
// LCOV is lane-neutral: it shows what executed but never adds a ran-headless or ran-device level.
function buildOverlay(graph, junits = [], lcovs = [], opts = {}) {
  const root = opts.root
  const nodes = new Map()
  const slot = (id) => { if (!nodes.has(id)) nodes.set(id, { 'ran-headless': 0, 'ran-device': 0, lcov: null }); return nodes.get(id) }
  const gnodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const specs = gnodes.filter((n) => isObj(n) && n.spec && typeof n.id === 'string').map((n) => n.id).sort(cmp)
  const specIndex = indexByBase(specs)
  const titles = new Map() // @suite title -> [spec ids]
  const ss = isObj(graph.specSuites) ? graph.specSuites : {}
  for (const id of specs) for (const t of Array.isArray(ss[id]) ? ss[id] : []) if (typeof t === 'string') { if (!titles.has(t)) titles.set(t, []); if (!titles.get(t).includes(id)) titles.get(t).push(id) }
  const covers = new Map()
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) if (isObj(e) && e.kind === 'spec-covers' && typeof e.from === 'string' && typeof e.to === 'string') { if (!covers.has(e.from)) covers.set(e.from, new Set()); covers.get(e.from).add(e.to) }
  const stats = { junitFiles: junits.length, cases: 0, mapped: 0, unmapped: 0, ambiguous: 0, specsPassed: 0, specsFailed: 0, lcovDropped: 0 }

  // returns { id } or { ambiguous: true } or null
  const specOf = (c) => {
    const byFile = lookup(specIndex, c.file && normPath(c.file, root))
    if (byFile) return { id: byFile }
    let ambiguous = false
    for (const t of [c.classname, c.suite]) {
      const hit = t && titles.get(t)
      if (hit && hit.length === 1) return { id: hit[0] }
      if (hit && hit.length > 1) ambiguous = true
    }
    for (const cand of [c.classname, c.suite]) {
      const id = lookup(specIndex, cand && normPath(cand, root))
      if (id) return { id }
    }
    return ambiguous ? { ambiguous: true } : null
  }
  for (const j of junits) {
    const per = new Map() // `lane\0spec` -> { lane, spec, passed, failed }
    for (const c of j.cases) {
      stats.cases++
      const r = specOf(c)
      if (!r || r.ambiguous) { stats.unmapped++; if (r) stats.ambiguous++; continue }
      stats.mapped++
      const lane = c.lane || (j.lane === 'device' ? 'device' : 'headless')
      const k = `${lane}\u0000${r.id}`
      if (!per.has(k)) per.set(k, { lane, spec: r.id, passed: 0, failed: 0 })
      if (c.status === 'passed') per.get(k).passed++
      else if (c.status === 'failed') per.get(k).failed++
    }
    for (const r of per.values()) {
      if (r.failed > 0 || r.passed === 0) { if (r.failed > 0) stats.specsFailed++; continue }
      stats.specsPassed++
      for (const id of [r.spec, ...(covers.get(r.spec) || [])]) slot(id)[`ran-${r.lane}`] += r.passed
    }
  }
  const fileIndex = indexByBase(gnodes.filter((n) => isObj(n) && n.kind === 'file' && typeof n.id === 'string').map((n) => n.id).sort(cmp))
  let lcovFiles = 0
  for (const l of lcovs) {
    lcovFiles++
    for (const r of l.records) {
      const cand = normPath(r.file, root)
      if (cand === null) { stats.lcovDropped++; continue }
      const id = lookup(fileIndex, cand)
      if (!id) continue
      const s = slot(id)
      // several records for one source (or several files) merge by the larger total, never by summing
      const lf = Math.max(s.lcov ? s.lcov.lf : 0, r.lf)
      s.lcov = { lf, lh: Math.min(lf, Math.max(s.lcov ? s.lcov.lh : 0, r.lh)) }
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
  if (s['ran-headless'] > 0) parts.push(`ran-headless (${s['ran-headless']} ${s['ran-headless'] === 1 ? 'case' : 'cases'} passed)`)
  if (s['ran-device'] > 0) parts.push(`ran-device (${s['ran-device']} ${s['ran-device'] === 1 ? 'case' : 'cases'} passed)`)
  if (s.lcov && s.lcov.lh > 0) parts.push(`executed (lcov ${s.lcov.lf ? Math.round((s.lcov.lh / s.lcov.lf) * 100) : 0}% of ${s.lcov.lf} lines)`)
  return parts.join('; ')
}

module.exports = { LEVELS, parseJunit, parseLcov, buildOverlay, evidenceText }
