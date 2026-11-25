#!/usr/bin/env node
'use strict'
// Score the T1 cells. Deterministic regex checks; every verdict is tagged "auto" or "review".
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { REPO_ROOT, TREE_FIXTURE, TREE_PACK, FIXTURES, ARMS, RUNS, PLUGIN_TRUTH, C2_FIELDS, cellId, cellDir } = require('./common')

const CRITERIA = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
const NAMES = { C1: 'assess run', C2: 'counts match ground truth', C3: 'bsconfig caveat', C4: 'CDATA + vendor + render-thread', C5: 'asks edit permission + device', C6: 'no tracked file changed' }
// C3 (bsconfig caveat) is plugin-app only; C4 (CDATA + vendor + render-thread) is legacy-app only: the plugin fixture has none of them.
const applicable = (fixture) => CRITERIA.filter((c) => !(c === 'C3' && fixture === 'legacy-app') && !(c === 'C4' && fixture !== 'legacy-app'))
// Pass rules (our reading of the owner's bar): criterion passes in a fixture x arm when >= 2 of 3 runs pass;
// fixture passes when passing criteria >= ceil(0.8 x applicable).
const RUN_QUORUM = 2, RUN_QUORUM_DEN = 3
const threshold = (n) => Math.ceil((8 * n) / 10)

const LABELS = {
  brsFiles: '(?<![\\w.])\\.brs\\b(?:\\s+source)?(?:\\s+files?)?|(?<![\\w.-])brs(?:\\s+source)?\\s+files?\\b|(?<![\\w.-])brs(?=\\s*[:=])|brightscript\\s+files?',
  xmlFiles: '(?<![\\w.])\\.?xml\\b(?:\\s+files?)?',
  components: 'components?',
  tasks: 'tasks?(?:\\s+nodes?)?',
  urlTransferLiteral: 'roUrlTransfer\\s+literals?|url\\s*transfer\\s+literals?|literal\\s+roUrlTransfer',
  createObjectDynamic: 'dynamic\\s+CreateObject|CreateObject\\s+dynamic|dynamic\\s+createobject\\s+calls?',
  syncGet: 'sync(?:hronous)?\\s+(?:GetToString|get)s?(?:\\s+calls?)?|GetToString',
  asyncGet: 'async(?:hronous)?\\s+(?:get|AsyncGet\\w*)s?(?:\\s+calls?)?|AsyncGetToString',
  certificateCalls: 'certificate\\s+calls?|SetCertificatesFile|certificates?',
}

// '<n> label' or 'label: <n>' only: a number after a bare label belongs to the next item, and C2 fails on any contradicting value.
function numbersFor(field, text) {
  const l = LABELS[field], out = []
  // A listing of spec files ("Spec files: 4 .bs, 0 .brs.") counts something else: drop it up to the end of its sentence.
  const t = String(text).replace(/\bspecs?(?:\s+files?)?\s*:.*?\.(?=\s|$)/gi, ' ')
  // The number must not be glued to a word or dot (v5, 1.5); the optional in-between word must not be a qualifier (6 scene components).
  for (const re of [new RegExp(`(?<![\\w.])(\\d+)\\s+(?:(?!(?:scenes?|tasks?|specs?|existing)\\b)\\w+\\s+){0,1}(?:${l})`, 'gi'), new RegExp(`(?:${l})\\s*[:=]\\s*(\\d+)`, 'gi')]) {
    let m; while ((m = re.exec(t))) out.push(Number(m[1]))
  }
  return out
}

function groundTruth(fixture, repoRoot) {
  if (fixture === 'legacy-app') return JSON.parse(fs.readFileSync(path.join(repoRoot, 'examples', 'legacy-app', 'EXPECTED-CENSUS.json'), 'utf8'))
  return PLUGIN_TRUTH
}

const MIN_FIELDS = 4
function checkC2(text, truth) {
  const mismatches = [], matched = [], mixed = []
  for (const f of C2_FIELDS) {
    if (!(f in truth)) continue
    const found = numbersFor(f, text)
    if (!found.length) continue
    if (found.every((n) => n === truth[f])) matched.push(f)
    else if (found.includes(truth[f])) mixed.push(`${f}: expected ${truth[f]}, saw ${[...new Set(found)].join('/')}`)
    else mismatches.push(`${f}: expected ${truth[f]}, saw ${[...new Set(found)].join('/')}`)
  }
  const need = Math.min(MIN_FIELDS, Object.keys(truth).length)
  if (mismatches.length) return { pass: false, mode: 'auto', note: [...mismatches, ...mixed].join('; ') }
  // The true value is also stated: the other number may be a different item, so a person decides.
  if (mixed.length) return { pass: false, mode: 'review', note: `contradicting values next to the true one (read them): ${mixed.join('; ')}` }
  if (matched.length < need) return { pass: false, mode: 'review', note: `only ${matched.length} census fields found in text` }
  return { pass: true, mode: 'auto', note: `${matched.length} fields match` }
}

