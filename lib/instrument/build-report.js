'use strict'
// Post-build reports for `instrument build` (FR-PACKAGE-FILES, FR-BSC-GATE): which files under rootDir did not reach the
// package, which `pkg:/` string literals point at files that are not in it, and how to classify and summarize bsc
// diagnostics. Pure helpers, no logging: build.js prints.
const fs = require('node:fs')
const path = require('node:path')

// Never counted as "not packaged": tool config, test specs, dot folders, zips. Mirrors the default of instrumentFiles().
const NOT_A_CHANNEL_FILE = [/^brighttest\.json$/i, /^bsconfig\.json$/i, /^package(-lock)?\.json$/i, /\.zip$/i, /^source\/tests\//i, /\.spec\.[^/]+$/i]
const SKIP_DIRS = new Set(['node_modules'])
const lc = (s) => String(s).replace(/\\/g, '/').toLowerCase()
// bsc emits .bs as .brs and drops type definitions
const pkgName = (rel) => lc(rel).replace(/\.bs$/, '.brs')

function walk(root, skipAbs, out = [], rel = '') {
  let ents
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch (e) { return out }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    const abs = path.join(root, r)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !skipAbs.has(path.resolve(abs))) walk(root, skipAbs, out, r) }
    else if (e.isFile()) out.push(r)
  }
  return out
}

// zipEntries: package entry names. Returns { missing: [{ group, count }], total } for files of rootDir not in the package.
function notPackaged(rootDir, zipEntries, skipDirs = []) {
  const inPkg = new Set(zipEntries.map(lc))
  const skipAbs = new Set(skipDirs.map((d) => path.resolve(d)))
  const groups = new Map()
  let total = 0
  for (const rel of walk(path.resolve(rootDir), skipAbs)) {
    const r = rel.replace(/\\/g, '/')
    if (NOT_A_CHANNEL_FILE.some((re) => re.test(r))) continue
    if (/\.d\.bs$/i.test(r)) continue
    if (inPkg.has(pkgName(r))) continue
    const top = r.includes('/') ? r.split('/')[0] + '/' : '(root)'
    groups.set(top, (groups.get(top) || 0) + 1)
    total++
  }
  return { total, missing: [...groups].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count || a.group.localeCompare(b.group)) }
}

// texts: [{ name, text }] of packaged .brs/.xml files. Returns the unique `pkg:/...` literals that point at no entry.
const PKG_LITERAL = /["'>](pkg:\/[^"'<>\s]+)["'<]/g
function missingPkgLiterals(texts, zipEntries) {
  const have = new Set(zipEntries.map(lc))
  const dirs = new Set()
  for (const e of have) { const parts = e.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')) }
  const seen = new Map()
  for (const { name, text } of texts) {
    let m
    PKG_LITERAL.lastIndex = 0
    while ((m = PKG_LITERAL.exec(text))) {
      const lit = m[1]
      if (/[%{}$*?]/.test(lit) || /["+]/.test(lit)) continue // placeholders, patterns
      const p = lc(lit.slice('pkg:/'.length)).replace(/\/+$/, '')
      if (!p || have.has(p) || dirs.has(p)) continue
      if (!seen.has(lit)) seen.set(lit, name)
    }
  }
  return [...seen].map(([literal, file]) => ({ literal, file }))
}

// ---- bsc diagnostics (FR-BSC-GATE) ----
const pkgOf = (d) => (d.file && (d.file.pkgPath || d.file.srcPath)) || ''
const lineOf = (d) => (d.range ? d.range.start.line + 1 : 0)

function dedupe(diags) {
  const seen = new Set()
  return diags.filter((d) => {
    const k = `${pkgOf(d)}:${lineOf(d)}:${d.code}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const isPlugin = (d) => typeof d.code === 'string' && /^BT9/.test(d.code)
function isParseDiag(d) {
  const ds = d.file && d.file.parser && d.file.parser.diagnostics
  if (!Array.isArray(ds)) return false
  return ds.some((p) => p.code === d.code && p.range && d.range && p.range.start.line === d.range.start.line && p.range.start.character === d.range.start.character)
}

// Splits error diagnostics into blocking and advisory. Blocking: plugin diagnostics (BT9xxx), parse errors in files the
// plugin may rewrite (not matched by `isExcluded`), everything when failOnBsc. Advisory: whole-program validation.
function classify(diags, { failOnBsc = false, isExcluded = () => false } = {}) {
  const blocking = []; const advisory = []
  for (const d of dedupe(diags)) {
    if (isPlugin(d) || failOnBsc || (isParseDiag(d) && !isExcluded(pkgOf(d)))) blocking.push(d)
    else advisory.push(d)
  }
  return { blocking, advisory }
}

// Per-code histogram of numeric bsc codes: { codes: [[code, n]...] sorted by count desc, line } where `line` is the
// ready-to-paste brighttest.json fragment.
function histogram(diags) {
  const counts = new Map()
  for (const d of diags) { if (isPlugin(d)) continue; counts.set(d.code, (counts.get(d.code) || 0) + 1) }
  const codes = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
  const filter = codes.map(([c]) => c).sort((a, b) => Number(a) - Number(b))
  return { codes, line: filter.length ? `"diagnosticFilters": [${filter.map((c) => (typeof c === 'number' ? c : JSON.stringify(c))).join(', ')}]` : null }
}

module.exports = { notPackaged, missingPkgLiterals, classify, dedupe, histogram, isPlugin, isParseDiag, pkgOf, lineOf }
