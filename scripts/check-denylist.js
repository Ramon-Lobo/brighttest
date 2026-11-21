#!/usr/bin/env node
'use strict'
// Deny-list guard (CLN-02). Zero dependencies. The term list lives OUTSIDE the repository:
// $BRIGHTTEST_DENYLIST (a file path) or ~/.brighttest/denylist.txt. Terms are never printed;
// hits are reported as file:line with the term masked.
//
//   node scripts/check-denylist.js                 scan tracked files (cwd's git repo)
//   node scripts/check-denylist.js --staged        scan added lines of the staged diff
//   node scripts/check-denylist.js --range A..B    scan commit messages + added lines of a push range
//   node scripts/check-denylist.js --path P [P..]  scan files/directories (positional args also work)
//   --json                machine-readable result on stdout
//   --allow-missing       exit 0 (with a warning) when no deny-list is configured
//
// Exit codes: 0 clean, 1 hits found, 2 usage/configuration error (fails closed).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const MAX_BUFFER = 1024 * 1024 * 1024

function parseArgs(argv) {
  const o = { mode: 'tracked', range: null, paths: [], json: false, allowMissing: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--staged') o.mode = 'staged'
    else if (a === '--range') { o.mode = 'range'; o.range = argv[++i] }
    else if (a.startsWith('--range=')) { o.mode = 'range'; o.range = a.slice(8) }
    else if (a === '--path') { o.mode = 'path'; o.paths.push(argv[++i]) }
    else if (a === '--json') o.json = true
    else if (a === '--allow-missing') o.allowMissing = true
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`)
    else { o.mode = 'path'; o.paths.push(a) }
  }
  if (o.mode === 'range' && !o.range) throw new Error('--range needs a git range, e.g. origin/main..HEAD')
  if (o.mode === 'path' && o.paths.some((p) => !p)) throw new Error('--path needs a path')
  return o
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().split('\n')[0]}`)
  return r.stdout
}

function isTrackedByGit(file) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], {
    cwd: path.dirname(file), encoding: 'utf8',
  })
  return r.status === 0
}

// Returns { file } or throws { exit:2, message }.
function locateList(env, allowMissing) {
  const file = env.BRIGHTTEST_DENYLIST || path.join(os.homedir(), '.brighttest', 'denylist.txt')
  if (!fs.existsSync(file)) {
    if (allowMissing) return null
    throw Object.assign(new Error('deny-list not configured: set BRIGHTTEST_DENYLIST to a file outside the repository (or create ~/.brighttest/denylist.txt)'), { exit: 2 })
  }
  if (isTrackedByGit(path.resolve(file))) {
    throw Object.assign(new Error('deny-list must live outside the repository (the given file is tracked by git)'), { exit: 2 })
  }
  const terms = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  if (!terms.length) throw Object.assign(new Error('deny-list is empty'), { exit: 2 })
  return terms
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function mask(term) {
  if (term.length <= 2) return '*'.repeat(term.length)
  return term[0] + '*'.repeat(term.length - 2) + term[term.length - 1]
}

function buildMatchers(terms) {
  return terms.map((t) => ({
    masked: mask(t),
    // word-ish: not embedded in a longer alphanumeric run
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(t).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'gi'),
  }))
}

// Long base64/hex-looking tokens (integrity hashes, ids): hits inside them are not real mentions.
const HASHY = /[A-Za-z0-9+/=_-]{40,}/g
function hashRanges(line) {
  const out = []
  for (const m of line.matchAll(HASHY)) {
    const t = m[0]
    if (/\d/.test(t) || (/[A-Z]/.test(t) && /[a-z]/.test(t))) out.push([m.index, m.index + t.length])
  }
  return out
}

// -> { hits: [masked...], ignored: n } for one line of text
function scanLine(line, matchers) {
  let ranges = null
  const hits = []
  let ignored = 0
  for (const m of matchers) {
    m.re.lastIndex = 0
    for (const x of line.matchAll(m.re)) {
      ranges = ranges || hashRanges(line)
      if (ranges.some(([a, b]) => x.index >= a && x.index < b)) ignored++
      else hits.push(m.masked)
    }
  }
  return { hits, ignored }
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0)
}

class Result {
  constructor() { this.hits = []; this.ignored = []; this.skipped = [] }
  line(kind, file, line, commit, text, matchers) {
    const r = scanLine(text, matchers)
    for (const masked of r.hits) this.hits.push({ kind, file, line, commit, masked })
    if (r.ignored) this.ignored.push({ file, line, reason: 'hash-like' })
  }
}

function scanText(res, kind, file, text, matchers, commit = null) {
  text.split(/\r?\n/).forEach((l, i) => res.line(kind, file, i + 1, commit, l, matchers))
}

