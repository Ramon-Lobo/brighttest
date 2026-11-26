#!/usr/bin/env node
'use strict'
// Prepare and score the no-edit T2 (first green run) and T3 (instrumented debug build, release gate) cells, two arms. Plain Node, no dependencies. Nothing here launches an agent.
//
// Usage:
//   node scripts/adopt-eval/t23.js prepare --run-root <dir> [--clean] [--tasks t2,t3]
//     Two arms, two roots (a baseline agent walking up from its cell must not reach with-skills prompts):
//       <dir>/legacy-app/<task>/{app/,prompt.md,out/}            with-skills
//       <dir>-baseline/legacy-app/<task>/{app/,prompt.md,out/}   baseline
//     ONE run per task and arm. app/ is a fresh copy of examples/legacy-app minus EXPECTED-CENSUS.json, node_modules (so no
//     shipped skills), .git; the baseline copy also drops README files. git init, one commit. out/ is where build outputs go.
//     with-skills prompt: task text, paths, local CLI path, then safety.md + the brownfield skill SKILL.md + references/* inlined.
//     baseline prompt: task text, paths, the isolation rule.
//   node scripts/adopt-eval/t23.js score --run-root <dir> --results <json> [--tasks t2,t3]
//     Writes <dir>/SCORE23.md and SCORE23.json. Results JSON:
//       { "cells": { "legacy-app/with-skills/t3": { "finalMessage": "...", "commands": ["..."], "reads": ["..."], "exitCodes": { "<command>": 0 } },
//                    "legacy-app/baseline/t3": { ... } } }
//     Exit codes come from the results JSON only (the scorer re-runs nothing except read-only `git` checks on app/; it never
//     runs the brighttest CLI). Baseline cells are checked for contamination (score.js contamination(): tool use, README read,
//     recorded `commands` and `reads`); a contaminated baseline cell is reported as excluded, not scored. Only with-skills gates.
//
// Verdicts are { pass, mode: 'auto' | 'review', note }. 'review' = a human must read the note.
//
// T2 diff allow-list (anything else in `git status`/`git diff` against the initial commit fails T2 "no app source diff"):
//   source/tests/**, brighttest.json, .gitignore, .env, .env.example, and generated dirs .brighttest/**, coverage/**, node_modules/**.
// T3 allow-list (extra criterion, the prompt says the app must not be edited): brighttest.json (init --brownfield writes it),
//   .gitignore, .brighttest/**, node_modules/**. `instrument build --out` should point outside app/; a zip inside app/ fails.
// Spec counting (T2): spec files under source/tests/ are *.spec.bs / *.spec.brs. legacy-app already ships some, so the criterion
//   counts files ADDED against the initial commit; if fewer than 3 were added the verdict is a FAIL tagged review.
// The `@SGNode` outcome of T2 is non-gating while ENG-PUB is held; it is not scored (read the final message).
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { REPO_ROOT, ARMS, armRoot } = require('./common')
const { contamination } = require('./score')

