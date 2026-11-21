#!/usr/bin/env node
'use strict'
// Production dependency audit gate. Fails (exit 1) on any high or critical advisory that is not listed in ALLOWED below.
// Zero dependencies. `npm audit` has no ignore list, so this wraps `npm audit --omit=dev --json`.
//
//   node scripts/audit-gate.js            run npm audit and apply the gate
//
// Every entry in ALLOWED needs a reason and a review date. Remove an entry as soon as a patched, compatible version exists.

const { spawnSync } = require('child_process')

const ALLOWED = [
  {
    id: 'GHSA-vcc3-ghjq-m6fr',
    pkg: 'decode-uri-component',
    reason: 'DoS on malformed percent-encoded input, reached only through source-map resolution in brs-node > nanomatch > snapdragon > source-map-resolve. The only patched release (0.5.1) is ESM-only, so forcing it breaks the CommonJS caller (source-map-resolve calls require() as a function).',
    review: '2026-12-31',
  },
  {
    id: 'GHSA-qr28-fpjm-wq7f',
    pkg: 'decode-uri-component',
    reason: 'Same package and path as GHSA-vcc3-ghjq-m6fr (quadratic replacement of percent-encoded runs).',
    review: '2026-12-31',
  },
]

const FAIL_LEVELS = new Set(['high', 'critical'])

const advisoryId = (url) => (String(url || '').match(/GHSA-[a-z0-9-]+/i) || [])[0]

// Root advisories behind a vulnerability entry; a string `via` means "depends on that vulnerable package".
function roots(vulns, name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const v = vulns[name]
  if (!v) return []
  const out = []
  for (const via of v.via || []) {
    if (typeof via === 'string') out.push(...roots(vulns, via, seen))
    else out.push({ id: advisoryId(via.url) || String(via.source), pkg: via.name || name })
  }
  return out
}

// Returns { failing: [{pkg, severity, ids}], allowed: [{pkg, ids}] }.
function evaluate(report, allowed = ALLOWED) {
  const ok = new Set(allowed.map((a) => a.id))
  const vulns = (report && report.vulnerabilities) || {}
  const failing = []
  const allowedHits = []
  for (const [name, v] of Object.entries(vulns)) {
    if (!FAIL_LEVELS.has(v.severity)) continue
    const rs = roots(vulns, name)
    const unallowed = rs.filter((r) => !ok.has(r.id))
    if (rs.length && !unallowed.length) allowedHits.push({ pkg: name, ids: [...new Set(rs.map((r) => r.id))] })
    else failing.push({ pkg: name, severity: v.severity, ids: [...new Set((unallowed.length ? unallowed : rs).map((r) => r.id))] })
  }
  return { failing, allowed: allowedHits }
}

function main() {
  const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let report
  try { report = JSON.parse(r.stdout) } catch (e) {
    console.error('audit-gate: could not parse npm audit output', r.stderr || '')
    process.exit(2)
  }
  if (report.error) { console.error('audit-gate: npm audit failed:', report.error.summary || report.error.code); process.exit(2) }
  const { failing, allowed } = evaluate(report)
  for (const a of allowed) console.log(`allowed: ${a.pkg} (${a.ids.join(', ')}), see scripts/audit-gate.js`)
  if (failing.length) {
    for (const f of failing) console.error(`FAIL: ${f.pkg} [${f.severity}] ${f.ids.join(', ')}`)
    console.error('audit-gate: high/critical advisories in production dependencies that are not allowed')
    process.exit(1)
  }
  console.log('audit-gate: clean (high/critical, production dependencies)')
}

if (require.main === module) main()
module.exports = { evaluate, ALLOWED }
