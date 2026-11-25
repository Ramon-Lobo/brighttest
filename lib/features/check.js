'use strict'
// `features check`: validates a brighttest-feature-tree/v1 document against its graph (rules V1-V9). Pure function of
// plain data; no file, process or network access (the command wiring in index.js reads the two files).
//
//   validate(tree, graph, { partial }) -> { schema, ok, errors, warnings, findings[], agentJudgement[] }
//   finding: { severity: 'error'|'warning', rule: 'V1'..'V9', code, pointer: '/features/3/members/2', message }
//
// Errors block the render; warnings only show in a banner. The validator never throws on a malformed tree: a rule that
// cannot run on a broken part skips it, and V1 reports the break.

const fs = require('node:fs')
const path = require('node:path')
const S = require('./schema')
const { classRank } = require('./testability')
const { hashGraph } = require('./graph')

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'
const ptr = (...parts) => '/' + parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')

// Same absolute-path pattern as lib/assess.js (PATH_RE, not exported there).
const PATH_RE = /(?<![\w.:/\\<>-])(?:\\\\[^\s\\/:'"`()<>]+[\\/]|[A-Za-z]:[\\/]|[\\/](?=[^\s\\/]))(?:[^\\/:'"`()<>\r\n]+[\\/])*(?:[^\s\\/:'"`()<>]+)?/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const CRED_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/i
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i
const TOKEN_RE = /[A-Za-z0-9+/]{32,}/
const HTML_RE = /<\/?[A-Za-z!?][^>]*>?/

function unsafeText(s) {
  if (CONTROL_RE.test(s)) return 'control characters'
  if (HTML_RE.test(s)) return 'HTML markup (text must be plain)'
  if (PATH_RE.test(s)) return 'an absolute path'
  if (CRED_URL_RE.test(s)) return 'a URL with credentials'
  if (BEARER_RE.test(s)) return 'a Bearer token'
  if (TOKEN_RE.test(s)) return 'a long token-like string'
  return null
}

function validate(tree, graph, opts = {}) {
  const findings = []
  const agentJudgement = []
  const add = (severity, rule, code, pointer, message) => findings.push({ severity, rule, code, pointer, message })
  const err = (rule, code, pointer, message) => add('error', rule, code, pointer, message)
  const warn = (rule, code, pointer, message) => add('warning', rule, code, pointer, message)

  const nodes = new Map()
  for (const n of (graph && graph.nodes) || []) if (n && isStr(n.id)) nodes.set(n.id, n)
  const edges = (graph && graph.edges) || []

  if (!isObj(tree)) {
    err('V1', 'schema', '', 'the tree must be a JSON object')
    return result(findings, agentJudgement)
  }

  // ---- V1: shape, types, enums, caps ----------------------------------------------------------------------------
  const texts = [] // [pointer, string] for V8
  const unknownKeys = (o, allowed, at) => { for (const k of Object.keys(o).sort()) if (!allowed.includes(k)) err('V1', 'schema', ptr(...at, k), k === 'dependsOn' ? 'dependsOn is computed from the graph, not authored' : `unknown key ${k}`) }
  const reqStr = (o, k, at, max) => {
    const v = o[k]
    if (!isStr(v) || v === '') { err('V1', 'schema', ptr(...at, k), `${k} must be a non-empty string`); return false }
    if (max && v.length > max) err('V1', 'too-long', ptr(...at, k), `${k} is ${v.length} characters; the limit is ${max}`)
    texts.push([ptr(...at, k), v])
    return true
  }
  const optStr = (o, k, at, max) => { if (o[k] === undefined) return; reqStr(o, k, at, max) }
  const strArray = (v, at) => {
    if (!Array.isArray(v)) { err('V1', 'schema', ptr(...at), 'must be an array'); return [] }
    v.forEach((x, i) => { if (!isStr(x) || x === '') err('V1', 'schema', ptr(...at, i), 'must be a non-empty string') })
    return v
  }

  unknownKeys(tree, S.KEYS.tree, [])
  if (tree.schema !== S.TREE_SCHEMA) err('V1', 'schema', '/schema', `schema must be ${S.TREE_SCHEMA}`)
  if (!isObj(tree.graph)) err('V1', 'schema', '/graph', 'graph must be an object with hash and treeHash')
  else { unknownKeys(tree.graph, S.KEYS.graph, ['graph']); for (const k of S.KEYS.graph) if (!isStr(tree.graph[k]) || !tree.graph[k]) err('V1', 'schema', ptr('graph', k), `${k} must be a non-empty string`) }
  if (!isObj(tree.provenance)) err('V1', 'schema', '/provenance', 'provenance must be an object')
  else { unknownKeys(tree.provenance, S.KEYS.provenance, ['provenance']); reqStr(tree.provenance, 'author', ['provenance'], 60); optStr(tree.provenance, 'createdFrom', ['provenance'], 60) }

  const features = Array.isArray(tree.features) ? tree.features : (err('V1', 'schema', '/features', 'features must be an array'), [])
  if (features.length > S.CAPS.features) err('V1', 'too-many', '/features', `${features.length} features; the limit is ${S.CAPS.features}`)
  const ignored = tree.ignored === undefined ? [] : Array.isArray(tree.ignored) ? tree.ignored : (err('V1', 'schema', '/ignored', 'ignored must be an array'), [])

  features.forEach((f, i) => {
    const at = ['features', i]
    if (!isObj(f)) { err('V1', 'schema', ptr(...at), 'a feature must be an object'); return }
    unknownKeys(f, S.KEYS.feature, at)
    reqStr(f, 'id', at); reqStr(f, 'name', at, S.CAPS.name); reqStr(f, 'summary', at, S.CAPS.summary); optStr(f, 'notes', at, S.CAPS.notes)
    if (!S.KINDS.includes(f.kind)) err('V1', 'schema', ptr(...at, 'kind'), `kind must be one of ${S.KINDS.join(', ')}`)
    if (!S.RISKS.includes(f.risk)) err('V1', 'schema', ptr(...at, 'risk'), `risk must be one of ${S.RISKS.join(', ')}`)
    if (strArray(f.members, [...at, 'members']).length === 0 && Array.isArray(f.members)) err('V1', 'schema', ptr(...at, 'members'), 'a feature needs at least one member')
    if (f.testability !== undefined) {
      if (!isObj(f.testability)) err('V1', 'schema', ptr(...at, 'testability'), 'testability must be an object')
      else {
        unknownKeys(f.testability, S.KEYS.testability, [...at, 'testability'])
        if (!Array.isArray(f.testability.overrides)) err('V1', 'schema', ptr(...at, 'testability', 'overrides'), 'overrides must be an array')
        else f.testability.overrides.forEach((o, j) => {
          const oat = [...at, 'testability', 'overrides', j]
          if (!isObj(o)) { err('V1', 'schema', ptr(...oat), 'an override must be an object'); return }
          unknownKeys(o, S.KEYS.override, oat)
          reqStr(o, 'node', oat); reqStr(o, 'reason', oat, S.CAPS.reason); optStr(o, 'evidence', oat)
          if (!S.LANES.includes(o.class)) err('V1', 'schema', ptr(...oat, 'class'), `class must be one of ${S.LANES.join(', ')} (unknown is not a lane)`)
        })
      }
    }
    if (f.proposedTests !== undefined) {
      if (!Array.isArray(f.proposedTests)) err('V1', 'schema', ptr(...at, 'proposedTests'), 'proposedTests must be an array')
      else {
        if (f.proposedTests.length > S.CAPS.proposedTestsPerFeature) err('V1', 'too-many', ptr(...at, 'proposedTests'), `${f.proposedTests.length} proposed tests; the limit is ${S.CAPS.proposedTestsPerFeature}`)
        f.proposedTests.forEach((t, j) => {
          const tat = [...at, 'proposedTests', j]
          if (!isObj(t)) { err('V1', 'schema', ptr(...tat), 'a proposed test must be an object'); return }
          unknownKeys(t, S.KEYS.proposedTest, tat)
          reqStr(t, 'target', tat); reqStr(t, 'title', tat, S.CAPS.name * 2); reqStr(t, 'why', tat, S.CAPS.why)
          if (!S.LANES.includes(t.lane)) err('V1', 'schema', ptr(...tat, 'lane'), `lane must be one of ${S.LANES.join(', ')}`)
          if (t.needs !== undefined) {
            if (!Array.isArray(t.needs)) err('V1', 'schema', ptr(...tat, 'needs'), 'needs must be an array')
            else t.needs.forEach((n, k) => { if (!S.NEEDS.includes(n)) err('V1', 'schema', ptr(...tat, 'needs', k), `needs must be one of ${S.NEEDS.join(', ')}`) })
          }
        })
      }
    }
  })
  ignored.forEach((g, i) => {
    const at = ['ignored', i]
    if (!isObj(g)) { err('V1', 'schema', ptr(...at), 'an ignored entry must be an object'); return }
    unknownKeys(g, S.KEYS.ignored, at); strArray(g.members, [...at, 'members']); reqStr(g, 'reason', at, S.CAPS.reason)
  })

  // ---- V9: paths ------------------------------------------------------------------------------------------------
  if (!isObj(tree.paths)) err('V9', 'bad-path', '/paths', 'paths must be an object with recommended and reason')
  else {
    unknownKeys(tree.paths, S.KEYS.paths, ['paths'])
    if (!S.PATHS.includes(tree.paths.recommended)) err('V9', 'bad-path', '/paths/recommended', `recommended must be one of ${S.PATHS.join(', ')}`)
    if (!isStr(tree.paths.reason) || tree.paths.reason.trim() === '') err('V9', 'bad-path', '/paths/reason', 'reason is required')
    else { if (tree.paths.reason.length > S.CAPS.reason) err('V1', 'too-long', '/paths/reason', `reason is ${tree.paths.reason.length} characters; the limit is ${S.CAPS.reason}`); texts.push(['/paths/reason', tree.paths.reason]) }
  }

  // ---- V2: binding ------------------------------------------------------------------------------------------------
  if (isObj(tree.graph)) {
    const real = graph && graph.hash
    if (isStr(tree.graph.hash) && tree.graph.hash !== real) err('V2', 'stale-graph', '/graph/hash', 'the tree was written for a different graph (stale-graph); run features graph again and re-map')
    const th = graph && graph.scan && graph.scan.treeHash
    if (isStr(tree.graph.treeHash) && tree.graph.treeHash !== th) err('V2', 'stale-graph', '/graph/treeHash', 'the tree quotes a different project treeHash than the graph (stale-graph)')
  }
  if (graph && graph.hash) {
    let again = null
    try { again = hashGraph(graph) } catch (e) { /* malformed graph: reported below */ }
    if (again !== graph.hash) err('V2', 'graph-hash', '/graph/hash', 'the graph file does not match its own hash (edited after it was written)')
  }

  // ---- V5: ids ----------------------------------------------------------------------------------------------------
  const seenId = new Map()
  features.forEach((f, i) => {
    if (!isObj(f) || !isStr(f.id)) return
    if (!S.SLUG_RE.test(f.id)) err('V5', 'bad-id', ptr('features', i, 'id'), `id must match ${S.SLUG_RE.source}`)
    if (seenId.has(f.id)) err('V5', 'duplicate-id', ptr('features', i, 'id'), `id ${f.id} is also used by feature ${seenId.get(f.id)}`)
    else seenId.set(f.id, i)
  })

  // ---- V3 / V4: members -------------------------------------------------------------------------------------------
  const owner = new Map() // node id -> first place that claims it
  const claim = (id, where, pointer) => {
    if (owner.has(id)) err('V3', 'duplicate-member', pointer, `${id} is already assigned by ${owner.get(id)}`)
    else owner.set(id, where)
  }
  const featureOf = new Map() // node id -> feature index
  features.forEach((f, i) => {
    if (!isObj(f) || !Array.isArray(f.members)) return
    f.members.forEach((m, j) => {
      if (!isStr(m)) return
      const p = ptr('features', i, 'members', j)
      if (!nodes.has(m)) { err('V4', 'unknown-member', p, `${m} is not a node of the graph`); return }
      if (nodes.get(m).kind === 'file') claim(m, `feature ${isStr(f.id) ? f.id : i}`, p)
      else if (featureOf.has(m)) err('V3', 'duplicate-member', p, `${m} is already in feature ${featureOf.get(m)}`)
      featureOf.set(m, isStr(f.id) ? f.id : String(i))
    })
  })
  const featureIdx = new Map()
  features.forEach((f, i) => { if (isObj(f) && Array.isArray(f.members)) for (const m of f.members) if (isStr(m) && !featureIdx.has(m)) featureIdx.set(m, i) })
  ignored.forEach((g, i) => {
    if (!isObj(g) || !Array.isArray(g.members)) return
    g.members.forEach((m, j) => {
      if (!isStr(m)) return
      const p = ptr('ignored', i, 'members', j)
      if (!nodes.has(m)) { err('V4', 'unknown-member', p, `${m} is not a node of the graph`); return }
      if (nodes.get(m).kind === 'file') claim(m, `ignored entry ${i}`, p)
      else if (featureIdx.has(m)) err('V3', 'duplicate-member', p, `${m} is also in a feature`)
      if (!featureIdx.has(m)) featureIdx.set(m, 'ignored:' + i)
    })
  })
  if (!opts.partial) {
    const missing = [...nodes.values()].filter((n) => n.kind === 'file' && !owner.has(n.id)).map((n) => n.id).sort(cmp)
    for (const id of missing.slice(0, 50)) err('V3', 'unassigned-file', '/features', `${id} is in no feature and not ignored`)
    if (missing.length > 50) err('V3', 'unassigned-file', '/features', `${missing.length - 50} more unassigned files`)
  }
  for (const n of nodes.values()) {
    if (n.kind !== 'component' || !isStr(n.file)) continue
    const fid = `file:${n.file}`
    const a = featureIdx.get(n.id); const b = featureIdx.get(fid)
    if (a !== undefined && b !== undefined && a !== b) err('V4', 'split-component', ptr('features', typeof a === 'number' ? a : 'ignored'), `${n.id} and its file ${fid} must be in the same feature`)
  }

  // ---- V6: overrides ----------------------------------------------------------------------------------------------
  const overridden = new Set()
  const ruleClass = (n) => (n && n.testability && n.testability.primary && n.testability.primary.class) || 'unknown'
  const specFile = (ev) => { const id = ev.startsWith('file:') ? ev : `file:${ev}`; const n = nodes.get(id); return !!n && n.kind === 'file' && !!n.spec }
  features.forEach((f, i) => {
    if (!isObj(f) || !isObj(f.testability) || !Array.isArray(f.testability.overrides)) return
    f.testability.overrides.forEach((o, j) => {
      if (!isObj(o) || !isStr(o.node)) return
      const p = ptr('features', i, 'testability', 'overrides', j)
      const n = nodes.get(o.node)
      if (!n) { err('V6', 'bad-override', `${p}/node`, `${o.node} is not a node of the graph`); return }
      overridden.add(o.node)
      if (!S.LANES.includes(o.class)) return
      const rc = ruleClass(n)
      const ev = isStr(o.evidence) ? o.evidence : ''
      const evOk = ev !== '' && (/^run:\S+/.test(ev) || specFile(ev))
      if (rc === 'unknown') { agentJudgement.push(o.node); return }
      if (classRank(o.class) < classRank(rc)) {
        if (ev === '') err('V6', 'bad-override', `${p}/evidence`, `${o.node} is ${rc} by rule; a cheaper class (${o.class}) needs evidence (a spec path in the graph, or run:<junit file>)`)
        else if (!evOk) err('V6', 'bad-override', `${p}/evidence`, `evidence ${ev} is neither a spec file of the graph nor run:<junit file>`)
      } else if (ev !== '' && !evOk) err('V6', 'bad-override', `${p}/evidence`, `evidence ${ev} is neither a spec file of the graph nor run:<junit file>`)
    })
  })

  // ---- V7: proposed tests -----------------------------------------------------------------------------------------
  const scriptFrom = new Set(edges.filter((e) => e && e.kind === 'script').map((e) => e.from))
  features.forEach((f, i) => {
    if (!isObj(f) || !Array.isArray(f.proposedTests)) return
    f.proposedTests.forEach((t, j) => {
      if (!isObj(t) || !isStr(t.target)) return
      const p = ptr('features', i, 'proposedTests', j)
      const n = nodes.get(t.target)
      if (!n) { err('V7', 'bad-test', `${p}/target`, `${t.target} is not a node of the graph`); return }
      if (n.kind !== 'file' && n.kind !== 'component') { err('V7', 'bad-test', `${p}/target`, `${t.target} is a ${n.kind} node; tests target files or components`); return }
      if (t.lane === 'headless-unit' && n.kind === 'component' && n.inlineCdata && !scriptFrom.has(n.id)) err('V7', 'bad-test', `${p}/lane`, `${t.target} has only inline CDATA script; headless-unit cannot reach it`)
      if (ruleClass(n) === 'unknown' && !overridden.has(t.target)) warn('V7', 'not-classified', `${p}/target`, `${t.target}: node not classified (no rule fired and no override); the lane is a guess`)
    })
  })

  // ---- V8: text hygiene -------------------------------------------------------------------------------------------
  for (const [pointer, s] of texts) {
    if (/\/(id|node|target|members\/\d+)$/.test(pointer)) continue // graph ids are checked by V4/V6/V7
    const why = (/\/evidence$/.test(pointer) && /^run:([\\/]|[A-Za-z]:)/.test(s)) ? 'an absolute path' : unsafeText(s)
    if (why) err('V8', 'unsafe-text', pointer, `contains ${why}`)
  }

  return result(findings, agentJudgement)
}

function result(findings, agentJudgement) {
  const order = { error: 0, warning: 1 }
  findings.sort((a, b) => order[a.severity] - order[b.severity] || cmp(a.rule, b.rule) || cmp(a.pointer, b.pointer) || cmp(a.message, b.message))
  const errors = findings.filter((f) => f.severity === 'error').length
  return { schema: S.CHECK_SCHEMA, ok: errors === 0, errors, warnings: findings.length - errors, findings, agentJudgement: [...new Set(agentJudgement)].sort(cmp) }
}

// ---- command ------------------------------------------------------------------------------------------------------
const MAX_INPUT = 32 * 1024 * 1024
function readJson(file, what, UsageError) {
  let st
  try { st = fs.statSync(file) } catch (e) { throw new UsageError(`cannot read ${what} ${file}: ${e.code || e.message}`) }
  if (!st.isFile()) throw new UsageError(`${what} ${file} is not a file`)
  if (st.size > MAX_INPUT) throw new UsageError(`${what} ${file} is larger than ${MAX_INPUT} bytes`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new UsageError(`${what} ${file} is not valid JSON`) }
}

function human(r, treeFile) {
  const L = [`brighttest features check (${r.schema}): ${treeFile}`]
  for (const f of r.findings) L.push(`  ${f.severity === 'error' ? 'error  ' : 'warning'} ${f.rule} ${f.code} ${f.pointer || '/'}: ${f.message}`)
  for (const n of r.agentJudgement) L.push(`  note    V6 agent judgement: ${n} has no rule class, the override is the agent's call`)
  L.push(r.ok ? `ok: ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : `invalid: ${r.errors} error${r.errors === 1 ? '' : 's'}, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}`)
  return L.join('\n') + '\n'
}

// o: { dir (tree file), graph, json, partial }. Returns the exit code; findings are not a usage error.
function runCheck(o, io, UsageError) {
  let treeFile = o.dir ? path.resolve(o.dir) : null
  if (!treeFile) {
    let staging = path.join(path.resolve('.'), '.brighttest')
    try { staging = require('../config').loadConfig(path.resolve('.')).stagingDir } catch (e) { /* default */ }
    treeFile = path.join(staging, 'features', 'tree.json')
  }
  const graphFile = o.graph ? path.resolve(o.graph) : path.join(path.dirname(treeFile), 'graph.json')
  const tree = readJson(treeFile, 'tree', UsageError)
  const graph = readJson(graphFile, 'graph', UsageError)
  if (!isObj(graph) || graph.schema !== S.GRAPH_SCHEMA || !Array.isArray(graph.nodes)) throw new UsageError(`graph ${graphFile} is not a ${S.GRAPH_SCHEMA} document`)
  const r = validate(tree, graph, { partial: !!o.partial })
  io.stdout(o.json ? JSON.stringify(r, null, 2) + '\n' : human(r, treeFile))
  return r.ok ? S.EXIT.ok : S.EXIT.invalid
}

module.exports = { validate, unsafeText, runCheck }
