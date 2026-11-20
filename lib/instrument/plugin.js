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
// Known false-positive class (ADR 0017): the net rewrite matches the member name only, so any object with a
// `setUrl` / `getUrl` method is rewritten. The runtime helpers are type-tolerant (non-strings pass through).
//
// Uses brighterscript's public exports plus the same three internals as the spike: SGTypes, file.parser.references
// .scriptTagImports and file.attachDependencyGraph (pin brighterscript to 0.73.x and re-test on upgrade).
const fs = require('node:fs')
const path = require('node:path')
const bsc = require('brighterscript')
const SGTypes = require('brighterscript/dist/parser/SGTypes')

const {
  isBrsFile, isXmlFile, isDottedGetExpression, isCommentStatement, createVisitor, WalkMode,
  CallExpression, VariableExpression, Statement, createIdentifier, createToken, TokenKind,
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
  '',
].join('\n')

const lc = (s) => String(s || '').toLowerCase()

// ---- tiny glob matcher (no minimatch: it is only a transitive dependency) --------------------------------------
function globToRegExp(glob) {
  let re = ''
  const g = String(glob).replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$', 'i')
}

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
// Emits `<prefix> : <original first statement>` on the original line (a separate line would shift line numbers).
class PrefixedStatement extends Statement {
  constructor(prefixText, inner) { super(); this.prefixText = prefixText; this.inner = inner }
  get range() { return this.inner.range }
  transpile(state) { return [state.sourceNode(this.inner, this.prefixText + ' : '), ...this.inner.transpile(state)] }
  walk() { /* opaque on purpose: see the plugin order contract */ }
  clone() { return new PrefixedStatement(this.prefixText, this.inner.clone()) }
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

// ---- factory -----------------------------------------------------------------------------------------------
function createPlugin(factoryOptions) {
  let options = { net: true, scene: true, op: true, ...(factoryOptions || {}) }
  let isExcluded = makeMatcher([...DEFAULT_EXCLUDE, ...(options.exclude || [])])
  let sceneInits = new Map()
  const freshStats = () => ({
    setUrl: 0, getUrl: 0, initPrepend: 0, initSynth: 0, opInjected: 0, opSkippedInherited: 0, runtimeImports: 0,
    inlineInitUnhandled: 0,
  })
  let stats = freshStats()
  let inlineInitUnhandled = []
  let synthesized = []
  let manifestWritten = false

  function configure(program) {
    const fromConfig = (program && program.options && program.options.instrument) || {}
    options = { net: true, scene: true, op: true, ...(factoryOptions || {}), ...fromConfig }
    isExcluded = makeMatcher([...DEFAULT_EXCLUDE, ...(factoryOptions && factoryOptions.exclude || []), ...(fromConfig.exclude || [])])
  }

  function beforeProgramValidate(p) {
    configure(p)
    stats = freshStats(); inlineInitUnhandled = []; synthesized = []; sceneInits = new Map(); manifestWritten = false
    const comps = []
    for (const f of Object.values(p.files)) if (isXmlFile(f) && f.componentName) comps.push(f)
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
    const addScript = (f, pkg) => {
      const script = new SGTypes.SGScript(); script.uri = 'pkg:/' + pkg; script.type = 'text/brightscript'
      f.ast.component.scripts.push(script)
      f.parser.references.scriptTagImports.push({ pkgPath: pkg, text: 'pkg:/' + pkg, filePathRange: bsc.Range.create(0, 0, 0, 0) })
      f.attachDependencyGraph(p.dependencyGraph)
    }

    // A user-defined BT_op would collide with the runtime: fail the build with a clear message.
    for (const f of Object.values(p.files)) {
      if (!isBrsFile(f) || isExcluded(f.pkgPath) || lc(f.pkgPath) === lc(RUNTIME_PKG)) continue
      const clash = f.parser.references.functionStatements.find((s) => lc(s.name && s.name.text) === 'bt_op')
      if (clash) {
        p.addDiagnostics([{
          file: f, code: 'BT9001', severity: 1, range: clash.name.range,
          message: 'brighttest instrument: BT_op is reserved for the injected runtime; rename this function or exclude the file',
        }])
      }
    }

    if (!p.getFile(RUNTIME_PKG)) p.setFile({ src: path.resolve('__bt_runtime__.brs'), dest: RUNTIME_PKG }, RUNTIME_SRC)

    // 1) runtime import + BT_op declaration with the inheritance guard (ancestors first: sort by chain length)
    const ordered = [...comps].sort((x, y) => chain(x).length - chain(y).length)
    const declared = (x) => !!x.ast.component.api && x.ast.component.api.functions.some((fn) => lc(fn.name) === 'bt_op')
    for (const f of ordered) {
      if (!injectable(f)) continue
      const ancestors = chain(f).map((n) => byName.get(n)).filter(Boolean)
      const inheritedRuntime = ancestors.some((a) => injectable(a) && provides(a, RUNTIME_PKG))
      if (!inheritedRuntime && !provides(f, RUNTIME_PKG)) { addScript(f, RUNTIME_PKG); stats.runtimeImports++ }
      if (options.op) {
        const inheritedOp = ancestors.some((a) => declared(a))
        if (!declared(f) && !inheritedOp) {
          if (!f.ast.component.api) f.ast.component.api = new SGTypes.SGInterface()
          f.ast.component.api.setFunction('BT_op'); stats.opInjected++
        } else if (inheritedOp) stats.opSkippedInherited++
      }
    }

    // 2) Scene init prepend / synthesis. Idempotent at runtime via the __bt_boot flag on m.top.
    if (!options.scene) return
    const isScene = (f) => rootBuiltin(f) === 'scene' || lc(f.parentComponentName && f.parentComponentName.text) === 'scene'
    const inlineInit = (f) => (f.ast.component.scripts || []).some((sc) => sc.cdata && /\b(sub|function)\s+init\s*\(/i.test(sc.cdata.text || ''))
    const findInit = (f) => {
      for (const imp of f.getAvailableScriptImports()) {
        const bf = p.getFile(imp)
        if (isBrsFile(bf) && !isExcluded(bf.pkgPath)) {
          const fn = bf.parser.references.functionStatements.find((s) => lc(s.name && s.name.text) === 'init')
          if (fn) return { bf, fn }
        }
      }
      return null
    }
    const covered = new Map()
    const cov = (f) => {
      if (covered.has(f)) return covered.get(f)
      let c = !!findInit(f)
      if (!c) { const par = parentOf(f); if (par && isScene(par)) c = cov(par) }
      covered.set(f, c); return c
    }
    for (const f of comps) {
      if (!isScene(f) || !injectable(f)) continue
      const own = findInit(f)
      if (own) { sceneInits.set(own.bf.pkgPath, (sceneInits.get(own.bf.pkgPath) || new Set()).add(own.fn)); continue }
      if (cov(f)) continue
      if (inlineInit(f)) { stats.inlineInitUnhandled++; inlineInitUnhandled.push(f.componentName.text); continue }
      const par = parentOf(f)
      if (par && isScene(par)) continue // the user Scene parent is synthesized instead
      const stub = `components/bt/BT_init_${f.componentName.text}.brs`
      if (!p.getFile(stub)) {
        p.setFile({ src: path.resolve('__bt_init__' + f.componentName.text + '.brs'), dest: stub }, 'sub init()\n    BT_bootstrap(m.top)\nend sub\n')
        addScript(f, stub); stats.initSynth++; synthesized.push(f.componentName.text)
      }
    }
  }

  function beforeFileTranspile(event) {
    const file = event.file
    if (!isBrsFile(file) || isExcluded(file.pkgPath)) return
    const editor = event.editor
    const done = new WeakSet()
    if (options.net) {
      file.ast.walk(createVisitor({
        CallExpression: (expr, parent, owner, key) => {
          if (done.has(expr) || !isDottedGetExpression(expr.callee)) return
          const nm = lc(expr.callee.name.text)
          if (nm === 'seturl' && expr.args.length === 1) {
            editor.setProperty(expr.args, 0, call('BT_url', [expr.args[0]], expr.range))
            stats.setUrl++
          } else if (nm === 'geturl' && expr.args.length === 0 && owner) {
            done.add(expr) // the walk descends into the node created here; never wrap twice
            editor.setProperty(owner, key, call('BT_unurl', [expr], expr.range))
            stats.getUrl++
          }
        },
      }), { walkMode: WalkMode.visitAllRecursive })
    }
    const inits = sceneInits.get(file.pkgPath)
    if (inits) {
      for (const fn of inits) {
        const body = fn.func.body
        const idx = body.statements.findIndex((s) => !isCommentStatement(s))
        if (idx < 0) continue // empty init: nothing to prefix without adding a line
        editor.setProperty(body.statements, idx, new PrefixedStatement('BT_bootstrap(m.top)', body.statements[idx]))
        stats.initPrepend++
      }
    }
  }

  // Staged manifest: merge bs_const and add the marker once bsc has written the staging dir.
  function afterProgramTranspile(arg) {
    const program = (arg && arg.program) || arg
    const staging = program && program.options && program.options.stagingDir
    if (!staging) return
    const mf = path.join(staging, 'manifest')
    if (!fs.existsSync(mf)) return
    fs.writeFileSync(mf, mergeManifest(fs.readFileSync(mf, 'utf8')))
    manifestWritten = true
  }

  const plugin = {
    name: PLUGIN_NAME,
    runsAfter: RUNS_AFTER,
    beforeProgramValidate,
    beforeFileTranspile,
    afterProgramTranspile,
    // Result object for the census (INS-F-T4) and tests.
    getResult: () => ({ stats: { ...stats }, inlineInitUnhandled: [...inlineInitUnhandled], synthesized: [...synthesized], manifestWritten }),
  }
  createPlugin.lastInstance = plugin // lets path-loaded runs (bsconfig `plugins`) read the result
  return plugin
}

module.exports = createPlugin
module.exports.default = createPlugin
Object.assign(module.exports, {
  createPlugin, mergeManifest, makeMatcher, assertPluginOrder,
  DEFAULT_EXCLUDE, RUNTIME_COVERAGE_EXCLUDE, RUNS_AFTER, RUNTIME_PKG, MARKER_KEY, MARKER_VALUE, BS_CONST_FLAG,
})