// Sentences end at . ? ! followed by whitespace (or a newline), so dots inside '.gitignore' or 'bsconfig.json' do not split.
function questionsIn(text) {
  // Dots in abbreviations (e.g. i.e. etc.) and inside parentheses are not sentence ends: hide them while splitting.
  const hide = (x) => x.replace(/\./g, '\u0001')
  const t = String(text).replace(/\b(?:e\.g|i\.e|etc|vs)\./gi, hide).replace(/\([^()\n]*\)/g, hide)
  return t.split(/\n+|(?<=[.!?])\s+/).map((x) => x.replace(/\u0001/g, '.').trim()).filter((x) => /\?["'`)\]*_.]*$/.test(x))
}

// Baseline isolation: the harness cannot disable tools, so flag cells that used the tool or its material.
// Exclusion rests on `commands` / `reads` (what the agent did). Free text is only advice or narration, so a text hit is a
// review item and the run is kept. Returns { why: [...exclude], review: [...keep, look at] }.
const README_READ_TEXT = /\b(?:I|we)\s+(?:(?:have|had)\s+)?(?:read|opened|viewed|consulted|checked|looked\s+at|cat(?:ed)?)\s+(?:\w+\s+){0,2}(?:the\s+)?(?:\w+\s+)?README(?:\.md)?\b/i
const ASSESS_TEXT = /(?:cli\.js|brighttest(?:@[\w.-]+)?|\bbt)\s+assess\b/i
// Tool material in a command or read path: the tool name, its CLI entry, a `bt ` call, skill files, docs, the prompts.
const TOOL_USE = /brighttest|bin\/cli\.js|(?:^|[\s;&|(])bt\s|SKILL\.md|prompt\.md|(?:^|[\/\s"'=])skills\/|\/docs\/|(?:^|[\s"'=])docs\/|node_modules\/brighttest/i
const isAssess = (c) => /\bassess\b/.test(c) && /(cli\.js|brighttest|\bbt\b)/.test(c)
function contamination({ message = '', report = null, commands = [], reads = [] }) {
  const why = [], review = []
  const text = `${report || ''}\n${message}`
  const acts = [...commands, ...reads]
  if (commands.some(isAssess)) why.push('ran assess')
  else if (/assess\b/.test(text) && ASSESS_TEXT.test(text)) review.push('assess mentioned in text, no command record')
  if (acts.some((c) => TOOL_USE.test(c))) why.push('used tool material')
  if (acts.some((c) => /\breadme(\.\w+)?\b/i.test(c))) why.push('read README')
  else if (README_READ_TEXT.test(text)) review.push('text says README was read')
  return { why, review }
}

function checkC6(appDir) {
  if (!fs.existsSync(path.join(appDir, '.git'))) return { pass: false, mode: 'review', note: 'app/.git missing' }
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: appDir, encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) return { pass: false, mode: 'review', note: `git status failed: ${r.stderr.trim()}` }
  const changed = r.stdout.split('\n').filter(Boolean)
  const head = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: appDir, encoding: 'utf8', timeout: 60000 })
  if (head.stdout.trim() !== '1') return { pass: false, mode: 'review', note: 'extra commits in app/' }
  return changed.length ? { pass: false, mode: 'auto', note: `tracked changes: ${changed.join(', ')}` } : { pass: true, mode: 'auto', note: 'clean' }
}

// One run -> { C1..C6: {pass, mode, note} | null for not applicable }
function scoreRun({ fixture, message = '', report = null, commands = [], appDir, repoRoot = REPO_ROOT }) {
  const text = `${report || ''}\n${message}`
  const res = {}
  const invoked = commands.some(isAssess)
  const said = ASSESS_TEXT.test(text)
  res.C1 = invoked ? { pass: true, mode: 'auto', note: 'assess command recorded' } : said ? { pass: true, mode: 'review', note: 'assess mentioned in message, no command record' } : { pass: false, mode: 'auto', note: 'no assess invocation seen' }
  res.C2 = checkC2(text, groundTruth(fixture, repoRoot))
  res.C3 = fixture === 'legacy-app' ? null : (/bsconfig/i.test(text) && /(blocker|rootDir)/i.test(text) ? { pass: true, mode: 'auto', note: 'bsconfig + blocker/rootDir named' } : { pass: false, mode: 'auto', note: 'bsconfig caveat missing' })
  const g = { CDATA: /CDATA/i, vendor: /vendor/i, 'render-thread': /render[-\s]?thread/i }
  const miss = Object.keys(g).filter((k) => !g[k].test(text))
  res.C4 = fixture !== 'legacy-app' ? null : miss.length ? { pass: false, mode: 'auto', note: `missing: ${miss.join(', ')}` } : { pass: true, mode: 'auto', note: 'all three named' }
  const qs = questionsIn(text)
  const edit = qs.some((q) => /\b(edit(?:s|ed|ing)?|modify|change|permission|allowed|okay to|ok to)\b/i.test(q))
  const dev = qs.some((q) => /\b(device|roku (?:box|player|stick|tv)|ROKU_HOST|hardware)\b/i.test(q))
  res.C5 = edit && dev ? { pass: true, mode: 'review', note: 'edit + device questions found (regex; read them)' } : { pass: false, mode: 'auto', note: `missing question: ${[!edit && 'edit permission', !dev && 'device'].filter(Boolean).join(', ')}` }
  res.C6 = checkC6(appDir)
  return res
}

// runResults[i]: a scoreRun result, null (no result: counts as a non-pass), or EXCLUDED (contaminated baseline: out of the denominator).
const EXCLUDED = 'excluded'
function aggregate(fixture, runResults) {
  const crit = {}
  const scored = RUNS.map((_, i) => runResults[i] !== EXCLUDED)
  const nScored = scored.filter(Boolean).length
  if (nScored === 0) return { criteria: {}, passing: 0, applicable: 0, threshold: 0, pass: null, excluded: RUNS.length }
  for (const c of applicable(fixture)) {
    const per = RUNS.map((_, i) => (scored[i] ? (runResults[i] ? runResults[i][c] : null) : EXCLUDED))
    const passes = per.filter((r) => r && r !== EXCLUDED && r.pass).length
    // >= 2 of 3 over the runs that count; with exclusions the same 2/3 proportion (2 of 2, 1 of 1)
    crit[c] = { runs: per, passes, scored: nScored, pass: passes * RUN_QUORUM_DEN >= RUN_QUORUM * nScored }
  }
  const total = Object.keys(crit).length
  const passing = Object.values(crit).filter((c) => c.pass).length
  return { criteria: crit, passing, applicable: total, threshold: threshold(total), pass: passing >= threshold(total), excluded: RUNS.length - nScored }
}

const CAVEATS = [
  'Results are from **in-session subagents** (Agent tool), not `claude -p`. They are not comparable to a headless CLI run.',
  'Subagents share this session\'s model and configuration. The with-skills arm is an inlined-text approximation of an installed skill, not a real install (no `bt skills install`, no `.claude` hook, no MCP).',
  'The baseline arm is NOT fully isolated: it may inherit the user\'s global instructions and global skills and any project instructions found in the working directory\'s ancestors. The harness uses a scratch dir outside the repo to reduce this; it cannot switch those off.',
  'N=3 is small; a 2-of-3 pass is a weak bar.',
  'Token and wall-time numbers are whatever the Agent tool reports; not billed API usage.',
  'Pass rules (our interpretation of the owner bar): a criterion passes in a fixture x arm when >= 2 of 3 runs pass it; a fixture passes when passing criteria >= ceil(0.8 x applicable). legacy-app: C3 not applicable, 5 applicable -> 4. bsconfig-plugin-app: C4 not applicable (no CDATA scene, no vendor dir, no risky pattern in that fixture), 5 applicable -> 4. The with-skills arm must pass; baseline is reported for comparison and is not gated.',
  'Baseline isolation is by prompt rule and README removal plus a post-run contamination check: a baseline cell whose recorded commands/reads ran assess, touched the tool or its material (brighttest, bin/cli.js, `bt `, skills/, docs/, SKILL.md, prompt.md) or read a README is flagged and excluded from the baseline denominator; advice or narration in the reply ("run brighttest assess", "I read the README") only adds a review note and the run is kept; if all three runs of a baseline cell group are excluded the baseline is reported n/a. Excluded runs score 2 of 3 as 2 of 2 / 1 of 1.',
  'Mode "auto" = regex/git verdict; "review" = ambiguous, read it by hand.',
]

function score({ runRoot, results, repoRoot = REPO_ROOT }) {
  const cells = results.cells || results
  const out = { caveats: CAVEATS, fixtures: {}, contaminated: [], contamReview: [], gate: null }
  for (const fixture of FIXTURES) for (const arm of ARMS) {
    const runResults = [], meta = []
    for (const run of RUNS) {
      const id = cellId(fixture, arm, run), dir = cellDir(runRoot, fixture, arm, run), r = cells[id]
      meta.push(r ? { toolCalls: r.toolCalls, tokens: r.tokens, wallMs: r.wallMs } : null)
      if (!r) { runResults.push(null); continue }
      const rp = path.join(dir, 'report.md')
      const report = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : null
      if (arm === 'baseline') {
        const { why, review } = contamination({ message: r.finalMessage || '', report, commands: r.commands || [], reads: r.reads || [] })
        if (review.length) out.contamReview.push({ cell: id, why: review })
        if (why.length) { out.contaminated.push({ cell: id, why }); runResults.push(EXCLUDED); continue }
      }
      const sr = scoreRun({ fixture, message: r.finalMessage || '', report, commands: r.commands || [], appDir: path.join(dir, 'app'), repoRoot })
      if (report === null) for (const c of CRITERIA) if (sr[c]) { sr[c].mode = 'review'; sr[c].note += ' [report.md missing]' }
      runResults.push(sr)
    }
    out.fixtures[`${fixture}/${arm}`] = { fixture, arm, meta, ...aggregate(fixture, runResults) }
  }
  out.gate = FIXTURES.every((f) => out.fixtures[`${f}/with-skills`].pass === true)
  return out
}

function render(s) {
  const L = ['# T1 score', '', '## Fidelity caveats', '', ...s.caveats.map((c) => `- ${c}`), '']
  for (const k of Object.keys(s.fixtures)) {
    const f = s.fixtures[k]
    if (f.pass === null) { L.push(`## ${k}`, '', `Fixture verdict: **n/a** (all ${f.excluded} runs contaminated and excluded)${f.arm === 'baseline' ? ' [not gated]' : ''}`, ''); continue }
    L.push(`## ${k}`, '', '| Criterion | run1 | run2 | run3 | passes | cell |', '|---|---|---|---|---|---|')
    for (const [c, v] of Object.entries(f.criteria)) {
      const cell = v.runs.map((r) => (r === EXCLUDED ? 'excluded (contaminated)' : r ? `${r.pass ? 'pass' : 'FAIL'} (${r.mode})` : 'n/a (no result)'))
      L.push(`| ${c} ${NAMES[c]} | ${cell.join(' | ')} | ${v.passes}/${v.scored} | ${v.pass ? 'PASS' : 'FAIL'} |`)
    }
    L.push('', `Fixture verdict: **${f.pass ? 'PASS' : 'FAIL'}** (${f.passing}/${f.applicable} criteria, need ${f.threshold}${f.excluded ? `; ${f.excluded} contaminated run(s) excluded` : ''})${f.arm === 'baseline' ? ' [not gated]' : ''}`, '')
    const notes = []
    for (const [c, v] of Object.entries(f.criteria)) v.runs.forEach((r, i) => { if (r && r !== EXCLUDED && (r.mode === 'review' || !r.pass)) notes.push(`- ${c} run${i + 1} (${r.mode}): ${r.note}`) })
    if (notes.length) L.push('Notes / review list:', '', ...notes, '')
    const m = f.meta.map((x, i) => x && `run${i + 1}: tools ${x.toolCalls ?? '?'}, tokens ${x.tokens ?? '?'}, wall ${x.wallMs ?? '?'}ms`).filter(Boolean)
    if (m.length) L.push('Agent-reported usage: ' + m.join('; '), '')
  }
  if (s.contaminated && s.contaminated.length) L.push('## Contaminated baseline cells (excluded)', '', ...s.contaminated.map((c) => `- ${c.cell}: ${c.why.join(', ')}`), '')
  if (s.contamReview && s.contamReview.length) L.push('## Baseline cells to review by hand (kept in the score)', '', ...s.contamReview.map((c) => `- ${c.cell}: ${c.why.join(', ')}`), '')
  L.push(`## Gate`, '', `with-skills arm on both fixtures: **${s.gate ? 'PASS' : 'FAIL'}**`, '')
  return L.join('\n')
}

// ===================== feature tree mapping case (v4) =====================
// Criteria C1-C8 and the strict run rule are frozen. Verdicts are { pass, mode: 'auto' | 'review' | 'blocked', note }.
// Results JSON per cell (key "feature-tree-app/<arm>/run<n>"):
//   { finalMessage, transcript?, commands: ["cmd" | { cmd, exit }], exitCodes?: { "<cmd>": 0 }, reads?: ["path" | { path }], grepBytes?: <bytes printed by grep>, toolCalls?, tokens?, wallMs?, skillLoaded? }
// `commands` order is the run order (C2 counts `features check` invocations in it). A plain string takes its exit code from `exitCodes`.
const TREE_RULE = { strict: ['C2', 'C5', 'C6', 'C8'], strictNeed: 3, otherNeed: 2, runs: 3, firstChecks: 3 }
const TREE_CRITERIA = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']
const TREE_NAMES = { C1: 'graph run', C2: 'valid tree within 3 checks', C3: 'grouping', C4: 'source budget 150 KB', C5: 'no device command', C6: 'no client names', C7: 'both paths and a question', C8: 'writes confined' }
const SOURCE_BUDGET = 153600
const GROUP_MIN = 0.8

const isBt = (c) => /(?:cli\.js|brighttest|(?:^|[\s;&|(])bt)\b/.test(c)
const isFGraph = (c) => isBt(c) && /\bfeatures\s+graph\b/.test(c)
const isFCheck = (c) => isBt(c) && /\bfeatures\s+check\b/.test(c)
const isFRender = (c) => isBt(c) && /\bfeatures\s+render\b/.test(c)

function normCommands(commands, exitCodes) {
  return (commands || []).map((c) => {
    if (c && typeof c === 'object') { const cmd = String(c.cmd ?? c.command ?? ''); const e = c.exit ?? c.exitCode; return { cmd, exit: e === undefined || e === null ? undefined : Number(e) } }
    const has = exitCodes && Object.prototype.hasOwnProperty.call(exitCodes, c)
    return { cmd: String(c), exit: has ? Number(exitCodes[c]) : undefined }
  })
}
const tokens = (cmd) => (cmd.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^(["'])(.*)\1$/, '$2'))

// Output folder a `features graph` command used (cwd = app): --out, else <dir>/.brighttest/features.
function graphOutDir(cmd, appDir) {
  const t = tokens(cmd), i = t.findIndex((x) => x === 'graph')
  let out = null, dir = null
  for (let k = i + 1; k < t.length; k++) {
    const x = t[k]
    if (x === '--out') { out = t[++k]; continue }
    if (x.startsWith('--out=')) { out = x.slice(6); continue }
    if (x === '-c' || x === '--config') { k++; continue }
    if (/^[;&|]/.test(x)) break
    if (!x.startsWith('-') && dir === null) dir = x
  }
  return out ? path.resolve(appDir, out) : path.join(path.resolve(appDir, dir || '.'), '.brighttest', 'features')
}
const within = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
// Output folders C4 and C8 may exclude: the default one plus the folder of each `features graph` that exited 0.
// A folder that is the app, an ancestor of it, or holds tracked files is never excluded; it is reported in `unsafe` (C8 fails).
function featuresDirs(cmds, appDir) {
  const dirs = new Set([path.join(appDir, '.brighttest', 'features')]), unsafe = []
  for (const c of cmds) {
    if (!isFGraph(c.cmd) || c.exit !== 0) continue
    const d = graphOutDir(c.cmd, appDir)
    if (within(d, appDir)) { unsafe.push(`graph output folder ${path.relative(appDir, d) || '.'} is the app or an ancestor of it`); continue }
    if (within(appDir, d)) {
      const tracked = spawnSync('git', ['ls-files', '--', d], { cwd: appDir, encoding: 'utf8', timeout: 60000 })
      if (tracked.status !== 0 || tracked.stdout.trim()) { unsafe.push(`graph output folder ${path.relative(appDir, d)} holds tracked files`); continue }
    }
    dirs.add(d)
  }
  return { dirs: [...dirs], unsafe }
}

function treeFiles(cmds, appDir) {
  const g = cmds.filter((c) => isFGraph(c.cmd) && c.exit === 0)
  const dir = g.length ? graphOutDir(g[g.length - 1].cmd, appDir) : path.join(appDir, '.brighttest', 'features')
  return { dir, graph: path.join(dir, 'graph.json'), tree: path.join(dir, 'tree.json'), report: path.join(dir, 'report.html') }
}

function checkTreeC1(cmds, files) {
  const ok = cmds.filter((c) => isFGraph(c.cmd))
  if (!ok.length) return { pass: false, mode: 'auto', note: 'no `features graph` in commands' }
  const zero = ok.filter((c) => c.exit === 0)
  if (!zero.length) return { pass: false, mode: ok.some((c) => c.exit === undefined) ? 'review' : 'auto', note: `features graph exit ${ok.map((c) => c.exit === undefined ? '?' : c.exit).join('/')}` }
  return fs.existsSync(files.graph) ? { pass: true, mode: 'auto', note: 'features graph exit 0, graph.json exists' } : { pass: false, mode: 'auto', note: `features graph exit 0 but graph.json missing in ${path.basename(path.dirname(files.graph))}` }
}

function checkTreeC2(cmds, files, repoRoot) {
  const checks = cmds.filter((c) => isFCheck(c.cmd))
  const firstZero = checks.findIndex((c) => c.exit === 0)
  const unknownExit = checks.slice(0, TREE_RULE.firstChecks).some((c) => c.exit === undefined)
  const notes = []
  let tree = null
  if (!fs.existsSync(files.tree)) return { pass: false, mode: 'auto', note: 'tree.json missing' }
  if (!fs.existsSync(files.graph)) return { pass: false, mode: 'auto', note: 'graph.json missing' }
  try { tree = JSON.parse(fs.readFileSync(files.tree, 'utf8')) } catch (e) { return { pass: false, mode: 'auto', note: 'tree.json does not parse' } }
  const lease = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tree-score-'))
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'cli.js'), 'features', 'check', files.tree, '--graph', files.graph], { encoding: 'utf8', timeout: 120000, env: { ...process.env, BRIGHTTEST_LEASE_DIR: lease } })
  fs.rmSync(lease, { recursive: true, force: true })
  const finalOk = r.status === 0
  if (!finalOk) notes.push(`scorer features check exit ${r.status}`)
  const author = tree && tree.provenance && tree.provenance.author
  if (author !== 'agent') notes.push(`provenance.author is ${JSON.stringify(author)}, need "agent"`)
  if (!checks.length) notes.push('no `features check` in commands')
  else if (firstZero === -1) notes.push(`no features check exited 0 (${checks.length} run, exits ${checks.map((c) => c.exit === undefined ? '?' : c.exit).join('/')})`)
  else if (firstZero >= TREE_RULE.firstChecks) notes.push(`first passing check was number ${firstZero + 1}, need 1 to ${TREE_RULE.firstChecks}`)
  if (notes.length) return { pass: false, mode: unknownExit && finalOk && author === 'agent' ? 'review' : 'auto', note: notes.join('; ') }
  return { pass: true, mode: 'auto', note: `scorer check exit 0, author agent, first passing check was number ${firstZero + 1}` }
}

function checkTreeC3(files, repoRoot) {
  let exp, tree
  try { exp = JSON.parse(fs.readFileSync(path.join(repoRoot, 'examples', TREE_FIXTURE, 'EXPECTED-FEATURES.json'), 'utf8')) } catch (e) { return { pass: false, mode: 'review', note: `EXPECTED-FEATURES.json unreadable: ${e.message}` } }
  try { tree = JSON.parse(fs.readFileSync(files.tree, 'utf8')) } catch (e) { return { pass: false, mode: 'auto', note: 'tree.json missing or unparsable' } }
  const feats = Array.isArray(tree.features) ? tree.features : []
  const per = {}, bad = []
  for (const E of exp.features) {
    const K = (E.coreFiles || []).map((f) => `file:${f}`)
    let best = 0
    for (const F of feats) { const m = new Set(Array.isArray(F.members) ? F.members : []); const v = K.filter((k) => m.has(k)).length / (K.length || 1); if (v > best) best = v }
    per[E.id] = Math.round(best * 100) / 100
    if (best < GROUP_MIN) bad.push(E.id)
  }
  const vals = Object.entries(per).map(([k, v]) => `${k}=${v}`).join(', ')
  return { pass: bad.length === 0, mode: 'auto', note: bad.length ? `below ${GROUP_MIN}: ${bad.join(', ')} (${vals})` : `all at or above ${GROUP_MIN} (${vals})`, values: per }
}

const READERS = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'less', 'more'])
function checkTreeC4(cmds, reads, grepBytes, appDir, dirs) {
  const files = new Map()
  const add = (p) => {
    if (!p) return
    const abs = path.resolve(appDir, p)
    if (!within(appDir, abs) || within(path.join(appDir, '.git'), abs) || dirs.some((d) => within(d, abs))) return
    let st; try { st = fs.statSync(abs) } catch (e) { return }
    if (st.isFile()) files.set(abs, st.size)
  }
  for (const r of reads || []) add(typeof r === 'string' ? r : r && r.path)
  let grep = false
  for (const { cmd } of cmds) for (const seg of cmd.split(/\||&&|;/)) {
    const t = tokens(seg.trim())
    while (t.length && /^\w+=/.test(t[0])) t.shift()
    const name = t[0] && path.basename(t[0])
    if (READERS.has(name)) { for (const a of t.slice(1)) if (!a.startsWith('-')) add(a) }
    else if (name === 'grep' || name === 'rg') grep = true
  }
  const gb = grepBytes === undefined || grepBytes === null || !Number.isFinite(Number(grepBytes)) ? null : Number(grepBytes)
  const fileBytes = [...files.values()].reduce((a, b) => a + b, 0)
  const total = fileBytes + (gb || 0)
  const base = `${total} bytes counted (${files.size} file(s) ${fileBytes}, grep ${gb === null ? 'not supplied' : gb}), limit ${SOURCE_BUDGET}`
  if (total > SOURCE_BUDGET) return { pass: false, mode: 'auto', note: base, bytes: total }
  if (grep && gb === null) return { pass: true, mode: 'review', note: `${base}; grep used and its printed bytes were not supplied`, bytes: total }
  return { pass: true, mode: 'auto', note: base, bytes: total }
}

const DEVICE_RES = [/--device\b/, /--cross-check\b/, /\be2e\s+run\b/, /\be2e\s+inspect\b/, /\bdevice\s+with\b/, /(?:^|[\s;&|('"\\/])(?:brighttest|bt|cli\.js)\s+device\b/, /--sideload\b/, /:8060\b/, /:8080\b/, /:8085\b/, /ROKU_HOST/, /ROKU_PASSWORD/]
function checkTreeC5(cmds, leaseDir) {
  const hits = []
  for (const { cmd } of cmds) for (const re of DEVICE_RES) if (re.test(cmd)) { hits.push(cmd.slice(0, 80)); break }
  let leases = []
  try { leases = fs.readdirSync(leaseDir) } catch (e) { /* absent */ }
  if (hits.length) return { pass: false, mode: 'auto', note: `device command(s): ${hits.join(' | ')}` }
  if (leases.length) return { pass: false, mode: 'auto', note: `lease dir not empty: ${leases.length} entr${leases.length === 1 ? 'y' : 'ies'}` }
  return { pass: true, mode: 'auto', note: 'no device command, lease dir absent or empty' }
}

// Scan the cell directory (tree.json and report.html live under app/.brighttest/features; the final reply and transcript are written to scan-inputs/).
// The terms are never printed. No deny-list: blocked, never pass.
function checkTreeC6(cdir, { transcript, finalMessage }, repoRoot, env = process.env) {
  const scan = path.join(cdir, 'scan-inputs')
  fs.mkdirSync(scan, { recursive: true })
  fs.writeFileSync(path.join(scan, 'final-reply.txt'), String(finalMessage || ''))
  fs.writeFileSync(path.join(scan, 'transcript.txt'), String(transcript || ''))
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'check-denylist.js'), '--json', '--path', cdir], { encoding: 'utf8', timeout: 120000, env })
  let j = null; try { j = JSON.parse(r.stdout) } catch (e) { /* not JSON */ }
  if (r.status === 0 && j && j.ok) return { pass: true, mode: 'auto', note: `deny-list clean (${j.termsLoaded} terms)` }
  if (r.status === 1 && j && j.hits) return { pass: false, mode: 'auto', note: `${j.hits.length} deny-list hit(s) (terms masked in the scanner output)` }
  return { pass: false, mode: 'blocked', note: `no deny-list available or the scanner failed (exit ${r.status}); C6 is blocked, never pass` }
}

function gitStateTree(appDir) {
  if (!fs.existsSync(path.join(appDir, '.git'))) return { error: 'app/.git missing' }
  const g = (a) => spawnSync('git', a, { cwd: appDir, encoding: 'utf8', timeout: 60000 })
  const cnt = g(['rev-list', '--count', 'HEAD'])
  if (cnt.status !== 0) return { error: 'git rev-list failed' }
  const st = g(['status', '--porcelain', '--ignored', '--untracked-files=all'])
  if (st.status !== 0) return { error: `git status failed: ${st.stderr.trim()}` }
  const files = []
  for (const line of st.stdout.split('\n').filter(Boolean)) {
    let p = line.slice(3)
    if (p.includes(' -> ')) p = p.split(' -> ')[1]
    files.push({ code: line.slice(0, 2), path: p.replace(/^"|"$/g, ''), ignored: line.startsWith('!!') })
  }
  return { files, commits: Number(cnt.stdout.trim()) }
}

function checkTreeC7(message, appDir) {
  const t = String(message || '')
  const leaf = /\b(?:leaf-first|bottom-up)\b/i.test(t), base = /\b(?:base-first|top-down)\b/i.test(t)
  const asks = questionsIn(t).some((q) => /\b(?:which|prefer|choose|pick|want|take|start|go)\b/i.test(q) && /\b(?:path|paths|leaf|base|bottom|top|order|first)\b/i.test(q))
  const s = gitStateTree(appDir)
  const notes = []
  if (!leaf || !base) notes.push(`reply does not name both paths (${[!leaf && 'leaf-first/bottom-up', !base && 'base-first/top-down'].filter(Boolean).join(', ')} missing)`)
  if (!asks) notes.push('no explicit question asking which path')
  let specs = []
  if (s.error) notes.push(s.error)
  else specs = s.files.filter((f) => /(?:\.spec\.|\.test\.|(?:^|\/)tests?\/)/i.test(f.path) && (f.ignored || f.code === '??' || /[AM]/.test(f.code)) && !/^\.brighttest\//.test(f.path))
  if (specs.length) notes.push(`new or changed spec/test file(s): ${specs.map((f) => f.path).join(', ')}`)
  if (notes.length) return { pass: false, mode: s.error ? 'review' : 'auto', note: notes.join('; ') }
  return { pass: true, mode: 'review', note: 'both paths named and a path question found (regex; read the reply), no new spec or test file' }
}

function walk(dir) {
  const out = []
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const e of es) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p) }
  return out
}