function scanFile(res, abs, label, matchers) {
  let buf
  try { buf = fs.readFileSync(abs) } catch { res.skipped.push(label); return }
  if (isBinary(buf)) { res.skipped.push(label); return }
  scanText(res, 'file', label, buf.toString('utf8'), matchers)
}

function walkPath(p, out) {
  const st = fs.lstatSync(p)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) if (n !== '.git') walkPath(path.join(p, n), out)
  } else out.push(p)
}

// Added lines of a unified diff (-U0), tagged with new-file line numbers.
function scanDiff(res, diff, matchers, commit) {
  let file = null
  let n = 0
  let cur = commit
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('\x01')) { cur = raw.slice(1).trim(); file = null; continue }
    if (raw.startsWith('diff --git')) { file = null; continue }
    if (raw.startsWith('+++ ')) { file = raw.startsWith('+++ b/') ? raw.slice(6) : null; continue }
    if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
      if (file) res.skipped.push(file)
      continue
    }
    const h = /^@@ -\S+ \+(\d+)/.exec(raw)
    if (h) { n = Number(h[1]); continue }
    if (file && raw.startsWith('+') && !raw.startsWith('+++')) {
      res.line('diff', file, n, cur ? cur.slice(0, 10) : null, raw.slice(1), matchers)
      n++
    }
  }
}

function run(opts, env = process.env, cwd = process.cwd()) {
  const terms = locateList(env, opts.allowMissing)
  if (terms === null) {
    return { exit: 0, result: { ok: true, mode: opts.mode, termsLoaded: 0, hits: [], ignored: [], skipped: [], warning: 'deny-list not configured (--allow-missing): nothing scanned' } }
  }
  const matchers = buildMatchers(terms)
  const res = new Result()

  if (opts.mode === 'tracked') {
    const root = git(['rev-parse', '--show-toplevel'], cwd).trim()
    for (const f of git(['ls-files', '-z'], cwd).split('\0').filter(Boolean)) {
      scanFile(res, path.join(root, f), f, matchers)
    }
  } else if (opts.mode === 'staged') {
    scanDiff(res, git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'], cwd), matchers, null)
  } else if (opts.mode === 'range') {
    const msgs = git(['log', '--format=%H%x00%B%x01', opts.range], cwd)
    for (const rec of msgs.split('\x01')) {
      const i = rec.indexOf('\0')
      if (i < 0) continue
      const hash = rec.slice(0, i).trim().slice(0, 10)
      rec.slice(i + 1).split(/\r?\n/).forEach((l, k) => res.line('message', null, k + 1, hash, l, matchers))
    }
    scanDiff(res, git(['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=%x01%H', opts.range], cwd), matchers, null)
  } else {
    for (const p of opts.paths) {
      const abs = path.resolve(cwd, p)
      if (!fs.existsSync(abs)) throw Object.assign(new Error(`path not found: ${p}`), { exit: 2 })
      const files = []
      walkPath(abs, files)
      for (const f of files) scanFile(res, f, path.relative(cwd, f) || f, matchers)
    }
  }
  res.skipped = [...new Set(res.skipped)]
  return {
    exit: res.hits.length ? 1 : 0,
    result: { ok: !res.hits.length, mode: opts.mode, termsLoaded: terms.length, hits: res.hits, ignored: res.ignored, skipped: res.skipped },
  }
}

function format(result) {
  const lines = []
  for (const h of result.hits) {
    const where = h.kind === 'message' ? `${h.commit}:message:${h.line}` : `${h.commit ? h.commit + ':' : ''}${h.file}:${h.line}`
    lines.push(`${where}  ${h.kind}  ${h.masked}`)
  }
  if (result.warning) lines.push(`warning: ${result.warning}`)
  if (result.skipped.length) lines.push(`skipped (binary/unreadable): ${result.skipped.length}`)
  if (result.ignored.length) lines.push(`ignored (hash-like): ${result.ignored.length}`)
  lines.push(result.ok
    ? `deny-list check (${result.mode}): clean (${result.termsLoaded} terms)`
    : `deny-list check (${result.mode}): ${result.hits.length} hit(s) (${result.termsLoaded} terms)`)
  return lines.join('\n')
}

function main(argv) {
  let opts
  try { opts = parseArgs(argv) } catch (e) { console.error(`check-denylist: ${e.message}`); return 2 }
  try {
    const { exit, result } = run(opts)
    if (opts.json) console.log(JSON.stringify(result, null, 2))
    else console.log(format(result))
    return exit
  } catch (e) {
    console.error(`check-denylist: ${e.message}`)
    return e.exit || 2
  }
}

module.exports = { parseArgs, run, format, mask, scanLine, buildMatchers }

if (require.main === module) process.exit(main(process.argv.slice(2)))
