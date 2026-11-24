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
// receiver's `setUrl`. Config: `instrument.net` is `true|false` (on/off) or `{ unknown, receivers: { allow, deny } }`; an invalid value (not a boolean or object, or receivers.allow/deny not an array
// of strings) is a BT9005 net-config-invalid error diagnostic, never a silent enable or ignore. BT9004 plugin-reused: see below.
// The runtime helpers stay type-tolerant (non-strings pass through), so a false positive is harmless at runtime.
// Known limits of the heuristic: (1) a parameter typed as an interface or a class is excluded, which is a possible false
// negative if that type wraps or is a transfer (allow it, or type it `as roUrlTransfer`/`as object`). (2) With
// `unknown: "report"`, `setUrl` on a confirmed receiver is rewritten in one function while `getUrl` on an unknown
// parameter in another function is skipped (classification is per function, `getUrl` only follows a `setUrl` on the same
// receiver in the same function). (3) `file#receiver` patterns use file globs where `*` does not cross `/`: write
// `**/name.brs#x` (or `source/*/name.brs#x`) to match below a folder.
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
// One plugin instance serves ONE build (single-build, ADR 0019 Amendment (d) R2; no watch support). A second
// beforeProgramValidate on the same program is ignored; a second Program on the same instance, or a second
// beforeProgramTranspile, is the error diagnostic BT9004 plugin-reused ("create a new Program per instrumented build").
// lib/instrument/build.js always creates a fresh plugin and Program per build.
const fs = require('node:fs')
const path = require('node:path')
const bsc = require('brighterscript')
const receiver = require('./receiver')
const rewriteNet = require('./rewrite-net')
const wrap = require('./wrap')
const { globToRegExp } = receiver

let SGTypes = null
try { SGTypes = require('brighterscript/dist/parser/SGTypes') } catch (e) { /* reported by missingPrivateApis */ }

