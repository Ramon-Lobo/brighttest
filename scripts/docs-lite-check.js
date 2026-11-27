#!/usr/bin/env node
'use strict'
// Lite-tier docs gate (ADR 0061). Port of the planning tools coverage.mjs and readability.mjs to CommonJS.
// Usage: node scripts/docs-lite-check.js [--strict] [--json]     (exit 1 on any failure)
//
// Checks, for the docs/ tree of this repo:
//  1. Coverage: every fact token of a full page (section headings, CLI flags, commands, UPPER_SNAKE codes and env
//     vars, BT9xxx codes, dotted config keys and JSON keys, exit codes, numeric limits) appears in the lite page at
//     the same relative path under docs/lite/. A renamed heading counts as covered when the lite page has
//     `<!-- covers: <original heading> -->`. motivation.md and architecture.md are pointer pages: headings only.
//     Intentional omissions live in docs/.vitepress/lite-coverage-ignore.json
//     ({ "<page>": { "<token>": "<reason>" } }, page "*" = all pages); every entry needs a non-empty reason.
//  2. Twin mapping: a lite page with no full twin fails unless it is in LITE_ONLY below.
//  3. Full-only: a full page with no lite page fails unless it is in FULL_ONLY below.
//  4. Structure (always): each lite page has the At a glance box, a Related section and a Full guide line.
//     Lite-only pages have no full twin to point at, so they need the At a glance box only.
//  5. Prose (--strict, reported as warnings, never a failure): paragraphs over 4 lines and runs of more than
//     120 prose words between structural elements.
const fs = require('fs')
const path = require('path')
const { tierMap } = require('./docs-tiers.js')

// Lite pages that have no full twin by design (they keep their usual URL).
const LITE_ONLY = ['cheat-sheet.md', 'maintainer-pages.md']
// Full pages that have no lite page by design (maintainer-facing; they keep their usual URL).
const FULL_ONLY = ['changelog.md', 'contributing.md', 'decisions-summary.md', 'maintainers.md']
// Short pointer pages: headings only.
const POINTER = ['motivation.md', 'architecture.md']

const ACTIONS = {
  skills: ['install', 'update', 'export', 'list', 'uninstall'], instrument: ['build', 'verify', 'census'],
  e2e: ['run', 'inspect', 'record', 'lint', 'stamp'], net: ['convert', 'token'], features: ['graph', 'check', 'render'],
  device: ['status', 'watch', 'with', 'lock', 'renew', 'unlock', 'reset', 'hook', 'log'],
  builds: ['list', 'show', 'add', 'install', 'pin', 'unpin', 'edit', 'rm', 'prune'], issue: ['redact', 'check', 'collect'],
}
const SUB = new Set(['init', 'studio', 'assess', 'doctor', 'setup', 'mcp', 'devices', ...Object.keys(ACTIONS)])

