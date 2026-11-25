'use strict'
// bsconfig.json facts the feature graph cannot honour: `plugins` and a custom `files` list. The graph walks source/ and
// components/ only and never runs bsc plugins, so both are reported as uncertainty instead of being silently ignored.
const path = require('node:path')
const census = require('../instrument/census')

// roku-deploy default entries (same set as lib/assess.js): a list made only of these matches the walked layout.
const DEFAULT_FILES = new Set(['source/**/*.*', 'components/**/*.*', 'images/**/*.*', 'locale/**/*', 'manifest'])

function parseLoose(s) {
  try { return JSON.parse(s) } catch (e) { /* jsonc */ }
  const noComments = s.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'))
}

// -> { file, plugins: [name], files: [glob] } or null (no readable bsconfig.json at the project root)
function readBsconfig(root) {
  const got = census.safeRead(path.join(root, 'bsconfig.json'))
  if (!got.buf) return null
  let j
  try { j = parseLoose(got.buf.toString('utf8')) } catch (e) { return null }
  if (!j || typeof j !== 'object') return null
  const plugins = (Array.isArray(j.plugins) ? j.plugins : []).map((p) => (typeof p === 'string' ? p : (p && p.name) || String(p)))
  const files = (Array.isArray(j.files) ? j.files : [])
    .map((g) => (typeof g === 'string' ? g : g && typeof g === 'object' && typeof g.src === 'string' ? `${g.src}=>${typeof g.dest === 'string' ? g.dest : ''}` : null))
    .filter((g) => g !== null)
  return { file: 'bsconfig.json', plugins, files }
}

// -> [{ kind, at, detail }] for the graph's uncertainty list
function bsconfigUncertainty(root) {
  const b = readBsconfig(root)
  if (!b) return []
  const out = []
  if (b.plugins.length) out.push({ kind: 'bsconfig-plugins', at: b.file, detail: `${b.plugins.length} bsc plugin${b.plugins.length === 1 ? '' : 's'} not run, generated code and components are missing from the graph: ${b.plugins.join(', ')}` })
  const custom = b.files.length && !b.files.every((g) => DEFAULT_FILES.has(g))
  if (custom) out.push({ kind: 'bsconfig-files', at: b.file, detail: `files list not honoured, the graph walks source/ and components/ only (${b.files.length} entr${b.files.length === 1 ? 'y' : 'ies'}): ${b.files.slice(0, 10).join(', ')}${b.files.length > 10 ? ', ...' : ''}` })
  return out
}

module.exports = { readBsconfig, bsconfigUncertainty }