const FIXTURE = 'legacy-app'
const PROMPTS = {
  t2: 'Get a first green headless run of brighttest with at least 3 meaningful specs. Do not edit the app\'s code.',
  t3: 'This app must not be edited. Make an instrumented debug build and show it can\'t ship.',
}
// Added to both arms for T3: a plain package zip is how "verify exits 0" is shown, and it does not edit the app.
const T3_NOTE = 'Put every build output (debug zip, plain package zip) in the out/ directory next to app/, never inside app/. Building a plain, non-instrumented package zip of the unmodified app (for example with the standard zip tool, run from outside app/ or with output in out/) is allowed and does not count as editing the app.'
// Added to both arms for T2: the answers to the brownfield skill's Step 0 questions, so the agent does not stop to ask them.
const T2_NOTE = 'Answers to the setup questions: you may add brighttest.json, spec files under source/tests/ and lines in .gitignore in the app folder. You may NOT edit the app source, components, manifest or bsconfig. No Roku device is available, so use headless runs only.'
const BASELINE_T23 = 'Use only file reads and standard shell commands inside your working directory and its sibling out/ directory. Do not read README files, and do not read or list anything outside those directories.'
const SKILL_DIR = 'adopting-brighttest-brownfield'
const skillFiles = (repoRoot = REPO_ROOT) => {
  const dir = path.join(repoRoot, 'skills', SKILL_DIR), refDir = path.join(dir, 'references')
  const refs = fs.existsSync(refDir) ? fs.readdirSync(refDir).sort().map((f) => path.join(refDir, f)).filter((f) => fs.statSync(f).isFile()) : []
  return [path.join(repoRoot, 'skills', '_always-on', 'safety.md'), path.join(dir, 'SKILL.md'), ...refs]
}
function buildPrompt({ arm, task, appDir, outDir, reportPath, repoRoot = REPO_ROOT }) {
  const lines = [PROMPTS[task], '', `Your working directory is ${appDir} (the app). Build outputs go in ${outDir}.`]
  if (task === 't2') lines.push('', T2_NOTE)
  if (task === 't3') lines.push('', T3_NOTE)
  lines.push('', 'In your final reply, summarize what you did, list the exact commands you ran with their exit codes, and explain any decision the task leaves open.')
  if (arm === 'with-skills') {
    lines.push('', `The brighttest CLI is available locally: run it as \`node ${path.join(repoRoot, 'bin', 'cli.js')} <command>\` from the app directory.`, '', 'Guidance (inlined for you; follow it):')
    for (const f of skillFiles(repoRoot)) lines.push('', `--- ${path.relative(path.join(repoRoot, 'skills'), f).split(path.sep).join('/')} ---`, fs.readFileSync(f, 'utf8').trim())
  } else if (arm === 'baseline') lines.push('', BASELINE_T23)
  else throw new Error(`unknown arm: ${arm}`)
  return lines.join('\n') + '\n'
}
const TASKS = Object.keys(PROMPTS)
const HIDDEN = new Set(['EXPECTED-CENSUS.json', 'node_modules', '.git'])
const T2_ALLOW = [/^source\/tests\//, /^brighttest\.json$/, /^\.gitignore$/, /^\.env(\.example)?$/, /^\.brighttest\//, /^coverage\//, /^node_modules\//]
const T3_ALLOW = [/^brighttest\.json$/, /^\.gitignore$/, /^\.brighttest\//, /^node_modules\//]
const cellId = (arm, task) => `${FIXTURE}/${arm}/${task}`
const cellDir = (root, arm, task) => path.join(armRoot(root, arm), FIXTURE, task)

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

function prepare({ runRoot, clean = false, repoRoot = REPO_ROOT, tasks = TASKS }) {
  if (!runRoot) throw new Error('--run-root is required')
  runRoot = path.resolve(runRoot)
  const roots = ARMS.map((arm) => armRoot(runRoot, arm))
  for (const r of roots) {
    const rel = path.relative(repoRoot, r)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('run root must be outside the repo')
  }
  const used = roots.filter((r) => fs.existsSync(r) && fs.readdirSync(r).length)
  if (used.length && !clean) throw new Error(`run root ${used[0]} is not empty (use --clean to wipe it)`)
  for (const r of used) fs.rmSync(r, { recursive: true, force: true })
  const cells = []
  const src = path.join(repoRoot, 'examples', FIXTURE)
  for (const arm of ARMS) for (const task of tasks) {
    const dir = cellDir(runRoot, arm, task), app = path.join(dir, 'app'), out = path.join(dir, 'out')
    fs.mkdirSync(out, { recursive: true })
    fs.cpSync(src, app, { recursive: true, filter: (s) => !HIDDEN.has(path.basename(s)) && !(arm === 'baseline' && /^readme(\.|$)/i.test(path.basename(s)) && path.dirname(s) === src) })
    git(app, ['init', '-q']); git(app, ['add', '-A']); git(app, ['commit', '-q', '-m', 'fixture baseline'])
    fs.writeFileSync(path.join(dir, 'prompt.md'), buildPrompt({ arm, task, appDir: app, outDir: out, repoRoot }))
    cells.push({ arm, task, dir })
  }
  const warn = /brighttest/i.test(runRoot) ? 'run root path contains "brighttest": use a neutral --run-root for a cleaner baseline' : null
  return { runRoot, cells, warn }
}

// ---- helpers ----
const lookup = (exitCodes, cmd) => (exitCodes && Object.prototype.hasOwnProperty.call(exitCodes, cmd) ? exitCodes[cmd] : undefined)
const SUBS = /\b(?:init|instrument|assess|e2e|device|skills|studio|doctor)\b/
// A plain test run: invokes brighttest (npx brighttest, bin/cli.js, brighttest) without a subcommand.
const isTestRun = (c) => /(?:npx\s+(?:--?\S+\s+)*brighttest|cli\.js|(?:^|[\s/])brighttest(?:\s|$))/.test(c) && !SUBS.test(c)
const isVerify = (c) => /\binstrument\s+verify\b/.test(c)

function gitState(appDir) {
  if (!fs.existsSync(path.join(appDir, '.git'))) return { error: 'app/.git missing' }
  const g = (a) => spawnSync('git', a, { cwd: appDir, encoding: 'utf8', timeout: 60000 })
  const cnt = g(['rev-list', '--count', 'HEAD'])
  if (cnt.status !== 0) return { error: 'git rev-list failed' }
  const st = g(['status', '--porcelain', '--untracked-files=all'])
  if (st.status !== 0) return { error: `git status failed: ${st.stderr.trim()}` }
  const files = []
  for (const line of st.stdout.split('\n').filter(Boolean)) {
    let p = line.slice(3)
    if (p.includes(' -> ')) p = p.split(' -> ')[1]
    files.push({ code: line.slice(0, 2), path: p.replace(/^"|"$/g, '') })
  }
  return { files, commits: Number(cnt.stdout.trim()) }
}

function checkDiff(appDir, allow) {
  const s = gitState(appDir)
  if (s.error) return { pass: false, mode: 'review', note: s.error }
  const bad = s.files.filter((f) => !allow.some((re) => re.test(f.path)))
  if (s.commits !== 1) return { pass: false, mode: 'review', note: 'extra commits in app/' }
  return bad.length ? { pass: false, mode: 'auto', note: `outside allow-list: ${bad.map((f) => f.path).join(', ')}` } : { pass: true, mode: 'auto', note: `${s.files.length} path(s) changed, all in allow-list` }
}

function readConfig(appDir) {
  try { return { cfg: JSON.parse(fs.readFileSync(path.join(appDir, 'brighttest.json'), 'utf8')) } } catch (e) { return { error: e.code === 'ENOENT' ? 'brighttest.json missing' : `brighttest.json does not parse: ${e.message}` } }
}

// ---- T2 ----
function scoreT2({ message = '', commands = [], exitCodes = {}, appDir }) {
  const res = {}
  const { cfg, error } = readConfig(appDir)
  const keys = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? ['rootDir', 'sourceGlobs', 'testsFilePattern'].filter((k) => !(k in cfg)) : null
  res.T2a = error ? { pass: false, mode: 'auto', note: error } : keys === null ? { pass: false, mode: 'auto', note: 'brighttest.json is not an object' } : keys.length ? { pass: false, mode: 'auto', note: `missing keys: ${keys.join(', ')}` } : { pass: true, mode: 'auto', note: 'parses; rootDir, sourceGlobs, testsFilePattern present' }
  const runs = commands.filter(isTestRun)
  if (!runs.length) res.T2b = { pass: false, mode: 'auto', note: 'no `npx brighttest` run in commands' }
  else {
    const last = runs[runs.length - 1], code = lookup(exitCodes, last)
    res.T2b = code === 0 ? { pass: true, mode: 'auto', note: `last run exit 0 (${runs.length} run(s) recorded)` } : code === undefined ? { pass: false, mode: 'review', note: `no exit code recorded for: ${last}` } : { pass: false, mode: 'auto', note: `last run exit ${code}: ${last}` }
  }
  const s = gitState(appDir)
  if (s.error) res.T2c = { pass: false, mode: 'review', note: s.error }
  else {
    const added = s.files.filter((f) => /^source\/tests\/.+\.spec\.(bs|brs)$/.test(f.path) && (f.code === '??' || f.code.includes('A')))
    const shipped = shippedSpecs(appDir)
    const total = listSpecs(path.join(appDir, 'source', 'tests'))
    res.T2c = added.length >= 3 ? { pass: true, mode: 'auto', note: `${added.length} spec file(s) added (${total} total under source/tests/)` } : { pass: false, mode: total >= 3 ? 'review' : 'auto', note: `${added.length} spec file(s) added, ${total} total (the fixture ships ${shipped}; the task asks for 3 new meaningful specs)` }
  }
  const said = /(flip|invert|break|broke|mutat|negat|wrong)\w*/i.test(message) && /\bfail(?:ed|s|ing)?\b/i.test(message) && /(restor|revert|reset|put\s+back|changed\s+back|undone|fixed\s+it\s+back)/i.test(message)
  const leftovers = listFiles(path.join(appDir, 'source', 'tests')).filter((f) => /\.(orig|bak|rej|tmp)$|~$/.test(f))
  res.T2d = leftovers.length ? { pass: false, mode: 'review', note: `leftover files in tests: ${leftovers.join(', ')}` } : said ? { pass: true, mode: 'review', note: 'message says a flipped test failed and was restored; confirm against the transcript (the restored files are the ones in app/source/tests)' } : { pass: false, mode: 'review', note: 'final message does not say a test was flipped, failed and restored' }
  res.T2e = checkDiff(appDir, T2_ALLOW)
  const ign = path.join(appDir, '.gitignore')
  const lines = fs.existsSync(ign) ? fs.readFileSync(ign, 'utf8').split(/\r?\n/).map((l) => l.trim()) : []
  res.T2f = lines.some((l) => /^\/?\.env(\*|\.\*)?$/.test(l) || l === '*.env') ? { pass: true, mode: 'auto', note: '.env listed in .gitignore' } : { pass: false, mode: 'auto', note: '.env not in .gitignore' }
  const smoke = commands.some((c) => /\bsmoke\b/i.test(c))
  res.T2g = smoke ? { pass: true, mode: 'auto', note: 'smoke command recorded' } : /\bsmoke\b/i.test(message) ? { pass: true, mode: 'review', note: 'smoke mentioned in message, no command record' } : { pass: false, mode: 'review', note: 'no engine smoke step in commands or message' }
  return res
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p)
  }
  return out
}
// Spec files in the initial (root) commit, so the note does not hard-code the fixture's count.
function shippedSpecs(appDir) {
  const g = (a) => spawnSync('git', a, { cwd: appDir, encoding: 'utf8', timeout: 60000 })
  const root = g(['rev-list', '--max-parents=0', 'HEAD'])
  if (root.status !== 0) return 'an unknown number'
  const ls = g(['ls-tree', '-r', '--name-only', root.stdout.trim().split('\n')[0]])
  if (ls.status !== 0) return 'an unknown number'
  return ls.stdout.split('\n').filter((f) => /^source\/tests\/.+\.spec\.(bs|brs)$/.test(f)).length
}
const listSpecs = (dir) => listFiles(dir).filter((f) => /\.spec\.(bs|brs)$/.test(f)).length

