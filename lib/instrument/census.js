'use strict'
// brighttest instrument census (INS-F-T4): a static, build-free scan of an app tree. It reports what an instrumented
// build would touch (Scenes, Tasks, `m.global.addFields` keys, registry sections, `setUrl` / `CreateObject` sites) and
// what it could not instrument. It derives the same candidate classes as the plugin (ADR 0019 decision 5) by reusing the
// plugin's constants and the receiver classifier, and the unit tests cross-check the two so they cannot drift.
//
//   census(rootDir, { config }) -> Promise<census>      census.v === 1; shape below
//   renderMarkdown(census)      -> string
//   write(census, outDir)       -> { json, md }          writes census.json and census.md
//
// census = { v, root, counts{brsFiles,xmlFiles,components,tasks,urlTransferLiteral,createObjectDynamic,syncGet,asyncGet,
//   certificateCalls}, scenes[], tasks[], globalFields[], registrySections[], network{setUrlSites[],createObjectSites[]},
//   notCovered[{file,line,reason}], skipped[{kind,file,line,reason,informational,excludedBy?,via?,component?}], inlineCdataScenes[],
//   inlineCdataSetUrl[{component,file,line}] (census-only: the plugin cannot see CDATA), parseErrors[] }
//
// Scope: `source/` and `components/` (the ground-truth scope of examples/legacy-app/EXPECTED-CENSUS.json), minus test
// folders and `*.spec.*`. Files matching the plugin's default excludes or the configured excludes are scanned but
// flagged excluded. Inline-CDATA Scenes are REPORT-ONLY (OD-35, ADR 0019 decision 4): recorded, never rewritten.
const fs = require('node:fs')
const path = require('node:path')
const bsc = require('brighterscript')
const receiver = require('./receiver')
const { mergedInstrumentExclude } = require('../config')
const { makeMatcher, DEFAULT_EXCLUDE, SCENE_BUILTINS, INFORMATIONAL_KINDS, isUnknownSceneRoot } = require('./plugin')

const { Lexer, Parser, ParseMode, createVisitor, WalkMode, isLiteralString, isVariableExpression, isAALiteralExpression,
  isDottedGetExpression, isIndexedGetExpression, isCommentStatement, isFunctionExpression, isExpressionStatement } = bsc

const SCAN_DIRS = ['source', 'components']
const SYNC_METHODS = new Set(['gettostring', 'gettofile', 'posttostring', 'postfromstring', 'postfromfile', 'head'])
const CONTENT_URL_FIELDS = new Set(['uri', 'streamurl', 'hdposterurl', 'sdposterurl'])
const lc = (s) => String(s || '').toLowerCase()
const unq = (s) => String(s).replace(/^"|"$/g, '')

function walkFiles(root, rel, out) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`
    if (e.isDirectory()) walkFiles(root, r, out)
    else if (e.isFile()) out.push(r)
  }
  return out
}
const isTestFile = (p) => /(^|\/)tests?\//i.test(p) || /\.spec\.[^/]*$/i.test(p)
const lineAt = (text, idx) => text.slice(0, idx).split('\n').length
const blank = (s) => s.replace(/[^\n]/g, ' ') // keep offsets and newlines when masking comments

function loadConfig(rootDir, given) {
  if (given && typeof given === 'object') return given
  const explicit = typeof given === 'string' && given !== ''
  const file = explicit ? path.resolve(rootDir, given) : path.join(rootDir, 'brighttest.json')
  const name = path.basename(file) // messages carry the file name only, never an absolute path
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (!explicit && e.code === 'ENOENT') return {} // no brighttest.json: defaults
    throw new Error(`cannot read config ${name}: ${e.code || 'read error'}`)
  }
  let cfg
  // fixed message on purpose: the parser's own text echoes part of the file, which may be a secrets file
  try { cfg = JSON.parse(text) } catch (e) { throw new Error(`could not parse ${name} as JSON; ${explicit ? 'fix it or pass another path' : 'fix it or remove it'}`) }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${name} must contain a JSON object`)
  return cfg
}