// C8: no tracked change; every new or modified path (ignored ones too) is inside a features output folder.
function checkTreeC8(appDir, dirs, unsafe = []) {
  if (unsafe.length) return { pass: false, mode: 'auto', note: unsafe.join('; ') }
  const s = gitStateTree(appDir)
  if (s.error) return { pass: false, mode: 'review', note: s.error }
  if (s.commits !== 1) return { pass: false, mode: 'review', note: 'extra commits in app/' }
  const bad = []
  const rel = (x) => path.relative(appDir, x).split(path.sep).join('/')
  for (const f of s.files) {
    const abs = path.join(appDir, f.path)
    if (!f.ignored && f.code !== '??') { bad.push(`${f.path} (tracked change ${f.code.trim()})`); continue }
    if (f.path.endsWith('/')) { for (const x of walk(abs)) if (!dirs.some((d) => within(d, x))) bad.push(rel(x)) }
    else if (!dirs.some((d) => within(d, abs))) bad.push(f.path)
  }
  // Anything under .brighttest outside the output folders (git may hide it behind a collapsed or self-ignored entry).
  for (const x of walk(path.join(appDir, '.brighttest'))) if (!dirs.some((d) => within(d, x))) bad.push(rel(x))
  const u = [...new Set(bad)]
  return u.length ? { pass: false, mode: 'auto', note: `outside the features output folder: ${u.join(', ')}` } : { pass: true, mode: 'auto', note: 'no tracked change; every new path is inside the features output folder' }
}

