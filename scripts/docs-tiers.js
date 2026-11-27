'use strict'
// Two-tier docs (ADR 0061). Lite pages live under docs/lite/ and are served at the usual URLs; the full page for
// the same path is served at /full/<path>. Pure functions, no dependencies; used by docs/.vitepress/config.mts
// and the tests. With no docs/lite/ directory every function returns an empty / identity result, so the site
// builds exactly as a single-tier site.
const fs = require('fs')
const path = require('path')

const SKIP_DIRS = new Set(['.vitepress', 'node_modules', 'public'])

function walk(dir, rel, out) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(path.join(dir, ent.name), r, out)
    } else if (ent.isFile() && ent.name.endsWith('.md') && !ent.name.startsWith('_')) out.push(r)
  }
  return out
}

// docsDir -> { tiered, liteOnly, fullOnly }: source-relative md paths without the lite/ prefix, sorted.
//  tiered:   a lite page and a full page exist for the path
//  liteOnly: only a lite page exists
//  fullOnly: only a full page exists (served at its usual URL)
function tierMap(docsDir) {
  const liteDir = path.join(docsDir, 'lite')
  const lite = new Set(walk(liteDir, '', []))
  const full = new Set(walk(docsDir, '', []).filter((r) => !r.startsWith('lite/')))
  const tiered = []
  const liteOnly = []
  const fullOnly = []
  for (const r of lite) (full.has(r) ? tiered : liteOnly).push(r)
  for (const r of full) if (!lite.has(r)) fullOnly.push(r)
  return { tiered: tiered.sort(), liteOnly: liteOnly.sort(), fullOnly: fullOnly.sort() }
}

// VitePress `rewrites` map. Empty when there is no lite tier.
function rewritesFor(map) {
  const out = {}
  for (const r of map.liteOnly) out[`lite/${r}`] = r
  for (const r of map.tiered) {
    out[`lite/${r}`] = r
    out[r] = `full/${r}`
  }
  return out
}

// Source path -> the full-tier source whose twin / alternate link applies, or null (lite-only page).
//  'lite/guide/x.md' -> 'guide/x.md' when a full twin exists, else null; 'guide/x.md' -> 'guide/x.md'.
function twinOf(filePath, map) {
  const f = String(filePath).replace(/\\/g, '/')
  if (!f.startsWith('lite/')) return f
  const rel = f.slice('lite/'.length)
  return map && map.tiered.includes(rel) ? rel : null
}

// Site link ("/guide/studio", "/writing-tests/", "/") -> source-relative md path.
function linkToRel(link) {
  const p = String(link).replace(/^\//, '')
  if (p === '') return 'index.md'
  if (p.endsWith('/')) return p + 'index.md'
  return p + '.md'
}

// "/guide/x#a" -> "/full/guide/x#a" when x is tiered; anything else (external, relative, untiered) unchanged.
function fullLink(url, map) {
  const m = /^(\/[^#?]*)([?#].*)?$/.exec(String(url))
  if (!m || m[1].startsWith('//') || m[1].startsWith('/full/') || m[1] === '/full') return url
  let p = m[1]
  if (/\.html$/.test(p)) p = p.slice(0, -5)
  if (p.endsWith('.md')) p = p.slice(0, -3)
  return map.tiered.includes(linkToRel(p)) ? '/full' + (p === '/' ? '/' : p) + (m[2] || '') : url
}

// Copy of a sidebar (array or multi-sidebar-free tree) with /full links for tiered pages.
function prefixFull(sidebar, map) {
  if (!Array.isArray(sidebar)) return sidebar
  return sidebar.map((it) => {
    const copy = { ...it }
    if (copy.items) copy.items = prefixFull(copy.items, map)
    if (copy.link) copy.link = fullLink(copy.link, map)
    return copy
  })
}

module.exports = { tierMap, rewritesFor, twinOf, prefixFull, fullLink, linkToRel }
