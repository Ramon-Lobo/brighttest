'use strict'
// brighttest feature graph core.
//
//   buildGraph(rootDir, { config }) -> Promise<graph>     graph.schema === 'brighttest-feature-graph/v1'
//   canonicalJson(value)            -> string              sorted keys, no whitespace
//   hashGraph(graph)                -> string              sha256 of the canonical JSON without the `hash` and `app` fields
//
// The graph is a pure function of the project tree: no clock, no absolute paths, no randomness. It reuses the census
// parse through the census `onFile` hook (no second parse; no AST node is retained) and reads spec files in a light second pass.
// Every read goes through the census `safeRead` (ADR 0032).
//
// Nodes file, component, builtin, global, registry, entry; edges extends, script, import, child, creates, runs-task, entry,
// global-read, global-write, registry, spec-covers, calls, callfunc, observes; scope resolution (a component's scope is its
// script closure through extends, nearest level wins; the source scope is source/**); purity (lib/features/testability.js)
// and testability records on nodes; uncertainty kinds dynamic-createobject, dynamic-global, dynamic-callfunc,
// dynamic-observe, ambiguous-call, ambiguous-callfunc, unresolved-script, unresolved-import, unresolved-call,
// unresolved-component, inline-cdata, eval, parse-error, not-read, truncated, bs-const-branch, component-library, nested-manifests, bsconfig-plugins, bsconfig-files, plus blindSpots.
// NOT here (later slices): SCC, clusters, `suggested`.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const bsc = require('brighterscript')
const census = require('../instrument/census')
const receiver = require('../instrument/receiver')
const assess = require('../assess')
const { mergedInstrumentExclude } = require('../config')
const { makeMatcher, DEFAULT_EXCLUDE, SCENE_BUILTINS, NON_SCENE_BUILTINS } = require('../instrument/plugin')

const testability = require('./testability')
const { nestedManifests, nestedHint } = require('./nested')
const { bsconfigUncertainty } = require('./bsconfig')

const { createVisitor, WalkMode, ParseMode, isLiteralString, isCallExpression, isFunctionExpression, isAALiteralExpression,
  isDottedSetStatement, isAssignmentStatement, isFunctionStatement, isMethodStatement, isNamespaceStatement, isDottedGetExpression } = bsc

const SCHEMA = 'brighttest-feature-graph/v1'
const MAX_ITEMS = 200 // uncertainty examples per kind; counts stay exact
const KNOWN_BUILTINS = new Set([...SCENE_BUILTINS, ...NON_SCENE_BUILTINS])
const SCAN_DIRS = ['source', 'components']
const lc = (s) => String(s || '').toLowerCase()
// BrightScript string literal text -> value: strip the quotes and unescape ""
const unq = (s) => String(s).replace(/^"|"$/g, '').replace(/""/g, '"')
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isTestFile = (p) => /(^|\/)tests?\//i.test(p) || /\.spec\.[^/]*$/i.test(p)
const SECRET = /(^\.env($|\.))|\.(pem|p12|pkg|key)$|^id_rsa/i
// Classes whose behaviour needs a device or a store fixture (testability inputs for later slices; a fixed short list).
const DEVICE_CLASSES = new Set(['rourltransfer', 'rochannelstore', 'rodeviceinfo', 'roappmanager', 'roinput', 'rovideoplayer', 'roaudioplayer', 'roappinfo', 'rohdmistatus', 'rotexturemanager'])

// bsc's global function table (a dist/ path of the 0.73 line): feature-detected, never required to load.
// Without it every call to a built-in comes out unresolved (counted, never thrown or dropped).
function loadBuiltinCallables() {
  try {
    const g = require('brighterscript/dist/globalCallables')
    const list = g && Array.isArray(g.globalCallables) ? g.globalCallables : []
    return new Set(list.map((c) => lc(c.name)))
  } catch (e) { return new Set() }
}

const BLIND_SPOTS = [
  'bsc plugins that generate code are not run; generated functions and components are not in the graph',
  'ropm prefix rewriting is not modelled; renamed library components appear as unresolved names',
  'component names built at runtime from strings are only reported as dynamic',
  'functions passed as strings to observeField in other components are not followed',
]

