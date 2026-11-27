'use strict'
// Inspects an untrusted package held in memory (ADR 0053 decisions 3 and 4). No extraction: only `manifest` and the
// marker-carrying text entries (.brs, .bs, .xml) are inflated, each under a cap. The kind uses verify.js's own marker
// rules (entryMarkers), so "instrumented" means the same here as in `instrument verify`.
//
// inspectPackage(buf, caps?) -> Promise<{ sha256, size, manifest, kind, markerCount, markerKinds, tokenOf }>
//   kind: 'instrumented' (any marker) | 'unknown' (no marker found but the text budget was hit) | 'store'.
//   tokenOf() returns the BT_config token (or null) for an in-memory comparison; it is non-enumerable, never serialized.
// Throws ZipError (BUILD_INVALID_ZIP, BUILD_UNSAFE_ZIP) or BUILD_NO_MANIFEST.
const crypto = require('node:crypto')
const { readCentralDirectory, inflateEntry, ZipError } = require('./zipinfo')
const { entryMarkers } = require('../instrument/verify')

const KB = 1024
const MB = 1024 * KB
const DEFAULT_CAPS = Object.freeze({
  manifestBytes: 64 * KB,
  textEntryBytes: 4 * MB,
  textTotalBytes: 64 * MB,
})
const TEXT_EXT = /\.(brs|bs|xml)$/i
const BT_CONFIG = 'source/bt/BT_config.brs'
const TOKEN_RE = /token\s*:\s*"([0-9a-f]{32})"/

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function parseManifest(text) {
  const kv = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^=#\s][^=]*?)\s*=(.*)$/.exec(line)
    if (m) kv[m[1].toLowerCase()] = m[2].trim()
  }
  const num = (k) => (/^\d+$/.test(kv[k] || '') ? Number(kv[k]) : null)
  const major = num('major_version')
  const minor = num('minor_version')
  const build = num('build_version')
  const parts = [major, minor, build]
  const version = major == null && minor == null && build == null ? null : parts.map((x) => (x == null ? 0 : x)).join('.')
  return { title: kv.title || null, major, minor, build, version }
}

async function inspectPackage(buf, caps) {
  const c = Object.assign({}, DEFAULT_CAPS, caps || {})
  const { entries } = readCentralDirectory(buf, c)
  const files = entries.filter((e) => !e.dir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const manifestEntry = files.find((e) => e.name === 'manifest')
  if (!manifestEntry) throw new ZipError('BUILD_NO_MANIFEST', 'no manifest at the top of the zip')
  if (manifestEntry.usize > c.manifestBytes) throw new ZipError('BUILD_UNSAFE_ZIP', `manifest over ${c.manifestBytes / KB} KB`)
  const manifest = parseManifest(inflateEntry(buf, manifestEntry, c.manifestBytes).toString('utf8'))

  const markers = []
  let budgetHit = false
  let spent = 0
  for (const e of files) {
    const read = () => {
      if (e.name === 'manifest') return inflateEntry(buf, e, c.manifestBytes).toString('utf8')
      if (e.usize > c.textEntryBytes || spent + e.usize > c.textTotalBytes) { budgetHit = true; return '' }
      spent += e.usize
      return inflateEntry(buf, e, c.textEntryBytes).toString('utf8')
    }
    markers.push(...await entryMarkers(e.name, read))
  }
  const markerKinds = [...new Set(markers.map((m) => m.kind))].sort()
  const kind = markers.length ? 'instrumented' : budgetHit ? 'unknown' : 'store'

  const out = { sha256: sha256Hex(buf), size: buf.length, manifest, kind, markerCount: markers.length, markerKinds }
  Object.defineProperty(out, 'tokenOf', {
    enumerable: false,
    value() {
      const e = files.find((f) => f.name === BT_CONFIG)
      if (!e || e.usize > c.textEntryBytes) return null
      const m = TOKEN_RE.exec(inflateEntry(buf, e, c.textEntryBytes).toString('utf8'))
      return m ? m[1] : null
    },
  })
  return out
}

module.exports = { inspectPackage, sha256Hex, DEFAULT_CAPS }