const {
  isBrsFile, isXmlFile, isExpressionStatement,
  isCommentStatement, isVariableExpression, isLiteralString, ParseMode,
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
const RUNTIME_HEAD = ['#if BT_AGENT', "' brighttest instrument runtime (skeleton). Injected into staged builds only."]
const RUNTIME_NET_STUBS = [
  'function BT_url(u as dynamic) as dynamic',
  '    if type(u) <> "String" and type(u) <> "roString" then return u',
  '    return u',
  'end function',
  '',
  'function BT_unurl(u as dynamic) as dynamic',
  '    return u',
  'end function',
  '',
]
const RUNTIME_TAIL = [
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
]
const RUNTIME_SRC = [...RUNTIME_HEAD, ...RUNTIME_NET_STUBS, ...RUNTIME_TAIL].join('\n')

// The real network runtime (BT_url / BT_unurl with the first-use hello) replaces the identity stubs when the build
// carries a generated BT_config.brs (lib/instrument/build.js); the real BT_net reads the hub and token from it. A build
// without BT_config (plugin used on its own, e.g. the Rooibos lanes before lane wiring) keeps the identity stubs.
const BT_CONFIG_PKG = 'source/bt/BT_config.brs'
const BT_NET_ASSET = path.join(__dirname, 'runtime', 'source', 'bt', 'BT_net.brs')
const BTNET_SPEC_ASSET = path.join(__dirname, 'runtime', 'source', 'bt', 'BTNet_spec.brs')
const BT_CORE_ASSET = path.join(__dirname, 'runtime', 'source', 'bt', 'BT_core.brs')
const BT_WRITE_ASSET = path.join(__dirname, 'runtime', 'source', 'bt', 'BT_write.brs')
const BT_MOP_ASSET = path.join(__dirname, 'runtime', 'source', 'btop', 'BT_mOp.brs')
const AGENT_ASSETS = ['BT_Agent.xml', 'BT_Agent.brs', 'BT_AgentTask.xml', 'BT_AgentTask.brs'].map((n) => ({
  dest: 'components/bt/' + n, src: path.join(__dirname, 'runtime', 'components', 'bt', n),
}))
// Real Scene bootstrap (STA-S-T1): creates the render-thread BT_Agent child. Guarded per Scene node (`__bt_boot`) so a base
// and a derived Scene init that both call it create one agent; a Scene only, never another node type.
const RUNTIME_TAIL_AGENT = [
  'sub BT_bootstrap(top as object)',
  '    if not top.isSubtype("Scene") then return',
  '    if top.hasField("__bt_boot") then return',
  '    top.addField("__bt_boot", "boolean", false)',
  '    cfg = BT_config()',
  '    if type(cfg) = "roAssociativeArray" and type(cfg.features) = "roAssociativeArray" and cfg.features.state = false then return',
  '    top.createChild("BT_Agent")',
  'end sub',
  '',
  'function BT_op(args as dynamic) as dynamic',
  '    return BT_mOp(m, args)',
  'end function',
  '#end if',
  '',
]
const stagedAsset = (a) => { const t = fs.readFileSync(a.src, 'utf8'); return a.dest.endsWith('.brs') ? stripFullLineComments(t) : t }
const stripGuards = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => !/^#(if BT_AGENT|end if)\s*$/i.test(l))
// Staging-time strip (ADR 0020 D3): drops full-line comments (first non-blank char is `'`) and blank lines from the staged
// runtime and agent .brs only; the repo files keep them (BrightScript has no multi-line strings, so no string spans lines).
// Trailing comments, strings and every other line are untouched. Never applied to user files, XML or BT_config.brs.
const stripFullLineComments = (text) => text.split('\n').filter((l) => !/^[ \t]*'/.test(l) && !/^[ \t\r]*$/.test(l)).join('\n') + '\n'
const runtimeSource = (realNet, realState, netSpec = false) => stripFullLineComments(runtimeSourceRaw(realNet, realState, netSpec))
const runtimeSourceRaw = (realNet, realState, netSpec = false) => {
  if (!realNet && !realState) return RUNTIME_SRC
  return [
    ...RUNTIME_HEAD,
    ...(realNet ? stripGuards(BT_NET_ASSET) : RUNTIME_NET_STUBS),
    ...(realNet && netSpec ? stripGuards(BTNET_SPEC_ASSET) : []),
    ...(realState ? stripGuards(BT_CORE_ASSET) : []),
    ...(realState ? stripGuards(BT_WRITE_ASSET) : []),
    ...(realState ? stripGuards(BT_MOP_ASSET) : []),
    ...(realState ? RUNTIME_TAIL_AGENT : RUNTIME_TAIL),
  ].join('\n')
}

// Every name the runtime defines. A user function with one of these names (any case) fails the build (BT9001).
const RESERVED_NAMES = Object.freeze(['BT_op', 'BT_url', 'BT_unurl', 'BT_bootstrap', 'BT_config', 'BT_netBase', 'BT_netState', 'BT_netHello', 'BT_netIsStr', 'BT_netIsHttp', 'BT_netCrumb', 'BT_netObserve',
  'BTNet_call', 'BTNet_reset', 'BTNet_mock', 'BTNet_fault', 'BTNet_useFixture', 'BTNet_requests',
  'BT_capsDefault', 'BT_capsFrom', 'BT_pubInt', 'BT_pubMaxBytes', 'BT_pubIntervalMs', 'BT_mark', 'BT_isSecretKey', 'BT_redactMatch',
  'BT_serialize', 'BT_nodeFields', 'BT_focusChain', 'BT_fit', 'BT_labelJson', 'BT_layers', 'BT_registryRaw',
  'BT_wMaxBytes', 'BT_wErr', 'BT_wKind', 'BT_wIs', 'BT_wIsStr', 'BT_wIsWhole', 'BT_wCompat', 'BT_wSplit', 'BT_wIsIndex', 'BT_wChild', 'BT_wCfgList', 'BT_wInList', 'BT_wNodeById', 'BT_wRoot', 'BT_wRegRead', 'BT_wRegWrite', 'BT_wGet', 'BT_wGetDone', 'BT_wSetPathX', 'BT_wSetBatch', 'BT_wSet', 'BT_wMerge', 'BT_wSnapshot', 'BT_wIsMarker', 'BT_wRestore', 'BT_wCallFunc', 'BT_wApply', 'BT_wAck', 'BT_wHandle', 'BT_wCadence', 'BT_wOrigin', 'BT_wUrl', 'BT_wHello', 'BT_wHelloInfo', 'BT_wPollStart', 'BT_wPostEvents', 'BT_wParsePoll', 'BT_wPumpOnce',
  'BT_wMismatch', 'BT_wBuiltinField', 'BT_wQueueAcks', 'BT_wMCall', 'BT_wMGet', 'BT_wRedSeg', 'BT_wRegChk', 'BT_wClampEvent', 'BT_wClampStep', 'BT_mBad', 'BT_mOp',
  'BT_dwHash', 'BT_dwEmit', 'BT_taskSnap', 'BT_inputTtlMs', 'BT_inputMaxPending', 'BT_inputMaxChunks', 'BT_inputNew', 'BT_inputTokenOk', 'BT_inputSweep', 'BT_inputSeen', 'BT_inputFinish', 'BT_inputFeed', 'BT_inputCmd', 'BT_inputPack', 'BT_inputRun'])

// Built-in Scene types a component's extends chain may reach (Roku docs; not verified on a device). A built-in root
// whose name contains "scene" but is not listed here is reported in skipped[] rather than guessed.
const SCENE_BUILTINS = Object.freeze(['scene', 'overhangpanelsetscene'])

// Built-in roots known NOT to be Scenes. Cross-checked against brighterscript's bundled Roku node data (every node there
// is listed or is a Scene descendant; no entry descends from Scene); not verified on a device. A few older names below are
// not in that data and are kept only to avoid new false positives. A built-in root that
// is neither listed here nor in SCENE_BUILTINS is reported as `unknown-scene-subtype` (fail closed: it may be a Scene
// type this plugin does not know). Names are lower-case.
const NON_SCENE_BUILTINS = Object.freeze([
  'node', 'group', 'layoutgroup', 'maskgroup', 'rectangle', 'poster', 'label', 'scrollinglabel', 'simplelabel',
  'multistylelabel', 'button', 'checklist', 'radiobuttonlist', 'buttongroup', 'labellist', 'markupgrid', 'markuplist',
  'rowlist', 'postergrid', 'timegrid', 'zoomrowlist', 'minikeyboard', 'keyboard', 'textedit', 'textinput',
  'dynamickeyboard', 'dynamicminikeyboard', 'dynamiccustomkeyboard', 'dynamickeyboardgrid', 'pinpad', 'dynamicpinpad',
  'video', 'videolist', 'overhang', 'panel', 'panelset', 'gridpanel', 'listpanel', 'rowlistpanel', 'linkedpanel',
  'standarddialog', 'standardmessagedialog', 'standardprogressdialog', 'standardkeyboarddialog', 'standardpindialog',
  'standardlistdialog', 'dialog', 'keyboarddialog', 'pindialog', 'progressdialog', 'messagedialog', 'busyspinner',
  'progressbar', 'timer', 'task', 'contentnode', 'animation', 'parallelanimation', 'sequentialanimation',
  'fieldinterpolator', 'floatfieldinterpolator', 'vector2dfieldinterpolator', 'colorfieldinterpolator',
  'intfieldinterpolator', 'stringfieldinterpolator', 'audio', 'soundeffect', 'rsgpalette', 'font', 'ecp', 'screen',
  'sgdexnode', 'channelstore', 'roskeyboard', 'targetgroup', 'targetset', 'targetlist', 'cameraxd', 'texturemanager',
  // Added after checking every node in brighterscript's bundled Roku data (test/instrument-plugin-builtins.test.js):
  'animationbase', 'arraygrid', 'bifdisplay', 'componentlibrary', 'dialogbase', 'dynamickeyboardbase', 'dynamickeygrid',
  'infopane', 'labelbase', 'monospacelabel', 'parentalcontrolpinpad', 'scrollabletext', 'standardpinpaddialog',
  'stddlgactioncarditem', 'stddlgareabase', 'stddlgbullettextitem', 'stddlgbutton', 'stddlgbuttonarea',
  'stddlgcontentarea', 'stddlgcustomitem', 'stddlgdeterminateprogressitem', 'stddlggraphicitem', 'stddlgitembase',
  'stddlgitemgroup', 'stddlgkeyboarditem', 'stddlgmultistyletextitem', 'stddlgprogressitem', 'stddlgsidecardarea',
  'stddlgtextitem', 'stddlgtitlearea', 'texteditbox', 'trickplaybar', 'voicetexteditbox',
])

// True when `root` (a lower-case built-in root name, not a user component) should be reported as unknown-scene-subtype.
const isUnknownSceneRoot = (root) => !!root && !SCENE_BUILTINS.includes(root) && !NON_SCENE_BUILTINS.includes(root)

// Every `skipped[]` kind the plugin can emit. build.js holds the strict table keyed by these (one table, ADR 0019 (d) R5).
const SKIP_KINDS = Object.freeze([
  'excluded-candidate', 'rewritten-shared-with-excluded', 'empty-init', 'inline-cdata-scene', 'unknown-scene-subtype',
  'init-in-excluded-file', 'init-shared-with-excluded-scene', 'indexed-seturl', 'indexed-geturl', 'bare-geturl',
  'net-receiver-unknown', 'net-receiver-excluded', 'xml-parse-failed', 'callfunc-seturl', 'wrap-target-unknown',
  'net-render-thread',
])

// skipped[] kinds that are informational: they do not count as "could not instrument" under instrument.strict.
const INFORMATIONAL_KINDS = Object.freeze(['rewritten-shared-with-excluded', 'net-receiver-excluded', 'callfunc-seturl', 'net-render-thread'])

// lower-cased and forward-slashed: bsc pkgPaths are backslashed on win32, ours are written with '/'
const lc = (s) => String(s || '').toLowerCase().replace(/\\/g, '/')

// Fixed virtual source root for files the plugin synthesizes (no cwd dependence).
const VIRTUAL_ROOT = '/__brighttest__/'

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
  // `this` is the view on purpose: a plugin after ours may replace `statements` on the view (an own property through the
  // AstEditor), and the emit must see that edit (ADR 0019 Amendment (d), R3). `block.transpile(state)` would ignore it.
  view.transpile = function (state) { return [text, ...block.transpile.call(this, state)] }
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
  f.parser.references.scriptTagImports.push({ pkgPath: path.normalize(pkg), text: 'pkg:/' + pkg, filePathRange: bsc.Range.create(0, 0, 0, 0) })
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
  const isDefaultExcluded = makeMatcher(DEFAULT_EXCLUDE)
  let sceneInits = new Map()
  let wraps = new Map() // pkgPath -> [{ fn, kind: 'dispatch'|'task', label }] (STA-S-T10)
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
  let netConfigErrors = []
  let classifier = receiver.createClassifier()
  let netFiles = new Map() // file -> classified net sites (one walk per file)
  const netOn = () => options.net !== false
  let scratch = null // scratch bsc Program used by the verify step
  const processed = new WeakSet() // programs already planned: one plugin instance serves one program
  let used = false // a Program was planned by this instance (single-build, BT9004)
  let transpiles = 0

  const skip = (kind, file, line, reason, extra) => { skipped.push({ kind, file, line, reason, ...(extra || {}) }) }
  const diag = (p, file, code, message, range) => {
    const f = file || Object.values(p.files)[0]
    if (f) p.addDiagnostics([{ file: f, code, severity: 1, range: range || bsc.Range.create(0, 0, 0, 0), message }])
  }

  function configure(program) {
    const fromConfig = (program && program.options && program.options.instrument) || {}
    options = { net: true, scene: true, op: true, ...(factoryOptions || {}), ...fromConfig }
    isExcluded = makeMatcher([...DEFAULT_EXCLUDE, ...(factoryOptions && factoryOptions.exclude || []), ...(fromConfig.exclude || [])])
    netConfigErrors = receiver.validateConfig(options.net)
    const net = options.net && typeof options.net === 'object' && !Array.isArray(options.net) ? options.net : {}
    const rc = net.receivers && typeof net.receivers === 'object' && !Array.isArray(net.receivers) ? net.receivers : {}
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
    if (used) { // a second Program on one instance: the lists would mix two builds
      diag(p, null, 'BT9004', 'brighttest instrument: plugin-reused: this plugin instance already planned a build; create a new Program per instrumented build')
      return
    }
    used = true
    processed.add(p)
    configure(p)
    stats = freshStats(); inlineInitUnhandled = []; synthesized = []; sceneInits = new Map(); wraps = new Map(); manifestWritten = false
    skipped = []; bootstrapped = []; opInjected = []; excluded = []; rewrittenKinds = new Set(); invalid = []; scratch = null
    netRewritten = []; netOverlaps = []
    for (const e of [...netConfigErrors, ...classifier.errors]) diag(p, null, 'BT9005', `brighttest instrument: ${e}`)
    const comps = []
    for (const f of Object.values(p.files)) {
      if (!isXmlFile(f)) continue
      // XML bsc could not parse cleanly is not analysed: no runtime import, no BT_op, no bootstrap (reported, trips strict)
      const bad = f.getDiagnostics().find((d) => d.severity === 1)
      if (bad) {
        if (!isExcluded(f.pkgPath)) skip('xml-parse-failed', f.pkgPath, bad.range ? bad.range.start.line + 1 : 1, `component XML did not parse (bsc ${bad.code}: ${String(bad.message).split('\n')[0]}); it is not analysed or instrumented`)
        continue
      }
      if (f.componentName) comps.push(f)
    }

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
          const excludedBy = isDefaultExcluded(f.pkgPath) ? 'default' : 'user'
          skip('excluded-candidate', f.pkgPath, sites[0].line, reason, { excludedBy })
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

    const realNet = netOn() && !!p.getFile(BT_CONFIG_PKG)
    const realState = options.scene !== false && !!p.getFile(BT_CONFIG_PKG)
    if (!p.getFile(RUNTIME_PKG)) p.setFile({ src: VIRTUAL_ROOT + '__bt_runtime__.brs', dest: RUNTIME_PKG }, runtimeSource(realNet, realState, options.netSpec === true))
    if (realState) {
      // agent components (components/bt/** is excluded from every rewrite); each imports the runtime and BT_config itself
      for (const a of AGENT_ASSETS) if (!p.getFile(a.dest)) p.setFile({ src: VIRTUAL_ROOT + a.dest, dest: a.dest }, stagedAsset(a))
    }

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
    const skipOnce = (kind, file, line, reason, extra) => {
      const key = kind + '|' + lc(file)
      if (!reported.has(key)) { reported.add(key); skip(kind, file, line, reason, extra) }
    }
    // R4: an excluded Scene anywhere below `f` in the extends closure inherits f's wrapped init (or synthesized stub)
    const excludedDescendant = (f) => comps.find((c) => !injectable(c) && isScene(c) && chain(c).includes(lc(f.componentName.text)))
    const extendsReason = (f, c) => `${f.componentName.text} is extended by the excluded Scene ${c.componentName.text}, which would inherit the bootstrap; the base init is left alone (un-exclude ${c.componentName.text} to bootstrap)`
    if (options.scene) {
      for (const f of comps) {
        if (injectable(f) && !isScene(f)) {
          const root = rootBuiltin(f)
          if (root && !byName.has(root) && isUnknownSceneRoot(root)) {
            skip('unknown-scene-subtype', f.pkgPath, 1, `built-in root "${root}" is not in the known Scene or non-Scene built-in lists; if it is a Scene type the component is not bootstrapped`)
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
            skipOnce('init-shared-with-excluded-scene', own.bf.pkgPath, initLine(own.fn), `init is shared with the excluded Scene ${exScene.componentName.text}; wrapping it would bootstrap a Scene the user excluded, so it is left alone`, { via: 'import', component: exScene.componentName.text })
            continue
          }
          const exChild = excludedDescendant(f)
          if (exChild) {
            skipOnce('init-shared-with-excluded-scene', own.bf.pkgPath, initLine(own.fn), extendsReason(f, exChild), { via: 'extends', component: exChild.componentName.text })
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
        const exKid = excludedDescendant(f)
        if (exKid) {
          skipOnce('init-shared-with-excluded-scene', f.pkgPath, 1, extendsReason(f, exKid), { via: 'extends', component: exKid.componentName.text })
          continue
        }
        const stub = `components/bt/BT_init_${f.componentName.text}.brs`
        if (!p.getFile(stub)) {
          p.setFile({ src: VIRTUAL_ROOT + stub, dest: stub }, '#if BT_AGENT\nsub init()\n    BT_bootstrap(m.top)\nend sub\n#end if\n')
          addScript(p, f, stub); stats.initSynth++; synthesized.push(f.componentName.text)
        }
      }
    }

    // 1b) STA-S-T10 wrap plan: config-named dispatch functions and the entry function of opt-in Tasks (state.dispatch,
    //     state.tasks). Only with the real state runtime; an unmatched name is reported, never guessed.
    const st = options.state && typeof options.state === 'object' ? options.state : {}
    const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
    const fnsOf = (bf) => bf.parser.references.functionStatements.filter((s) => !s.namespaceName)
    const planWrap = (bf, fn, kind, label) => {
      const list = wraps.get(bf.pkgPath) || []
      if (list.some((w) => w.fn === fn)) return
      const why = wrap.refuseReason(bf, fn)
      if (why) { skip('wrap-target-unknown', bf.pkgPath, fn.name.range.start.line + 1, `${fn.name.text}: ${why}; it is not wrapped`); return }
      wraps.set(bf.pkgPath, [...list, { fn, kind, label }])
    }
    if (realState) {
      for (const want of names(st.dispatch)) {
        let hit = false
        for (const bf of Object.values(p.files)) {
          if (!isBrsFile(bf) || isExcluded(bf.pkgPath) || lc(bf.pkgPath) === lc(RUNTIME_PKG)) continue
          for (const fn of fnsOf(bf)) {
            if (lc(fn.name.text) !== lc(want)) continue
            hit = true
            const use = wrap.valueUse(p, fn.name.text, (x) => isBrsFile(x) && !isExcluded(x.pkgPath) && lc(x.pkgPath) !== lc(RUNTIME_PKG))
            if (use) skip('wrap-target-unknown', use.file, use.line, `state.dispatch names ${want}, but ${fn.name.text} is also used as a value (not called directly); a wrapper cannot keep the AA method binding (m), so nothing is wrapped`)
            else planWrap(bf, fn, 'dispatch', fn.name.text)
          }
        }
        if (!hit) skip('wrap-target-unknown', 'brighttest.json', 0, `state.dispatch names ${want}, but no non-excluded function with that name exists; nothing is wrapped`)
      }
      for (const want of names(st.tasks)) {
        const tf = byName.get(lc(want))
        let target = null
        if (tf && !isExcluded(tf.pkgPath)) {
          const files = importedFiles(tf).filter((bf) => lc(bf.pkgPath) !== lc(RUNTIME_PKG))
          for (const bf of files) {
            const init = fnsOf(bf).find((s) => lc(s.name.text) === 'init')
            const nm = init && wrap.taskFunctionName(init)
            const fn = nm && files.flatMap((x) => fnsOf(x).map((s) => ({ x, s }))).find((e) => lc(e.s.name.text) === lc(nm))
            if (fn && !isExcluded(fn.x.pkgPath)) { target = fn; break }
          }
        }
        if (target) planWrap(target.x, target.s, 'task', tf.componentName.text)
        else skip('wrap-target-unknown', tf ? tf.pkgPath : 'brighttest.json', 0, `state.tasks names ${want}, but its entry function (m.top.functionName = "<name>" in init) was not found in a non-excluded file; the Task is not snapshotted`)
      }
    }

    // 2) Files that will be rewritten: net sites (non-excluded) and init files that will be wrapped.
    const rewritten = new Map() // lower-case pkgPath -> { pkg, line }
    for (const [pkg, list] of wraps) rewritten.set(lc(pkg), { pkg, line: list[0].fn.name.range.start.line + 1 })
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

    // 2b) Informational: hand-written BT_url( calls that run on the render thread, where BT_url is the identity (NET-BTURL-RT,
    //     ADR 0021). Runs on the source files before any rewrite, so calls this plugin inserts are never seen. A component
    //     whose chain does not reach Task: every call. A Task: calls in init and in observeField callbacks it registers
    //     (best effort, literal callback names only). Reported once per file and line.
    const isTask = (f) => lc(f.componentName.text) === 'task' || chain(f).includes('task')
    const inFn = (fn, call) => fn.func.range && call.range && fn.func.range.start.line <= call.range.start.line && call.range.start.line <= fn.func.range.end.line
    const callsOf = (bf) => bf.parser.references.functionExpressions.flatMap((fe) => fe.callExpressions || [])
    const btUrlCalls = (bf) => callsOf(bf).filter((c) => isVariableExpression(c.callee) && lc(c.callee.name.text) === 'bt_url')
    const renderSeen = new Set()
    const renderHint = 'render-thread BT_url is the identity on device; wrap the URL in a Task'
    for (const f of comps) {
      if (!injectable(f)) continue
      const task = isTask(f)
      for (const bf of importedFiles(f)) {
        if (lc(bf.pkgPath) === lc(RUNTIME_PKG) || isExcluded(bf.pkgPath)) continue
        const calls = btUrlCalls(bf)
        if (!calls.length) continue
        let hot = calls
        if (task) {
          const fns = bf.parser.references.functionStatements
          const init = fns.find((s) => lc(s.name && s.name.text) === 'init')
          const observerNames = new Set()
          if (init) {
            for (const c of init.func.callExpressions || []) {
              const nm = rewriteNet.calleeMember(c.callee)
              if ((nm === 'observefield' || nm === 'observefieldscoped') && c.args[1] && isLiteralString(c.args[1])) observerNames.add(lc(String(c.args[1].token.text).replace(/^"|"$/g, '')))
            }
          }
          const roots = fns.filter((s) => s === init || observerNames.has(lc(s.name && s.name.text)))
          hot = calls.filter((c) => roots.some((fn) => inFn(fn, c)))
        }
        for (const c of hot) {
          const line = c.range.start.line + 1
          const key = lc(bf.pkgPath) + '|' + line
          if (renderSeen.has(key)) continue
          renderSeen.add(key)
          skip('net-render-thread', bf.pkgPath, line, renderHint)
        }
      }
    }

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
      if (!inheritedRuntime && !provides(f, RUNTIME_PKG)) {
        addScript(p, f, RUNTIME_PKG); stats.runtimeImports++
        // the real BT_net calls BT_config(), which must resolve in every component scope that imports the runtime
        if ((realNet || realState) && !ancestors.some((a) => provides(a, BT_CONFIG_PKG)) && !provides(f, BT_CONFIG_PKG)) addScript(p, f, BT_CONFIG_PKG)
      }
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

  function beforeProgramTranspile(program) {
    transpiles++
    if (transpiles > 1) diag(program, null, 'BT9004', 'brighttest instrument: plugin-reused: this plugin instance already transpiled a build; create a new Program per instrumented build')
  }

  function beforeFileTranspile(event) {
    const file = event.file
    if (!isBrsFile(file) || isExcluded(file.pkgPath)) return
    const editor = event.editor
    if (netOn()) {
      rewriteNet.rewriteFile({
        file, editor, sites: netSites(file), call, skip, stats, netRewritten, netOverlaps, rewrittenKinds,
      })
    }
    for (const w of wraps.get(file.pkgPath) || []) {
      try {
        wrap.applyWrap(file, editor, w.fn, w.kind, w.label)
        rewrittenKinds.add(lc(file.pkgPath) + '|wrap')
      } catch (e) {
        skip('wrap-target-unknown', file.pkgPath, w.fn.name.range.start.line + 1, `${w.fn.name.text} could not be wrapped (${e.message}); it is left as written`)
      }
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
    const kinds = ['net', 'init-bootstrap', 'wrap'].filter((k) => rewrittenKinds.has(lc(file.pkgPath) + '|' + k))
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
    const pkgFwd = file.pkgPath.replace(/\\/g, '/') // package paths in messages and results are forward-slashed
    for (const d of errs) {
      const line = d.range ? d.range.start.line + 1 : 0
      const rec = { file: pkgFwd, line, code: d.code, message: d.message, kinds }
      invalid.push(rec)
      diag(program, file, 'BT9003', `brighttest instrument: staged-output-invalid: ${pkgFwd}:${line} bsc ${d.code} "${d.message}" (rewrite: ${kinds.join(', ')})`, bsc.Range.create(Math.max(line - 1, 0), 0, Math.max(line - 1, 0), 0))
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
    beforeProgramTranspile,
    beforeFileTranspile,
    afterFileTranspile,
    afterProgramTranspile,
    // Result object for the census (INS-F-T4) and tests. Schema 1 is additive.
    // pkgPath is backslashed on win32; the result schema is always forward-slashed (package paths).
    getResult: () => { const fwd = (x) => (x && typeof x.file === 'string' ? { ...x, file: x.file.replace(/\\/g, '/') } : { ...x }); return {
      schema: 1,
      stats: { ...stats, netRewrites: { ...stats.netRewrites } },
      skipped: skipped.map(fwd),
      synthesized: [...synthesized],
      bootstrapped: bootstrapped.map(fwd),
      opInjected: [...opInjected],
      excluded: excluded.map(fwd),
      inlineInitUnhandled: [...inlineInitUnhandled],
      invalid: invalid.map((x) => ({ ...fwd(x), kinds: [...x.kinds] })),
      manifestWritten,
      rewritten: netRewritten.map(fwd),
      netOverlaps: netOverlaps.map(fwd),
    } },
  }
  createPlugin.lastInstance = plugin // single-build, process-global: see the header comment
  return plugin
}

module.exports = createPlugin
module.exports.default = createPlugin
Object.assign(module.exports, {
  createPlugin, mergeManifest, makeMatcher, assertPluginOrder, missingPrivateApis,
  DEFAULT_EXCLUDE, NON_SCENE_BUILTINS, SKIP_KINDS, VIRTUAL_ROOT, isUnknownSceneRoot, RUNTIME_COVERAGE_EXCLUDE, RUNS_AFTER, RUNTIME_PKG, MARKER_KEY, MARKER_VALUE, BS_CONST_FLAG,
  RESERVED_NAMES, SCENE_BUILTINS, RUNTIME_SRC, runtimeSource, runtimeSourceRaw, stripFullLineComments, stagedAsset, AGENT_ASSETS, INFORMATIONAL_KINDS,
})