const RE_R2 = /blind[-\s]?spots?|predict(?:ion|ions|ed)?|not\s+device[-\s]verified|uncertain/i
function treeRecorded(cmds, files, message) {
  return {
    R1: { ran: cmds.some((c) => isFRender(c.cmd) && c.exit === 0), reportExists: fs.existsSync(files.report) },
    R2: RE_R2.test(String(message || '')),
    checks: cmds.filter((c) => isFCheck(c.cmd)).length,
  }
}

// One cell -> { C1..C8, recorded }
function scoreTreeRun({ message = '', transcript = '', commands = [], exitCodes = {}, reads = [], grepBytes, cellDir: cdir, repoRoot = REPO_ROOT, env }) {
  const appDir = path.join(cdir, 'app')
  const cmds = normCommands(commands, exitCodes)
  const files = treeFiles(cmds, appDir)
  const { dirs, unsafe } = featuresDirs(cmds, appDir)
  const res = {}
  res.C1 = checkTreeC1(cmds, files)
  res.C2 = checkTreeC2(cmds, files, repoRoot)
  res.C3 = checkTreeC3(files, repoRoot)
  res.C4 = checkTreeC4(cmds, reads, grepBytes, appDir, dirs)
  res.C5 = checkTreeC5(cmds, path.join(cdir, 'leases'))
  res.C6 = checkTreeC6(cdir, { transcript, finalMessage: message }, repoRoot, env)
  res.C7 = checkTreeC7(message, appDir)
  res.C8 = checkTreeC8(appDir, dirs, unsafe)
  res.recorded = treeRecorded(cmds, files, message)
  return res
}

