#!/usr/bin/env node
'use strict'
// Multi-version docs site build.
//
//   node scripts/docs-site.js plan  [--tags v0.7.0,v0.6.0]
//   node scripts/docs-site.js build --out <dir> [--only <version|next>] [--base-prefix /brighttest/]
//                                   [--keep-temp] [--dry-run]
//
// The site is rebuilt from git on every run: `main` at <base>next/, the latest release tag at <base> (and
// again at its own <base>vX.Y/), and every other kept minor (its highest patch tag) at <base>vX.Y/.
// Selection comes from `v*.*.*` tags filtered by docs/.vitepress/versions.config.json.
//
// Every version is built by VitePress into its OWN temporary directory (`vitepress build --outDir X` empties X),
// then copied into --out, root first. versions.json is written last. Temporary git worktrees live under
// os.tmpdir() and are removed on success, error and SIGINT/SIGTERM. Nothing is written inside the repo
// working tree except --out. CI must check out with full history (fetch-depth 0): lastUpdated needs it.
//
// The theme overlay (docs/.vitepress/theme) is copied from the CHECKED-OUT WORKING TREE of --repo, not from
// `main`: uncommitted theme edits are what old tags get. Run it from a clean checkout of main in CI.
// POSIX only (signal handling and the fixture tests assume it). Env: BRIGHTTEST_DOCS_BASE overrides the base
// prefix (otherwise read from docs/.vitepress/config.mts, then /brighttest/); --base-prefix beats both.
//
// Testing hooks: --repo <dir>, --next-ref <ref>, --no-install, --vitepress-bin <path>.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const DEFAULT_BASE = '/brighttest/'

// ---------- pure helpers ----------

function parseTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim())
  return m ? { tag: String(tag).trim(), major: +m[1], minor: +m[2], patch: +m[3], id: `${m[1]}.${m[2]}` } : null
}

function parseMinor(s) {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(s).trim())
  return m ? { major: +m[1], minor: +m[2], id: `${m[1]}.${m[2]}` } : null
}

function cmpMinor(a, b) {
  return a.major - b.major || a.minor - b.minor
}

function normBase(p) {
  let b = String(p || DEFAULT_BASE).trim()
  if (!b.startsWith('/')) b = '/' + b
  if (!b.endsWith('/')) b += '/'
  return b
}

// tags + config -> plan. Prereleases and non-semver tags are ignored.
function plan(tags, config = {}, basePrefix = DEFAULT_BASE) {
  const base = normBase(basePrefix)
  const bad = (field, value) => new Error(`invalid versions.config.json ${field}: ${JSON.stringify(value)}`)
  let floor = null
  if (config.floor !== undefined && config.floor !== null && config.floor !== '') {
    floor = parseMinor(config.floor)
    if (!floor) throw bad('floor', config.floor)
  }
  if (config.exclude !== undefined && !Array.isArray(config.exclude)) throw bad('exclude', config.exclude)
  const exclude = new Set()
  for (const e of config.exclude || []) {
    const m = parseMinor(e)
    if (!m) throw bad('exclude', e)
    exclude.add(m.id)
  }
  let keep = Infinity
  if (config.keep !== undefined && config.keep !== null) {
    if (!Number.isInteger(config.keep) || config.keep < 1) throw bad('keep', config.keep)
    keep = config.keep
  }

  const bestByMinor = new Map()
  for (const t of tags) {
    const p = parseTag(t)
    if (!p) continue
    const cur = bestByMinor.get(p.id)
    if (!cur || p.patch > cur.patch) bestByMinor.set(p.id, p)
  }
  let minors = [...bestByMinor.values()]
    .filter((p) => !floor || cmpMinor(p, floor) >= 0)
    .filter((p) => !exclude.has(p.id))
    .sort((a, b) => cmpMinor(b, a))
    .slice(0, keep)

  const releases = minors.map((p, i) => ({
    id: p.id,
    tag: p.tag,
    path: i === 0 ? base : `${base}v${p.id}/`,
    alias: i === 0 ? `${base}v${p.id}/` : undefined,
    latest: i === 0,
  }))

  const builds = []
  builds.push({ id: 'next', ref: 'main', base: `${base}next/`, rel: 'next', channel: 'next' })
  for (const r of releases) {
    if (r.latest) builds.push({ id: r.id, tag: r.tag, base, rel: '', channel: 'release', latest: true })
    builds.push({ id: r.id, tag: r.tag, base: `${base}v${r.id}/`, rel: `v${r.id}`, channel: 'release', latest: r.latest })
  }
  return {
    schema: 1,
    basePrefix: base,
    config: { floor: config.floor, exclude: config.exclude || [], keep: config.keep },
    latest: releases[0] ? releases[0].id : null,
    next: { ref: 'main', path: `${base}next/` },
    releases,
    builds: orderBuilds(builds),
  }
}