const norm = (s) => s.toLowerCase().replace(/`/g, '').replace(/\{#[^}]*\}/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

// md, page -> Map(token -> kind)
function extract(md, page) {
  const t = new Map()
  const add = (k, v) => { v = v.trim(); if (v && !t.has(v)) t.set(v, k) }
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence) {
      const h = /^(##|###)\s+(.+?)\s*$/.exec(line)
      if (h) add('heading', h[2].replace(/\{#[^}]*\}/, '').trim())
    }
  }
  if (POINTER.includes(page)) return t
  for (const m of md.matchAll(/(?<![\w-])--[a-zA-Z][\w-]*(?:=any)?/g)) add('flag', m[0])
  for (const m of md.matchAll(/\bbrighttest ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*)?)/g)) {
    const [sub, act] = m[1].split(' ')
    if (!SUB.has(sub)) continue
    add('command', ACTIONS[sub] && ACTIONS[sub].includes(act) ? `brighttest ${sub} ${act}` : `brighttest ${sub}`)
  }
  for (const m of md.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) add('code', m[0])
  for (const m of md.matchAll(/\bBT9\d{3}\b/g)) add('code', m[0])
  for (const m of md.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_*]+)+)`/g)) {
    if (!/\.(md|json|js|ts|brs|bs|xml|yaml|yml|zip|har|html|txt|ndjson|log|png|mts|svelte|mdc|info)$/.test(m[1])) add('config', m[1])
  }
  for (const m of md.matchAll(/"([a-zA-Z][A-Za-z0-9]+)"\s*:/g)) add('config', m[1])
  for (const m of md.matchAll(/\bexit(?:s|ed)?(?: code| codes)?:?\s+\**`?(\d{1,3})\b/gi)) add('exit', m[1])
  for (const m of md.matchAll(/\b(\d+(?:\.\d+)?)\s?(ms|s|KB|MB|GB|kB|minutes?|seconds?|hours?|days?|%)(?![a-zA-Z])/g)) add('limit', `${m[1]} ${m[2]}`)
  for (const m of md.matchAll(/\b(\d+(?:\.\d+)?)(m|h)\b/g)) add('limit', `${m[1]}${m[2]}`)
  for (const m of md.matchAll(/\b(80|8060|8080|8085|8700|8790|870\d)\b/g)) add('limit', m[1])
  return t
}

function covered(tok, kind, lite, liteNorm, liteHeadingsNorm) {
  switch (kind) {
    case 'heading': {
      const n = norm(tok)
      return liteHeadingsNorm.has(n) || liteNorm.includes(`covers ${n}`) || liteNorm.includes(n)
    }
    case 'exit':
      return new RegExp(`exit[^\\n]{0,300}\\b${tok}\\b`, 'i').test(lite) ||
        new RegExp(`^\\|\\s*\\**\`?${tok}\`?\\**\\s*\\|`, 'm').test(lite) ||
        new RegExp(`\\b${tok}\\b[^\\n]{0,120}exit`, 'i').test(lite)
    case 'limit': {
      const m = /^(\d+(?:\.\d+)?)\s?(.*)$/.exec(tok)
      return new RegExp(`(?<![\\d.])${m[1].replace('.', '\\.')}(?![\\d])`).test(lite)
    }
    case 'command': return lite.includes(tok.replace(/^brighttest /, ''))
    default: return lite.includes(tok)
  }
}

// ignore: parsed ignore file -> list of problems (entries without a reason).
function ignoreProblems(ignore) {
  const out = []
  for (const [page, toks] of Object.entries(ignore || {})) {
    for (const [tok, why] of Object.entries(toks || {})) {
      if (typeof why !== 'string' || !why.trim()) out.push(`ignore entry ${page} / ${tok} has no reason`)
    }
  }
  return out
}

function structureIssues(md, liteOnly) {
  const issues = []
  if (!/::: info At a glance/.test(md)) issues.push('no "At a glance" box')
  if (!liteOnly) {
    if (!/^## Related/m.test(md)) issues.push('no "Related" section')
    if (!/\*\*Full guide:\*\*/.test(md)) issues.push('no "Full guide" line')
  }
  return issues
}

function proseWarnings(md) {
  const issues = []
  const lines = md.split('\n')
  let fence = false, para = [], run = 0, runStart = 0
  const flushPara = (n) => { if (para.length > 4) issues.push(`line ${n - para.length + 1}: paragraph of ${para.length} lines`); para = [] }
  const structural = (l) => /^\s*(#|\||[-*] |\d+\. |:::|<!--|```)/.test(l)
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; flushPara(i); run = 0; return }
    if (fence) return
    if (l.trim() === '') { flushPara(i); return }
    if (structural(l)) { flushPara(i); run = 0; return }
    if (/^\s{2,}\S/.test(l)) return
    if (run === 0) runStart = i + 1
    para.push(l)
    run += l.split(/\s+/).filter(Boolean).length
    if (run > 120) { issues.push(`line ${runStart}: ${run}+ prose words without a structural break`); run = -1e9 }
  })
  flushPara(lines.length)
  return issues
}

