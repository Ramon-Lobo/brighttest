'use strict'
// brighttest instrument plugin (INS-F-T1 skeleton): a brighterscript 0.73 plugin that rewrites a staged build only.
// Design: ADR 0015 (single staged plugin), ADR 0017 (name-based rewrites). Prototype findings: SPK-SP2.
//
// PLUGIN ORDER CONTRACT: list this plugin AFTER the Rooibos coverage processor ("rooibos"). If it runs first, its
// Scene `init` wrapper hides the first statement from Rooibos's AST walk and that line drops out of coverage
// (SPK-SP2: denominator 227 vs 230). The plugin object advertises this as `runsAfter: 'rooibos'`, and
// `assertPluginOrder()` enforces it for build helpers. Do not "fix" this by delegating walk() to the wrapped
// statement: Rooibos edits the owner array and crashes.
//
// Not handled (reported, not fixed): Scenes whose `init` lives in an inline CDATA script. bsc does not parse CDATA
// scripts, so such an init is invisible; the plugin counts those Scenes (`inlineInitUnhandled`) and skips synthesis
// so no duplicate `init` is created. Those Scenes are NOT bootstrapped.
//
// LINE NUMBERS (ADR 0019 Amendment C, F4): line numbers are NOT preserved for rewritten files. bsc re-emits an
// AST-edited file (blank lines dropped, inline `if` and single-line AA literals expanded, `a : b` split), so a rewritten
// file differs from its source. Guaranteed: (1) an unrewritten .brs file is byte-identical to the source; (2) a rewritten
// file equals, line for line, the plugin-off build in which every file is AST-transpiled (the plugin adds, removes and
// moves no line of its own: rewrites stay in place, the Scene bootstrap sits on the `init` signature line, new code lives
// in new files); (3) excluded/vendor files are untouched; (4) a runtime error inside BT_* reports the runtime file's line.
// Crash lines of a rewritten file must be mapped (`instrument.lineMap` is a follow-up, INS-F-T9; not implemented here).
//
// Scene init bootstrap (F1): `sub init() : BT_bootstrap(m.top)` with the original body on the following lines, valid
// before any first statement. After every transpile the emitted text of each rewritten file is re-parsed through a
// scratch Program; a parse error fails the build as BT9003 `staged-output-invalid` (file, staged line, bsc code).
// Firmware acceptance of a colon after the signature is unverified (TP-INS-14 sub-check (g)).
//
// Excluded components (F2/F3): the plan reads the whole program. An excluded component that imports a rewritten file
// gets the runtime script import only (info entry `rewritten-shared-with-excluded`). An `init` in an excluded file, or
// shared with an excluded Scene, is never wrapped and never duplicated (`init-in-excluded-file`,
// `init-shared-with-excluded-scene`; both count as "could not instrument", unlike INFORMATIONAL_KINDS).
//
// Net rewrite (ADR 0017 + ADR 0019 Amendment A, INS-F-T8): the member name is the gate (`setUrl` with one argument,
// `getUrl` with none), then lib/instrument/receiver.js classifies each site's receiver from static evidence in one
// function/file: confirmed, likely, unknown or excluded. Confirmed, likely and unknown are rewritten; unknown sites are
// listed in rewritten[] with confidence "unknown" (`instrument.net.unknown: "report"` skips them instead and records
// `net-receiver-unknown`). Excluded sites (another type, or an `instrument.net.receivers.deny` match) are not rewritten
// and recorded as `net-receiver-excluded`; an allow match overrides excluded, deny wins over allow. `getUrl` follows its
// receiver's `setUrl`. Config: `instrument.net` is `true|false` (on/off) or `{ unknown, receivers: { allow, deny } }`.
// The runtime helpers stay type-tolerant (non-strings pass through), so a false positive is harmless at runtime.
//
// Uses brighterscript's public exports plus a few internals (SGTypes, file.parser.references.scriptTagImports,
// file.attachDependencyGraph, ast.component.api.setFunction). They are confined to `addScript` and `declareOp`, and
// `missingPrivateApis` feature-detects them so a brighterscript bump fails the build with a message naming the API
// (pin brighterscript to 0.73.x and re-test on upgrade; ADR 0019 decision 3). The signature-line bootstrap uses the
// AstEditor and Block#transpile (`withSignatureCall`), also feature-detected; Program#plugins.plugins is detected too.
//
// BT_AGENT: the plugin defines the `BT_AGENT` conditional-compile constant itself (`options.manifest.bs_const`, set in
// beforeProgramCreate/afterProgramCreate, i.e. before any file is parsed), because bsc evaluates `#if` from the source
// manifest plus that option and never from the staged manifest. Every injected file is wrapped in `#if BT_AGENT`.
//
// getResult() schema 1 (additive): { schema, stats, skipped[{kind,file,line,reason}], synthesized[componentName],
// bootstrapped[{file,line}], opInjected[componentName], excluded[{file,reason}], inlineInitUnhandled[componentName],
// invalid[{file,line,code,message,kinds}], manifestWritten, rewritten[{kind:"setUrl"|"getUrl",file,line,receiver,
// confidence:"confirmed"|"likely"|"unknown"}], netOverlaps[{file,line,receiver,allow,deny}] }; stats.netRewrites
// {confirmed,likely,unknown,excluded} counts classified net sites. skipped[] adds kinds net-receiver-excluded (informational)
// and net-receiver-unknown. Census and verify consume it.
//
// createPlugin.lastInstance is process-global and exists only so a path-loaded plugin (bsconfig `plugins`) can be read
// after a build; it is single-build. Use the object returned by createPlugin() when you construct the plugin yourself.
// One plugin instance serves one program: a second beforeProgramValidate on the same program is ignored.
const fs = require('node:fs')
const path = require('node:path')
const bsc = require('brighterscript')
const receiver = require('./receiver')
const { globToRegExp } = receiver