// ---- T3 ----
function scoreT3({ message = '', commands = [], exitCodes = {}, appDir }) {
  const res = {}
  res.T3a = commands.some((c) => /\binit\b/.test(c) && /--brownfield\b/.test(c)) ? { pass: true, mode: 'auto', note: 'init --brownfield recorded' } : { pass: false, mode: 'auto', note: 'no `init --brownfield` in commands' }
  const builds = commands.filter((c) => /\binstrument\s+build\b/.test(c))
  const withOut = builds.filter((c) => /--out\b/.test(c))
  if (!withOut.length) res.T3b = { pass: false, mode: 'auto', note: builds.length ? 'instrument build without --out' : 'no `instrument build --out` in commands' }
  else {
    const codes = withOut.map((c) => lookup(exitCodes, c))
    res.T3b = codes.includes(0) ? { pass: true, mode: 'auto', note: 'instrument build --out exit 0' } : codes.every((x) => x === undefined) ? { pass: false, mode: 'review', note: 'no exit code recorded for instrument build' } : { pass: false, mode: 'auto', note: `instrument build exit ${codes.join('/')}` }
  }
  const ver = commands.filter(isVerify).map((c) => ({ c, code: lookup(exitCodes, c) }))
  const has3 = ver.some((v) => v.code === 3), has0 = ver.some((v) => v.code === 0)
  res.T3c = has3 && has0 ? { pass: true, mode: 'auto', note: 'verify exit 3 and exit 0 both recorded (read which zip each ran on: 3 must be the debug zip, 0 the plain package)' } : !ver.length ? { pass: false, mode: 'auto', note: 'no `instrument verify` in commands' } : { pass: false, mode: ver.some((v) => v.code === undefined) ? 'review' : 'auto', note: `verify exit codes: ${ver.map((v) => v.code === undefined ? '?' : v.code).join('/')}; need 3 on the debug zip and 0 on a plain package` }
  const { cfg, error } = readConfig(appDir)
  if (error) res.T3d = { pass: false, mode: 'auto', note: error }
  else {
    const ex = cfg.instrument && cfg.instrument.exclude
    const alias = 'instrumentExclude' in cfg || (cfg.instrument && typeof cfg.instrument === 'object' && 'instrumentExclude' in cfg.instrument)
    res.T3d = Array.isArray(ex) && ex.length && !alias ? { pass: true, mode: 'auto', note: `instrument.exclude has ${ex.length} entr${ex.length === 1 ? 'y' : 'ies'}; no instrumentExclude alias` } : { pass: false, mode: 'auto', note: [!(Array.isArray(ex) && ex.length) && 'instrument.exclude missing or empty', alias && 'deprecated instrumentExclude present'].filter(Boolean).join('; ') }
  }
  const strictOn = !error && cfg.instrument && cfg.instrument.strict === true
  const explained = /\bstrict\b/i.test(message) && /(ramp|warn|gradual|phase|later|tighten|raise|enable|turn(?:ed)? on|first (?:build|run)|stays? off)/i.test(message)
  res.T3e = strictOn ? { pass: false, mode: 'auto', note: 'instrument.strict is true in brighttest.json' } : explained ? { pass: true, mode: 'review', note: 'strict not enabled in config; message mentions strict and a ramp: read the explanation' } : { pass: false, mode: 'review', note: 'strict not enabled, but the message does not explain the strict ramp' }
  res.T3f = checkDiff(appDir, T3_ALLOW)
  return res
}

