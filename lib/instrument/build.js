'use strict'
// brighttest instrument build (INS-F-T2): builds the app through brighterscript with the instrument plugin and writes a
// sideloadable package. Design: ADR 0015, ADR 0019 Amendment (d) R1/R2/R5.
//
//   build(cfg, opts) -> Promise<{ exitCode, out, errors, strictTrips, informational, result, lines }>
//     cfg   a loadConfig() object (rootDir, stagingDir, sourceGlobs, instrument{strict,exclude,net,...})
//     opts  { out, strict, verbose, plugins, log(line) }   plugins: extra plugin objects/paths loaded AFTER ours
//
// One build = one fresh Program and one fresh plugin instance (single-build; no watch support). The package is built to a
// temp path next to the output and moved to `out` only after every gate passed, so a failed build never leaves a stale or
// partial file at `out` (an older good package at `out` is left untouched). `deploy` is never passed to bsc; sideloading is
// a separate step (INS-F-T5) that runs only after these gates.
//
// Gates, in order (R1): (1) any error diagnostic: plugin (BT9001, BT9002, BT9003, BT9004, BT9005) or bsc; (2)
// getResult().invalid (BT9003 list); (3) strict: any skipped[] entry that trips per STRICT_TABLE. Gates 1-2 exit 1,
// gate 3 exits 4 (exit 3 belongs to `instrument verify`). stderr: one line per blocking item, then
// `instrument build failed: N error(s), no package written`.
//
// BT_config.brs (per-build 128-bit token, hub, features, caps) is generated into the staging dir for the build and removed
// after it; it never enters the user's source tree and the token is never printed or logged.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const bsc = require('brighterscript')
const createPlugin = require('./plugin')
const { writeBsConfig } = require('../config')

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_STRICT = 4
const DEFAULT_OUT = 'app.bt-instrumented.zip'
const BT_CONFIG_PKG = 'source/bt/BT_config.brs'
const DEFAULT_CAPS = Object.freeze({ depth: 6, arrayItems: 50, stringBytes: 2048 })
const DEFAULT_HUB_PORT = 8790

// The single strict table (ADR 0019 Amendment (d) R5). Value: true = trips `instrument.strict`, false = informational,
// a function = decided per entry. Anything not listed trips (fail closed). A unit test asserts every kind the plugin can
// emit (createPlugin.SKIP_KINDS) is a key here.
const STRICT_TABLE = Object.freeze({
  'excluded-candidate': (e) => e.excludedBy !== 'default', // framework/vendor/spec paths excluded by default are expected
  'rewritten-shared-with-excluded': false,
  'empty-init': true,
  'inline-cdata-scene': true,
  'unknown-scene-subtype': true,
  'init-in-excluded-file': true,
  'init-shared-with-excluded-scene': true, // via import or via extends
  'indexed-seturl': true,
  'indexed-geturl': true,
  'bare-geturl': true,
  'net-receiver-unknown': true, // only emitted with instrument.net.unknown: "report"
  'net-receiver-excluded': false,
  'xml-parse-failed': true,
  'callfunc-seturl': false,
  'parse-threw': true, // an invalid[].code, listed so the table is complete
})

function tripsStrict(entry) {
  const rule = Object.prototype.hasOwnProperty.call(STRICT_TABLE, entry.kind) ? STRICT_TABLE[entry.kind] : true
  return typeof rule === 'function' ? !!rule(entry) : !!rule
}

// The instrumented package keeps the real source/main.brs (a package without it installs but the channel exits at launch)
// and drops test specs. A `!source/main.brs` negation in the shared sourceGlobs is removed for this lane only.
const MAIN_NEGATION = /^!\.?\/?source\/main\.brs$/
const TESTS_NEGATION = '!source/tests/**'
function instrumentGlobs(globs) {
  const kept = (globs || []).filter((g) => typeof g !== 'string' || !MAIN_NEGATION.test(g))
  return kept.includes(TESTS_NEGATION) ? kept : [...kept, TESTS_NEGATION]
}

const pos = (e) => `${e.file}:${e.line}`