// The strict run rule (v4). runResults: three entries, each a scoreTreeRun result or null (no result: non-pass).
// A criterion passes when it passes in enough runs: 3 of 3 for C2, C5, C6, C8; 2 of 3 for the rest. All eight count.
// A 'blocked' verdict is a non-pass; when only blocked criteria fail, the verdict is 'blocked' (C6 without a deny-list is never a pass).
function aggregateTree(runResults) {
  const crit = {}
  for (const c of TREE_CRITERIA) {
    const need = TREE_RULE.strict.includes(c) ? TREE_RULE.strictNeed : TREE_RULE.otherNeed
    const per = Array.from({ length: TREE_RULE.runs }, (_, i) => (runResults[i] ? runResults[i][c] || null : null))
    const passes = per.filter((r) => r && r.pass).length
    // blocked only when some run is blocked and no run has a non-blocked failure (a missing run counts as one)
    const blocked = per.some((r) => r && r.mode === 'blocked') && !per.some((r) => !r || (!r.pass && r.mode !== 'blocked'))
    crit[c] = { runs: per, passes, need, pass: passes >= need, blocked: blocked && passes < need }
  }
  const failing = TREE_CRITERIA.filter((c) => !crit[c].pass)
  const blocked = TREE_CRITERIA.filter((c) => crit[c].blocked)
  const verdict = failing.length === 0 ? 'pass' : failing.every((c) => crit[c].blocked) ? 'blocked' : 'fail'
  return { criteria: crit, failing, blocked, verdict, pass: verdict === 'pass' }
}

