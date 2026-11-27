'use strict'
// brighttest instrument verify (INS-F-T3): the release gate. Reads a built package (zip or directory) and reports
// every brighttest instrumentation marker it contains. Contract: ADR 0019 decision 5.
//
// verify(pathToZipOrDir) -> Promise<{ exitCode: 0|3, result: 'clean'|'instrumented', markers: [{ kind, path, detail? }] }>
//   exitCode 3 / result 'instrumented': at least one marker; exitCode 0 / 'clean': none.
//   Rejects (Error, code BT_VERIFY_*) on a missing, unreadable or corrupt input; never resolves with another code.
//
// Markers (kinds): manifest-key (`bt_instrumented`), bs-const (`BT_AGENT=true` token in `bs_const`),
// runtime-file (any file under source/bt/** or components/bt/**), component-xml (`BT_Agent` in a component XML),
// string (`__bt_agent` or `__bt_boot` in a .brs/.bs/.xml file). `BT_AGENT=false` and the greenfield libraries
// (BTHttp, BTStore) are not markers. The plugin must only write markers listed here: a new plugin marker needs a
// change in this file in the same PR. Path constants come from plugin.js, never redeclared.
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const { RUNTIME_PKG, MARKER_KEY, BS_CONST_FLAG } = require('./plugin')

const EXIT_CLEAN = 0
const EXIT_INSTRUMENTED = 3
const RUNTIME_DIRS = Object.freeze([
  path.posix.dirname(RUNTIME_PKG) + '/', // source/bt/
  'components/bt/',
])
const STRINGS = Object.freeze(['__bt_agent', '__bt_boot'])
const COMPONENT_MARKER = 'BT_Agent'
const TEXT_EXT = /\.(brs|bs|xml)$/i

const lc = (s) => String(s).toLowerCase()
const fail = (code, msg) => Object.assign(new Error(msg), { code })

// Manifest checks: key `bt_instrumented` (any value), and `BT_AGENT=true` among the `bs_const` entries.
function manifestMarkers(text, pkgPath) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([^=#\s][^=]*?)\s*=(.*)$/.exec(line)
    if (!m) continue
    const key = lc(m[1])
    if (key === MARKER_KEY) out.push({ kind: 'manifest-key', path: pkgPath, detail: MARKER_KEY })
    if (key === 'bs_const') {
      for (const e of m[2].split(';')) {
        const [name, ...rest] = e.split('=')
        if (lc(name.trim()) === lc(BS_CONST_FLAG) && lc(rest.join('=').trim()) === 'true') {
          out.push({ kind: 'bs-const', path: pkgPath, detail: `${BS_CONST_FLAG}=true` })
        }
      }
    }
  }
  return out
}

// All markers of one package entry. `read()` is called lazily, only for files whose content can carry a marker.
async function entryMarkers(pkgPath, read) {
  const out = []
  const lower = lc(pkgPath)
  if (RUNTIME_DIRS.some((d) => lower.startsWith(d))) out.push({ kind: 'runtime-file', path: pkgPath })
  if (lower === 'manifest') out.push(...manifestMarkers(await read(), pkgPath))
  else if (TEXT_EXT.test(lower)) {
    const text = String(await read())
    for (const s of STRINGS) if (lc(text).includes(s)) out.push({ kind: 'string', path: pkgPath, detail: s })
    if (lower.endsWith('.xml') && text.includes(COMPONENT_MARKER)) out.push({ kind: 'component-xml', path: pkgPath, detail: COMPONENT_MARKER })
  }
  return out
}

function walkDir(root, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walkDir(root, r, out)
    else if (e.isFile()) out.push(r)
  }
  return out
}

const normalize = (p) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '')

async function verify(target) {
  if (typeof target !== 'string' || !target) throw fail('BT_VERIFY_INPUT', 'verify: a path to a zip or directory is required')
  let stat
  try { stat = fs.statSync(target) } catch (e) { throw fail('BT_VERIFY_MISSING', `verify: ${target} does not exist`) }
  const markers = []
  if (stat.isDirectory()) {
    for (const rel of walkDir(target).sort()) {
      markers.push(...await entryMarkers(normalize(rel), () => fs.readFileSync(path.join(target, rel), 'utf8')))
    }
  } else {
    let zip
    try { zip = await JSZip.loadAsync(fs.readFileSync(target)) } catch (e) {
      throw fail('BT_VERIFY_CORRUPT', `verify: ${target} is not a readable zip: ${e.message}`)
    }
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort()
    for (const name of names) {
      markers.push(...await entryMarkers(normalize(name), () => zip.files[name].async('string')))
    }
  }
  const exitCode = markers.length ? EXIT_INSTRUMENTED : EXIT_CLEAN
  return { exitCode, result: markers.length ? 'instrumented' : 'clean', markers }
}

module.exports = { verify, entryMarkers, EXIT_CLEAN, EXIT_INSTRUMENTED, RUNTIME_DIRS, STRINGS, COMPONENT_MARKER }