// BT-CFG-EMIT: instrument.state.redact.paths / publish.maxBytes / publish.intervalMs. Unset means nothing is emitted; a
// wrong type or out-of-range value is an error naming the full key (never coerced). The runtime fallback (BT_pubInt)
// stays as defence only.
const PUBLISH_RANGES = { maxBytes: [1024, 1048576], intervalMs: [100, 60000] }
// instrument.state.callable: callFunc names the write path may run (STA-S-T6-F1). Plain BrightScript identifiers (a
// namespaced `x.fn` is the mangled `x_fn`), no duplicates (case-insensitive: the runtime compares with LCase).
const CALLABLE_MAX_NAMES = 64
const CALLABLE_MAX_LEN = 64
const CALLABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
function validateStateConfig(instrument) {
  const state = instrument && instrument.state
  if (state === undefined || state === null) return
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(state)) return
  if (state.redact !== undefined) {
    if (!isObj(state.redact)) throw new Error('instrument.state.redact must be an object')
    const paths = state.redact.paths
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string'))) throw new Error('instrument.state.redact.paths must be an array of strings')
  }
  if (state.callable !== undefined) {
    const c = state.callable
    if (!Array.isArray(c) || !c.every((p) => typeof p === 'string')) throw new Error('instrument.state.callable must be an array of strings')
    if (c.length > CALLABLE_MAX_NAMES) throw new Error(`instrument.state.callable must have at most ${CALLABLE_MAX_NAMES} names (got ${c.length})`)
    const seen = new Set()
    for (const n of c) {
      if (!CALLABLE_NAME.test(n) || n.length > CALLABLE_MAX_LEN) throw new Error(`instrument.state.callable entries must be identifiers of at most ${CALLABLE_MAX_LEN} characters (got ${JSON.stringify(n)})`)
      if (seen.has(n.toLowerCase())) throw new Error(`instrument.state.callable has a duplicate name (${JSON.stringify(n)})`)
      seen.add(n.toLowerCase())
    }
  }
  if (state.publish !== undefined) {
    if (!isObj(state.publish)) throw new Error('instrument.state.publish must be an object')
    for (const [k, [lo, hi]] of Object.entries(PUBLISH_RANGES)) {
      const v = state.publish[k]
      if (v === undefined) continue
      if (!Number.isInteger(v)) throw new Error(`instrument.state.publish.${k} must be an integer number (got ${JSON.stringify(v)})`)
      if (v < lo || v > hi) throw new Error(`instrument.state.publish.${k} must be an integer from ${lo} to ${hi} (got ${v})`)
    }
  }
}

// Generated BT_config.brs. The token line is `token: "<32 lowercase hex>"`.
function renderBtConfig(token, instrument) {
  const i = instrument || {}
  const hub = i.hub && typeof i.hub === 'object' ? i.hub : {}
  const state = i.state && typeof i.state === 'object' ? i.state : {}
  const caps = { ...DEFAULT_CAPS, ...(state.caps && typeof state.caps === 'object' ? state.caps : {}) }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const str = (v) => JSON.stringify(String(v === undefined || v === null ? '' : v)).replace(/\\u([0-9a-f]{4})/gi, '?')
  const registrySections = (Array.isArray(state.registrySections) ? state.registrySections : [])
    .filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
  const redactPaths = state.redact && Array.isArray(state.redact.paths) ? state.redact.paths.filter((v) => typeof v === 'string') : null
  const pub = state.publish && typeof state.publish === 'object' ? state.publish : {}
  const pubParts = ['maxBytes', 'intervalMs'].filter((k) => Number.isInteger(pub[k])).map((k) => `${k}: ${pub[k]}`)
  const callable = Array.isArray(state.callable) ? state.callable.filter((v) => typeof v === 'string') : []
  return [
    '#if BT_AGENT',
    "' brighttest instrument config. Generated for this build only; not part of the source tree.",
    'function BT_config() as object',
    '    return {',
    `        token: "${token}"`,
    `        hub: { host: ${str(hub.host || require('./hub').lanHost() || '127.0.0.1')}, port: ${num(hub.port, DEFAULT_HUB_PORT)} }`,
    `        features: { net: ${i.net !== false}, state: ${i.scene !== false}, op: ${i.op !== false} }`,
    ...(registrySections.length ? [`        registrySections: [${registrySections.map(str).join(', ')}]`] : []),
    ...(redactPaths !== null ? [`        redact: { paths: [${redactPaths.map(str).join(', ')}] }`] : []),
    ...(callable.length ? [`        callFuncAllow: [${callable.map(str).join(', ')}]`] : []),
    ...(pubParts.length ? [`        publish: { ${pubParts.join(', ')} }`] : []),
    `        caps: { depth: ${num(caps.depth, DEFAULT_CAPS.depth)}, arrayItems: ${num(caps.arrayItems, DEFAULT_CAPS.arrayItems)}, stringBytes: ${num(caps.stringBytes, DEFAULT_CAPS.stringBytes)} }`,
    '    }',
    'end function',
    '#end if',
    '',
  ].join('\n')
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try { fs.renameSync(from, to) } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.copyFileSync(from, to); fs.unlinkSync(from)
  }
}
const rmQuiet = (p) => { try { fs.rmSync(p, { force: true, recursive: true }) } catch (e) { /* best effort */ } }

