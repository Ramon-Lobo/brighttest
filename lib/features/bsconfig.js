'use strict'
// bsconfig.json facts the feature graph cannot honour: `plugins` and a custom `files` list. The graph walks source/ and
// components/ only and never runs bsc plugins, so both are reported as uncertainty instead of being silently ignored.
// `extends` is followed (json files inside the project root only, no symlinks, depth capped); the child wins per key.
const fs = require('node:fs')
const path = require('node:path')
const census = require('../instrument/census')

// roku-deploy default entries (same set as lib/assess.js): a list made only of these matches the walked layout.
const DEFAULT_FILES = new Set(['source/**/*.*', 'components/**/*.*', 'images/**/*.*', 'locale/**/*', 'manifest'])
const MAX_EXTENDS = 5
const NAME_CAP = 120
const LIST_CAP = 10

// strict parse first, else the shared JSONC stripper (BOM, comments, trailing commas outside strings)
function parseLoose(s) {
  try { return JSON.parse(s) } catch (e) { /* jsonc */ }
  return JSON.parse(census.stripJsonc(s))
}

// echoed text comes from a project file: drop control characters, cap the length, never leave it empty
function clean(v, empty = '(unnamed)') {
  const s = String(v).replace(/[\x00-\x1f\x7f]/g, '')
  if (s === '') return empty
  return s.length > NAME_CAP ? `${s.slice(0, NAME_CAP)}…` : s
}
function list(a) { return a.slice(0, LIST_CAP).join(', ') + (a.length > LIST_CAP ? ', …' : '') }

function pluginName(p) {
  if (typeof p === 'string') return clean(p)
  if (p && typeof p === 'object' && !Array.isArray(p) && typeof p.name === 'string') return clean(p.name)
  if (p && typeof p === 'object' && !Array.isArray(p)) return '(unnamed plugin)'
  return '(non-string plugin)'
}
function fileEntry(g) {
  if (typeof g === 'string') return clean(g)
  if (g && typeof g === 'object' && !Array.isArray(g)) {
    const src = Array.isArray(g.src) ? g.src.filter((x) => typeof x === 'string').join('|') : typeof g.src === 'string' ? g.src : ''
    return `${clean(src, '(no src)')}=>${typeof g.dest === 'string' ? clean(g.dest, '') : ''}`
  }
  return '(non-string entry)'
}

const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }

// -> { file, plugins: [name], files: [entry], customFiles, rootDir, notes: [text] }, or { notRead: text } (file exists but
// cannot be used), or null (no bsconfig.json at the project root)
function readBsconfig(root) {
  const start = path.join(root, 'bsconfig.json')
  const got = census.safeRead(start)
  if (!got.buf) return got.refused === 'missing' ? null : { notRead: `refused (${got.refused})` }
  let j
  try { j = parseLoose(got.buf.toString('utf8')) } catch (e) { return { notRead: 'not valid JSON or JSONC' } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { notRead: 'not a JSON object' }

  const notes = []
  let realRoot = null
  try { realRoot = fs.realpathSync(root) } catch (e) { /* no extends then */ }
  // merged view: the first config in the chain (child first) that sets a key wins
  const merged = {}
  const take = (c) => { for (const k of ['plugins', 'files', 'rootDir']) if (merged[k] === undefined && c[k] !== undefined) merged[k] = c[k] }
  take(j)
  let cur = j
  let curFile = start
  for (let depth = 0; cur && typeof cur.extends === 'string' && cur.extends !== ''; depth++) {
    if (depth >= MAX_EXTENDS) { notes.push(`extends chain deeper than ${MAX_EXTENDS} not followed further`); break }
    const target = path.resolve(path.dirname(curFile), cur.extends)
    let ok = !!realRoot && /\.json$/i.test(target)
    if (ok) { try { ok = inside(realRoot, path.join(fs.realpathSync(path.dirname(target)), path.basename(target))) } catch (e) { ok = false } }
    const r = ok ? census.safeRead(target) : { refused: 'outside the project, not a json file or unresolved' }
    if (!r.buf) { notes.push('extends target not read (outside the project root, missing, symlink or unreadable), its plugins and files are unknown'); break }
    let parent
    try { parent = parseLoose(r.buf.toString('utf8')) } catch (e) { parent = null }
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) { notes.push('extends target not read (not a JSON object), its plugins and files are unknown'); break }
    take(parent)
    cur = parent
    curFile = target
  }

  const plugins = (Array.isArray(merged.plugins) ? merged.plugins : []).map(pluginName)
  const rawFiles = Array.isArray(merged.files) ? merged.files : []
  const files = rawFiles.map(fileEntry)
  const customFiles = rawFiles.some((g) => typeof g !== 'string' || !DEFAULT_FILES.has(g))
  return { file: 'bsconfig.json', plugins, files, customFiles, rootDir: typeof merged.rootDir === 'string' && merged.rootDir !== '' ? clean(merged.rootDir, '') : null, notes }
}

// -> [{ kind, at, detail }] for the graph's uncertainty list
function bsconfigUncertainty(root) {
  const b = readBsconfig(root)
  if (!b) return []
  if (b.notRead) return [{ kind: 'bsconfig-not-read', at: 'bsconfig.json', detail: `not read bsconfig.json: ${b.notRead}; its plugins and files list are unknown` }]
  const out = []
  for (const n of b.notes) out.push({ kind: 'bsconfig-not-read', at: b.file, detail: `not read: ${n}` })
  if (b.plugins.length) out.push({ kind: 'bsconfig-plugins', at: b.file, detail: `${b.plugins.length} bsc plugin${b.plugins.length === 1 ? '' : 's'} not run, generated code and components are missing from the graph: ${list(b.plugins)}` })
  if (b.customFiles) {
    const base = b.rootDir && b.rootDir !== '.' ? `source/ and components/ under the project root only (bsconfig rootDir ${JSON.stringify(b.rootDir)} is the effective base for the files list, not used by the graph)` : 'source/ and components/ only'
    out.push({ kind: 'bsconfig-files', at: b.file, detail: `files list not honoured, the graph walks ${base} (${b.files.length} entr${b.files.length === 1 ? 'y' : 'ies'}): ${list(b.files)}` })
  }
  return out
}

module.exports = { readBsconfig, bsconfigUncertainty, parseLoose }
