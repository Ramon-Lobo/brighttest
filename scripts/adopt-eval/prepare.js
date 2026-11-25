#!/usr/bin/env node
'use strict'
// Prepare the 12 T1 cells: <root>/<fixture>/run<n>/{app/,prompt.md} (with-skills) and <root>-baseline/<fixture>/run<n>/... (baseline). Does not launch anything.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { REPO_ROOT, DEFAULT_RUN_ROOT, FIXTURES, ARMS, RUNS, armRoot, cellDir, buildPrompt, TREE_FIXTURE, buildTreePrompt } = require('./common')

// Ground truth must not be visible to the agent.
const HIDDEN = new Set(['EXPECTED-CENSUS.json', 'node_modules', '.git'])
// Tree case: ground truth, README and any prior output are removed for both arms before the base commit.
const TREE_HIDDEN = new Set(['EXPECTED-GRAPH.json', 'EXPECTED-FEATURES.json', 'README.md', '.brighttest', 'node_modules', '.git'])

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

function prepare({ runRoot = DEFAULT_RUN_ROOT, clean = false, repoRoot = REPO_ROOT } = {}) {
  runRoot = path.resolve(runRoot)
  const roots = ARMS.map((arm) => armRoot(runRoot, arm))
  for (const r of roots) {
    const rel = path.relative(repoRoot, r)
    // A different drive (Windows) makes path.relative return an absolute path: that is outside the repo.
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    if (inside) throw new Error('run root must be outside the repo')
  }
  const used = roots.filter((r) => fs.existsSync(r) && fs.readdirSync(r).length)
  if (used.length && !clean) throw new Error(`run root ${used[0]} is not empty (use --clean to wipe it)`)
  for (const r of used) fs.rmSync(r, { recursive: true, force: true })
  for (const r of roots) fs.mkdirSync(r, { recursive: true })
  const cells = []
  for (const fixture of FIXTURES) for (const arm of ARMS) for (const run of RUNS) {
    const dir = cellDir(runRoot, fixture, arm, run)
    const app = path.join(dir, 'app')
    fs.mkdirSync(dir, { recursive: true })
    // The fixture README describes the tool; baseline cells must not be able to read it, so it is left out of baseline copies.
    fs.cpSync(path.join(repoRoot, 'examples', fixture), app, { recursive: true, filter: (s) => !HIDDEN.has(path.basename(s)) && !(arm === 'baseline' && /^readme(\.|$)/i.test(path.basename(s)) && path.dirname(s) === path.join(repoRoot, 'examples', fixture)) })
    git(app, ['init', '-q'])
    git(app, ['add', '-A'])
    git(app, ['commit', '-q', '-m', 'fixture baseline'])
    const reportPath = path.join(dir, 'report.md')
    fs.writeFileSync(path.join(dir, 'prompt.md'), buildPrompt({ arm, appDir: app, reportPath, repoRoot }))
    cells.push({ fixture, arm, run, dir })
  }
  const warn = /brighttest/i.test(runRoot) ? 'run root path contains "brighttest": baseline prompts will show that word in paths; use a neutral --run-root for a cleaner baseline' : null
  return { runRoot, cells, warn }
}

// Feature-tree case: <root>/feature-tree-app/run<n>/{app/,prompt.md} (with-skills) and <root>-baseline/... (baseline). Fixture copy minus ground truth, README and .brighttest.
function prepareTree({ runRoot, clean = false, repoRoot = REPO_ROOT, arms = ARMS, runs = RUNS } = {}) {
  if (!runRoot) throw new Error('--run-root is required')
  runRoot = path.resolve(runRoot)
  const roots = arms.map((arm) => armRoot(runRoot, arm))
  for (const r of roots) {
    const rel = path.relative(repoRoot, r)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('run root must be outside the repo')
  }
  const used = roots.filter((r) => fs.existsSync(r) && fs.readdirSync(r).length)
  if (used.length && !clean) throw new Error(`run root ${used[0]} is not empty (use --clean to wipe it)`)
  for (const r of used) fs.rmSync(r, { recursive: true, force: true })
  const src = path.join(repoRoot, 'examples', TREE_FIXTURE)
  const cells = []
  for (const arm of arms) for (const run of runs) {
    const dir = cellDir(runRoot, TREE_FIXTURE, arm, run), app = path.join(dir, 'app')
    fs.mkdirSync(dir, { recursive: true })
    fs.cpSync(src, app, { recursive: true, filter: (s) => !(path.dirname(s) === src && TREE_HIDDEN.has(path.basename(s))) && !['node_modules', '.git'].includes(path.basename(s)) })
    git(app, ['init', '-q']); git(app, ['add', '-A']); git(app, ['commit', '-q', '-m', 'fixture baseline'])
    fs.writeFileSync(path.join(dir, 'prompt.md'), buildTreePrompt({ arm, appDir: app, leaseDir: path.join(dir, 'leases'), repoRoot }))
    cells.push({ arm, run, dir })
  }
  return { runRoot, cells }
}

function main(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-root') opts.runRoot = argv[++i]
    else if (argv[i] === '--clean') opts.clean = true
    else if (argv[i] === '--case' && argv[i + 1] === 'tree') { opts.tree = true; i++ }
    else { console.error('usage: prepare.js [--case tree] [--run-root <dir>] [--clean]'); return 2 }
  }
  try {
    if (opts.tree && !opts.runRoot) { console.error('prepare: --case tree needs --run-root'); return 2 }
    const r = opts.tree ? prepareTree(opts) : prepare(opts)
    for (const c of r.cells) console.log(c.dir)
    console.log(`prepared ${r.cells.length} cells under ${r.runRoot}`)
    if (r.warn) console.error(`warning: ${r.warn}`)
    return 0
  } catch (e) { console.error(`prepare: ${e.message}`); return 1 }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { prepare, prepareTree }