let SGTypes = null
try { SGTypes = require('brighterscript/dist/parser/SGTypes') } catch (e) { /* reported by missingPrivateApis */ }

const {
  isBrsFile, isXmlFile, isDottedGetExpression, isIndexedGetExpression, isLiteralString, isExpressionStatement,
  isCommentStatement, createVisitor, WalkMode, ParseMode,
  CallExpression, VariableExpression, createIdentifier, createToken, TokenKind,
} = bsc

const PLUGIN_NAME = 'brighttest-instrument'
const RUNS_AFTER = 'rooibos'
const RUNTIME_PKG = 'source/bt/BT_runtime.brs'
const MARKER_KEY = 'bt_instrumented'
const MARKER_VALUE = '1'
const BS_CONST_FLAG = 'BT_AGENT'

// Package-path globs never rewritten. Matching is case-insensitive and dotfile-tolerant.
const DEFAULT_EXCLUDE = Object.freeze([
  'source/vendor/**',
  'source/rooibos/**',
  'roku_modules/**',
  'components/bt/**',
  'source/bt/**',
  '**/*rooibos*',
  '**/*rooibos*/**',
  '**/*.spec.*',
])

// The injected runtime must not count toward coverage. INS-F-T2 wires this into the rooibos block of config.js.
const RUNTIME_COVERAGE_EXCLUDE = Object.freeze(['**/source/bt/**', '**/components/bt/**'])

// Skeleton runtime (placeholder until the real runtime files land with INS-F-T2/T3). Kept here so the plugin is
// self-contained for TP-INS-17. BT_op is the callFunc entry point declared on every root component.
const RUNTIME_SRC = [
  '#if BT_AGENT',
  "' brighttest instrument runtime (skeleton). Injected into staged builds only.",
  'function BT_url(u as dynamic) as dynamic',
  '    if type(u) <> "String" and type(u) <> "roString" then return u',
  '    return u',
  'end function',
  '',
  'function BT_unurl(u as dynamic) as dynamic',
  '    return u',
  'end function',
  '',
  'sub BT_bootstrap(top as object)',
  '    if not top.isSubtype("Scene") then return',
  '    if top.hasField("__bt_boot") then return',
  '    top.addField("__bt_boot", "boolean", false)',
  'end sub',
  '',
  'function BT_op(args as dynamic) as dynamic',
  '    return { ok: true }',
  'end function',
  '#end if',
  '',
].join('\n')

// Every name the runtime defines. A user function with one of these names (any case) fails the build (BT9001).
const RESERVED_NAMES = Object.freeze(['BT_op', 'BT_url', 'BT_unurl', 'BT_bootstrap'])

// Built-in Scene types a component's extends chain may reach (Roku docs; not verified on a device). A built-in root
// whose name contains "scene" but is not listed here is reported in skipped[] rather than guessed.
const SCENE_BUILTINS = Object.freeze(['scene', 'overhangpanelsetscene'])

// skipped[] kinds that are informational: they do not count as "could not instrument" under instrument.strict.
const INFORMATIONAL_KINDS = Object.freeze(['rewritten-shared-with-excluded', 'net-receiver-excluded'])

const lc = (s) => String(s || '').toLowerCase()

// ---- tiny glob matcher (no minimatch: it is only a transitive dependency; shared with the receiver classifier) ----