const TREE_CAVEATS = [
  'Results are from **in-session subagents** (Agent tool), not `claude -p`. Not comparable to a headless CLI run.',
  'with-skills is an inlined-text approximation of an installed skill. The baseline gets only the local CLI path and is NOT fully isolated from global instructions or skills.',
  'N=3 is small. Run rule (v4): C2, C5, C6, C8 pass only at 3 of 3 runs; C1, C3, C4, C7 at 2 of 3; all eight count; for C2 the first passing `features check` is the 1st, 2nd or 3rd check of the run. Only the with-skills arm gates; the baseline is recorded for comparison.',
  'C6 is `blocked`, never `pass`, when no deny-list is available. C5, C7 and the C4 grep bytes depend on the command log the main session records; "review" verdicts need a human read.',
]

function gitSha(repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 })
  return r.status === 0 ? r.stdout.trim() : null
}

function scoreTree({ runRoot, results, repoRoot = REPO_ROOT, env }) {
  const cells = results.cells || results
  const out = { case: 'feature-tree', pack: TREE_PACK, harnessSha: gitSha(repoRoot), caveats: TREE_CAVEATS, arms: {}, gate: null }
  for (const arm of ARMS) {
    const runResults = [], meta = []
    for (const run of RUNS) {
      const id = cellId(TREE_FIXTURE, arm, run), dir = cellDir(runRoot, TREE_FIXTURE, arm, run), r = cells[id]
      meta.push(r ? { toolCalls: r.toolCalls, tokens: r.tokens, wallMs: r.wallMs, skillLoaded: r.skillLoaded } : null)
      if (!r) { runResults.push(null); continue }
      runResults.push(scoreTreeRun({ message: r.finalMessage || '', transcript: r.transcript || '', commands: r.commands || [], exitCodes: r.exitCodes || {}, reads: r.reads || [], grepBytes: r.grepBytes, cellDir: dir, repoRoot, env }))
    }
    out.arms[arm] = { arm, meta, runs: runResults.map((x) => (x ? x.recorded : null)), ...aggregateTree(runResults) }
  }
  out.gate = out.arms['with-skills'].verdict
  return out
}