// Root (rel '') first so later copies are layered on top of it, then the rest by path.
function orderBuilds(builds) {
  return [...builds].sort((a, b) => (a.rel === '') === (b.rel === '') ? a.rel.localeCompare(b.rel) : a.rel === '' ? -1 : 1)
}

// First line only, temp paths scrubbed: versions.json is published.
function shortReason(err) {
  return String(err || '').split('\n')[0].replace(/\S*docs-site-\S*/g, '<tmp>').trim()
}

function versionsJson(p, results, { generated, nextSha } = {}) {
  const ok = (id, rel) => results.some((r) => r.ok && r.build.id === id && r.build.rel === rel)
  const versions = []
  if (ok('next', 'next')) {
    versions.push({ id: 'next', label: 'next (unreleased)', path: p.next.path, ref: 'main', ...(nextSha ? { sha: nextSha } : {}) })
  }
  for (const r of p.releases) {
    if (r.latest) {
      if (ok(r.id, '') && ok(r.id, `v${r.id}`)) {
        versions.push({ id: r.id, label: `v${r.id} (latest)`, path: r.path, alias: r.alias, tag: r.tag })
      }
    } else if (ok(r.id, `v${r.id}`)) {
      versions.push({ id: r.id, label: `v${r.id}`, path: r.path, tag: r.tag })
    }
  }
  const skipped = []
  for (const res of results) {
    if (res.ok) continue
    const id = res.build.id
    if (!skipped.some((s) => s.id === id)) skipped.push({ id, ref: res.build.tag || res.build.ref, reason: shortReason(res.error) })
  }
  return {
    schema: 1,
    generated: generated || new Date().toISOString(),
    latest: p.latest,
    versions,
    skipped,
  }
}

// Group builds per ref so one worktree + install serves a version built at several paths.
function groupByRef(builds) {
  const groups = new Map()
  for (const b of builds) {
    const key = b.tag || b.ref
    if (!groups.has(key)) groups.set(key, { key, tag: b.tag, ref: b.ref, id: b.id, builds: [] })
    groups.get(key).builds.push(b)
  }
  return [...groups.values()]
}

// Builds always go to a per-build temp dir, never into the output tree.
function buildArgs(build, outDir) {
  return ['build', 'docs', '--base', build.base, '--outDir', outDir]
}

function fatalFailures(p, results) {
  return results.filter((r) => !r.ok && (r.build.id === 'next' || r.build.id === p.latest))
}

// Layer built dirs into `out`, root first. Refuses to overwrite a path another build placed.
function assemble(out, items) {
  fs.mkdirSync(out, { recursive: true })
  const rank = new Map(orderBuilds(items.map((i) => i.build)).map((b, i) => [b, i]))
  const ordered = [...items].sort((a, b) => rank.get(a.build) - rank.get(b.build))
  for (const it of ordered) {
    const rel = it.build.rel
    const dest = rel ? path.join(out, rel) : out
    if (rel && fs.existsSync(dest)) throw new Error(`refusing to overwrite ${dest}`)
    fs.cpSync(it.dir, dest, { recursive: true })
  }
}

function summaryMarkdown(p, results) {
  const lines = ['## Docs site build plan', '', `Latest release: ${p.latest ? 'v' + p.latest : '(none)'}`, '', '| Version | Source | Path | Status |', '|---|---|---|---|']
  for (const b of p.builds) {
    const r = results && results.find((x) => x.build === b)
    const status = !results ? 'planned' : r ? (r.ok ? `built (${r.seconds}s)` : `FAILED: ${String(r.error).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')}`) : 'not run'
    lines.push(`| ${b.id}${b.latest ? ' (latest)' : ''} | ${b.tag || b.ref} | \`${b.base}\` | ${status} |`)
  }
  return lines.join('\n') + '\n'
}