// ---- bsconfig rootDir (the project root stays the read boundary) ------------------------------------------------
function stripJsonc(t) {
  let out = ''; let i = 0
  while (i < t.length) {
    const ch = t[i]
    if (ch === '"') { let j = i + 1; while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1; out += t.slice(i, j + 1); i = j + 1 } else if (ch === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++ } else if (ch === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2 } else { out += ch; i++ }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
function realIn(realRoot, p) { try { const r = fs.realpathSync(p); return inside(realRoot, r) ? r : null } catch (e) { return null } }
// Effective scan base: the bsconfig rootDir (own or inherited through extends) when it is a directory inside the project
// root, else the project root itself. Never reads a file whose real path is outside the root. Any problem falls back to root.
function effectiveBase(root) {
  let realRoot
  try { realRoot = fs.realpathSync(root) } catch (e) { return root }
  let file = realIn(realRoot, path.join(root, 'bsconfig.json'))
  for (let depth = 0; file && depth < 10; depth++) {
    let cfg
    try { cfg = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8'))) } catch (e) { return root }
    if (!cfg || typeof cfg !== 'object') return root
    if (typeof cfg.rootDir === 'string' && cfg.rootDir !== '') {
      const dir = realIn(realRoot, path.resolve(path.dirname(file), cfg.rootDir))
      return dir && fs.statSync(dir).isDirectory() ? path.join(root, path.relative(realRoot, dir)) : root
    }
    if (typeof cfg.extends !== 'string' || cfg.extends === '') return root
    file = realIn(realRoot, path.resolve(path.dirname(file), cfg.extends))
  }
  return root
}

// ---- XML (regex level: bsc is not needed for names, extends and script tags) ------------------------------------
function parseComponent(pkg, text) {
  const t = text.replace(/<!--[\s\S]*?-->/g, blank)
  const head = /<component\b([^>]*)>/i.exec(t)
  if (!head) return null
  const attr = (s, n) => { const m = new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i').exec(s); return m ? m[1] : null }
  const name = attr(head[1], 'name')
  if (!name) return null
  const scripts = []
  const re = /<script\b([^>]*?)(\/>|>([\s\S]*?)<\/script>)/gi
  let m
  while ((m = re.exec(t))) {
    const body = m[3] || ''
    const cd = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body)
    scripts.push({ uri: attr(m[1], 'uri'), line: lineAt(t, m.index), cdata: cd ? cd[1] : null, cdataLine: cd ? lineAt(t, t.indexOf(cd[0], m.index) + '<![CDATA['.length) : 0 })
  }
  const fn = /<field\b[^>]*\bid\s*=\s*"functionName"[^>]*\bvalue\s*=\s*"([^"]*)"/i.exec(t)
  return { name, extends: attr(head[1], 'extends'), file: pkg, scripts, xmlFunctionName: fn ? fn[1] : null }
}

function resolveUri(xmlPkg, uri) {
  if (!uri) return null
  if (/^pkg:\//i.test(uri)) return uri.replace(/^pkg:\/+/i, '')
  if (/^[a-z]+:\//i.test(uri)) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(xmlPkg), uri))
}

// ---- BrightScript (bsc parser only; no Program, no build) -------------------------------------------------------
// Conditional compilation (`#if`) is evaluated against the app manifest's bs_const, as bsc does for a Program, using the
// Preprocessor internal (feature-detected; without it the raw parse is used and `#if` blocks show as parse problems).
let Preprocessor = null
let parseManifest = null
try { ({ Preprocessor } = require('brighterscript/dist/preprocessor/Preprocessor')); ({ parseManifest } = require('brighterscript/dist/preprocessor/Manifest')) } catch (e) { /* raw parse */ }

function parseBrs(pkg, text, manifestText) {
  const mode = /\.bs$/i.test(pkg) ? ParseMode.BrighterScript : ParseMode.BrightScript
  let parser
  if (Preprocessor && parseManifest) {
    try {
      const lexed = Lexer.scan(text)
      const pre = new Preprocessor()
      pre.process(lexed.tokens, parseManifest(manifestText || ''))
      parser = new Parser()
      parser.parse(pre.processedTokens.length ? pre.processedTokens : lexed.tokens, { mode })
    } catch (e) { parser = null }
  }
  if (!parser) parser = Parser.parse(text, { mode })
  const errors = parser.diagnostics.filter((d) => d.severity === 1 || d.severity === undefined)
  return { pkgPath: pkg, ast: parser.ast, parser, errors }
}

function scanBrs(file, facts) {
  const fnOf = (n) => n.findAncestor(isFunctionExpression)
  const calls = []
  file.ast.walk(createVisitor({
    CallExpression: (expr) => {
      const c = expr.callee
      if (isVariableExpression(c) && lc(c.name.text) === 'createobject') {
        const a0 = expr.args[0]
        if (a0 && isLiteralString(a0)) facts.createObjects.push({ line: expr.range.start.line + 1, cls: unq(a0.token.text), expr })
        else if (a0 && isVariableExpression(a0)) facts.createObjects.push({ line: expr.range.start.line + 1, cls: '<dynamic>', expr })
        return
      }
      if (!isDottedGetExpression(c)) return
      const name = lc(c.name.text)
      const recv = receiver.toText(c.obj) || '<expression>'
      if (name === 'addfields' && lc(recv) === 'm.global') {
        const a = expr.args[0]
        if (a && isAALiteralExpression(a)) {
          for (const el of a.elements) if (el.keyToken) facts.globalFields.push({ name: unq(el.keyToken.text), line: el.keyToken.range.start.line + 1 })
        } else facts.globalFields.push({ name: '<dynamic>', line: expr.range.start.line + 1 })
      }
      if (SYNC_METHODS.has(name)) facts.syncCalls.push({ name, line: expr.range.start.line + 1, receiver: recv, fn: fnOf(expr) })
      if (name === 'callfunc' && expr.args[0] && isLiteralString(expr.args[0]) && lc(unq(expr.args[0].token.text)) === 'seturl') facts.callFuncSetUrl.push(expr.range.start.line + 1)
      if (name === 'asyncgettostring') facts.asyncGet++
      if (name === 'gettostring') facts.syncGet++
      if (name === 'setcertificatesfile') facts.certs++
      calls.push(expr)
    },
    DottedSetStatement: (s) => {
      const name = lc(s.name.text)
      if (name === 'functionname' && isLiteralString(s.value)) facts.functionNames.push(unq(s.value.token.text))
      if (CONTENT_URL_FIELDS.has(name)) facts.contentUrls.push({ line: s.range.start.line + 1 })
    },
  }), { walkMode: WalkMode.visitAllRecursive })
  // registry sections: CreateObject("roRegistrySection", <name>)
  for (const co of facts.createObjects) {
    if (lc(co.cls) !== 'roregistrysection') continue
    const a1 = co.expr.args[1]
    facts.registry.push({ name: a1 && isLiteralString(a1) ? unq(a1.token.text) : '<dynamic>', line: co.line })
  }
}

// ---- census ------------------------------------------------------------------------------------------------------
async function census(rootDir, opts = {}) {
  const root = path.resolve(rootDir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`census: ${rootDir} is not a directory`)
  const config = loadConfig(root, opts.config)
  const inst = config.instrument && typeof config.instrument === 'object' ? config.instrument : {}
  const extra = mergedInstrumentExclude(config) // instrument.exclude + deprecated top-level instrumentExclude
  const isExcluded = makeMatcher([...DEFAULT_EXCLUDE, ...extra])
  const isDefaultExcluded = makeMatcher(DEFAULT_EXCLUDE)
  const netCfg = inst.net && typeof inst.net === 'object' ? inst.net : {}
  const classifier = receiver.createClassifier({ allow: netCfg.receivers && netCfg.receivers.allow, deny: netCfg.receivers && netCfg.receivers.deny, unknown: netCfg.unknown })

  const base = effectiveBase(root)
  let manifestText = ''
  try { manifestText = fs.readFileSync(path.join(base, 'manifest'), 'utf8') } catch (e) { /* no manifest: no bs_const */ }
  const rels = SCAN_DIRS.flatMap((d) => walkFiles(base, d, [])).filter((p) => !isTestFile(p)).sort()
  const byLc = new Map()
  const counts = { brsFiles: 0, xmlFiles: 0, components: 0, tasks: 0, urlTransferLiteral: 0, createObjectDynamic: 0, syncGet: 0, asyncGet: 0, certificateCalls: 0 }
  const comps = new Map() // lower-case component name -> component
  const brs = new Map() // lower-case pkgPath -> { file, facts }
  const parseErrors = []
  const skipped = []
  // `excludedBy: "default"` excluded-candidate entries are informational like the strict table says (ADR 0019 (d) R5)
  const skip = (kind, file, line, reason, extra) => skipped.push({ kind, file, line, reason, ...(extra || {}), informational: INFORMATIONAL_KINDS.includes(kind) || (extra && extra.excludedBy === 'default') })
  const inlineCdataSetUrl = [] // setUrl inside inline CDATA scripts: bsc never parses it, so this is census-only

  for (const pkg of rels) {
    byLc.set(lc(pkg), pkg)
    const text = fs.readFileSync(path.join(base, pkg), 'utf8')
    if (/\.xml$/i.test(pkg)) {
      counts.xmlFiles++
      const c = parseComponent(pkg, text)
      if (c) { counts.components++; comps.set(lc(c.name), c) } else if (/<component\b/i.test(text)) parseErrors.push({ file: pkg, reason: 'component XML without a name' })
    } else if (/\.(brs|bs)$/i.test(pkg)) {
      counts.brsFiles++
      const file = parseBrs(pkg, text, manifestText)
      if (file.errors.length) parseErrors.push({ file: pkg, reason: `${file.errors.length} parse error(s), first line ${file.errors[0].range ? file.errors[0].range.start.line + 1 : '?'}` })
      const facts = { createObjects: [], globalFields: [], registry: [], syncCalls: [], contentUrls: [], callFuncSetUrl: [], functionNames: [], asyncGet: 0, syncGet: 0, certs: 0 }
      scanBrs(file, facts)
      counts.urlTransferLiteral += facts.createObjects.filter((c) => lc(c.cls) === 'rourltransfer').length
      counts.createObjectDynamic += facts.createObjects.filter((c) => c.cls === '<dynamic>').length
      counts.syncGet += facts.syncGet; counts.asyncGet += facts.asyncGet; counts.certificateCalls += facts.certs
      brs.set(lc(pkg), { file, facts, text })
    }
  }
  for (const c of comps.values()) if (c.extends && lc(c.extends) === 'task') counts.tasks++ // direct, as the ground truth counts
  // the ground truth counts only direct `extends="Task"`; the tasks section below also follows inheritance.

  // chains and scripts
  const chain = (c) => { const out = []; const seen = new Set([lc(c.name)]); let n = c; while (n && n.extends && !seen.has(lc(n.extends))) { out.push(n.extends); seen.add(lc(n.extends)); n = comps.get(lc(n.extends)) } return out }
  const isScene = (c) => chain(c).some((n) => SCENE_BUILTINS.includes(lc(n)))
  const isTask = (c) => chain(c).some((n) => lc(n) === 'task')
  const scriptFiles = (c) => c.scripts.map((s) => resolveUri(c.file, s.uri)).filter(Boolean).map((p) => byLc.get(lc(p))).filter(Boolean)
  const closure = (c) => { const out = []; const seen = new Set(); let n = c; while (n && !seen.has(lc(n.name))) { seen.add(lc(n.name)); for (const f of scriptFiles(n)) if (!out.includes(f)) out.push(f); n = n.extends ? comps.get(lc(n.extends)) : null } return out }
  const initOf = (f) => { const e = brs.get(lc(f)); if (!e) return null; return (e.file.parser.references.functionStatements || []).find((s) => lc(s.name && s.name.text) === 'init') || null }
  const findInit = (c) => { for (const f of closure(c)) { const fn = initOf(f); if (fn) return { file: f, fn } } return null }
  const initLine = (fn) => fn.name.range.start.line + 1
  const bodyEmpty = (fn) => !fn.func.body.statements.some((s) => !isCommentStatement(s))
  const importersOf = (pkg) => [...comps.values()].filter((c) => scriptFiles(c).some((f) => lc(f) === lc(pkg)))
  const inlineInit = (c) => c.scripts.find((s) => s.cdata && /\b(sub|function)\s+init\s*\(/i.test(s.cdata))

  // scenes (plan mirrors the plugin's Scene init planning: ADR 0019 decisions 1.4 and 5)
  const scenes = []
  const inlineCdataScenes = []
  const covered = new Map()
  const cov = (c) => {
    if (covered.has(lc(c.name))) return covered.get(lc(c.name))
    covered.set(lc(c.name), false)
    let r = !!findInit(c)
    if (!r) { const par = c.extends && comps.get(lc(c.extends)); if (par && isScene(par)) r = cov(par) }
    covered.set(lc(c.name), r); return r
  }
  const reported = new Set()
  const skipOnce = (kind, file, line, reason, extra) => { const k = kind + '|' + lc(file); if (!reported.has(k)) { reported.add(k); skip(kind, file, line, reason, extra) } }
  const sortedComps = [...comps.values()].sort((a, b) => a.file.localeCompare(b.file))
  const excludedDescendant = (c) => sortedComps.find((o) => isExcluded(o.file) && isScene(o) && chain(o).some((n) => lc(n) === lc(c.name)))
  const extendsReason = (c, o) => `${c.name} is extended by the excluded Scene ${o.name}, which would inherit the bootstrap; the base init is left alone (un-exclude ${o.name} to bootstrap)`
  for (const c of sortedComps) {
    const injectable = !isExcluded(c.file)
    if (injectable && !isScene(c)) {
      const rootName = chain(c).slice(-1)[0] || (c.extends || '')
      if (rootName && !comps.has(lc(rootName)) && isUnknownSceneRoot(lc(rootName))) {
        skip('unknown-scene-subtype', c.file, 1, `built-in root "${lc(rootName)}" is not in the known Scene or non-Scene built-in lists; if it is a Scene type the component is not bootstrapped`)
      }
    }
    if (!isScene(c)) continue
    const own = findInit(c)
    const entry = { component: c.name, file: c.file, extendsChain: chain(c), hasInit: !!own, plan: 'none', excluded: !injectable }
    if (!injectable) { entry.plan = 'excluded'; scenes.push(entry); continue }
    if (own) {
      entry.initFile = own.file; entry.initLine = initLine(own.fn)
      if (isExcluded(own.file)) { entry.plan = 'skipped:init-in-excluded-file'; skip('init-in-excluded-file', own.file, initLine(own.fn), `init of ${c.name} lives in an excluded file; the Scene is not bootstrapped and no second init is synthesized`) }
      else if (bodyEmpty(own.fn)) { entry.plan = 'skipped:empty-init'; skip('empty-init', own.file, initLine(own.fn), 'init has no statements, nothing to wrap') }
      else {
        const exScene = sortedComps.find((o) => isExcluded(o.file) && isScene(o) && scriptFiles(o).some((f) => lc(f) === lc(own.file)))
        const exKid = exScene ? null : excludedDescendant(c)
        if (exScene) { entry.plan = 'skipped:init-shared-with-excluded-scene'; skipOnce('init-shared-with-excluded-scene', own.file, initLine(own.fn), `init is shared with the excluded Scene ${exScene.name}; wrapping it would bootstrap a Scene the user excluded, so it is left alone`, { via: 'import', component: exScene.name }) }
        else if (exKid) { entry.plan = 'skipped:init-shared-with-excluded-scene'; skipOnce('init-shared-with-excluded-scene', own.file, initLine(own.fn), extendsReason(c, exKid), { via: 'extends', component: exKid.name }) }
        else entry.plan = 'bootstrap'
      }
      scenes.push(entry); continue
    }
    if (cov(c)) { entry.hasInit = true; entry.plan = 'bootstrap'; scenes.push(entry); continue }
    const inl = inlineInit(c)
    if (inl) {
      entry.plan = 'skipped:inline-cdata-scene'
      skip('inline-cdata-scene', c.file, inl.line, 'Scene init lives in an inline CDATA script; bsc does not parse it, so the Scene is not bootstrapped')
      inlineCdataScenes.push({ component: c.name, file: c.file, scriptLine: inl.line, initDetected: true, note: 'state agent unavailable for this Scene' })
    } else if (!(c.extends && comps.get(lc(c.extends)) && isScene(comps.get(lc(c.extends))))) {
      const exKid = excludedDescendant(c)
      if (exKid) { entry.plan = 'skipped:init-shared-with-excluded-scene'; skipOnce('init-shared-with-excluded-scene', c.file, 1, extendsReason(c, exKid), { via: 'extends', component: exKid.name }) }
      else entry.plan = 'synthesize'
    } else entry.plan = 'synthesize-in-parent'
    scenes.push(entry)
  }

  const tasks = sortedComps.filter(isTask).map((c) => {
    let fnName = c.xmlFunctionName
    if (!fnName) for (const f of closure(c)) { const e = brs.get(lc(f)); if (e && e.facts.functionNames.length) { fnName = e.facts.functionNames[0]; break } }
    return { component: c.name, file: c.file, functionName: fnName || null }
  })

  // per-file thread context: which components import the file
  const threadOf = (pkg) => {
    const imp = importersOf(pkg)
    if (!imp.length) return /^source\//i.test(pkg) ? 'render' : 'unknown'
    const t = imp.filter(isTask).map((c) => `task:${c.name}`)
    return t.length === imp.length ? t.join(',') : (t.length ? `mixed:${t.join(',')}` : 'render')
  }

  // network sites
  const globalFields = []
  const registrySections = []
  const setUrlSites = []
  const createObjectSites = []
  const notCovered = []
  for (const [key, { file, facts }] of [...brs.entries()].sort()) {
    const pkg = file.pkgPath
    const excluded = isExcluded(pkg)
    for (const g of facts.globalFields) globalFields.push({ name: g.name, file: pkg, line: g.line })
    for (const r of facts.registry) registrySections.push({ name: r.name, file: pkg, line: r.line })
    const thread = threadOf(pkg)
    for (const co of facts.createObjects) {
      const url = lc(co.cls) === 'rourltransfer'
      if (!url && co.cls !== '<dynamic>') continue
      const dyn = co.cls === '<dynamic>'
      const covered = !excluded && !dyn
      createObjectSites.push({ file: pkg, line: co.line, class: co.cls === '<dynamic>' ? '<dynamic>' : 'roUrlTransfer', covered })
      if (excluded) notCovered.push({ file: pkg, line: co.line, reason: 'excluded' })
      else if (dyn) notCovered.push({ file: pkg, line: co.line, reason: 'dynamic CreateObject' })
    }
    const sites = classifier.analyzeFile(file)
    if (excluded) {
      if (sites.length) skip('excluded-candidate', pkg, sites[0].line, 'file is in an excluded glob and contains setUrl/getUrl call sites that are not rewritten', { excludedBy: isDefaultExcluded(pkg) ? 'default' : 'user' })
    }
    const siteKeys = new Map()
    for (const s of sites) {
      const kind = s.name === 'seturl' ? 'setUrl' : 'getUrl'
      if (s.indexed) { if (!excluded) skip('indexed-' + s.name, pkg, s.line, `indexed call ["${kind}"] is not rewritten`); continue }
      if (!s.eligible) {
        if (s.name === 'geturl' && s.expr.args.length === 0 && !excluded) skip('bare-geturl', pkg, s.line, 'getUrl() used as a bare statement: its result is discarded, nothing to rewrite')
        continue
      }
      if (!excluded) {
        if (s.action === 'excluded') skip('net-receiver-excluded', pkg, s.line, `${s.receiver}.${kind}: ${s.reason}; not rewritten`)
        else if (s.action === 'unknown-skip') skip('net-receiver-unknown', pkg, s.line, `${s.receiver}.${kind}: ${s.reason}; skipped because instrument.net.unknown is "report"`)
      }
      if (s.name !== 'seturl') continue
      const covered = !excluded && s.action === 'rewrite'
      setUrlSites.push({ file: pkg, line: s.line, receiver: s.receiver, thread, covered, confidence: s.cls })
      siteKeys.set(s.expr, s)
      if (!covered) notCovered.push({ file: pkg, line: s.line, reason: excluded ? 'excluded' : 'receiver not a roUrlTransfer' })
    }
    // sync transfers on the render thread are never intercepted off-thread: report them
    if (!excluded && !/^task:/.test(thread)) {
      const recvs = new Set(sites.filter((s) => s.eligible && s.name === 'seturl').map((s) => s.receiver))
      for (const sc of facts.syncCalls) if (recvs.has(sc.receiver)) notCovered.push({ file: pkg, line: sc.line, reason: 'render-thread sync' })
    }
    if (!excluded) for (const ln of facts.callFuncSetUrl) skip('callfunc-seturl', pkg, ln, 'callFunc("setUrl", ...) is not rewritten and cannot work on a real roUrlTransfer (informational)')
    for (const cu of facts.contentUrls) notCovered.push({ file: pkg, line: cu.line, reason: 'content-node URL' })
  }
  // setUrl inside inline CDATA scripts: invisible to the plugin (bsc does not parse CDATA), so only the census reports it
  for (const c of sortedComps) {
    for (const sc of c.scripts) {
      if (!sc.cdata) continue
      sc.cdata.split('\n').forEach((ln, i) => { if (/\.\s*setUrl\s*\(/i.test(ln.replace(/'.*$/, ''))) inlineCdataSetUrl.push({ component: c.name, file: c.file, line: sc.cdataLine + i }) })
    }
  }
  for (const p of parseErrors) if (/component XML/.test(p.reason)) skip('xml-parse-failed', p.file, 1, p.reason)

  const order = (a, b) => (a.file || '').localeCompare(b.file || '') || (a.line || 0) - (b.line || 0)
  return {
    v: 1,
    root: path.basename(root),
    counts,
    scenes,
    tasks,
    globalFields: globalFields.sort(order),
    registrySections: registrySections.sort(order),
    network: { setUrlSites: setUrlSites.sort(order), createObjectSites: createObjectSites.sort(order) },
    notCovered: notCovered.sort(order),
    skipped: skipped.sort(order),
    inlineCdataScenes,
    inlineCdataSetUrl,
    parseErrors,
  }
}

// ---- markdown ----------------------------------------------------------------------------------------------------
function renderMarkdown(c) {
  const out = []
  const table = (head, rows) => {
    if (!rows.length) { out.push('_none_', ''); return }
    out.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`)
    for (const r of rows) out.push(`| ${r.map((x) => String(x === undefined || x === null ? '' : x).replace(/\|/g, '\\|')).join(' | ')} |`)
    out.push('')
  }
  const k = c.counts
  out.push(`# Instrumentation census: ${c.root}`, '')
  out.push(`Files: ${k.brsFiles} BrightScript, ${k.xmlFiles} XML; ${k.components} components, ${k.tasks} tasks.`)
  out.push(`Network: ${k.urlTransferLiteral} roUrlTransfer literals, ${k.createObjectDynamic} dynamic CreateObject, ${k.syncGet} sync get, ${k.asyncGet} async get, ${k.certificateCalls} certificate calls.`, '')
  out.push(`## Scenes (${c.scenes.length})`, '')
  table(['Component', 'File', 'Extends', 'Init', 'Plan'], c.scenes.map((s) => [s.component, s.file, s.extendsChain.join(' > '), s.hasInit ? 'yes' : 'no', s.plan]))
  out.push(`## Tasks (${c.tasks.length})`, '')
  table(['Component', 'File', 'Function'], c.tasks.map((t) => [t.component, t.file, t.functionName]))
  out.push(`## Global fields (${c.globalFields.length})`, '')
  table(['Name', 'File', 'Line'], c.globalFields.map((g) => [g.name, g.file, g.line]))
  out.push(`## Registry sections (${c.registrySections.length})`, '')
  table(['Name', 'File', 'Line'], c.registrySections.map((g) => [g.name, g.file, g.line]))
  out.push(`## setUrl sites (${c.network.setUrlSites.length})`, '')
  table(['File', 'Line', 'Receiver', 'Thread', 'Class', 'Covered'], c.network.setUrlSites.map((s) => [s.file, s.line, s.receiver, s.thread, s.confidence, s.covered ? 'yes' : 'no']))
  out.push(`## CreateObject sites (${c.network.createObjectSites.length})`, '')
  table(['File', 'Line', 'Class', 'Covered'], c.network.createObjectSites.map((s) => [s.file, s.line, s.class, s.covered ? 'yes' : 'no']))
  out.push(`## Not covered (${c.notCovered.length})`, '')
  table(['File', 'Line', 'Reason'], c.notCovered.map((n) => [n.file, n.line, n.reason]))
  const hard = c.skipped.filter((s) => !s.informational)
  out.push(`## Could not instrument (${hard.length})`, '')
  table(['Kind', 'File', 'Line', 'Reason'], hard.map((s) => [s.kind, s.file, s.line, s.reason]))
  const info = c.skipped.filter((s) => s.informational)
  if (info.length) { out.push(`## Informational (${info.length})`, ''); table(['Kind', 'File', 'Line', 'Reason'], info.map((s) => [s.kind, s.file, s.line, s.reason])) }
  if (c.inlineCdataScenes.length) {
    out.push(`## Inline CDATA Scenes (report only, ${c.inlineCdataScenes.length})`, '')
    table(['Component', 'File', 'Script tag line', 'Init detected', 'Note'], c.inlineCdataScenes.map((s) => [s.component, s.file, s.scriptLine, s.initDetected ? 'yes' : 'no', s.note]))
  }
  if (c.inlineCdataSetUrl.length) {
    out.push(`## setUrl in inline CDATA (census only, never rewritten, ${c.inlineCdataSetUrl.length})`, '')
    table(['Component', 'File', 'Line'], c.inlineCdataSetUrl.map((s) => [s.component, s.file, s.line]))
  }
  if (c.parseErrors.length) { out.push(`## Parse problems (${c.parseErrors.length})`, ''); table(['File', 'Reason'], c.parseErrors.map((p) => [p.file, p.reason])) }
  return out.join('\n')
}

function write(c, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const json = path.join(outDir, 'census.json')
  const md = path.join(outDir, 'census.md')
  fs.writeFileSync(json, JSON.stringify(c, null, 2) + '\n')
  fs.writeFileSync(md, renderMarkdown(c) + '\n')
  return { json, md }
}

module.exports = { census, renderMarkdown, write }
