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
// In this slice: nodes file, component, builtin, global, registry, entry; edges extends, script, import, child, creates,
// runs-task, entry, global-read, global-write, registry, spec-covers; uncertainty kinds dynamic-createobject,
// dynamic-global, unresolved-script, unresolved-import, inline-cdata, parse-error, not-read, truncated, bs-const-branch,
// component-library, plus blindSpots. NOT here (later slices): scope resolution, calls, callfunc, observes, purity,
// testability, SCC, clusters, `suggested`.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const bsc = require('brighterscript')
const census = require('../instrument/census')
const receiver = require('../instrument/receiver')
const assess = require('../assess')
const { mergedInstrumentExclude } = require('../config')
const { makeMatcher, DEFAULT_EXCLUDE, SCENE_BUILTINS, NON_SCENE_BUILTINS } = require('../instrument/plugin')

const { createVisitor, WalkMode, isLiteralString, isCallExpression, isFunctionExpression, isAALiteralExpression,
  isDottedSetStatement, isAssignmentStatement } = bsc

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
function treeHash(root) {
  const sc = assess.scan(root)
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
function collectBrs(pkg, text, ctx) {
  const { parsed, facts } = ctx
  const refs = parsed.parser.references
  const out = { functions: [], imports: [], creates: [], runs: [], gReads: [], gWrites: [], scenes: [], registry: facts.registry.map((r) => ({ name: r.name === '<dynamic>' ? r.name : r.name.replace(/""/g, '"'), line: r.line })), ifs: [], keyHandler: false, network: false, platform: [] }
  for (const f of refs.functionStatements || []) if (f.name) out.functions.push({ name: f.name.text, line: f.name.range.start.line + 1 })
  out.functions.sort((a, b) => a.line - b.line || cmp(a.name, b.name))
  out.keyHandler = out.functions.some((f) => lc(f.name) === 'onkeyevent')
  for (const imp of refs.importStatements || []) if (imp.filePath) out.imports.push({ path: imp.filePath, line: (imp.range ? imp.range.start.line : 0) + 1 })
  const line = (n) => n.range.start.line + 1
  // the enclosing function as a scalar key (name@line), never the AST node
  const fnOf = (n) => { const f = n.findAncestor(isFunctionExpression); if (!f) return ''; const st = f.parent; return `${st && st.name && st.name.text ? st.name.text : ''}@${f.range.start.line + 1}` }
  const isCallee = (e) => e.parent && isCallExpression(e.parent) && e.parent.callee === e
  const recvOfAssign = (call) => {
    const p = call.parent
    if (p && isDottedSetStatement(p) && p.value === call) return `${receiver.toText(p.obj) || '?'}.${p.name.text}`
    if (p && isAssignmentStatement(p) && p.value === call) return p.name.text
    return null
  }
  const nameArg = (a) => (a && isLiteralString(a) ? unq(a.token.text) : null)
  const addGlobalKeys = (call) => {
    const a = call.args[0]
    if (a && isAALiteralExpression(a)) for (const el of a.elements) { if (el.keyToken) out.gWrites.push({ name: unq(el.keyToken.text), line: el.keyToken.range.start.line + 1, detail: 'addFields' }) }
    else out.gWrites.push({ name: null, line: line(call), detail: 'addFields' })
  }
  parsed.ast.walk(createVisitor({
    CallExpression: (e) => {
      const c = e.callee
      if (c.name && c.obj === undefined && lc(c.name.text) === 'createobject') {
        const cls = nameArg(e.args[0])
        if (cls === null) { out.creates.push({ line: line(e), name: null, fn: fnOf(e), recv: recvOfAssign(e), what: 'CreateObject with a variable class name' }); return }
        if (lc(cls) === 'rosgnode') { const n = nameArg(e.args[1]); out.creates.push({ line: line(e), name: n, fn: fnOf(e), recv: recvOfAssign(e), what: 'CreateObject with a variable component name' }) } else if (DEVICE_CLASSES.has(lc(cls))) { if (!out.platform.includes(cls)) out.platform.push(cls); if (lc(cls) === 'rourltransfer') out.network = true }
        return
      }
      if (c.obj === undefined || !c.name) return
      const nm = lc(c.name.text)
      if (nm === 'createchild' && e.args.length) { out.creates.push({ line: line(e), name: nameArg(e.args[0]), fn: fnOf(e), recv: recvOfAssign(e), what: 'createChild with a variable component name' }) }
      if (nm === 'createscene' && e.args.length) out.scenes.push({ line: line(e), name: nameArg(e.args[0]) })
      if (nm === 'addfields' && lc(receiver.toText(c.obj)) === 'm.global') addGlobalKeys(e)
    },
    DottedGetExpression: (e) => {
      if (isCallee(e)) return
      if (lc(receiver.toText(e.obj)) === 'm.global') out.gReads.push({ name: e.name.text, line: line(e) })
    },
    DottedSetStatement: (s) => {
      if (lc(receiver.toText(s.obj)) === 'm.global') out.gWrites.push({ name: s.name.text, line: line(s) })
      else if (lc(s.name.text) === 'control' && isLiteralString(s.value) && lc(unq(s.value.token.text)) === 'run') out.runs.push({ line: line(s), fn: fnOf(s), recv: receiver.toText(s.obj) })
    },
    IndexedGetExpression: (e) => { if (lc(receiver.toText(e.obj)) === 'm.global') out.gReads.push({ name: null, line: line(e) }) },
    IndexedSetStatement: (s) => { if (lc(receiver.toText(s.obj)) === 'm.global') out.gWrites.push({ name: null, line: line(s) }) },
  }), { walkMode: WalkMode.visitAllRecursive })
  // #if guards (bsc evaluates them against the manifest bs_const; this only records where they are)
  text.split('\n').forEach((ln, i) => {
    const m = /^\s*#(?:else\s*if|elseif|if)\s+(!?\s*[A-Za-z_]\w*)/i.exec(ln)
    if (m) out.ifs.push({ line: i + 1, name: m[1].replace(/^!\s*/, '') })
  })
  return out
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
  const known = new Map(walked.files.map((f) => [lc(f), f]))
  const manifest = escapedDirs.has('manifest') ? { refused: 'path-outside-root' } : census.safeRead(path.join(base, 'manifest'))
  const manifestText = manifest.buf ? manifest.buf.toString('utf8') : ''
  const consts = manifestConsts(manifestText)

  const nodes = new Map(); const edges = []; const unc = []
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id }
  const edge = (from, to, kind, conf, at, extra) => edges.push({ from, to, kind, conf, at, ...(extra || {}) })
  const uncertain = (kind, at, detail) => unc.push({ kind, at, detail })

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
      if (hit) edge(`file:${rel}`, `file:${hit}`, 'script', 'exact', at)
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
    for (const i of data.ifs) { const v = consts[lc(i.name)]; uncertain('bs-const-branch', `${rel}:${i.line}`, `#if ${i.name}, analyzed with the manifest value (${v === undefined ? 'not set' : v})`) }
  }
  if (nodes.has('file:source/main.brs') || edges.some((e) => e.kind === 'entry')) addNode({ id: 'entry:main', kind: 'entry', file: 'source/main.brs' })

  // spec pass (light): @SGNode("X") annotations and called names; census skips these files
  const CALL_RE = /(^|[^.\w@])([A-Za-z_]\w*)\s*\(/g
  const KEYWORDS = new Set(['if', 'then', 'else', 'while', 'for', 'each', 'function', 'sub', 'return', 'print', 'not', 'and', 'or', 'class', 'new', 'step', 'to', 'in', 'end', 'exit', 'goto', 'stop', 'dim', 'type', 'namespace', 'import', 'as', 'rem'])
  for (const rel of walked.files.filter((f) => isTestFile(f) && /\.(brs|bs)$/i.test(f))) {
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
  for (const l of walked.links) notRead(l, `${l} is a symlink and was not read`)
  const th = treeHash(root)
  if (th.truncated) uncertain('truncated', '.', 'the file cap or the size cap was hit; the graph covers only part of the tree')

  // canonical order
  const sortedNodes = [...nodes.values()].sort((a, b) => cmp(a.id, b.id))
  const key = (e) => `${e.from}\u0000${e.kind}\u0000${e.to}\u0000${e.at}\u0000${e.detail || ''}`
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
    resolution: { edgesTotal: sortedEdges.length, byConf },
    uncertainty: { counts, total: unc.length, items, blindSpots: BLIND_SPOTS },
  }
  graph.hash = hashGraph(graph)
  return graph
}

module.exports = { buildGraph, canonicalJson, hashGraph, SCHEMA, parseXml, collectBrs }