// ---------- process helpers ----------

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`)
  return r.stdout.trim()
}

let activeChild = null

// Kill the running child (if any) and wait briefly for it to close.
function killActive() {
  const c = activeChild
  if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const hard = setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 2000)
    const done = setTimeout(resolve, 3000)
    c.once('close', () => { clearTimeout(hard); clearTimeout(done); resolve() })
    try { c.kill('SIGTERM') } catch { resolve() }
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    activeChild = child
    let tail = ''
    const keep = (d) => { tail = (tail + d).slice(-4000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (e) => resolve({ ok: false, output: String(e.message) }))
    child.on('close', (code) => resolve({ ok: code === 0, output: tail.trim() }))
  })
}

function readConfig(repo) {
  const f = path.join(repo, 'docs', '.vitepress', 'versions.config.json')
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

function defaultBase(repo, env = process.env) {
  if (env.BRIGHTTEST_DOCS_BASE) return env.BRIGHTTEST_DOCS_BASE
  try {
    const src = fs.readFileSync(path.join(repo, 'docs', '.vitepress', 'config.mts'), 'utf8')
    const m = /^\s*base:\s*['"]([^'"]+)['"]/m.exec(src)
    if (m) return m[1]
  } catch {}
  return DEFAULT_BASE
}

function parseArgs(argv) {
  const o = { _: [] }
  const withVal = new Set(['out', 'only', 'base-prefix', 'tags', 'repo', 'next-ref', 'vitepress-bin'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const k = a.slice(2)
    if (withVal.has(k)) {
      if (i + 1 >= argv.length) throw new Error(`--${k} needs a value`)
      o[k] = argv[++i]
    } else o[k] = true
  }
  return o
}

function listTags(repo, override) {
  if (override) return override.split(',').map((s) => s.trim()).filter(Boolean)
  return git(repo, ['tag', '--list', 'v*']).split('\n').filter(Boolean)
}

function say(msg) { process.stderr.write(msg + '\n') }

function resolveNextRef(repo, explicit) {
  let ref = null
  if (explicit) {
    if (String(explicit).startsWith('-')) throw new Error(`invalid --next-ref: ${explicit}`)
    ref = explicit
  } else {
    for (const r of ['origin/main', 'main', 'HEAD']) {
      if (spawnSync('git', ['rev-parse', '--verify', '--quiet', r], { cwd: repo }).status === 0) { ref = r; break }
    }
  }
  ref = ref || 'HEAD'
  say(`next: building ${ref}`)
  return ref
}

// ---------- commands ----------

function cmdPlan(o) {
  const repo = path.resolve(o.repo || path.join(__dirname, '..'))
  const p = plan(listTags(repo, o.tags), readConfig(repo), o['base-prefix'] || defaultBase(repo))
  process.stdout.write(JSON.stringify(p, null, 2) + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(p))
  return 0
}

async function cmdBuild(o) {
  if (!o.out) throw new Error('build needs --out <dir>')
  const repo = path.resolve(o.repo || path.join(__dirname, '..'))
  const out = path.resolve(o.out)
  const p = plan(listTags(repo, o.tags), readConfig(repo), o['base-prefix'] || defaultBase(repo))
  const nextRef = resolveNextRef(repo, o['next-ref'])

  let builds = p.builds
  if (o.only) {
    const want = String(o.only).replace(/^v/, '')
    builds = builds.filter((b) => b.id === want)
    if (!builds.length) throw new Error(`--only ${o.only}: not in the plan`)
  }
  if (!p.latest && !o.only) throw new Error('no release tags match the config; refusing to publish without a latest release')

  if (spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo, encoding: 'utf8' }).stdout.trim() === 'true') {
    say('warning: shallow clone; lastUpdated dates will be wrong and tags may be missing. Use fetch-depth 0 in CI.')
  }
  const themeSrc = path.join(repo, 'docs', '.vitepress', 'theme')
  const haveOverlay = fs.existsSync(themeSrc)
  if (!haveOverlay) say(`warning: no theme overlay at ${themeSrc}; old tags build with the default theme`)

  if (o['dry-run']) {
    for (const g of groupByRef(builds)) {
      say(`worktree ${g.tag ? 'refs/tags/' + g.tag : nextRef} (tmp)`)
      for (const b of g.builds) say(`  vitepress ${buildArgs(b, '<tmp>/' + (b.rel || 'root')).join(' ')}  [BRIGHTTEST_DOCS_CHANNEL=${b.channel}]`)
    }
    process.stdout.write(JSON.stringify({ ...p, builds }, null, 2) + '\n')
    return 0
  }

  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`--out ${out} is not empty`)

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-'))
  const worktrees = []
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const w of worktrees) spawnSync('git', ['worktree', 'remove', '--force', w], { cwd: repo })
    spawnSync('git', ['worktree', 'prune'], { cwd: repo })
    if (!o['keep-temp']) fs.rmSync(tmpRoot, { recursive: true, force: true })
    else say(`kept temp dir ${tmpRoot}`)
  }
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => { killActive().then(() => { cleanup(); process.exit(code) }) })
  }

  const results = []
  let nextSha
  try {
    for (const g of groupByRef(builds)) {
      const wt = path.join(tmpRoot, 'wt-' + (g.tag || 'next'))
      const ref = g.tag ? `refs/tags/${g.tag}` : nextRef
      const fail = (error) => { for (const b of g.builds) results.push({ build: b, ok: false, error }); say(`FAILED ${g.key}: ${error}`) }
      const added = spawnSync('git', ['worktree', 'add', '--detach', wt, ref], { cwd: repo, encoding: 'utf8' })
      if (added.status !== 0) { fail(`git worktree add failed: ${(added.stderr || '').trim()}`); continue }
      worktrees.push(wt)
      if (!g.tag) { try { nextSha = git(repo, ['rev-parse', '--short', ref]) } catch {} }

      if (g.tag && haveOverlay && !fs.existsSync(path.join(wt, 'docs', '.vitepress', 'theme'))) {
        fs.cpSync(themeSrc, path.join(wt, 'docs', '.vitepress', 'theme'), { recursive: true })
        say(`overlaid theme on ${g.tag}`)
      }
      if (!o['no-install']) {
        const t0 = Date.now()
        const inst = await run('npm', g.tag ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['ci', '--no-audit', '--no-fund'], { cwd: wt })
        if (!inst.ok) { fail(`npm ci failed: ${inst.output.split('\n').slice(-3).join(' | ')}`); continue }
        say(`installed ${g.key} in ${Math.round((Date.now() - t0) / 1000)}s`)
      }
      const bin = o['vitepress-bin'] ? path.resolve(o['vitepress-bin']) : path.join(wt, 'node_modules', '.bin', 'vitepress')
      for (const b of g.builds) {
        const dir = path.join(tmpRoot, 'out-' + (b.rel || 'root'))
        const t0 = Date.now()
        const r = await run(bin, buildArgs(b, dir), { cwd: wt, env: { ...process.env, BRIGHTTEST_DOCS_CHANNEL: b.channel } })
        const seconds = Math.round((Date.now() - t0) / 1000)
        if (r.ok && fs.existsSync(dir)) { results.push({ build: b, ok: true, dir, seconds }); say(`built ${g.key} at ${b.base} in ${seconds}s`) }
        else { results.push({ build: b, ok: false, error: `vitepress build failed: ${r.output.split('\n').slice(-3).join(' | ')}` }); say(`FAILED ${g.key} at ${b.base}`) }
      }
    }

    const fatal = fatalFailures(p, results)
    const good = results.filter((r) => r.ok).map((r) => ({ build: r.build, dir: r.dir }))
    assemble(out, good)
    fs.writeFileSync(path.join(out, 'versions.json'), JSON.stringify(versionsJson(p, results, { nextSha }), null, 2) + '\n')
    const md = summaryMarkdown({ ...p, builds }, results)
    say(md)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
    if (fatal.length) { say(`error: required build failed (${fatal.map((f) => f.build.id).join(', ')})`); return 1 }
    return 0
  } finally {
    cleanup()
  }
}

async function main(argv) {
  const o = parseArgs(argv)
  const cmd = o._[0]
  if (cmd === 'plan') return cmdPlan(o)
  if (cmd === 'build') return cmdBuild(o)
  say('usage: docs-site.js plan | build --out <dir> [--only <version|next>] [--base-prefix /x/] [--keep-temp] [--dry-run]')
  return 2
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { say(`error: ${e.message}`); process.exit(1) },
  )
}

module.exports = { parseTag, plan, orderBuilds, versionsJson, groupByRef, buildArgs, fatalFailures, assemble, summaryMarkdown, defaultBase, parseArgs }