const NAMES = {
  T2a: 'valid brighttest.json', T2b: '`npx brighttest` exit 0', T2c: '3+ new spec files under source/tests/', T2d: 'flipped test failed then restored',
  T2e: 'no app source diff (allow-list)', T2f: '`.env` in .gitignore', T2g: 'engine smoke step run',
  T3a: '`init --brownfield` run', T3b: '`instrument build --out` exit 0', T3c: '`instrument verify` exit 3 on debug zip, 0 on plain package',
  T3d: '`instrument.exclude` present, no `instrumentExclude`', T3e: 'strict ramp explained, not enabled', T3f: 'app not edited (allow-list; extra check)',
}

// Baseline contamination: reuse score.js. The fixture's own brighttest.json is part of the app, so a command that only names it is not tool use.
const ownConfig = (x) => String(x).replace(/brighttest\.json/gi, 'app-config.json')
function score({ runRoot, results, tasks = TASKS }) {
  const cells = results.cells || results
  const out = { arms: {}, contaminated: [], contamReview: [], gate: null }
  for (const arm of ARMS) {
    out.arms[arm] = {}
    for (const task of tasks) {
      const id = cellId(arm, task), r = cells[id]
      if (!r) { out.arms[arm][task] = { present: false, criteria: {}, pass: false }; continue }
      if (arm === 'baseline') {
        const { why, review } = contamination({ message: ownConfig(r.finalMessage || ''), commands: (r.commands || []).map(ownConfig), reads: (r.reads || []).map(ownConfig) })
        if (review.length) out.contamReview.push({ cell: id, why: review })
        if (why.length) { out.contaminated.push({ cell: id, why }); out.arms[arm][task] = { present: true, excluded: true, criteria: {}, pass: null }; continue }
      }
      const args = { message: r.finalMessage || '', commands: r.commands || [], exitCodes: r.exitCodes || {}, appDir: path.join(cellDir(runRoot, arm, task), 'app') }
      const criteria = task === 't2' ? scoreT2(args) : scoreT3(args)
      const vals = Object.values(criteria)
      // A task passes when every criterion passes. T3f is an extra check but still counts.
      out.arms[arm][task] = { present: true, criteria, pass: vals.every((v) => v.pass), review: vals.filter((v) => v.mode === 'review').length }
    }
  }
  // Only the with-skills arm gates; baseline is reported for comparison.
  out.gate = tasks.every((t) => out.arms['with-skills'][t].pass === true)
  return out
}

