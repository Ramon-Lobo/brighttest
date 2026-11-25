#!/usr/bin/env node
'use strict'
// Score the T1 cells. Deterministic regex checks; every verdict is tagged "auto" or "review".
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { REPO_ROOT, FIXTURES, ARMS, RUNS, PLUGIN_TRUTH, C2_FIELDS, cellId, cellDir } = require('./common')

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

function main(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--run-root') o.runRoot = argv[++i]; else if (argv[i] === '--results') o.results = argv[++i]; else { o.bad = true } }
  if (o.bad || !o.runRoot || !o.results) { console.error('usage: score.js --run-root <dir> --results <json>'); return 2 }
  try {
    const s = score({ runRoot: path.resolve(o.runRoot), results: JSON.parse(fs.readFileSync(o.results, 'utf8')) })
    fs.writeFileSync(path.join(o.runRoot, 'SCORE.md'), render(s))
    fs.writeFileSync(path.join(o.runRoot, 'SCORE.json'), JSON.stringify(s, null, 2))
    console.log(render(s))
    return 0
  } catch (e) { console.error(`score: ${e.message}`); return 1 }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { score, scoreRun, aggregate, threshold, render, numbersFor, applicable, questionsIn, contamination, EXCLUDED }