// opts: { docsDir, ignore, liteOnly, fullOnly, strict } -> { pages, tokens, failures, ignored, warnings, results }
function check(opts) {
  const docsDir = opts.docsDir
  const ignore = opts.ignore || {}
  const liteOnlyOk = new Set(opts.liteOnly || LITE_ONLY)
  const fullOnlyOk = new Set(opts.fullOnly || FULL_ONLY)
  const map = tierMap(docsDir)
  const failures = []
  const warnings = []
  const results = []
  for (const p of ignoreProblems(ignore)) failures.push({ page: '(ignore file)', kind: 'ignore', message: p })
  for (const r of map.liteOnly) {
    if (!liteOnlyOk.has(r)) failures.push({ page: `lite/${r}`, kind: 'twin', message: 'lite page has no full twin and is not in the lite-only allowlist' })
  }
  for (const r of map.fullOnly) {
    if (!fullOnlyOk.has(r)) failures.push({ page: r, kind: 'lite-missing', message: 'full page has no lite page and is not in the full-only list' })
  }
  for (const r of map.tiered) {
    const full = fs.readFileSync(path.join(docsDir, r), 'utf8')
    const lite = fs.readFileSync(path.join(docsDir, 'lite', r), 'utf8')
    const liteNorm = norm(lite)
    const liteHeadingsNorm = new Set([...lite.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => norm(m[1])))
    const toks = extract(full, r)
    const missing = []
    const ignored = []
    for (const [tok, kind] of toks) {
      if (covered(tok, kind, lite, liteNorm, liteHeadingsNorm)) continue
      const why = (ignore[r] && ignore[r][tok]) || (ignore['*'] && ignore['*'][tok])
      if (typeof why === 'string' && why.trim()) ignored.push({ tok, kind, why })
      else missing.push({ tok, kind })
    }
    for (const m of missing) failures.push({ page: r, kind: 'missing-token', message: `missing ${m.kind} ${m.tok}` })
    results.push({ page: r, tokens: toks.size, missing, ignored })
  }
  for (const r of [...map.tiered, ...map.liteOnly]) {
    const md = fs.readFileSync(path.join(docsDir, 'lite', r), 'utf8')
    for (const i of structureIssues(md, map.liteOnly.includes(r))) failures.push({ page: `lite/${r}`, kind: 'structure', message: i })
    if (opts.strict) for (const i of proseWarnings(md)) warnings.push({ page: `lite/${r}`, message: i })
  }
  const sum = (f) => results.reduce((a, x) => a + f(x), 0)
  return {
    pages: map.tiered.length, litePages: map.tiered.length + map.liteOnly.length,
    tokens: sum((x) => x.tokens), ignored: sum((x) => x.ignored.length),
    failures, warnings, results,
  }
}

function main(argv) {
  const root = path.resolve(__dirname, '..')
  const docsDir = path.join(root, 'docs')
  const ignoreFile = path.join(docsDir, '.vitepress', 'lite-coverage-ignore.json')
  const ignore = fs.existsSync(ignoreFile) ? JSON.parse(fs.readFileSync(ignoreFile, 'utf8')) : {}
  const res = check({ docsDir, ignore, strict: argv.includes('--strict') })
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2))
  else {
    for (const f of res.failures) console.log(`FAIL ${f.page}: ${f.message}`)
    for (const w of res.warnings) console.log(`warn ${w.page}: ${w.message}`)
    console.log(`${res.pages} tiered pages, ${res.litePages} lite pages, ${res.tokens} fact tokens, ${res.ignored} ignored, ` +
      `${res.failures.length} failures, ${res.warnings.length} prose warnings`)
  }
  return res.failures.length ? 1 : 0
}

module.exports = { extract, covered, check, structureIssues, proseWarnings, ignoreProblems, LITE_ONLY, FULL_ONLY, POINTER }
if (require.main === module) process.exit(main(process.argv.slice(2)))