function makeMatcher(globs) {
  const res = globs.map(globToRegExp)
  return (pkgPath) => {
    const p = String(pkgPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
    return res.some((r) => r.test(p))
  }
}

// ---- manifest: bs_const merge + marker -----------------------------------------------------------------------
// Keeps every original bs_const entry and its value, sets BT_AGENT=true, sets bt_instrumented=1. No other line changes.
function mergeManifest(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const lines = String(text).split(/\r?\n/)
  const trailing = lines.length && lines[lines.length - 1] === ''
  if (trailing) lines.pop()
  const keyOf = (l) => { const m = /^\s*([^=#\s][^=]*?)\s*=/.exec(l); return m ? lc(m[1]) : null }
  let constIdx = -1
  let markerIdx = -1
  lines.forEach((l, i) => {
    if (keyOf(l) === 'bs_const' && constIdx < 0) constIdx = i
    if (keyOf(l) === MARKER_KEY && markerIdx < 0) markerIdx = i
  })
  if (constIdx >= 0) {
    const value = lines[constIdx].slice(lines[constIdx].indexOf('=') + 1)
    const entries = value.split(';').map((s) => s.trim()).filter(Boolean)
      .filter((e) => lc(e.split('=')[0].trim()) !== lc(BS_CONST_FLAG))
    entries.push(`${BS_CONST_FLAG}=true`)
    lines[constIdx] = 'bs_const=' + entries.join(';')
  } else lines.push(`bs_const=${BS_CONST_FLAG}=true`)
  if (markerIdx >= 0) lines[markerIdx] = `${MARKER_KEY}=${MARKER_VALUE}`
  else lines.push(`${MARKER_KEY}=${MARKER_VALUE}`)
  return lines.join(eol) + eol
}

// ---- AST node helpers --------------------------------------------------------------------------------------
// F1 (ADR 0019 Amendment C): the bootstrap call goes on the `init` signature line, `sub init() : BT_bootstrap(m.top)`,
// and the original body follows on its own lines. A same-line prefix on the first statement is invalid for an `if`
// (BS1054). The body Block of the one FunctionExpression is replaced (through the AstEditor, undone after emit) by a
// prototype-linked view whose transpile emits the call first. Block.transpile starts every statement with a newline,
// so the call lands right after `)` or `as <type>` and no line is added or removed.
function withSignatureCall(block, text) {
  const view = Object.create(block)
  view.transpile = (state) => [text, ...block.transpile(state)]
  return view
}

function call(name, args, range) {
  return new CallExpression(
    new VariableExpression(createIdentifier(name, range)),
    createToken(TokenKind.LeftParen, '(', range),
    createToken(TokenKind.RightParen, ')', range),
    args,
  )
}

function assertPluginOrder(plugins) {
  const name = (p) => (typeof p === 'string' ? p : (p && p.name) || '')
  const idx = (re) => plugins.findIndex((p) => re.test(name(p)))
  const mine = idx(/instrument[\\/]plugin(\.js)?$|^brighttest-instrument$/)
  const rooibos = idx(/rooibos/i)
  if (mine >= 0 && rooibos >= 0 && mine < rooibos) {
    throw new Error('brighttest instrument plugin must be listed after the rooibos plugin (coverage ordering contract)')
  }
  return true
}

// ---- private-API confinement (ADR 0019 decision 3) ----------------------------------------------------------------
// Returns the names of the brighterscript internals this plugin relies on that are missing. `sample` is any parsed
// component XML file (or undefined at load time).
function missingPrivateApis(sample, program) {
  const out = receiver.missingApis()
  if (typeof bsc.Program !== 'function') out.push('Program (scratch verify program)')
  if (typeof bsc.Block !== 'function' || typeof bsc.Block.prototype.transpile !== 'function') out.push('Block#transpile (signature-line bootstrap)')
  if (program && !(program.plugins && Array.isArray(program.plugins.plugins))) out.push('Program#plugins.plugins')
  if (!SGTypes) out.push('brighterscript/dist/parser/SGTypes')
  else {
    if (typeof SGTypes.SGScript !== 'function') out.push('SGTypes.SGScript')
    if (typeof SGTypes.SGInterface !== 'function') out.push('SGTypes.SGInterface')
    else if (typeof SGTypes.SGInterface.prototype.setFunction !== 'function') out.push('SGTypes.SGInterface#setFunction')
  }
  if (sample) {
    if (typeof sample.attachDependencyGraph !== 'function') out.push('XmlFile#attachDependencyGraph')
    if (!sample.parser || !sample.parser.references || !Array.isArray(sample.parser.references.scriptTagImports)) out.push('XmlFile#parser.references.scriptTagImports')
    if (!sample.ast || !sample.ast.component || !Array.isArray(sample.ast.component.scripts)) out.push('XmlFile#ast.component.scripts')
    if (typeof sample.getAvailableScriptImports !== 'function') out.push('XmlFile#getAvailableScriptImports')
    if (!Array.isArray(sample.scriptTagImports)) out.push('XmlFile#scriptTagImports')
  }
  return out
}

// Adds a <script> tag for `pkg` to a component XML file. All script-tag internals live here.
function addScript(program, f, pkg) {
  const script = new SGTypes.SGScript(); script.uri = 'pkg:/' + pkg; script.type = 'text/brightscript'
  f.ast.component.scripts.push(script)
  f.parser.references.scriptTagImports.push({ pkgPath: pkg, text: 'pkg:/' + pkg, filePathRange: bsc.Range.create(0, 0, 0, 0) })
  f.attachDependencyGraph(program.dependencyGraph)
}

// Declares <function name="BT_op"/> on a component interface. All interface internals live here.
function declareOp(f) {
  if (!f.ast.component.api) f.ast.component.api = new SGTypes.SGInterface()
  f.ast.component.api.setFunction('BT_op')
}

function setBsConst(opts) {
  if (!opts) return
  opts.manifest = { ...(opts.manifest || {}), bs_const: { ...((opts.manifest && opts.manifest.bs_const) || {}), [BS_CONST_FLAG]: true } }
}

// ---- factory -----------------------------------------------------------------------------------------------
function createPlugin(factoryOptions) {
  let options = { net: true, scene: true, op: true, ...(factoryOptions || {}) }
  let isExcluded = makeMatcher([...DEFAULT_EXCLUDE, ...(options.exclude || [])])
  let sceneInits = new Map()
  const freshStats = () => ({
    setUrl: 0, getUrl: 0, initPrepend: 0, initSynth: 0, opInjected: 0, opSkippedInherited: 0, runtimeImports: 0,
    inlineInitUnhandled: 0, netRewrites: { confirmed: 0, likely: 0, unknown: 0, excluded: 0 },
  })
  let stats = freshStats()
  let inlineInitUnhandled = []
  let synthesized = []
  let skipped = []
  let bootstrapped = []
  let opInjected = []
  let excluded = []
  let manifestWritten = false
  let rewrittenKinds = new Set() // `${lower pkgPath}|${kind}` for every file this plugin edited at transpile
  let invalid = [] // BT9003 staged-output-invalid
  let netRewritten = [] // net sites rewritten, with the receiver confidence
  let netOverlaps = []
  let classifier = receiver.createClassifier()
  let netFiles = new Map() // file -> classified net sites (one walk per file)
  const netOn = () => options.net !== false
  let scratch = null // scratch bsc Program used by the verify step
  const processed = new WeakSet() // programs already planned: one plugin instance serves one program

  const skip = (kind, file, line, reason) => { skipped.push({ kind, file, line, reason }) }
  const diag = (p, file, code, message, range) => {
    const f = file || Object.values(p.files)[0]
    if (f) p.addDiagnostics([{ file: f, code, severity: 1, range: range || bsc.Range.create(0, 0, 0, 0), message }])
  }

  function configure(program) {
    const fromConfig = (program && program.options && program.options.instrument) || {}
    options = { net: true, scene: true, op: true, ...(factoryOptions || {}), ...fromConfig }
    isExcluded = makeMatcher([...DEFAULT_EXCLUDE, ...(factoryOptions && factoryOptions.exclude || []), ...(fromConfig.exclude || [])])
    const net = options.net && typeof options.net === 'object' ? options.net : {}
    const rc = net.receivers || {}
    classifier = receiver.createClassifier({ allow: rc.allow, deny: rc.deny, unknown: net.unknown })
    netFiles = new Map()
  }

  // Classified net sites of a file: one AST walk, cached for the planning and the transpile pass.
  const netSites = (file) => {
    if (!netFiles.has(file)) netFiles.set(file, classifier.analyzeFile(file))
    return netFiles.get(file)
  }
  const firstRewriteLine = (file) => {
    const hit = netSites(file).find((x) => x.action === 'rewrite')
    return hit ? hit.line : 0
  }

  // bsc evaluates `#if BT_AGENT` from options.manifest.bs_const at manifest load, before any file is parsed.
  function beforeProgramCreate(builder) { setBsConst(builder && builder.options) }
  function afterProgramCreate(program) { setBsConst(program && program.options) }

  function beforeProgramValidate(p) {
    if (processed.has(p)) return // second validate on the same program (watch mode): the plan is already applied
    processed.add(p)
    configure(p)
    stats = freshStats(); inlineInitUnhandled = []; synthesized = []; sceneInits = new Map(); manifestWritten = false
    skipped = []; bootstrapped = []; opInjected = []; excluded = []; rewrittenKinds = new Set(); invalid = []; scratch = null
    netRewritten = []; netOverlaps = []
    for (const e of classifier.errors) diag(p, null, 'BT9004', `brighttest instrument: ${e}`)
    const comps = []
    for (const f of Object.values(p.files)) if (isXmlFile(f) && f.componentName) comps.push(f)

    // Plugin order self-check (bsc has no runsAfter): rooibos must come before this plugin.
    const list = (p.plugins && p.plugins.plugins) || []
    const mine = list.indexOf(plugin)
    const rooibosIdx = list.findIndex((x) => /rooibos/i.test((x && x.name) || ''))
    if (mine >= 0 && rooibosIdx > mine) {
      diag(p, null, 'BT9002', 'brighttest instrument: plugin order is wrong, the rooibos plugin must be listed before the instrument plugin (otherwise Scene init lines drop out of coverage)')
      return
    }

    // Private brighterscript APIs must exist; otherwise fail the build naming them instead of degrading.
    const missing = missingPrivateApis(comps[0], p)
    if (missing.length) {
      diag(p, null, 'BT9003', `brighttest instrument: unsupported brighterscript version, missing internal API: ${missing.join(', ')} (pinned to 0.73.x)`)
      return
    }

    const byName = new Map(comps.map((f) => [lc(f.componentName.text), f]))
    const parentOf = (f) => byName.get(lc(f.parentComponentName && f.parentComponentName.text))
    const chain = (f) => {
      const out = []; const seen = new Set()
      let n = lc(f.parentComponentName && f.parentComponentName.text)
      while (n && !seen.has(n)) { seen.add(n); out.push(n); const pf = byName.get(n); n = pf ? lc(pf.parentComponentName && pf.parentComponentName.text) : '' }
      return out
    }
    const rootBuiltin = (f) => { const c = chain(f); return c.length ? c[c.length - 1] : '' }
    const injectable = (f) => !isExcluded(f.pkgPath)
    const ownScripts = (f) => f.scriptTagImports.map((i) => lc(i.pkgPath))
    const provides = (f, pkg) => ownScripts(f).includes(lc(pkg))

    // A user function named like a runtime function would collide with it: fail the build with a clear message.
    // Also report excluded files that still contain setUrl/getUrl call sites (never rewritten there).
    const reserved = new Set(RESERVED_NAMES.map(lc))
    for (const f of Object.values(p.files)) {
      if (!isBrsFile(f) || lc(f.pkgPath) === lc(RUNTIME_PKG)) continue
      if (isExcluded(f.pkgPath)) {
        const sites = netSites(f)
        if (sites.length) {
          const reason = 'file is in an excluded glob and contains setUrl/getUrl call sites that are not rewritten'
          excluded.push({ file: f.pkgPath, reason })
          skip('excluded-candidate', f.pkgPath, sites[0].line, reason)
        }
        continue
      }
      for (const s of f.parser.references.functionStatements) {
        // the full callable name: a namespaced `x.BT_url` becomes `x_BT_url` and cannot collide with the runtime
        const full = s.getName ? s.getName(ParseMode.BrightScript) : (s.name && s.name.text)
        const hit = reserved.has(lc(full)) ? full : null
        if (hit) {
          const canonical = RESERVED_NAMES.find((n) => lc(n) === lc(hit))
          diag(p, f, 'BT9001', `brighttest instrument: ${canonical} is reserved for the injected runtime; rename this function or exclude the file`, s.name.range)
        }
      }
    }

    if (!p.getFile(RUNTIME_PKG)) p.setFile({ src: path.resolve('__bt_runtime__.brs'), dest: RUNTIME_PKG }, RUNTIME_SRC)

    // 1) Scene init plan, built from the WHOLE program (excluded files included, F3). It runs before the runtime
    //    imports because the files it will wrap count as rewritten files for the F2 import rule.
    const isScene = (f) => chain(f).some((n) => SCENE_BUILTINS.includes(n))
    const inlineInit = (f) => (f.ast.component.scripts || []).find((sc) => sc.cdata && /\b(sub|function)\s+init\s*\(/i.test(sc.cdata.text || ''))
    const importedFiles = (f) => f.getAvailableScriptImports().map((imp) => p.getFile(imp)).filter((bf) => isBrsFile(bf))
    const importsPkg = (f, pkg) => f.getAvailableScriptImports().some((imp) => lc(imp) === lc(pkg))
    // First `init` in the component's own import closure, whether or not the file is rewritable.
    const findInit = (f) => {
      for (const bf of importedFiles(f)) {
        if (lc(bf.pkgPath) === lc(RUNTIME_PKG)) continue
        const fn = bf.parser.references.functionStatements.find((s) => lc(s.name && s.name.text) === 'init')
        if (fn) return { bf, fn, excluded: isExcluded(bf.pkgPath) }
      }
      return null
    }
    const initLine = (fn) => fn.name.range.start.line + 1
    const bodyEmpty = (fn) => !fn.func.body.statements.some((s) => !isCommentStatement(s))
    const covered = new Map()
    const cov = (f) => {
      if (covered.has(f)) return covered.get(f)
      let c = !!findInit(f)
      if (!c) { const par = parentOf(f); if (par && isScene(par)) c = cov(par) }
      covered.set(f, c); return c
    }
    const reported = new Set()
    const skipOnce = (kind, file, line, reason) => {
      const key = kind + '|' + lc(file)
      if (!reported.has(key)) { reported.add(key); skip(kind, file, line, reason) }
    }
    if (options.scene) {
      for (const f of comps) {
        if (injectable(f) && !isScene(f)) {
          const root = rootBuiltin(f)
          if (root && !byName.has(root) && /scene/i.test(root) && !SCENE_BUILTINS.includes(root)) {
            skip('unknown-scene-subtype', f.pkgPath, 1, `built-in root "${root}" looks like a Scene type but is not in the known Scene list; it is not bootstrapped`)
          }
        }
        if (!isScene(f) || !injectable(f)) continue
        const own = findInit(f)
        if (own) {
          if (own.excluded) {
            skip('init-in-excluded-file', own.bf.pkgPath, initLine(own.fn), `init of ${f.componentName.text} lives in an excluded file; the Scene is not bootstrapped and no second init is synthesized`)
            continue
          }
          if (bodyEmpty(own.fn)) { skip('empty-init', own.bf.pkgPath, initLine(own.fn), 'init has no statements, nothing to wrap'); continue }
          const exScene = comps.find((c) => !injectable(c) && isScene(c) && importsPkg(c, own.bf.pkgPath))
          if (exScene) {
            skipOnce('init-shared-with-excluded-scene', own.bf.pkgPath, initLine(own.fn), `init is shared with the excluded Scene ${exScene.componentName.text}; wrapping it would bootstrap a Scene the user excluded, so it is left alone`)
            continue
          }
          sceneInits.set(own.bf.pkgPath, (sceneInits.get(own.bf.pkgPath) || new Set()).add(own.fn))
          continue
        }
        if (cov(f)) continue
        const inl = inlineInit(f)
        if (inl) {
          stats.inlineInitUnhandled++; inlineInitUnhandled.push(f.componentName.text)
          skip('inline-cdata-scene', f.pkgPath, inl.range ? inl.range.start.line + 1 : 1, 'Scene init lives in an inline CDATA script; bsc does not parse it, so the Scene is not bootstrapped')
          continue
        }
        const par = parentOf(f)
        if (par && isScene(par)) continue // the user Scene parent is synthesized instead
        const stub = `components/bt/BT_init_${f.componentName.text}.brs`
        if (!p.getFile(stub)) {
          p.setFile({ src: '/__brighttest__/' + stub, dest: stub }, '#if BT_AGENT\nsub init()\n    BT_bootstrap(m.top)\nend sub\n#end if\n')
          addScript(p, f, stub); stats.initSynth++; synthesized.push(f.componentName.text)
        }
      }
    }

    // 2) Files that will be rewritten: net sites (non-excluded) and init files that will be wrapped.
    const rewritten = new Map() // lower-case pkgPath -> { pkg, line }
    if (netOn()) {
      for (const f of Object.values(p.files)) {
        if (!isBrsFile(f) || isExcluded(f.pkgPath) || lc(f.pkgPath) === lc(RUNTIME_PKG)) continue
        const line = firstRewriteLine(f)
        if (line) rewritten.set(lc(f.pkgPath), { pkg: f.pkgPath, line })
      }
    }
    for (const [pkg, fns] of sceneInits) {
      if (!rewritten.has(lc(pkg))) rewritten.set(lc(pkg), { pkg, line: initLine([...fns][0]) })
    }
    const importsRewritten = (f) => [...rewritten.values()].filter((r) => importsPkg(f, r.pkg))

    // 3) runtime import (+ BT_op declaration with the inheritance guard). Ancestors first: sort by chain length.
    //    Injectable components get both. An excluded component that imports a rewritten file gets the runtime import
    //    only (F2): runtime function definitions, no BT_op declaration, no bootstrap.
    const ordered = [...comps].sort((x, y) => chain(x).length - chain(y).length)
    const declared = (x) => !!x.ast.component.api && x.ast.component.api.functions.some((fn) => lc(fn.name) === 'bt_op')
    for (const f of ordered) {
      const inject = injectable(f)
      const shared = inject ? [] : importsRewritten(f)
      if (!inject && !shared.length) continue
      const ancestors = chain(f).map((n) => byName.get(n)).filter(Boolean)
      const inheritedRuntime = ancestors.some((a) => provides(a, RUNTIME_PKG))
      if (!inheritedRuntime && !provides(f, RUNTIME_PKG)) { addScript(p, f, RUNTIME_PKG); stats.runtimeImports++ }
      if (!inject) {
        for (const r of shared) {
          skip('rewritten-shared-with-excluded', r.pkg, r.line, `rewritten file is also imported by the excluded component ${f.componentName.text}; it got the runtime import only (informational)`)
        }
        continue
      }
      if (options.op) {
        const inheritedOp = ancestors.some((a) => declared(a))
        if (!declared(f) && !inheritedOp) {
          declareOp(f); stats.opInjected++; opInjected.push(f.componentName.text)
        } else if (inheritedOp) stats.opSkippedInherited++
      }
    }
  }

  function beforeFileTranspile(event) {
    const file = event.file
    if (!isBrsFile(file) || isExcluded(file.pkgPath)) return
    const editor = event.editor
    const done = new WeakSet()
    const at = (expr) => expr.range.start.line + 1
    if (netOn()) {
      const sites = new Map(netSites(file).map((x) => [x.expr, x]))
      const netStat = (cls) => { stats.netRewrites[cls]++ }
      const handle = (site, expr, owner, key, kind) => {
        if (site.overlap) netOverlaps.push({ file: file.pkgPath, line: site.line, receiver: site.receiver, ...site.overlap })
        if (site.action === 'excluded') {
          skip('net-receiver-excluded', file.pkgPath, site.line, `${site.receiver}.${kind}: ${site.reason}; not rewritten`)
          netStat('excluded'); return false
        }
        if (site.action === 'unknown-skip') {
          skip('net-receiver-unknown', file.pkgPath, site.line, `${site.receiver}.${kind}: ${site.reason}; skipped because instrument.net.unknown is "report"`)
          netStat('unknown'); return false
        }
        netStat(site.cls)
        netRewritten.push({ kind, file: file.pkgPath, line: site.line, receiver: site.receiver, confidence: site.cls })
        return true
      }
      file.ast.walk(createVisitor({
        CallExpression: (expr, parent, owner, key) => {
          if (done.has(expr)) return
          const nm = calleeMember(expr.callee)
          if (!nm) return
          if (isIndexedGetExpression(expr.callee)) {
            if (nm === 'seturl' || nm === 'geturl') skip('indexed-' + nm, file.pkgPath, at(expr), `indexed call ["${nm === 'seturl' ? 'setUrl' : 'getUrl'}"] is not rewritten`)
            return
          }
          // A node another plugin created after planning has no classification: treat it as unknown (fail toward interception).
          const site = sites.get(expr) || { action: 'rewrite', cls: 'unknown', line: at(expr), receiver: receiver.toText(expr.callee.obj) || '<expression>', reason: '' }
          if (nm === 'seturl' && expr.args.length === 1) {
            if (!handle(site, expr, owner, key, 'setUrl')) return
            editor.setProperty(expr.args, 0, call('BT_url', [expr.args[0]], expr.range))
            stats.setUrl++; rewrittenKinds.add(lc(file.pkgPath) + '|net')
          } else if (nm === 'geturl' && expr.args.length === 0) {
            if (!owner || isExpressionStatement(owner)) {
              skip('bare-geturl', file.pkgPath, at(expr), 'getUrl() used as a bare statement: its result is discarded, nothing to rewrite')
              return
            }
            if (!handle(site, expr, owner, key, 'getUrl')) return
            done.add(expr) // the walk descends into the node created here; never wrap twice
            editor.setProperty(owner, key, call('BT_unurl', [expr], expr.range))
            stats.getUrl++; rewrittenKinds.add(lc(file.pkgPath) + '|net')
          }
        },
      }), { walkMode: WalkMode.visitAllRecursive })
    }
    const inits = sceneInits.get(file.pkgPath)
    if (inits) {
      for (const fn of inits) {
        editor.setProperty(fn.func, 'body', withSignatureCall(fn.func.body, ' : BT_bootstrap(m.top)'))
        stats.initPrepend++; bootstrapped.push({ file: file.pkgPath, line: fn.name.range.start.line + 1 })
        rewrittenKinds.add(lc(file.pkgPath) + '|init-bootstrap')
      }
    }
  }

  // Verify step (F1, always on): transpile-time rewrites bypass bsc validation, so re-parse every rewritten file's
  // emitted text through a scratch Program (not Parser.parse: it rejects a valid `#if` with 1081). Any parse error
  // becomes BT9003 staged-output-invalid with file, staged line, bsc code and the rewrite kind(s).
  function afterFileTranspile(event) {
    const file = event.file
    if (!isBrsFile(file) || typeof event.code !== 'string') return
    const kinds = ['net', 'init-bootstrap'].filter((k) => rewrittenKinds.has(lc(file.pkgPath) + '|' + k))
    if (!kinds.length) return
    const program = event.program
    if (!scratch) {
      const bsConst = (program.options && program.options.manifest && program.options.manifest.bs_const) || {}
      scratch = new bsc.Program({ rootDir: '/__brighttest_verify__', manifest: { bs_const: { ...bsConst, [BS_CONST_FLAG]: true } } })
    }
    const dest = file.pkgPath.replace(/\.bs$/i, '.brs')
    let errs = []
    try {
      const sf = scratch.setFile({ src: '/__brighttest_verify__/' + dest, dest }, event.code)
      errs = sf.getDiagnostics().filter((d) => d.severity === 1)
      scratch.removeFile(sf.srcPath)
    } catch (e) {
      errs = [{ code: 'parse-threw', message: String(e && e.message || e), range: bsc.Range.create(0, 0, 0, 0) }]
    }
    for (const d of errs) {
      const line = d.range ? d.range.start.line + 1 : 0
      const rec = { file: file.pkgPath, line, code: d.code, message: d.message, kinds }
      invalid.push(rec)
      diag(program, file, 'BT9003', `brighttest instrument: staged-output-invalid: ${file.pkgPath}:${line} bsc ${d.code} "${d.message}" (rewrite: ${kinds.join(', ')})`, bsc.Range.create(Math.max(line - 1, 0), 0, Math.max(line - 1, 0), 0))
    }
  }

  // Staged manifest: merge bs_const and add the marker once bsc has written the staging dir.
  // bsc zips the staging dir only after the transpile emit returns (ProgramBuilder.createPackageIfEnabled), so this
  // runs before the zip; test/instrument-plugin.test.js covers createPackage:true.
  function afterProgramTranspile(arg) {
    const program = (arg && arg.program) || arg
    const staging = program && program.options && program.options.stagingDir
    if (!staging) return
    const mf = path.join(staging, 'manifest')
    if (!fs.existsSync(mf)) return
    fs.writeFileSync(mf, mergeManifest(fs.readFileSync(mf, 'utf8')))
    manifestWritten = true
    if (invalid.length) {
      const first = invalid[0]
      throw new Error(`BT9003 staged-output-invalid: ${invalid.length} parse error(s) in rewritten output, first ${first.file}:${first.line} bsc ${first.code} (rewrite: ${first.kinds.join(', ')})`)
    }
  }

  const plugin = {
    name: PLUGIN_NAME,
    runsAfter: RUNS_AFTER,
    beforeProgramCreate,
    afterProgramCreate,
    beforeProgramValidate,
    beforeFileTranspile,
    afterFileTranspile,
    afterProgramTranspile,
    // Result object for the census (INS-F-T4) and tests. Schema 1 is additive.
    getResult: () => ({
      schema: 1,
      stats: { ...stats, netRewrites: { ...stats.netRewrites } },
      skipped: skipped.map((x) => ({ ...x })),
      synthesized: [...synthesized],
      bootstrapped: bootstrapped.map((x) => ({ ...x })),
      opInjected: [...opInjected],
      excluded: excluded.map((x) => ({ ...x })),
      inlineInitUnhandled: [...inlineInitUnhandled],
      invalid: invalid.map((x) => ({ ...x, kinds: [...x.kinds] })),
      manifestWritten,
      rewritten: netRewritten.map((x) => ({ ...x })),
      netOverlaps: netOverlaps.map((x) => ({ ...x })),
    }),
  }
  createPlugin.lastInstance = plugin // single-build, process-global: see the header comment
  return plugin
}

// Member name of a call target: `a.name` or `a["name"]` (string literal), lower-cased; '' for anything else.
function calleeMember(callee) {
  if (isDottedGetExpression(callee)) return lc(callee.name.text)
  if (isIndexedGetExpression(callee) && callee.index && isLiteralString(callee.index)) {
    return lc(String(callee.index.token.text).replace(/^"|"$/g, ''))
  }
  return ''
}

module.exports = createPlugin
module.exports.default = createPlugin
Object.assign(module.exports, {
  createPlugin, mergeManifest, makeMatcher, assertPluginOrder, missingPrivateApis,
  DEFAULT_EXCLUDE, RUNTIME_COVERAGE_EXCLUDE, RUNS_AFTER, RUNTIME_PKG, MARKER_KEY, MARKER_VALUE, BS_CONST_FLAG,
  RESERVED_NAMES, SCENE_BUILTINS, RUNTIME_SRC, INFORMATIONAL_KINDS,
})