// ---- canonical JSON and hashing ---------------------------------------------------------------------------------
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
  return JSON.stringify(v === undefined ? null : v)
}
function hashGraph(g) {
  const { hash, app, ...rest } = g // eslint-disable-line no-unused-vars
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

// ---- assess treeHash (same lines and rule as lib/assess.js readTree, which is not exported) ----
const READ_RE = /(^|\/)(manifest|package\.json|package-lock\.json|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml)$|(^|\/)(bsconfig|brighttest)[^/]*\.json$|\.(brs|bs|xml)$|^\.gitignore$|^\.github\/workflows\/[^/]+\.ya?ml$/i
function treeHash(root, sc) {
  const lines = []
  for (const f of sc.files) {
    let h = '-'
    if (READ_RE.test(f.rel)) {
      const got = census.safeRead(path.join(root, f.rel))
      if (got.buf) h = crypto.createHash('sha256').update(got.buf).digest('hex')
    }
    lines.push(`${f.rel}\t${f.size}\t${h}`)
  }
  return { files: sc.files.length, skippedSensitive: sc.skippedSensitive, overCap: sc.overCap, truncated: sc.truncated, treeHash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex') }
}

// ---- XML (regex level, with line numbers and entity decoding) ----------------------------------------------------
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  })
}
const attrOf = (s, n) => { const m = new RegExp(`(?:^|\\s)${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(s); return m ? decode(m[1] !== undefined ? m[1] : m[2]) : null }
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

function parseXml(text) {
  const t = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\n]/g, ' '))
  const lower = t.toLowerCase()
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  const lineAt = (idx) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 } return lo + 1 }
  const out = { name: null, extends: null, line: 0, scripts: [], fields: [], functions: [], hasInterface: false, children: [] }
  let m; let inChildren = 0; let inInterface = false
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(t))) {
    const closing = m[1] === '/'; const tag = m[2]; const rest = m[3]; const ltag = tag.toLowerCase()
    const selfClose = /\/\s*$/.test(rest); const line = lineAt(m.index)
    if (closing) { if (ltag === 'children') inChildren = Math.max(0, inChildren - 1); else if (ltag === 'interface') inInterface = false; continue }
    if (ltag === 'component' && !out.name) { out.name = attrOf(rest, 'name'); out.extends = attrOf(rest, 'extends'); out.line = line; continue }
    if (ltag === 'interface') { out.hasInterface = true; inInterface = !selfClose; continue }
    if (ltag === 'children') { if (!selfClose) inChildren++; continue }
    if (inInterface) {
      if (ltag === 'field') out.fields.push({ id: attrOf(rest, 'id'), type: attrOf(rest, 'type'), onChange: attrOf(rest, 'onChange') })
      else if (ltag === 'function') out.functions.push(attrOf(rest, 'name'))
      continue
    }
    if (ltag === 'script') {
      const body = selfClose ? '' : text.slice(m.index + m[0].length, (lower.indexOf('</script>', m.index + m[0].length) + 1 || text.length + 1) - 1)
      out.scripts.push({ uri: attrOf(rest, 'uri'), line, cdata: /<!\[CDATA\[/.test(body) })
      continue
    }
    if (inChildren) out.children.push({ tag, id: attrOf(rest, 'id'), line })
  }
  return out
}

// ---- BrightScript per-file facts from the census parse (no ASTs kept) ---------------------------------------------
// Built-ins a pure function may call: arithmetic, string and conversion helpers with no state and no clock. Every other
// built-in (random numbers, files, blocking, dynamic code, the channel runtime, localization) makes its caller impure.
const PURE_BUILTINS = new Set(['abs', 'atn', 'cdbl', 'cint', 'cos', 'csng', 'exp', 'fix', 'int', 'log', 'sgn', 'sin', 'sqr', 'tan', 'type', 'box', 'findmemberfunction', 'strtoi', 'parsejson', 'formatjson', 'ucase', 'lcase', 'asc', 'chr', 'instr', 'left', 'len', 'mid', 'right', 'str', 'stri', 'string', 'stringi', 'val', 'substitute', 'tab', 'pos', 'asciitohex', 'hextoascii', 'hextointeger'])
const CLOCK_BUILTINS = new Set(['uptime'])
const CLOCK_CLASSES = new Set(['rodatetime', 'rotimespan'])
// CreateObject classes a pure function may use, plus the clock classes
const PURE_CLASSES = new Set(['roassociativearray', 'roarray', 'rolist', 'rostring', 'robytearray', 'roregex', 'rodatetime', 'roevpdigest', 'rohmac', 'roevpcipher', 'roxmlelement', 'rolonginteger', 'rotimespan'])
// methods on a receiver that change state outside the function
const IMPURE_METHODS = new Set(['callfunc', 'observefield', 'observefieldscoped', 'unobservefield', 'setfield', 'setfields', 'addfield', 'addfields', 'appendchild', 'createchild', 'removechild', 'insertchild', 'setfocus', 'update'])
const CERT_METHODS = new Set(['setcertificatesfile', 'initclientcertificates', 'setcertificatesdepth', 'enablehostverification', 'enablepeerverification'])

function collectBrs(pkg, text, ctx) {
  const { parsed, facts } = ctx
  const refs = parsed.parser.references
  const PM = ParseMode.BrighterScript
  const out = { functions: [], classes: [], imports: [], creates: [], runs: [], gReads: [], gWrites: [], scenes: [], registry: facts.registry.map((r) => ({ name: r.name === '<dynamic>' ? r.name : r.name.replace(/""/g, '"'), line: r.line })), ifs: [], keyHandler: false, network: false, platform: [],
    sgNode: false, evals: [], calls: [], news: [], callfuncs: [], observes: [], findNodes: [], findAssigns: [], createClasses: [], focus: [], waits: [], certs: [], launchArgs: [], impure: {}, clock: {}, locals: {} }
  const named = (fe) => !!(fe.parent && (isFunctionStatement(fe.parent) || isMethodStatement(fe.parent)) && fe.parent.name && fe.parent.name.text)
  // a function expression's key; an anonymous function inside a named one belongs to the named one
  const fnKeyOf = (fe) => {
    let f = fe
    while (!named(f)) { const up = f.parent && f.parent.findAncestor ? f.parent.findAncestor(isFunctionExpression) : null; if (!up) break; f = up }
    const st = f.parent; return `${st && st.name && st.name.text ? st.name.text : ''}@${f.range.start.line + 1}`
  }
  for (const f of refs.functionStatements || []) if (f.name) out.functions.push({ name: f.name.text, line: f.name.range.start.line + 1, key: f.func ? fnKeyOf(f.func) : `${f.name.text}@${f.name.range.start.line + 1}`, qname: f.getName(PM) })
  out.functions.sort((a, b) => a.line - b.line || cmp(a.name, b.name))
  for (const c of refs.classStatements || []) if (c.name) out.classes.push({ name: c.name.text, qname: c.getName(PM), line: c.name.range.start.line + 1 })
  out.keyHandler = out.functions.some((f) => lc(f.name) === 'onkeyevent')
  for (const imp of refs.importStatements || []) if (imp.filePath) out.imports.push({ path: imp.filePath, line: (imp.range ? imp.range.start.line : 0) + 1 })
  const line = (n) => n.range.start.line + 1
  // the enclosing function as a scalar key (name@line), never the AST node
  const fnOf = (n) => { const f = n.findAncestor(isFunctionExpression); return f ? fnKeyOf(f) : '' }
  const nsOf = (n) => { const ns = n.findAncestor(isNamespaceStatement); return ns ? ns.getName(PM) : '' }
  const isCallee = (e) => e.parent && isCallExpression(e.parent) && e.parent.callee === e
  const recvOfAssign = (call) => {
    const p = call.parent
    if (p && isDottedSetStatement(p) && p.value === call) return `${receiver.toText(p.obj) || '?'}.${p.name.text}`
    if (p && isAssignmentStatement(p) && p.value === call) return p.name.text
    return null
  }
  // a read of a field of the entry function's first parameter (Main or RunUserInterface: the launch arguments). The nearest
  // enclosing function that declares the receiver name decides, so a closure with its own parameter of that name does not count.
  const isLaunchArg = (e, obj) => {
    const rn = lc(receiver.toText(obj) || ''); if (!rn) return false
    let f = e.findAncestor(isFunctionExpression)
    while (f) {
      const ps = f.parameters || []
      if (ps.some((p) => p.name && lc(p.name.text) === rn)) {
        const st = f.parent
        return !!(named(f) && /^(main|runuserinterface)$/i.test(st.name.text) && ps[0] && ps[0].name && lc(ps[0].name.text) === rn)
      }
      f = f.parent && f.parent.findAncestor ? f.parent.findAncestor(isFunctionExpression) : null
    }
    return false
  }
  const nameArg = (a) => (a && isLiteralString(a) ? unq(a.token.text) : null)
  const bad = (fn, ln, why) => { if (!fn) return; const l = out.impure[fn] || (out.impure[fn] = []); if (!l.some((x) => x.why === why)) l.push({ line: ln, why }) }
  const tick = (fn, ln) => { if (!fn) return; const l = out.clock[fn] || (out.clock[fn] = []); l.push(ln) }
  const local = (fn, name) => { if (!fn) return; const l = out.locals[fn] || (out.locals[fn] = []); if (!l.includes(lc(name))) l.push(lc(name)) }
  // m.top.findNode("id") -> the literal id, else null
  const findNodeId = (v) => {
    if (!v || !isCallExpression(v) || !isDottedGetExpression(v.callee) || lc(v.callee.name.text) !== 'findnode') return null
    return { id: nameArg(v.args[0]), obj: receiver.toText(v.callee.obj) || '?' }
  }
  const addGlobalKeys = (call) => {
    const a = call.args[0]
    if (a && isAALiteralExpression(a)) for (const el of a.elements) { if (el.keyToken) out.gWrites.push({ name: unq(el.keyToken.text), line: el.keyToken.range.start.line + 1, detail: 'addFields' }) }
    else out.gWrites.push({ name: null, line: line(call), detail: 'addFields' })
  }
  parsed.ast.walk(createVisitor({
    FunctionExpression: (f) => { const k = fnKeyOf(f); for (const p of f.parameters || []) if (p.name) local(k, p.name.text) },
    AssignmentStatement: (s) => {
      local(fnOf(s), s.name.text)
      const fnd = findNodeId(s.value)
      if (fnd) out.findAssigns.push({ recv: s.name.text, id: fnd.id, obj: fnd.obj, line: line(s) })
    },
    VariableExpression: (e) => { if (lc(e.name.text) === 'm') bad(fnOf(e), line(e), 'uses m.') },
    NewExpression: (e) => {
      const fn = fnOf(e)
      const nm = e.className && e.className.getName ? e.className.getName(PM) : ''
      if (nm) out.news.push({ name: nm, line: line(e), fn, ns: nsOf(e) })
      bad(fn, line(e), `new ${nm}`)
    },
    CallExpression: (e) => {
      const c = e.callee
      const fn = fnOf(e)
      if (c.name && c.obj === undefined) {
        const nm = c.name.text; const ln = lc(nm)
        if (ln === 'createobject') {
          const cls = nameArg(e.args[0])
          if (cls === null) { out.creates.push({ line: line(e), name: null, fn, recv: recvOfAssign(e), what: 'CreateObject with a variable class name' }); bad(fn, line(e), 'CreateObject with a variable class'); return }
          const lcls = lc(cls)
          if (lcls === 'rosgnode') { out.sgNode = true; const n = nameArg(e.args[1]); out.creates.push({ line: line(e), name: n, fn, recv: recvOfAssign(e), what: 'CreateObject with a variable component name' }); bad(fn, line(e), 'CreateObject roSGNode') } else {
            out.createClasses.push({ cls, line: line(e) })
            if (DEVICE_CLASSES.has(lcls)) { if (!out.platform.includes(cls)) out.platform.push(cls); if (lcls === 'rourltransfer') out.network = true }
            if (CLOCK_CLASSES.has(lcls)) tick(fn, line(e))
            if (!PURE_CLASSES.has(lcls)) bad(fn, line(e), `CreateObject ${cls}`)
          }
          return
        }
        out.calls.push({ name: nm, line: line(e), fn, ns: nsOf(e) })
        if (CLOCK_BUILTINS.has(ln)) tick(fn, line(e))
        if (ln === 'sleep' || ln === 'wait') out.waits.push({ line: line(e) })
        if (ln === 'eval') out.evals.push({ line: line(e) })
        return
      }
      if (c.obj === undefined || !c.name) return
      const nm = lc(c.name.text)
      const rt = receiver.toText(c.obj)
      if (nm === 'createchild' && e.args.length) { out.creates.push({ line: line(e), name: nameArg(e.args[0]), fn, recv: recvOfAssign(e), what: 'createChild with a variable component name' }) }
      if (nm === 'createscene' && e.args.length) out.scenes.push({ line: line(e), name: nameArg(e.args[0]) })
      if (nm === 'addfields' && lc(rt) === 'm.global') addGlobalKeys(e)
      if (nm === 'callfunc') out.callfuncs.push({ line: line(e), col: e.range.start.character + 1, name: nameArg(e.args[0]), fn })
      if (nm === 'observefield' || nm === 'observefieldscoped') {
        const direct = findNodeId(c.obj)
        out.observes.push({ line: line(e), col: e.range.start.character + 1, recv: rt || (direct ? `${direct.obj}.findNode(${direct.id === null ? '?' : JSON.stringify(direct.id)})` : '<expression>'), direct: direct ? { id: direct.id, obj: direct.obj } : null, fn })
      }
      if ((nm === 'lookup' || nm === 'doesexist') && isLaunchArg(e, c.obj)) out.launchArgs.push({ line: line(e) })
      if (nm === 'findnode') out.findNodes.push({ line: line(e), id: nameArg(e.args[0]) })
      if (nm === 'setfocus') out.focus.push({ line: line(e), what: 'setFocus' })
      if (CERT_METHODS.has(nm)) out.certs.push({ line: line(e) })
      if (IMPURE_METHODS.has(nm)) bad(fn, line(e), `method ${c.name.text}`)
      // a possibly namespaced function call: ns.Fn(); only used when a function with that name exists
      if (rt && /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(rt) && lc(rt).split('.')[0] !== 'm') out.calls.push({ name: `${rt}.${c.name.text}`, line: line(e), fn, ns: nsOf(e), dotted: true })
    },
    DottedGetExpression: (e) => {
      if (isCallee(e)) return
      if (lc(receiver.toText(e.obj)) === 'm.global') out.gReads.push({ name: e.name.text, line: line(e), fn: fnOf(e) })
      const fn = fnOf(e)
      if (isLaunchArg(e, e.obj)) out.launchArgs.push({ line: line(e) })
    },
    DottedSetStatement: (s) => {
      if (lc(receiver.toText(s.obj)) === 'm.global') out.gWrites.push({ name: s.name.text, line: line(s) })
      else if (lc(s.name.text) === 'control' && isLiteralString(s.value) && lc(unq(s.value.token.text)) === 'run') out.runs.push({ line: line(s), fn: fnOf(s), recv: receiver.toText(s.obj) })
      if (lc(s.name.text) === 'focusable') out.focus.push({ line: line(s), what: 'focusable' })
      const fnd = findNodeId(s.value)
      if (fnd) out.findAssigns.push({ recv: `${receiver.toText(s.obj) || '?'}.${s.name.text}`, id: fnd.id, obj: fnd.obj, line: line(s) })
    },
    IndexedGetExpression: (e) => {
      if (lc(receiver.toText(e.obj)) === 'm.global') out.gReads.push({ name: null, line: line(e), fn: fnOf(e) })
      else if (isLaunchArg(e, e.obj)) out.launchArgs.push({ line: line(e) })
    },
    IndexedSetStatement: (s) => { if (lc(receiver.toText(s.obj)) === 'm.global') out.gWrites.push({ name: null, line: line(s) }) },
  }), { walkMode: WalkMode.visitAllRecursive })
  // a call to a name that the function itself holds in a variable or parameter is not a call to a named function
  out.calls = out.calls.filter((c) => {
    if (c.dotted || !(out.locals[c.fn] || []).includes(lc(c.name))) return true
    bad(c.fn, c.line, 'calls a function value')
    return false
  })
  // #if guards (bsc evaluates them against the manifest bs_const; this only records where they are)
  text.split('\n').forEach((ln, i) => {
    const m = /^\s*#(?:else\s*if|elseif|if)\s+(!?\s*[A-Za-z_]\w*)/i.exec(ln)
    if (m) out.ifs.push({ line: i + 1, name: m[1].replace(/^!\s*/, '') })
  })
  return out
}

// per-kind site tallies: a site is resolved when every outcome at it is name, exact or builtin; the rest are unresolved on purpose
// (a variable callFunc name, an ambiguous callee, an observeField receiver that is not m.top or a findNode of a known child)
function siteTally(edges) {
  const sites = new Map()
  for (const e of edges) {
    if (e.kind !== 'calls' && e.kind !== 'callfunc' && e.kind !== 'observes') continue
    const k = `${e.kind}|${e.at}|${e.col || ''}`
    sites.set(k, (sites.get(k) !== false) && (e.conf === 'name' || e.conf === 'exact' || e.conf === 'builtin'))
  }
  const by = { calls: { sites: 0, resolved: 0, unresolved: 0 }, callfunc: { sites: 0, resolved: 0, unresolved: 0 }, observes: { sites: 0, resolved: 0, unresolved: 0 } }
  for (const [k, ok] of sites) { const t = by[k.slice(0, k.indexOf('|'))]; t.sites++; if (ok) t.resolved++; else t.unresolved++ }
  return { by, total: sites.size, resolved: [...sites.values()].filter(Boolean).length }
}
// share of call, callFunc and observeField sites the graph resolved
function sitesPct(edges) {
  const t = siteTally(edges)
  return t.total ? Math.round((100 * t.resolved) / t.total) : 100
}

const manifestTitle = (text) => { const m = /^\s*title\s*=(.*)$/im.exec(text || ''); return m ? m[1].trim() : '' }
function manifestConsts(text) {
  const m = /^\s*bs_const\s*=(.*)$/im.exec(text || '')
  const out = {}
  if (m) for (const kv of m[1].split(';')) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim().toLowerCase() }
  return out
}

function loadConfigLoose(root, given) {
  if (given && typeof given === 'object') return given
  const explicit = typeof given === 'string' && given !== ''
  const got = census.safeRead(explicit ? path.resolve(root, given) : path.join(root, 'brighttest.json'), explicit ? { followLink: true, skipName: true } : {})
  if (!got.buf) return {}
  try { const c = JSON.parse(got.buf.toString('utf8')); return c && typeof c === 'object' && !Array.isArray(c) ? c : {} } catch (e) { return {} }
}

// Walk source/ and components/ under base: every regular file (relative posix path), plus symlinks (never followed).
function walkBase(base, skipDirs) {
  const files = []; const links = []
  const go = (rel) => {
    let ents
    try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }) } catch (e) { return }
    for (const e of ents) {
      const r = `${rel}/${e.name}`
      if (e.isSymbolicLink()) { links.push(r); continue }
      if (e.isDirectory()) { if (e.name.toLowerCase() === 'certs' || /^\.env($|\.)/i.test(e.name)) continue; go(r) } else if (e.isFile() && !SECRET.test(e.name)) files.push(r)
    }
  }
  for (const d of SCAN_DIRS) if (!skipDirs.has(d)) go(d)
  return { files: files.sort(), links: links.sort() }
}

// Spec roots outside source/ and components/: the conventional top-level test dirs (test, tests, spec, specs) plus the
// static leading directory of `testsFilePattern` (config; a pattern that starts with a wildcard, brace, `..`, or an
// absolute path adds none). Names are matched case-insensitively against the real directory entries and the real name is
// used in ids. A root is dropped when its real path is the project, leaves it, or equals or sits under source/ or
// components/ (those are walked already); roots are deduplicated by real path.
const CONVENTION_SPEC_ROOTS = ['test', 'tests', 'spec', 'specs']
const SPEC_FILE_CAP = 5000
const BRS_FILE = /\.(brs|bs)$/i
const SPEC_SKIP_DIRS = new Set(['node_modules', 'roku_modules', '.git'])
function patternLead(config) {
  const raw = config && typeof config.testsFilePattern === 'string' ? config.testsFilePattern.replace(/\\/g, '/') : ''
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return []
  const lead = []
  for (const sg of raw.replace(/^\.\//, '').split('/').slice(0, -1)) { if (!sg || sg === '.' || sg === '..' || /[*?{}[\]!()]/.test(sg)) break; lead.push(sg) }
  return lead
}
function resolveSpecRoots(base, config, isVendor) {
  let rb; try { rb = fs.realpathSync(base) } catch (e) { return [] }
  const real = (rel) => { try { return fs.realpathSync(path.join(base, rel)) } catch (e) { return null } }
  const under = (p, d) => p === d || p.startsWith(d + path.sep)
  const blocked = SCAN_DIRS.map((d) => real(d)).filter(Boolean)
  const pick = (dir, name) => { // every real entry of `dir` named `name` ignoring case (case-sensitive disks can hold both)
    let ents; try { ents = fs.readdirSync(path.join(base, dir)) } catch (e) { return [] }
    return ents.filter((n) => lc(n) === lc(name)).sort()
  }
  const expand = (segs) => segs.reduce((rels, sg) => rels.flatMap((rel) => pick(rel, sg).map((hit) => (rel ? `${rel}/${hit}` : hit))), [''])
  const wanted = CONVENTION_SPEC_ROOTS.map((n) => [n]); const lead = patternLead(config); if (lead.length) wanted.push(lead)
  const out = []; const seen = new Set()
  for (const rel of wanted.flatMap(expand)) {
    if (!rel) continue
    const rp = real(rel)
    if (!rp || rp === rb || !under(rp, rb) || blocked.some((d) => under(rp, d)) || seen.has(rp)) continue
    if (SCAN_DIRS.includes(rel.split('/')[0].toLowerCase())) continue
    // the real location must not sit in a vendor folder either (tests -> node_modules/pkg)
    const realRel = path.relative(rb, rp).split(path.sep).join('/')
    if (realRel.split('/').some((sg) => SPEC_SKIP_DIRS.has(lc(sg))) || isVendor(realRel) || isVendor(`${realRel}/x`)) continue
    seen.add(rp); out.push(rel)
  }
  return out
}
// Walk the spec roots: skips vendor dirs (node_modules etc. and anything the vendor matcher excludes), never follows
// symlinks, and stops at SPEC_FILE_CAP files. Returns { files, links, capped }.
function walkSpecRoots(base, roots, isVendor, isFileVendor) {
  const files = []; const links = []; let capped = false
  const go = (rel) => {
    if (capped) return
    let ents
    try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }) } catch (e) { return }
    ents.sort((x, y) => cmp(x.name, y.name))
    for (const e of ents) {
      const r = `${rel}/${e.name}`
      if (e.isSymbolicLink()) { if (BRS_FILE.test(e.name)) links.push(r); continue }
      if (e.isDirectory()) { if (SPEC_SKIP_DIRS.has(lc(e.name)) || e.name.toLowerCase() === 'certs' || /^\.env($|\.)/i.test(e.name) || isVendor(r) || isVendor(`${r}/x`)) continue; go(r); continue }
      // only .brs/.bs files count toward the cap, so fixtures and data files cannot starve the real specs
      if (e.isFile() && BRS_FILE.test(e.name) && !SECRET.test(e.name) && !isFileVendor(r)) { if (files.length >= SPEC_FILE_CAP) { capped = true; return } files.push(r) }
    }
  }
  for (const d of roots) go(d)
  return { files: files.sort(), links: links.sort(), capped }
}

// ---- the builder -------------------------------------------------------------------------------------------------
async function buildGraph(rootDir, opts = {}) {
  const root = path.resolve(rootDir)
  const xmlFiles = new Map() // rel -> { parsed, bytes }
  const brsFiles = new Map() // rel -> { data, bytes }
  const cen = await census.census(root, { config: opts.config, onFile: (pkg, ctx) => {
    const bytes = Buffer.byteLength(ctx.text)
    if (ctx.kind === 'xml') { if (ctx.component) xmlFiles.set(pkg, { x: parseXml(ctx.text), bytes }); else xmlFiles.set(pkg, { x: null, bytes }) } else brsFiles.set(pkg, { data: collectBrs(pkg, ctx.text, ctx), bytes })
  } })

  const config = loadConfigLoose(root, opts.config)
  const base = census.effectiveBase(root, config.rootDir, [])
  const isVendor = makeMatcher([...DEFAULT_EXCLUDE, ...mergedInstrumentExclude(config)])
  // a top-level source/ or components/ whose real path leaves the project root is reported by the census and never walked
  const escapedDirs = new Set(cen.skipped.filter((s) => s.kind === 'path-outside-root').map((s) => s.file))
  const walked = walkBase(base, escapedDirs)
  // spec files outside source/ and components/ (read only by the spec pass; they never join `known`)
  // DEFAULT_EXCLUDE drops `**/*.spec.*` (specs are not instrumented); here specs are the point, so that one entry is left out
  const isSpecVendor = makeMatcher([...DEFAULT_EXCLUDE.filter((g) => !/\.spec\./.test(g)), ...mergedInstrumentExclude(config)])
  // the rooibos-name patterns guard folders only here: a spec file may legitimately be named after rooibos
  const isSpecFileVendor = makeMatcher([...DEFAULT_EXCLUDE.filter((g) => !/\.spec\.|rooibos/.test(g)), ...mergedInstrumentExclude(config)])
  const specWalk = walkSpecRoots(base, resolveSpecRoots(base, config, isSpecVendor), isSpecVendor, isSpecFileVendor)
  const isBrs = (f) => /\.(brs|bs)$/i.test(f)
  const specFiles = [...new Set([...walked.files.filter((f) => isTestFile(f) && isBrs(f)), ...specWalk.files.filter(isBrs)])].sort()
  const known = new Map(walked.files.map((f) => [lc(f), f]))
  const manifest = escapedDirs.has('manifest') ? { refused: 'path-outside-root' } : census.safeRead(path.join(base, 'manifest'))
  const manifestText = manifest.buf ? manifest.buf.toString('utf8') : ''
  const consts = manifestConsts(manifestText)

  const nodes = new Map(); const edges = []; const unc = []
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id }
  const edge = (from, to, kind, conf, at, extra) => edges.push({ from, to, kind, conf, at, ...(extra || {}) })
  const uncertain = (kind, at, detail) => unc.push({ kind, at, detail })
  const uncSeen = new Set()
  const uncertainOnce = (kind, at, detail, candidates) => { const k = `${kind}\u0000${at}\u0000${detail}`; if (uncSeen.has(k)) return; uncSeen.add(k); unc.push({ kind, at, detail, ...(candidates ? { candidates } : {}) }) }

  // components
  const comps = new Map() // lc name -> { name, file, x }
  for (const rel of [...xmlFiles.keys()].sort()) { const e = xmlFiles.get(rel); if (e.x && e.x.name && !comps.has(lc(e.x.name))) comps.set(lc(e.x.name), { name: e.x.name, file: rel, x: e.x }) }
  const chainOf = (c) => { const out = []; const seen = new Set([lc(c.name)]); let n = c; while (n && n.x.extends && !seen.has(lc(n.x.extends))) { out.push(n.x.extends); seen.add(lc(n.x.extends)); n = comps.get(lc(n.x.extends)) } return out }
  const isTask = (c) => lc(c.x.extends) === 'task' || chainOf(c).some((n) => lc(n) === 'task')
  // app component -> comp:<Name>; known built-in -> builtin:<Name>; anything else is unresolved (to: null)
  const target = (name) => {
    const c = comps.get(lc(name)); if (c) return { id: `comp:${c.name}`, conf: 'name', comp: c }
    if (KNOWN_BUILTINS.has(lc(name))) return { id: addNode({ id: `builtin:${lc(name)}`, kind: 'builtin' }), conf: 'builtin' }
    return { id: null, conf: 'unresolved' }
  }
  const compEdge = (from, name, kind, at) => {
    const t = target(name)
    if (t.id === null) { edge(from, null, kind, 'unresolved', at, { detail: name }); uncertain('unresolved-component', at, name) } else edge(from, t.id, kind, t.conf, at)
  }

  // file nodes
  const fileNode = (rel, lang, bytes, extra) => addNode({ id: `file:${rel}`, kind: 'file', lang, bytes, vendor: !isTestFile(rel) && isVendor(rel), spec: isTestFile(rel), ...(extra || {}) })
  if (manifest.buf) addNode({ id: 'file:manifest', kind: 'file', lang: 'manifest', bytes: manifest.buf.length, vendor: false, spec: false })
  const fnIndex = new Map() // lc function name -> [rel] (non-spec files)
  const compScripts = new Map() // lc component name -> [rel of resolved brs/bs script files]

  for (const rel of [...brsFiles.keys()].sort()) {
    const { data, bytes } = brsFiles.get(rel)
    const facts = {}
    const uniq = (a) => [...new Set(a)]
    const gr = uniq(data.gReads.map((g) => g.name).filter(Boolean)).sort(); const gw = uniq(data.gWrites.map((g) => g.name).filter(Boolean)).sort()
    if (data.network) facts.network = true
    const reg = uniq(data.registry.map((r) => r.name).filter((n) => n !== '<dynamic>')); if (reg.length) facts.registry = reg
    if (gr.length) facts.globalsRead = gr
    if (gw.length) facts.globalsWritten = gw
    const cr = uniq(data.creates.slice().sort((a, b) => a.line - b.line).map((c) => c.name === null ? '<dynamic>' : c.name)); if (cr.length) facts.creates = cr
    if (data.keyHandler) facts.keyHandler = true
    if (data.platform.length) facts.platformObjects = data.platform.slice().sort()
    const guards = uniq(data.ifs.map((i) => i.name)); if (guards.length) facts.bsConstGuards = guards
    fileNode(rel, /\.bs$/i.test(rel) ? 'bs' : 'brs', bytes, { functions: data.functions, ...(Object.keys(facts).length ? { facts } : {}) })
    if (!isTestFile(rel)) for (const f of data.functions) { const k = lc(f.name); if (!fnIndex.has(k)) fnIndex.set(k, []); if (!fnIndex.get(k).includes(rel)) fnIndex.get(k).push(rel) }
  }

  for (const rel of [...xmlFiles.keys()].sort()) {
    const { x, bytes } = xmlFiles.get(rel)
    fileNode(rel, 'xml', bytes)
    if (!x || !x.name) continue
    const c = comps.get(lc(x.name)); if (!c || c.file !== rel) continue
    const id = `comp:${c.name}`; const chain = chainOf(c)
    const root0 = chain.length ? chain[chain.length - 1] : x.extends
    const rootIsApp = !root0 || comps.has(lc(root0))
    const builtinRoot = !rootIsApp && KNOWN_BUILTINS.has(lc(root0)) ? root0 : null
    const unresolvedRoot = !rootIsApp && !builtinRoot ? root0 : null
    const node = { id, kind: 'component', file: rel, extends: x.extends, builtinRoot, ...(unresolvedRoot ? { unresolvedRoot } : {}), isScene: [x.extends, ...chain].some((n) => SCENE_BUILTINS.includes(lc(n))), isTask: isTask(c) }
    if (node.isTask) node.thread = 'task'
    if (x.hasInterface) node.interface = { fields: x.fields.map((f) => ({ id: f.id, type: f.type, ...(f.onChange ? { onChange: f.onChange } : {}) })), functions: x.functions }
    node.children = x.children.map((k) => ({ tag: k.tag, id: k.id }))
    if (x.scripts.some((s) => s.cdata)) node.inlineCdata = true
    addNode(node)
    // extends
    if (x.extends) { const t = comps.get(lc(x.extends)); if (t) edge(id, `comp:${t.name}`, 'extends', 'exact', `${rel}:${x.line}`); else compEdge(id, x.extends, 'extends', `${rel}:${x.line}`) }
    // scripts
    const xmlDir = path.posix.dirname(rel)
    for (const s of x.scripts) {
      const at = `${rel}:${s.line}`
      if (!s.uri) { if (s.cdata) uncertain('inline-cdata', at, 'functions inside CDATA are invisible to the parser'); continue }
      let p = null
      if (/^pkg:\//i.test(s.uri)) p = s.uri.replace(/^pkg:\/+/i, ''); else if (!/^[a-z][a-z0-9+.-]*:/i.test(s.uri)) p = path.posix.normalize(path.posix.join(xmlDir, s.uri))
      const hit = p ? known.get(lc(p)) : null
      if (hit) { edge(`file:${rel}`, `file:${hit}`, 'script', 'exact', at); if (brsFiles.has(hit)) { const k = lc(c.name); if (!compScripts.has(k)) compScripts.set(k, []); compScripts.get(k).push(hit) } }
      else { edge(`file:${rel}`, null, 'script', 'unresolved', at, { detail: s.uri }); uncertain('unresolved-script', at, s.uri) }
    }
    // children
    for (const k of x.children) {
      compEdge(id, k.tag, 'child', `${rel}:${k.line}`)
      if (lc(k.tag) === 'componentlibrary') uncertain('component-library', `${rel}:${k.line}`, 'ComponentLibrary loads components at runtime')
    }
  }

  // BrightScript edges
  const isTaskName = (name) => { const c = name ? comps.get(lc(name)) : null; return !!c && isTask(c) }
  for (const rel of [...brsFiles.keys()].sort()) {
    const { data } = brsFiles.get(rel); const from = `file:${rel}`
    for (const imp of data.imports) {
      const at = `${rel}:${imp.line}`
      const p = /^pkg:\//i.test(imp.path) ? imp.path.replace(/^pkg:\/+/i, '') : path.posix.normalize(path.posix.join(path.posix.dirname(rel), imp.path))
      const hit = known.get(lc(p))
      if (hit) edge(from, `file:${hit}`, 'import', 'exact', at)
      else { edge(from, null, 'import', 'unresolved', at, { detail: imp.path }); uncertain('unresolved-import', at, imp.path) }
    }
    for (const cr of data.creates) {
      const at = `${rel}:${cr.line}`
      if (cr.name === null) { edge(from, null, 'creates', 'dynamic', at, { detail: cr.what }); uncertain('dynamic-createobject', at, cr.what); continue }
      compEdge(from, cr.name, 'creates', at)
    }
    for (const r of data.runs) {
      // a receiver that matches a create in this function (BrightScript names are case-insensitive) decides the target,
      // even when that create is not an app Task; a receiver that matches no create in the function falls back to
      // every Task created in that function
      const inFn = data.creates.filter((c) => c.fn === r.fn)
      const byRecv = r.recv ? inFn.filter((c) => c.recv && lc(c.recv) === lc(r.recv)) : []
      const targets = (byRecv.length ? byRecv : inFn).filter((c) => isTaskName(c.name))
      for (const c of targets) edge(from, `comp:${comps.get(lc(c.name)).name}`, 'runs-task', 'name', `${rel}:${r.line}`)
    }
    for (const s of data.scenes) {
      if (!/^source\//i.test(rel)) continue
      const at = `${rel}:${s.line}`; const e = 'entry:main'
      if (s.name === null) { edge(e, null, 'entry', 'dynamic', at); continue }
      const c = comps.get(lc(s.name)); if (c) edge(e, `comp:${c.name}`, 'entry', 'name', at); else edge(e, null, 'entry', 'unresolved', at, { detail: s.name })
    }
    const glob = (list, kind) => {
      for (const g of list) {
        const at = `${rel}:${g.line}`; const extra = g.detail ? { detail: g.detail } : undefined
        if (g.name === null) { edge(from, null, kind, 'dynamic', at, extra); uncertain('dynamic-global', at, 'm.global with a runtime field name') } else edge(from, addNode({ id: `global:${g.name}`, kind: 'global' }), kind, 'exact', at, extra)
      }
    }
    glob(data.gReads, 'global-read'); glob(data.gWrites, 'global-write')
    for (const r of data.registry) {
      const at = `${rel}:${r.line}`
      if (r.name === '<dynamic>') edge(from, null, 'registry', 'dynamic', at); else edge(from, addNode({ id: `registry:${r.name}`, kind: 'registry' }), 'registry', 'exact', at)
    }
    for (const ev of data.evals) uncertainOnce('eval', `${rel}:${ev.line}`, 'Eval runs code built at runtime; the graph cannot see it')
    for (const i of data.ifs) { const v = consts[lc(i.name)]; uncertain('bs-const-branch', `${rel}:${i.line}`, `#if ${i.name}, analyzed with the manifest value (${v === undefined ? 'not set' : v})`) }
  }
  if (nodes.has('file:source/main.brs') || edges.some((e) => e.kind === 'entry')) addNode({ id: 'entry:main', kind: 'entry', file: 'source/main.brs' })

  // ---- scopes, calls, callFunc, observeField, purity, testability ----------------------------------------------
  const builtins = Object.prototype.hasOwnProperty.call(opts, 'builtinCallables') ? new Set((opts.builtinCallables || []).map(lc)) : loadBuiltinCallables()
  const importTarget = (rel, p0) => known.get(lc(/^pkg:\//i.test(p0) ? p0.replace(/^pkg:\/+/i, '') : path.posix.normalize(path.posix.join(path.posix.dirname(rel), p0))))
  const importClosure = (rels) => {
    const seen = new Set(); const stack = [...rels]
    while (stack.length) {
      const r = stack.pop(); if (seen.has(r) || !brsFiles.has(r)) continue
      seen.add(r)
      for (const imp of brsFiles.get(r).data.imports) { const h = importTarget(r, imp.path); if (h) stack.push(h) }
    }
    return [...seen].sort()
  }
  // A scope is a list of levels, nearest first. A component's levels are its own scripts (with their imports), then each
  // extended component's, so a nearer definition shadows a farther one. The source scope is all of source/** in one level.
  const sourceFiles = [...brsFiles.keys()].filter((r) => /^source\//i.test(r)).sort()
  const scopes = [{ name: 'source', levels: [sourceFiles], comp: null }]
  for (const c of [...comps.values()].sort((a, b) => cmp(a.name, b.name))) {
    const levels = []; const taken = new Set(); const guard = new Set(); let n = c
    while (n && !guard.has(lc(n.name))) {
      guard.add(lc(n.name))
      const files = importClosure(compScripts.get(lc(n.name)) || []).filter((r) => !taken.has(r))
      files.forEach((r) => taken.add(r)); levels.push(files)
      n = n.x.extends ? comps.get(lc(n.x.extends)) : null
    }
    scopes.push({ name: c.name, levels, comp: c })
  }
  const defsOf = (scope, wantClass) => {
    const key = wantClass ? 'cidx' : 'fidx'
    if (!scope[key]) {
      scope[key] = scope.levels.map((files) => {
        const m = new Map()
        for (const rel of files) {
          const d = brsFiles.get(rel).data
          for (const f of wantClass ? d.classes : d.functions) { const k = lc(f.qname || f.name); if (!m.has(k)) m.set(k, []); m.get(k).push({ rel, key: f.key || `${f.name}@${f.line}` }) }
        }
        return m
      })
    }
    return scope[key]
  }
  const scopesOfFile = new Map()
  const indexScope = (sc) => { for (const rel of new Set(sc.levels.flat())) { if (!scopesOfFile.has(rel)) scopesOfFile.set(rel, []); scopesOfFile.get(rel).push(sc) } }
  scopes.forEach(indexScope)
  // a script that no component loads and that is not under source/ is its own scope (named by its path), so its calls resolve
  // against what it imports instead of being dropped
  // (an orphan that another orphan imports is covered by that importer's scope; orphans in a pure import cycle keep their own)
  const orphans = [...brsFiles.keys()].filter((rel) => !scopesOfFile.has(rel)).sort()
  const closures = new Map(orphans.map((rel) => [rel, new Set(importClosure([rel]))]))
  for (const rel of orphans) {
    if (orphans.some((p) => p !== rel && closures.get(p).has(rel) && !closures.get(rel).has(p))) continue
    const sc = { name: rel, levels: [[...closures.get(rel)].sort()], comp: null }; scopes.push(sc); indexScope(sc)
  }
  const compsOfFile = (rel) => (scopesOfFile.get(rel) || []).filter((sc) => sc.comp)
  const childTag = (c, id) => {
    const guard = new Set(); let n = c
    while (n && !guard.has(lc(n.name))) { guard.add(lc(n.name)); const k = n.x.children.find((ch) => ch.id === id); if (k) return k.tag; n = n.x.extends ? comps.get(lc(n.x.extends)) : null }
    return null
  }
  const compsByFn = new Map() // lc interface function name -> [comp ids]
  for (const c of comps.values()) for (const f of new Set(c.x.functions.map(lc))) { if (!compsByFn.has(f)) compsByFn.set(f, []); compsByFn.get(f).push(`comp:${c.name}`) }
  // the type at the end of a tag's extends chain (the tag itself when it is not an app component)
  const baseTypeOf = (tag) => {
    let c = comps.get(lc(tag)); let t = tag; const seen = new Set()
    while (c && !seen.has(lc(c.name))) { seen.add(lc(c.name)); t = c.x.extends || t; c = c.x.extends ? comps.get(lc(c.x.extends)) : null }
    return t
  }
  const fnId = (rel, key) => `${rel}#${key}`
  const purIn = new Map() // fn id -> { why[], clock, calls[{ name, ids[] }] }
  for (const rel of brsFiles.keys()) {
    const d = brsFiles.get(rel).data
    for (const f of d.functions) {
      const key = f.key
      purIn.set(fnId(rel, key), { why: (d.impure[key] || []).map((x) => x.why), clock: !!(d.clock[key] || []).length, calls: [] })
    }
  }
  // the namespace-relative name is tried at every level before the plain name, so it wins over a nearer plain definition
  const findDefs = (sc, keys, wantClass) => { for (const k of keys) for (const lv of defsOf(sc, wantClass)) { const h = lv.get(k); if (h && h.length) return h } return [] }

  for (const rel of [...brsFiles.keys()].sort()) {
    const { data } = brsFiles.get(rel); const from = `file:${rel}`
    const fileScopes = scopesOfFile.get(rel) || []
    const siteList = [...data.calls.map((c) => ({ ...c, cls: false })), ...data.news.map((c) => ({ ...c, cls: true }))]
    for (const c of siteList) {
      if (!fileScopes.length) continue
      const at = `${rel}:${c.line}`; const detail = c.cls ? `new ${c.name}` : c.name
      const keys = []
      if (c.ns && !c.dotted) keys.push(lc(`${c.ns}.${c.name}`))
      keys.push(lc(c.name))
      const groups = new Map() // outcome key -> { out, scopes[] }
      for (const sc of fileScopes) {
        const defs = findDefs(sc, keys, c.cls)
        let out
        if (defs.length) {
          const uniq = [...new Map(defs.map((x) => [fnId(x.rel, x.key), x])).values()]
          const files = [...new Set(uniq.map((x) => x.rel))].sort()
          out = uniq.length === 1 ? { t: 'name', file: files[0], ids: [fnId(uniq[0].rel, uniq[0].key)] } : { t: 'amb', files, ids: uniq.map((x) => fnId(x.rel, x.key)) }
        } else if (c.dotted || (!c.cls && builtins.has(lc(c.name)))) { out = { t: 'skip' } } else { out = { t: 'unres' } }
        const k = out.t === 'name' ? `n:${out.file}` : out.t === 'amb' ? `a:${out.files.join(',')}` : out.t
        if (!groups.has(k)) groups.set(k, { out, scopes: [] })
        groups.get(k).scopes.push(sc.name)
      }
      const caller = purIn.get(fnId(rel, c.fn))
      for (const { out, scopes: names } of groups.values()) {
        if (out.t === 'skip') {
          if (!c.dotted && caller && !PURE_BUILTINS.has(lc(c.name)) && !CLOCK_BUILTINS.has(lc(c.name)) && !caller.why.includes(`calls ${c.name}`)) caller.why.push(`calls ${c.name}`)
          continue
        }
        if (out.t === 'name') { edge(from, `file:${out.file}`, 'calls', 'name', at, { scopes: names, detail }); if (caller) caller.calls.push({ name: detail, ids: out.ids }) } else if (out.t === 'amb') {
          const cands = out.files.map((f) => `file:${f}`)
          edge(from, null, 'calls', 'ambiguous', at, { scopes: names, detail, candidates: cands }); uncertainOnce('ambiguous-call', at, detail, cands)
          if (caller) caller.calls.push({ name: detail, ids: out.ids })
        } else {
          edge(from, null, 'calls', 'unresolved', at, { scopes: names, detail }); uncertainOnce('unresolved-call', at, detail)
          if (caller) { caller.why.push(`unresolved callee ${detail}`) }
        }
      }
    }
    // callFunc: by function name against the components' <interface><function> declarations
    // several sites of one kind on one line are distinct sites: they carry a column so none collapses into another
    const colOf = (list, x) => (list.filter((y) => y.line === x.line).length > 1 ? { col: x.col } : {})
    for (const cf of data.callfuncs) {
      const at = `${rel}:${cf.line}`; const cc = colOf(data.callfuncs, cf)
      if (cf.name === null) { edge(from, null, 'callfunc', 'dynamic', at, { detail: 'callFunc with a variable name', ...cc }); uncertainOnce('dynamic-callfunc', at, 'callFunc with a variable name'); continue }
      const cands = (compsByFn.get(lc(cf.name)) || []).slice().sort()
      if (cands.length === 1) edge(from, cands[0], 'callfunc', 'name', at, { detail: cf.name, ...cc })
      else if (cands.length > 1) { edge(from, null, 'callfunc', 'ambiguous', at, { detail: cf.name, candidates: cands, ...cc }); uncertainOnce('ambiguous-callfunc', at, cf.name, cands) } else edge(from, null, 'callfunc', 'unresolved', at, { detail: cf.name, ...cc })
    }
    // observeField: m.top is the component itself; a receiver assigned from m.top.findNode("id") resolves through <children>
    const compScopes = compsOfFile(rel)
    for (const o of data.observes) {
      const at = `${rel}:${o.line}`; const cc = colOf(data.observes, o)
      const dyn = (why) => { edge(from, null, 'observes', 'unresolved', at, { detail: why, ...cc }); uncertainOnce('dynamic-observe', at, o.recv) }
      if (lc(o.recv) === 'm.top') {
        if (!compScopes.length) { dyn('receiver m.top outside a component scope'); continue }
        for (const sc of compScopes) edge(from, `comp:${sc.comp.name}`, 'observes', 'name', at, { detail: 'm.top', ...cc })
        continue
      }
      let a = o.direct ? { id: o.direct.id, obj: o.direct.obj, recv: null } : null
      if (!a) { const cand = data.findAssigns.filter((x) => lc(x.recv) === lc(o.recv)); a = cand.filter((x) => x.line <= o.line).pop() || cand[0] || null }
      if (!a || a.id === null || lc(a.obj) !== 'm.top' || !compScopes.length) {
        dyn(a ? `receiver ${o.recv} comes from a findNode that cannot be resolved` : (data.creates.some((x) => x.recv && lc(x.recv) === lc(o.recv)) ? `receiver ${o.recv} was assigned from CreateObject, not findNode` : `receiver ${o.recv} is not m.top or a findNode result`))
        continue
      }
      const text = a.recv ? `${a.recv} = ${a.obj}.findNode(${JSON.stringify(a.id)})` : `${a.obj}.findNode(${JSON.stringify(a.id)})`
      for (const sc of compScopes) {
        const tag = childTag(sc.comp, a.id)
        if (tag === null) { dyn(`findNode(${JSON.stringify(a.id)}) matches no <children> id of ${sc.comp.name}`); continue }
        const t = target(tag)
        // an unresolved child tag was already reported by the child edge: no second uncertainty item
        if (t.id === null) edge(from, null, 'observes', 'unresolved', at, { detail: text, ...cc }); else edge(from, t.id, 'observes', t.conf, at, { detail: text, ...cc })
      }
    }
  }

  // purity (U1/U2): fixed point over the resolved calls
  const pur = testability.computePurity(purIn)
  for (const rel of brsFiles.keys()) {
    const node = nodes.get(`file:${rel}`); const d = brsFiles.get(rel).data
    node.functions = d.functions.map((f) => { const p = pur.get(fnId(rel, f.key)); return { name: f.name, line: f.line, ...(f.qname && f.qname !== f.name ? { qname: f.qname } : {}), pure: p.pure, ...(p.why.length ? { why: p.why } : {}), ...(p.clock ? { clock: true } : {}) } })
    node.scope = (scopesOfFile.get(rel) || []).map((sc) => sc.name)
    // component-aware facts: a findNode that resolves to a Timer/Animation or Video/Audio child, or a created one
    const facts = node.facts || {}
    const plat = new Set(facts.platformObjects || [])
    for (const sc of compsOfFile(rel)) {
      for (const fnd of d.findNodes) {
        const tag = fnd.id === null ? null : childTag(sc.comp, fnd.id)
        const root = tag ? baseTypeOf(tag) : null
        if (root && /^(timer|animation)$/i.test(root)) facts.timers = true
        if (root && /^(video|audio)$/i.test(root)) plat.add(root)
      }
    }
    for (const cr of d.creates) if (cr.name && /^(timer|animation)$/i.test(baseTypeOf(cr.name))) facts.timers = true
    if (plat.size) facts.platformObjects = [...plat].sort()
    if (Object.keys(facts).length) node.facts = facts
  }

  // testability rules over the finished graph
  const sites = new Map()
  for (const rel of brsFiles.keys()) {
    const d = brsFiles.get(rel).data; const kh = d.functions.find((f) => lc(f.name) === 'onkeyevent')
    sites.set(rel, { makesScenes: d.sgNode || d.createClasses.some((c) => lc(c.cls) === 'rosgscreen'), createClasses: d.createClasses, waits: d.waits, certs: d.certs, focus: d.focus, launchArgs: d.launchArgs, registry: d.registry, keyHandlerLine: kh ? kh.line : 0, globalInit: d.gReads.filter((g) => /^init@/i.test(g.fn || '')).map((g) => ({ name: g.name, line: g.line })) })
  }
  const compFiles = new Map()
  for (const sc of scopes) if (sc.comp) compFiles.set(`comp:${sc.comp.name}`, { xml: sc.comp.file, files: [...new Set(sc.levels.flat())].filter((r) => !/^source\//i.test(r)).sort() })
  const seeded = new Set(Object.keys(config.globalFields && typeof config.globalFields === 'object' ? config.globalFields : {}).map(lc))
  const tmap = testability.classify({
    nodes: [...nodes.values()], edges, sites, compFiles, seeded, uncertainty: unc,
    setUrl: (cen.network && cen.network.setUrlSites) || [], notCovered: cen.notCovered || [],
    entryTargets: new Set(edges.filter((e) => e.kind === 'entry' && e.to).map((e) => e.to)),
  })
  for (const [id, rec] of tmap) { nodes.get(id).testability = rec }

  // spec pass (light): @SGNode("X") annotations and called names; census skips these files
  const CALL_RE = /(^|[^.\w@])([A-Za-z_]\w*)\s*\(/g
  const KEYWORDS = new Set(['if', 'then', 'else', 'while', 'for', 'each', 'function', 'sub', 'return', 'print', 'not', 'and', 'or', 'class', 'new', 'step', 'to', 'in', 'end', 'exit', 'goto', 'stop', 'dim', 'type', 'namespace', 'import', 'as', 'rem'])
  for (const rel of specFiles) {
    const got = census.safeRead(path.join(base, rel))
    if (!got.buf) continue
    const from = `file:${rel}`
    fileNode(rel, /\.bs$/i.test(rel) ? 'bs' : 'brs', got.buf.length, { spec: true })
    const own = new Set()
    const lines = got.buf.toString('utf8').split('\n')
    lines.forEach((ln) => { const d = /^\s*(?:function|sub)\s+([A-Za-z_]\w*)/i.exec(ln); if (d) own.add(lc(d[1])) })
    lines.forEach((ln, i) => {
      const at = `${rel}:${i + 1}`
      const sg = /@SGNode\s*\(\s*"([^"]*)"\s*\)/i.exec(ln)
      if (sg) { const c = comps.get(lc(sg[1])); if (c) edge(from, `comp:${c.name}`, 'spec-covers', 'name', at); else edge(from, null, 'spec-covers', 'unresolved', at, { detail: sg[1] }) }
      const code = ln.replace(/"(?:[^"]|"")*"/g, '""').replace(/'.*$/, '')
      const seen = new Set(); let m
      CALL_RE.lastIndex = 0
      while ((m = CALL_RE.exec(code))) {
        const nm = lc(m[2])
        if (KEYWORDS.has(nm) || own.has(nm) || seen.has(nm)) continue
        const defs = fnIndex.get(nm)
        if (!defs) continue
        seen.add(nm)
        if (defs.length === 1) edge(from, `file:${defs[0]}`, 'spec-covers', 'name', at, { detail: m[2] })
        else edge(from, null, 'spec-covers', 'ambiguous', at, { detail: m[2], candidates: defs.map((d) => `file:${d}`).sort() })
      }
    })
  }

  // census-reported uncertainty
  for (const p of cen.parseErrors) uncertain('parse-error', p.file, p.reason)
  const seenNR = new Set()
  const notRead = (f, why) => { if (!seenNR.has(f)) { seenNR.add(f); uncertain('not-read', f, why) } }
  for (const s of cen.skipped) if (s.kind === 'sensitive-or-oversized-not-read' || s.kind === 'path-outside-root') notRead(s.file, s.reason)
  for (const l of [...new Set([...walked.links, ...specWalk.links])].sort()) notRead(l, `${l} is a symlink and was not read`)
  const sc = assess.scan(root)
  const th = treeHash(root, sc)
  // hint only when the manifest is truly absent (a refused one, e.g. a symlink or oversized file, is not a missing one)
  if (manifest.refused === 'missing') {
    const nested = nestedManifests(sc.files.map((f) => f.rel))
    if (nested.length) uncertain('nested-manifests', '.', nestedHint(nested))
  }
  for (const u of bsconfigUncertainty(root)) uncertain(u.kind, u.at, u.detail)
  if (specWalk.capped) uncertain('truncated', '.', `the spec roots hold more than ${SPEC_FILE_CAP} files; the graph covers only part of them`)
  if (th.truncated) uncertain('truncated', '.', 'the file cap or the size cap was hit; the graph covers only part of the tree')

  // canonical order
  const sortedNodes = [...nodes.values()].sort((a, b) => cmp(a.id, b.id))
  const key = (e) => `${e.from}\u0000${e.kind}\u0000${e.to}\u0000${e.at}\u0000${e.detail || ''}\u0000${e.col || ''}`
  const seenE = new Set()
  const sortedEdges = edges.filter((e) => { const k = key(e); if (seenE.has(k)) return false; seenE.add(k); return true }).sort((a, b) => cmp(key(a), key(b)))
  unc.sort((a, b) => cmp(a.kind + '\u0000' + a.at + '\u0000' + a.detail, b.kind + '\u0000' + b.at + '\u0000' + b.detail))
  const counts = {}; for (const u of unc) counts[u.kind] = (counts[u.kind] || 0) + 1
  // items are capped per kind so one noisy kind cannot hide the others; counts stay exact
  const perKind = {}; const items = unc.filter((u) => (perKind[u.kind] = (perKind[u.kind] || 0) + 1) <= MAX_ITEMS)
  const byConf = {}; for (const e of sortedEdges) byConf[e.conf] = (byConf[e.conf] || 0) + 1

  const graph = {
    schema: SCHEMA,
    app: manifestTitle(manifestText) || path.basename(root), // display only, never hashed
    scan: th,
    nodes: sortedNodes,
    edges: sortedEdges,
    resolution: { edgesTotal: sortedEdges.length, byConf, callSitesResolvedPct: sitesPct(sortedEdges), sites: siteTally(sortedEdges).by },
    uncertainty: { counts, total: unc.length, items, blindSpots: BLIND_SPOTS },
  }
  graph.hash = hashGraph(graph)
  return graph
}

module.exports = { buildGraph, canonicalJson, hashGraph, SCHEMA, parseXml, collectBrs, loadBuiltinCallables, resolveSpecRoots }
