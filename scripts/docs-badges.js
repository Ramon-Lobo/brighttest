'use strict'
// "New" and "Updated" page badges for the versioned docs site. Pure and dependency-free; the VitePress config
// loads it with createRequire, and scripts/changelog.js uses listPages.
//
//   New      a page in this tree that is absent from the baseline release's page list.
//   Updated  a page linked from a changelog line of the coming release (a page that is New shows New only).
//   Baseline the previous release: on `next`/`dev` the newest entry of release-pages.json; on `latest` the entry
//            before the one for this build's version. `old` builds show nothing.
// Nothing here reads git. Anything unusable yields no badges rather than an error.

const fs = require('node:fs')
const path = require('node:path')

const VER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

function cmpVer(a, b) {
  const pa = VER_RE.exec(a), pb = VER_RE.exec(b)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d) return d
  }
  return 0
}

// docs-relative file path -> clean URL path ("guide/mcp", "index", "guide/index" for guide/index.md).
function pageOfFile(rel) {
  return rel.split(path.sep).join('/').replace(/\.md$/, '')
}

function globToRe(glob) {
  const g = String(glob).replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++ } else re += '[^/]*'
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

// Every *.md under docsDir, as page paths, sorted. Skips .vitepress, node_modules, public, files starting with
// "_", and any srcExclude globs (relative to docsDir).
function listPages(docsDir, { srcExclude = [] } = {}) {
  const excludes = srcExclude.map(globToRe)
  const out = []
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (ent.name === '.vitepress' || ent.name === 'node_modules' || ent.name === 'public') continue
        walk(path.join(dir, ent.name), r)
      } else if (ent.isFile() && ent.name.endsWith('.md') && !ent.name.startsWith('_')) {
        if (excludes.some((re) => re.test(r))) continue
        out.push(pageOfFile(r))
      }
    }
  }
  walk(docsDir, '')
  return out.sort()
}

// Page paths from docs-relative file paths (for example `git ls-tree` output with the "docs/" prefix removed),
// applying the same skip rules as listPages. Sorted, unique.
function pagesFromFiles(files, { srcExclude = [] } = {}) {
  const excludes = srcExclude.map(globToRe)
  const out = new Set()
  for (const f of files) {
    const parts = String(f).split('/')
    const name = parts[parts.length - 1]
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    if (parts.slice(0, -1).some((d) => d === '.vitepress' || d === 'node_modules' || d === 'public')) continue
    if (excludes.some((re) => re.test(f))) continue
    out.add(pageOfFile(f))
  }
  return [...out].sort()
}

// A link target -> page path, or null (external, anchor-only, not a page).
function normalizeTarget(target, fromDir, pages) {
  let t = String(target).trim()
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//') || t.startsWith('#')) return null
  t = t.split('#')[0].split('?')[0]
  if (!t) return null
  t = t.startsWith('/') ? t.slice(1) : path.posix.normalize(path.posix.join(fromDir, t))
  t = t.replace(/\.(md|html)$/, '')
  if (t === '' || t === '.') t = 'index'
  else if (t.endsWith('/')) t += 'index'
  return pages.has(t) ? t : null
}

// The body of the changelog section for `heading` ("Unreleased" or a version), or ''.
function changelogSection(text, version) {
  const lines = String(text || '').split('\n')
  const want = version === null ? /^## Unreleased\b/ : new RegExp('^## v' + String(version).replace(/^v/, '').replace(/\./g, '\\.') + '\\b')
  const start = lines.findIndex((l) => want.test(l))
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
  return lines.slice(start + 1, end).join('\n')
}

function linkedPages(sectionText, pages, changelogPage = 'changelog') {
  const fromDir = path.posix.dirname(changelogPage) === '.' ? '' : path.posix.dirname(changelogPage)
  const set = pages instanceof Set ? pages : new Set(pages)
  const found = new Set()
  const re = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m
  while ((m = re.exec(sectionText))) {
    const p = normalizeTarget(m[1], fromDir, set)
    if (p) found.add(p)
  }
  return found
}

// -> { baseline: entry | null, badges: { page: 'new' | 'updated' }, reason }
function badgeInfo({ pages = [], releasePages, changelogText = '', channel = 'dev', version } = {}) {
  const none = (reason) => ({ baseline: null, badges: {}, reason })
  if (channel === 'old') return none('old minor')
  if (!releasePages || releasePages.schema !== 1 || !Array.isArray(releasePages.releases)) return none('no usable release-pages data')
  const entries = releasePages.releases
    .filter((r) => r && VER_RE.test(r.version) && Array.isArray(r.pages))
    .sort((a, b) => cmpVer(a.version, b.version))
  if (!entries.length) return none('no usable release-pages data')

  let baseline
  let section = null
  if (channel === 'latest') {
    if (!version || !VER_RE.test(version)) return none('no build version')
    const i = entries.findIndex((e) => cmpVer(e.version, version) === 0)
    if (i < 1) return none('no previous release entry')
    baseline = entries[i - 1]
    section = version
  } else {
    baseline = entries[entries.length - 1]
  }

  const pageSet = new Set(pages)
  const before = new Set(baseline.pages)
  const badges = {}
  for (const p of linkedPages(changelogSection(changelogText, section), pageSet)) badges[p] = 'updated'
  for (const p of pageSet) if (!before.has(p)) badges[p] = 'new'
  return { baseline, badges, reason: '' }
}

// -> { page: 'new' | 'updated' }
function computeBadges(args) {
  return badgeInfo(args).badges
}

// Append the label to sidebar items whose link is badged. Returns a new tree; input is untouched.
function labelSidebar(items, badges, labels = { new: 'New', updated: 'Updated' }) {
  if (!Array.isArray(items)) return items
  return items.map((it) => {
    const copy = { ...it }
    if (copy.items) copy.items = labelSidebar(copy.items, badges, labels)
    if (copy.link) {
      const p = normalizeTarget(copy.link, '', new Set(Object.keys(badges)))
      const kind = p && badges[p]
      if (kind) copy.text = `${copy.text} <span class="bt-badge bt-badge--${kind}">${labels[kind]}</span>`
    }
    return copy
  })
}

module.exports = { pagesFromFiles, computeBadges, badgeInfo, listPages, linkedPages, changelogSection, normalizeTarget, labelSidebar, pageOfFile, cmpVer }
