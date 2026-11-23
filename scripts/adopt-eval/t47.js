#!/usr/bin/env node
'use strict'
// Harness for TP-ADOPT-14 (T4 greenfield) and TP-ADOPT-15 (T5 CI). Plain Node, offline, no model, no device.
//
// Usage:
//   node scripts/adopt-eval/t47.js prepare    --run-root <dir> [--clean]
//       -> <dir>/greenfield/t4/{app/,prompt.md}; app/ = fresh copy of examples/greenfield-skeleton, git init + 1 commit.
//   node scripts/adopt-eval/t47.js prepare-t5 --run-root <dir> --from <T4 end-state dir> [--clean]
//       -> <dir>/greenfield/t5/{app/,prompt.md,.t47-meta.json}; app/ = copy of the T4 end state (the original is never touched).
//          --from may be the T4 app dir or the T4 cell dir (the one holding app/). Input is the T4 passing end state (design 10.2), not legacy-app.
//   node scripts/adopt-eval/t47.js score      --run-root <dir> --results <json>
//       -> <dir>/SCORE47.md and SCORE47.json. results: { "cells": { "greenfield/t4": { finalMessage, commands: [..], exitCodes: { "<command>": n } }, "greenfield/t5": {...} } }
//
// T4 prompt text: the TP-ADOPT-14 text from the test pack ("Turn this skeleton into a testable Roku app with one feature (a list
// screen with a detail view) and tests."), not the shorter design 6.2 line.
// Verdicts are "auto" (regex, git or exit-code based) or "review" (heuristic; read it by hand). A cell passes when every criterion passes.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { REPO_ROOT } = require('./common')

const T4_PROMPT = 'Turn this skeleton into a testable Roku app with one feature (a list screen with a detail view) and tests.'
const T5_PROMPT = 'Add CI for brighttest to this project (GitHub Actions).'
const T4_ID = 'greenfield/t4', T5_ID = 'greenfield/t5'
const SKIP = new Set(['node_modules', '.git'])

const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const title = (appDir) => { const m = /^title=(.*)$/m.exec(read(path.join(appDir, 'manifest')) || ''); return m ? m[1].trim() : null }

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, pred, out); else if (pred(p)) out.push(p)
  }
  return out
}

function prepareRoot(runRoot, repoRoot, clean) {
  runRoot = path.resolve(runRoot)
  const rel = path.relative(repoRoot, runRoot)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('run root must be outside the repo')
  return runRoot
}
function freshCell(cell, clean) {
  if (fs.existsSync(cell) && fs.readdirSync(cell).length) {
    if (!clean) throw new Error(`cell ${cell} is not empty (use --clean to wipe it)`)
    fs.rmSync(cell, { recursive: true, force: true })
  }
  fs.mkdirSync(cell, { recursive: true })
}
const cellPath = (runRoot, id) => path.join(runRoot, ...id.split('/'))

function prepare({ runRoot, clean = false, repoRoot = REPO_ROOT } = {}) {
  if (!runRoot) throw new Error('--run-root is required')
  runRoot = prepareRoot(runRoot, repoRoot)
  const dir = cellPath(runRoot, T4_ID), app = path.join(dir, 'app')
  freshCell(dir, clean)
  fs.cpSync(path.join(repoRoot, 'examples', 'greenfield-skeleton'), app, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) })
  git(app, ['init', '-q']); git(app, ['add', '-A']); git(app, ['commit', '-q', '-m', 'skeleton baseline'])
  fs.writeFileSync(path.join(dir, 'prompt.md'), `${T4_PROMPT}\n\nYour working directory is ${app}.\n`)
  return { runRoot, dir, app }
}