function render(s) {
  const L = ['# T2 and T3 score', '', 'One run per task and arm. A task passes when every criterion passes; "review" verdicts need a human read before they are final. Only with-skills gates; baseline is for comparison.', '']
  for (const arm of ARMS) for (const [task, t] of Object.entries(s.arms[arm])) {
    L.push(`## ${arm} ${task.toUpperCase()} (${cellId(arm, task)})`, '')
    if (!t.present) { L.push('No result for this cell: **FAIL**', ''); continue }
    if (t.excluded) { L.push('Contaminated baseline cell: excluded, not scored.', ''); continue }
    L.push('| Criterion | verdict | mode | note |', '|---|---|---|---|')
    for (const [c, v] of Object.entries(t.criteria)) L.push(`| ${c} ${NAMES[c]} | ${v.pass ? 'pass' : 'FAIL'} | ${v.mode} | ${String(v.note).replace(/\|/g, '/')} |`)
    L.push('', `Verdict: **${t.pass ? 'PASS' : 'FAIL'}** (${t.review} review item(s))${arm === 'baseline' ? ' [not gated]' : ''}`, '')
  }
  if (s.contaminated.length) L.push('## Contaminated baseline cells (excluded)', '', ...s.contaminated.map((c) => `- ${c.cell}: ${c.why.join(', ')}`), '')
  if (s.contamReview.length) L.push('## Baseline cells to review by hand (kept in the score)', '', ...s.contamReview.map((c) => `- ${c.cell}: ${c.why.join(', ')}`), '')
  L.push('## Gate', '', `with-skills arm: **${s.gate ? 'PASS' : 'FAIL'}**`, '')
  return L.join('\n')
}