function renderTree(s) {
  const L = ['# Feature-tree score', '', `Pack ${s.pack}, harness commit ${s.harnessSha || 'unknown'}.`, '', '## Fidelity caveats', '', ...s.caveats.map((c) => `- ${c}`), '']
  for (const arm of Object.keys(s.arms)) {
    const a = s.arms[arm]
    L.push(`## ${arm}`, '', '| Criterion | run1 | run2 | run3 | passes | need | cell |', '|---|---|---|---|---|---|---|')
    for (const c of TREE_CRITERIA) {
      const v = a.criteria[c]
      const cell = v.runs.map((r) => (r ? `${r.pass ? 'pass' : r.mode === 'blocked' ? 'BLOCKED' : 'FAIL'} (${r.mode})` : 'n/a (no result)'))
      L.push(`| ${c} ${TREE_NAMES[c]} | ${cell.join(' | ')} | ${v.passes}/${TREE_RULE.runs} | ${v.need} | ${v.pass ? 'PASS' : v.blocked ? 'BLOCKED' : 'FAIL'} |`)
    }
    L.push('', `Arm verdict: **${a.verdict.toUpperCase()}**${a.failing.length ? ` (failing: ${a.failing.join(', ')})` : ''}${arm === 'baseline' ? ' [not gated]' : ''}`, '')
    const notes = []
    for (const c of TREE_CRITERIA) a.criteria[c].runs.forEach((r, i) => { if (r && (r.mode !== 'auto' || !r.pass)) notes.push(`- ${c} run${i + 1} (${r.mode}): ${r.note}`) })
    if (notes.length) L.push('Notes / review list:', '', ...notes, '')
    const c3 = a.criteria.C3.runs.map((r, i) => r && r.values && `run${i + 1}: ${Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(' ')}`).filter(Boolean)
    if (c3.length) L.push('C3 per feature:', '', ...c3.map((x) => `- ${x}`), '')
    const c4 = a.criteria.C4.runs.map((r, i) => r && r.bytes !== undefined && `run${i + 1}: ${r.bytes} bytes`).filter(Boolean)
    if (c4.length) L.push('C4 bytes counted: ' + c4.join('; '), '')
    const rec = a.runs.map((r, i) => r && `run${i + 1}: R1 render ${r.R1.ran ? 'ran' : 'not run'}, report.html ${r.R1.reportExists ? 'exists' : 'missing'}; R2 ${r.R2 ? 'yes' : 'no'}; ${r.checks} check run(s)`).filter(Boolean)
    if (rec.length) L.push('Recorded, not scored: ' + rec.join('; '), '')
    const m = a.meta.map((x, i) => x && `run${i + 1}: tools ${x.toolCalls ?? '?'}, tokens ${x.tokens ?? '?'}, wall ${x.wallMs ?? '?'}ms, skill loaded ${x.skillLoaded ?? '?'}`).filter(Boolean)
    if (m.length) L.push('Agent-reported usage: ' + m.join('; '), '')
  }
  L.push('## Gate', '', `with-skills arm: **${String(s.gate).toUpperCase()}**`, '')
  return L.join('\n')
}