function prepareT5({ runRoot, from, clean = false, repoRoot = REPO_ROOT } = {}) {
  if (!runRoot || !from) throw new Error('--run-root and --from are required')
  runRoot = prepareRoot(runRoot, repoRoot)
  let src = path.resolve(from)
  if (!fs.existsSync(path.join(src, 'manifest')) && fs.existsSync(path.join(src, 'app', 'manifest'))) src = path.join(src, 'app')
  if (!fs.existsSync(path.join(src, 'manifest'))) throw new Error(`--from ${from} has no manifest (expected the T4 end state)`)
  const legacy = title(path.join(repoRoot, 'examples', 'legacy-app'))
  if (legacy && title(src) === legacy) throw new Error('--from is the legacy app; T5 input is the T4 greenfield end state')
  const dir = cellPath(runRoot, T5_ID), app = path.join(dir, 'app')
  if (path.resolve(dir) === src || src.startsWith(dir + path.sep)) throw new Error('--from is inside the T5 cell')
  freshCell(dir, clean)
  fs.cpSync(src, app, { recursive: true, filter: (s) => path.basename(s) !== 'node_modules' })
  if (!fs.existsSync(path.join(app, '.git'))) { git(app, ['init', '-q']); git(app, ['add', '-A']); git(app, ['commit', '-q', '-m', 'T4 end state']) }
  fs.writeFileSync(path.join(dir, 'prompt.md'), `${T5_PROMPT}\n\nYour working directory is ${app}.\n`)
  fs.writeFileSync(path.join(dir, '.t47-meta.json'), JSON.stringify({ input: 't4-end-state' }, null, 2))
  return { runRoot, dir, app }
}

// ---- scoring ----
const ok = (mode, note) => ({ pass: true, mode, note })
const bad = (mode, note) => ({ pass: false, mode, note })
const exitFor = (cell, re) => {
  const ec = cell.exitCodes || {}
  for (const [cmd, n] of Object.entries(ec)) if (re.test(cmd)) return n
  return undefined
}
const BT_CMD = /(?:brighttest|cli\.js|\bbt\b)/
const SUBCMD = /\b(?:init|e2e|instrument|assess|device|skills|doctor|studio)\b/
// A plain headless spec run: a brighttest invocation with no subcommand word.
const isSpecRun = (c) => BT_CMD.test(c) && !SUBCMD.test(c)