function main(argv) {
  const cmd = argv[0], o = {}
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--run-root') o.runRoot = argv[++i]
    else if (argv[i] === '--results') o.results = argv[++i]
    else if (argv[i] === '--clean') o.clean = true
    else if (argv[i] === '--tasks') o.tasks = argv[++i].split(',')
    else o.bad = true
  }
  const usage = 'usage: t23.js prepare --run-root <dir> [--clean] [--tasks t2,t3] | t23.js score --run-root <dir> --results <json> [--tasks t2,t3]'
  if (o.tasks && !o.tasks.every((t) => TASKS.includes(t))) o.bad = true
  if (o.bad || !o.runRoot || (cmd !== 'prepare' && cmd !== 'score') || (cmd === 'score' && !o.results)) { console.error(usage); return 2 }
  try {
    if (cmd === 'prepare') {
      const r = prepare({ runRoot: o.runRoot, clean: o.clean, tasks: o.tasks })
      for (const c of r.cells) console.log(`${c.arm} ${c.task} ${c.dir}`)
      console.log(`prepared ${r.cells.length} cells under ${r.runRoot}`)
      return 0
    }
    const runRoot = path.resolve(o.runRoot)
    const s = score({ runRoot, results: JSON.parse(fs.readFileSync(o.results, 'utf8')), tasks: o.tasks })
    fs.writeFileSync(path.join(runRoot, 'SCORE23.md'), render(s))
    fs.writeFileSync(path.join(runRoot, 'SCORE23.json'), JSON.stringify(s, null, 2))
    console.log(render(s))
    return 0
  } catch (e) { console.error(`t23: ${e.message}`); return 1 }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { prepare, buildPrompt, skillFiles, score, scoreT2, scoreT3, render, PROMPTS, T2_ALLOW, T3_ALLOW }
