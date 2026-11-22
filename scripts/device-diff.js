#!/usr/bin/env node
'use strict'
// Cross-device diff (DEV2-04). Reads two saved JSON files (doctor --json or probe output) and prints one row
// per differing key. Read only: no device, no network. Exit 0 identical, 1 differences, 2 usage or read error.
// Keys that identify the device rather than describe it (host, serial) are skipped so two devices compare cleanly.
const fs = require('fs')

const IGNORE = new Set(['host', 'serial'])

function flatten(v, prefix, out) {
  if (Array.isArray(v)) {
    if (!v.length) out[prefix] = []
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out))
  } else if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length && prefix) out[prefix] = {}
    for (const k of keys) {
      if (!prefix && IGNORE.has(k)) continue
      flatten(v[k], prefix ? `${prefix}.${k}` : k, out)
    }
  } else out[prefix || '(root)'] = v
  return out
}

function diff(a, b) {
  const fa = flatten(a, '', {}), fb = flatten(b, '', {})
  const rows = []
  for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()) {
    const inA = k in fa, inB = k in fb
    if (inA && inB && JSON.stringify(fa[k]) === JSON.stringify(fb[k])) continue
    rows.push({ key: k, a: inA ? fa[k] : undefined, b: inB ? fb[k] : undefined })
  }
  return rows
}

function main(argv) {
  if (argv.length !== 2) { process.stderr.write('usage: node scripts/device-diff.js <a.json> <b.json>\n'); return 2 }
  let a, b
  try { a = JSON.parse(fs.readFileSync(argv[0], 'utf8')); b = JSON.parse(fs.readFileSync(argv[1], 'utf8')) }
  catch (e) { process.stderr.write(`device-diff: ${e.message}\n`); return 2 }
  const rows = diff(a, b)
  const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v))
  for (const r of rows) process.stdout.write(`${r.key}: ${show(r.a)} -> ${show(r.b)}\n`)
  return rows.length ? 1 : 0
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { diff, flatten, main }