function scriptRefs(appDir) {
  const refs = new Set()
  for (const x of walk(appDir, (p) => p.endsWith('.xml'))) {
    const re = /<script\b[^>]*\buri\s*=\s*["']([^"']+)["']/gi
    let m; const t = read(x)
    while ((m = re.exec(t))) refs.add(path.basename(m[1]))
  }
  return refs
}
const INTERACTIVE = ['LabelList', 'MarkupList', 'MarkupGrid', 'RowList', 'PosterGrid', 'ZoomRowList', 'Button', 'ButtonGroup', 'CheckList', 'RadioButtonList', 'TextEditBox', 'Keyboard', 'MiniKeyboard']
function interactiveNodes(appDir) {
  const found = []
  const re = new RegExp(`<(${INTERACTIVE.join('|')})\\b([^>]*)>`, 'g')
  for (const x of walk(appDir, (p) => p.endsWith('.xml') && /components/.test(path.relative(appDir, p)))) {
    let m; const t = read(x)
    while ((m = re.exec(t))) found.push({ file: path.relative(appDir, x), tag: m[1], hasId: /\bid\s*=/.test(m[2]) })
  }
  return found
}
function scoreT4({ cell, appDir, repoRoot }) {
  const commands = cell.commands || [], text = cell.finalMessage || '', r = {}
  r.init = commands.some((c) => /\binit\b.*--greenfield|--greenfield\b.*\binit\b/.test(c)) ? ok('auto', 'init --greenfield recorded') : bad('auto', 'no init --greenfield command')
  const mf = read(path.join(appDir, 'manifest')) || ''
  r.btAgent = /^\s*bs_const\s*=(?:.*;)?\s*BT_AGENT\s*=\s*false\b/mi.test(mf) ? ok('auto', 'bs_const has BT_AGENT=false') : bad('auto', 'manifest lacks bs_const BT_AGENT=false')
  const refs = scriptRefs(appDir)
  const brs = walk(appDir, (p) => p.endsWith('.brs')).map((p) => path.relative(appDir, p).split(path.sep).join('/')).filter((p) => p !== 'source/main.brs' && !/(^|\/)tests?\//.test(p) && /^components\//.test(p))
  const missing = brs.filter((b) => !refs.has(path.basename(b)))
  r.scriptTags = !brs.length ? bad('review', 'no new component .brs files found; read what was added') : missing.length ? bad('auto', `no <script> tag for: ${missing.join(', ')}`) : ok('auto', `${brs.length} new .brs file(s) all tagged`)
  const nodes = interactiveNodes(appDir), noId = nodes.filter((n) => !n.hasId)
  r.ids = !nodes.length ? bad('review', 'no interactive nodes found in components/') : noId.length ? bad('review', `no id on: ${noId.map((n) => `${n.tag} in ${n.file}`).join(', ')}`) : ok('review', `${nodes.length} interactive node(s) have ids; check that the list and detail nodes are among them`)
  const specs = walk(path.join(appDir, 'source'), (p) => /tests?\//.test(path.relative(appDir, p)) && p.endsWith('.brs'))
  const specCmd = commands.find(isSpecRun)
  const specKey = Object.keys(cell.exitCodes || {}).find(isSpecRun), sc = specKey === undefined ? undefined : cell.exitCodes[specKey]
  r.spec = !specs.length ? bad('review', 'no spec file under source/tests') : sc === 0 ? ok('auto', `headless run exit 0, ${specs.length} spec file(s)`) : sc !== undefined ? bad('auto', `headless run exit ${sc}`) : bad('review', `${specs.length} spec file(s); ${specCmd ? 'headless command recorded' : 'no headless command recorded'} but no exit code`)
  const flows = walk(appDir, (p) => /\.e2e\.ya?ml$/.test(p))
  if (!flows.length) r.e2eLint = bad('auto', 'no *.e2e.yaml flow written')
  else {
    const code = exitFor(cell, /e2e\s+lint/)
    if (code !== undefined) r.e2eLint = code === 0 ? ok('auto', `e2e lint exit 0 (results), ${flows.length} flow(s)`) : bad('auto', `e2e lint exit ${code}`)
    else {
      const x = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'cli.js'), 'e2e', 'lint', ...flows], { cwd: appDir, encoding: 'utf8', timeout: 60000 })
      r.e2eLint = x.status === 0 ? ok('auto', `e2e lint re-run exit 0, ${flows.length} flow(s)`) : bad('auto', `e2e lint re-run exit ${x.status}`)
    }
  }
  r.btStore = btStore(text)
  return r
}
const NEG = /\b(?:no|not|never|cannot|can't|can not|without|n't|doesn't|does not|isn't|unsupported|none)\b/i
function btStore(text) {
  const sentences = text.split(/\n+|(?<=[.!?])\s+/)
  const tt = sentences.filter((s) => /time[-\s]?travel/i.test(s))
  const promised = tt.filter((s) => !NEG.test(s))
  const mentions = /BTStore/.test(text), limits = /BTStore/.test(text) && /\b(limit|limitation|limits|not persist|does not|doesn't|cannot|only)\b/i.test(text)
  if (promised.length) return bad('auto', `time-travel mentioned without negation: "${promised[0].trim().slice(0, 120)}"`)
  if (!mentions) return bad('auto', 'BTStore not mentioned in the final message')
  if (!limits) return bad('review', 'BTStore mentioned but no limits language found')
  return ok('review', tt.length ? 'BTStore limits language found; time-travel only mentioned negated' : 'BTStore limits language found, no time-travel promise (read the limits)')
}

// workflow helpers
const workflowFiles = (appDir) => walk(path.join(appDir, '.github', 'workflows'), (p) => /\.ya?ml$/.test(p))
const joinContinuations = (t) => t.replace(/\\\r?\n\s*/g, ' ')
const indentOf = (l) => l.length - l.trimStart().length
// Split `jobs:` into { name, text }.
function jobsOf(text) {
  const lines = text.split(/\r?\n/), i0 = lines.findIndex((l) => /^jobs\s*:/.test(l))
  if (i0 < 0) return []
  const jobs = []; let cur = null, ji = null
  for (const l of lines.slice(i0 + 1)) {
    if (l.trim() === '' || /^\s*#/.test(l)) { if (cur) cur.lines.push(l); continue }
    const ind = indentOf(l)
    if (ind === 0) break
    if (ji === null) ji = ind
    const m = ind === ji && /^(\S[^:]*):\s*$/.exec(l.trim())
    if (m) { cur = { name: m[1], lines: [] }; jobs.push(cur) } else if (cur) cur.lines.push(l)
  }
  return jobs.map((j) => ({ name: j.name, text: j.lines.join('\n') }))
}
// The step block (lines of the `- ` item) that contains line i.
function stepBlock(lines, i) {
  let s = i
  while (s > 0 && !/^\s*-\s/.test(lines[s])) s--
  const ind = indentOf(lines[s]); let e = i + 1
  while (e < lines.length && !(lines[e].trim() && indentOf(lines[e]) <= ind)) e++
  return lines.slice(s, e).join('\n')
}
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{20,}/,
  // password-like variable with a literal value (not a ${{ secrets.X }} / $VAR reference, not blank or a placeholder)
  /\b[A-Za-z_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY)[A-Za-z_]*\s*[:=]\s*(?!['"]?(?:\$\{\{|\$\{?[A-Za-z_]|<|\*+|x{3,}|changeme|your[-_]|replace|example|placeholder|\s*['"]?\s*$))['"]?[^\s'"#]{4,}/i,
]
function secretHits(appDir) {
  const hits = []
  for (const f of walk(appDir, (p) => { try { return fs.statSync(p).size < 1e6 } catch { return false } })) {
    const t = read(f); if (t === null || t.includes('\0')) continue
    t.split(/\r?\n/).forEach((l, i) => { if (SECRET_PATTERNS.some((re) => re.test(l))) hits.push(`${path.relative(appDir, f)}:${i + 1}`) })
  }
  return hits
}
function scoreT5({ cell, appDir }) {
  const r = {}, files = workflowFiles(appDir)
  if (!files.length) {
    const none = bad('auto', 'no .github/workflows/*.yml found')
    for (const k of ['node22', 'headless', 'verifyGate', 'device']) r[k] = none
  } else {
    const texts = files.map((f) => joinContinuations(read(f) || '')), all = texts.join('\n')
    const lines = all.split(/\r?\n/)
    r.node22 = /node-version\s*:\s*(?:\[[^\]]*\b22\b[^\]]*\]|['"]?22(?:\.[\dx]+)*['"]?(?:\s|$|#))/.test(all) || /node-version(?:-file)?\s*:[^\n]*\b22\b/.test(all) ? ok('auto', 'node-version 22 in workflow') : bad('auto', 'no node-version 22 found')
    const hl = lines.find((l) => /--coverage\b/.test(l) && /--lcov\b/.test(l) && /--junit\b/.test(l))
    r.headless = hl ? ok('auto', 'one command has --coverage --lcov --junit') : bad('auto', 'no single command with --coverage --lcov --junit')
    const vi = lines.findIndex((l) => /instrument\s+verify\b/.test(l) && !/^\s*#/.test(l))
    if (vi < 0) r.verifyGate = bad('auto', 'no instrument verify step')
    else {
      const blk = stepBlock(lines, vi)
      r.verifyGate = /continue-on-error\s*:\s*true/i.test(blk) || /\|\|\s*(?:true|:)/.test(blk) ? bad('auto', 'instrument verify step is non-blocking (continue-on-error or || true)') : ok('auto', 'instrument verify is a blocking step')
    }
    const devJobs = texts.flatMap(jobsOf).filter((j) => /BRIGHTTEST_AGENT/.test(j.text) || /\bdevice\b/i.test(j.name))
    const dj = devJobs.find((j) => /BRIGHTTEST_AGENT/.test(j.text))
    if (!dj) r.device = bad('auto', 'no job sets BRIGHTTEST_AGENT')
    else {
      const miss = []
      if (!/self-hosted/.test(dj.text)) miss.push('runs-on self-hosted')
      if (!/BRIGHTTEST_AGENT\s*:\s*['"]?ci:\S+/.test(dj.text)) miss.push('BRIGHTTEST_AGENT=ci:<id>')
      if (!/BRIGHTTEST_LEASE_WAIT/.test(dj.text)) miss.push('BRIGHTTEST_LEASE_WAIT')
      if (/--no-lease|BRIGHTTEST_NO_LEASE/.test(all)) miss.push('no --no-lease (found one)')
      r.device = miss.length ? bad('auto', `device job "${dj.name}" missing: ${miss.join(', ')}`) : ok('auto', `device job "${dj.name}" self-hosted with ci agent and lease wait`)
    }
    const dj2 = devJobs.length ? devJobs : []
    const win = dj2.filter((j) => /windows/i.test(j.text))
    const claim = /windows[^.\n]*\bdevice|device[^.\n]*windows/i.test(cell.finalMessage || '') && !NEG.test((cell.finalMessage || '').split(/(?<=[.!?])\s+/).find((s) => /windows/i.test(s) && /device/i.test(s)) || '')
    r.noWindowsDevice = win.length ? bad('review', `device job mentions Windows: ${win.map((j) => j.name).join(', ')}`) : claim ? bad('review', 'final message may claim Windows device support; read it') : ok('review', 'no Windows in device jobs; read the message for a support claim')
  }
  if (!r.noWindowsDevice) r.noWindowsDevice = bad('review', 'no workflow to check')
  const hits = secretHits(appDir)
  r.noSecrets = hits.length ? bad('auto', `possible secret(s) at ${hits.join(', ')} (values not shown)`) : ok('auto', 'no token or password patterns in files')
  return r
}

const NAMES = {
  init: 'init --greenfield run', btAgent: 'manifest BT_AGENT=false', scriptTags: 'script tags for new files', ids: 'ids on interactive nodes', spec: 'spec green headless', e2eLint: 'e2e flow accepted by e2e lint', btStore: 'BTStore limits stated, no time-travel promise',
  node22: 'Node 22 in workflow', headless: 'headless --coverage --lcov --junit', verifyGate: 'instrument verify release gate', noSecrets: 'no secrets in files', device: 'device job self-hosted, BRIGHTTEST_AGENT=ci:<id>, BRIGHTTEST_LEASE_WAIT', noWindowsDevice: 'Windows not claimed for device',
}

function score({ runRoot, results, repoRoot = REPO_ROOT }) {
  const cells = results.cells || results, out = { cells: {}, caveats: CAVEATS }
  for (const [id, fn] of [[T4_ID, scoreT4], [T5_ID, scoreT5]]) {
    const dir = cellPath(runRoot, id), appDir = path.join(dir, 'app'), cell = cells[id]
    if (!cell && !fs.existsSync(appDir)) continue
    if (!fs.existsSync(appDir)) throw new Error(`results has ${id} but ${appDir} does not exist`)
    if (id === T5_ID) {
      const meta = read(path.join(dir, '.t47-meta.json'))
      if (!meta || JSON.parse(meta).input !== 't4-end-state') throw new Error('T5 cell was not prepared from the T4 end state (run prepare-t5); refusing to score it')
      const legacy = title(path.join(repoRoot, 'examples', 'legacy-app'))
      if (legacy && title(appDir) === legacy) throw new Error('T5 cell holds the legacy app; T5 is scored on the T4 end state only')
    }
    const criteria = fn({ cell: cell || {}, appDir, repoRoot })
    const values = Object.values(criteria)
    out.cells[id] = { noResult: !cell, criteria, passing: values.filter((c) => c.pass).length, total: values.length, pass: values.every((c) => c.pass), reviewNeeded: Object.keys(criteria).filter((k) => criteria[k].mode === 'review') }
  }
  if (!Object.keys(out.cells).length) throw new Error('no T4 or T5 cell found under the run root')
  return out
}
const CAVEATS = [
  'Mode "auto" = regex, git or exit-code verdict; "review" = heuristic, read it by hand. A cell passes only when every criterion passes.',
  'T5 is scored on the T4 end state (design 10.2), never on legacy-app.',
  'Secret scan prints file:line only, never the match.',
  'Nothing here proves a workflow runs on GitHub or a device job holds a lease; those are not verified offline.',
]
function render(s) {
  const L = ['# T4 / T5 score (TP-ADOPT-14, TP-ADOPT-15), ADOPT-21', '', '## Caveats', '', ...s.caveats.map((c) => `- ${c}`), '']
  for (const [id, c] of Object.entries(s.cells)) {
    L.push(`## ${id}`, '', ...(c.noResult ? ['No results entry for this cell: command- and message-based criteria score as failures.', ''] : []), '| Criterion | verdict | mode | note |', '|---|---|---|---|')
    for (const [k, v] of Object.entries(c.criteria)) L.push(`| ${NAMES[k] || k} | ${v.pass ? 'PASS' : 'FAIL'} | ${v.mode} | ${v.note.replace(/\|/g, '/')} |`)
    L.push('', `Cell verdict: **${c.pass ? 'PASS' : 'FAIL'}** (${c.passing}/${c.total})`, c.reviewNeeded.length ? `Review by hand: ${c.reviewNeeded.map((k) => NAMES[k] || k).join('; ')}` : '', '')
  }
  return L.join('\n')
}

function main(argv) {
  const [cmd, ...rest] = argv, o = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--run-root') o.runRoot = rest[++i]
    else if (rest[i] === '--clean') o.clean = true
    else if (rest[i] === '--from') o.from = rest[++i]
    else if (rest[i] === '--results') o.results = rest[++i]
    else o.bad = true
  }
  const usage = 'usage: t47.js prepare|prepare-t5|score --run-root <dir> [--clean] [--from <T4 end state>] [--results <json>]'
  if (o.bad || !o.runRoot || !['prepare', 'prepare-t5', 'score'].includes(cmd) || (cmd === 'prepare-t5' && !o.from) || (cmd === 'score' && !o.results)) { console.error(usage); return 2 }
  try {
    if (cmd === 'prepare') { const r = prepare(o); console.log(r.dir); console.log(`prepared T4 cell under ${r.runRoot}`) }
    else if (cmd === 'prepare-t5') { const r = prepareT5(o); console.log(r.dir); console.log(`prepared T5 cell under ${r.runRoot}`) }
    else {
      const runRoot = path.resolve(o.runRoot), s = score({ runRoot, results: JSON.parse(fs.readFileSync(o.results, 'utf8')) })
      fs.writeFileSync(path.join(runRoot, 'SCORE47.md'), render(s)); fs.writeFileSync(path.join(runRoot, 'SCORE47.json'), JSON.stringify(s, null, 2))
      console.log(render(s))
    }
    return 0
  } catch (e) { console.error(`t47: ${e.message}`); return 1 }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { prepare, prepareT5, score, scoreT4, scoreT5, render, btStore, secretHits, jobsOf, T4_PROMPT, T5_PROMPT }