async function build(cfg, opts = {}) {
  const log = opts.log || ((l) => process.stderr.write(l + '\n'))
  const instrument = cfg.instrument || {}
  const strict = opts.strict !== undefined && opts.strict !== null ? !!opts.strict : !!instrument.strict
  const out = path.resolve(opts.out || path.join(cfg.stagingDir, 'instrument', DEFAULT_OUT))
  const work = path.join(cfg.stagingDir, 'instrument')
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const tmpZip = path.join(path.dirname(out), `.${path.basename(out)}.${tag}.tmp.zip`)
  const genDir = path.join(work, `gen-${tag}`)
  const lines = []
  const emit = (l) => { lines.push(l); log(l) }
  const fail = (exitCode, count, result, extra) => {
    emit(`instrument build failed: ${count} error(s), no package written`)
    return { exitCode, out: null, errors: extra.errors || 0, strictTrips: extra.strictTrips || [], informational: extra.informational || [], result, lines }
  }

  // NET-WIRE: `--net` bakes the operator's hub token (BRIGHTTEST_HUB_TOKEN) so the run's hub accepts the build; no
  // token means no build (never an empty or random token on this path).
  let buildToken = crypto.randomBytes(16).toString('hex')
  if (opts.net) {
    const { hubTokenFromEnv, HUB_TOKEN_ENV } = require('./hub')
    buildToken = hubTokenFromEnv(opts.env || process.env)
    if (!buildToken) {
      emit(`instrument build --net needs a hub token: set ${HUB_TOKEN_ENV} to 32 lowercase hex characters (the e2e run's hub accepts the same value)`)
      return fail(EXIT_ERROR, 1, null, { errors: 1 })
    }
  }

  // NET-HUB-PORT: the hub address comes from instrument.hub (the same source `e2e run` listens on). `auto` is never baked.
  let bakedInstrument = instrument
  {
    const { hubAddress } = require('./hub')
    let addr
    try { addr = hubAddress(cfg) } catch (e) { emit(`instrument build: ${e.message}`); return fail(EXIT_ERROR, 1, null, { errors: 1 }) }
    if (!addr.host && opts.net) {
      emit('instrument build --net: no hub host. Set instrument.hub.host in brighttest.json (the address the device dials; the e2e run expects the same value), or connect this machine to a LAN so its address can be used')
      return fail(EXIT_ERROR, 1, null, { errors: 1 })
    }
    bakedInstrument = { ...instrument, hub: { ...(instrument.hub && typeof instrument.hub === 'object' ? instrument.hub : {}), host: addr.host || '127.0.0.1', port: addr.port } }
  }

  try { validateStateConfig(instrument) } catch (e) { emit(`instrument build: ${e.message}`); return fail(EXIT_ERROR, 1, null, { errors: 1 }) }

  // BT_config.brs: generated outside the user's tree, removed after the build
  fs.mkdirSync(genDir, { recursive: true })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const cfgSrc = path.join(genDir, 'BT_config.brs')
  fs.writeFileSync(cfgSrc, renderBtConfig(buildToken, bakedInstrument))

  const plugin = createPlugin()
  const { bsconfig } = writeBsConfig({ ...cfg, sourceGlobs: instrumentGlobs(cfg.sourceGlobs) }, 'instrument', { outFile: tmpZip, extraFiles: [{ src: cfgSrc, dest: BT_CONFIG_PKG }] })
  const pb = new bsc.ProgramBuilder()
  pb.plugins.add(plugin)
  for (const extra of opts.plugins || []) {
    if (typeof extra === 'string') bsconfig.plugins = [...bsconfig.plugins, path.resolve(cfg.rootDir, extra)]
    else pb.plugins.add(extra)
  }
  // bsc prints its own diagnostics; this command prints the gate lines instead
  pb.printDiagnostics = () => {}
  let thrown = null
  try {
    await pb.run({ ...bsconfig, cwd: cfg.rootDir, logLevel: 'error' })
  } catch (e) { thrown = e }

  try {
    const result = plugin.getResult()
    const diags = pb.getDiagnostics().filter((d) => d.severity === 1)
    const isStagedInvalid = (d) => d.code === 'BT9003' && /staged-output-invalid/.test(d.message || '')
    const others = diags.filter((d) => !isStagedInvalid(d))
    const nonInvalidDiag = (d) => {
      const f = d.file && (d.file.pkgPath || d.file.srcPath) || ''
      const ln = d.range ? d.range.start.line + 1 : 0
      return `${d.code} ${f}${f ? ':' + ln : ''} ${String(d.message).split('\n')[0]}`
    }

    // gates 1 and 2: errors and BT9003. The BT9003 list is the plugin's own record; the diagnostics repeat it.
    if (diags.length || result.invalid.length || thrown) {
      let n = 0
      for (const d of others) { emit(nonInvalidDiag(d)); n++ }
      for (const x of result.invalid) { emit(`BT9003 staged-output-invalid ${pos(x)} (bsc ${x.code}, ${x.kinds.join('+')})`); n++ }
      if (!n && thrown) { emit(`build error: ${thrown.message}`); n++ }
      if (!n) n = diags.length
      return fail(EXIT_ERROR, n, result, { errors: n })
    }

    // gate 3: strict (R5 table)
    const trips = result.skipped.filter(tripsStrict)
    const informational = result.skipped.filter((e) => !tripsStrict(e))
    if (strict && trips.length) {
      for (const e of trips) emit(`strict: ${e.kind} ${pos(e)} ${e.reason}`)
      return fail(EXIT_STRICT, trips.length, result, { strictTrips: trips, informational })
    }

    if (!fs.existsSync(tmpZip)) {
      emit('build error: brighterscript did not write a package')
      return fail(EXIT_ERROR, 1, result, { errors: 1 })
    }

    // only now does the package reach `out`
    moveFile(tmpZip, out)
    const s = result.stats
    const summary = [
      `${s.setUrl} setUrl and ${s.getUrl} getUrl rewrite(s)`,
      `${result.bootstrapped.length} Scene init(s) bootstrapped`,
      `${result.synthesized.length} synthesized`,
      `${result.opInjected.length} BT_op declaration(s)`,
    ].join(', ')
    const notes = strict ? trips.concat(informational) : result.skipped
    log(`instrument build: wrote ${out}`)
    log(`  ${summary}`)
    log(`  ${notes.length} report entr${notes.length === 1 ? 'y' : 'ies'} (${informational.length} informational${strict ? '' : `, ${trips.length} would trip strict`})`)
    if (opts.verbose) for (const e of result.skipped) log(`  ${tripsStrict(e) ? 'note' : 'info'}: ${e.kind} ${pos(e)} ${e.reason}`)
    return { exitCode: EXIT_OK, out, errors: 0, strictTrips: trips, informational, result, lines }
  } finally {
    rmQuiet(tmpZip)
    rmQuiet(genDir)
  }
}

module.exports = { build, instrumentGlobs, tripsStrict, renderBtConfig, validateStateConfig, STRICT_TABLE, BT_CONFIG_PKG, EXIT_OK, EXIT_ERROR, EXIT_STRICT }