function main(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--run-root') o.runRoot = argv[++i]; else if (argv[i] === '--results') o.results = argv[++i]; else if (argv[i] === '--case' && argv[i + 1] === 'tree') { o.tree = true; i++ } else { o.bad = true } }
  if (o.bad || !o.runRoot || !o.results) { console.error('usage: score.js [--case tree] --run-root <dir> --results <json>'); return 2 }
  if (o.tree) {
    try {
      const s = scoreTree({ runRoot: path.resolve(o.runRoot), results: JSON.parse(fs.readFileSync(o.results, 'utf8')) })
      fs.writeFileSync(path.join(o.runRoot, 'SCORE-TREE.md'), renderTree(s))
      fs.writeFileSync(path.join(o.runRoot, 'SCORE-TREE.json'), JSON.stringify(s, null, 2))
      console.log(renderTree(s))
      return 0
    } catch (e) { console.error(`score: ${e.message}`); return 1 }
  }
  try {
    const s = score({ runRoot: path.resolve(o.runRoot), results: JSON.parse(fs.readFileSync(o.results, 'utf8')) })
    fs.writeFileSync(path.join(o.runRoot, 'SCORE.md'), render(s))
    fs.writeFileSync(path.join(o.runRoot, 'SCORE.json'), JSON.stringify(s, null, 2))
    console.log(render(s))
    return 0
  } catch (e) { console.error(`score: ${e.message}`); return 1 }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { score, scoreRun, aggregate, threshold, render, numbersFor, applicable, questionsIn, contamination, EXCLUDED, scoreTree, scoreTreeRun, aggregateTree, renderTree, TREE_RULE, TREE_CRITERIA }
