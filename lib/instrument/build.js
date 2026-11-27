'use strict'
// brighttest instrument build (INS-F-T2): builds the app through brighterscript with the instrument plugin and writes a
// sideloadable package. Design: ADR 0015, ADR 0019 Amendment (d) R1/R2/R5.
//
//   build(cfg, opts) -> Promise<{ exitCode, out, errors, strictTrips, informational, result, lines }>
//     result.record: { id, store, created } when the package was added to the builds store (cfg.builds.record !== false), else null
//     cfg   a loadConfig() object (rootDir, stagingDir, sourceGlobs, instrument{strict,exclude,net,...})
//     opts  { out, strict, verbose, plugins, log(line), token, hub, net }   plugins: extra plugin objects/paths loaded AFTER ours;
//           token: 32 lowercase hex build token; hub: { host, port } baked address; net: --net lane (its env token wins over opts.token)
//
// One build = one fresh Program and one fresh plugin instance (single-build; no watch support). The package is built to a
// temp path next to the output and moved to `out` only after every gate passed, so a failed build never leaves a stale or
// partial file at `out` (an older good package at `out` is left untouched). `deploy` is never passed to bsc; sideloading is
// a separate step (INS-F-T5) that runs only after these gates.
//
// FR-BSC-GATE: gate 1 fails on plugin errors (BT9xxx) and parse errors in files the plugin may rewrite; other bsc
// (whole-program validation) errors are warnings with a per-code histogram and a paste-ready `diagnosticFilters` line,
// unless opts.failOnBscErrors (`--fail-on-bsc-errors`) restores the strict behaviour. These are compiler checks, not
// Roku runtime errors. FR-PACKAGE-FILES: after a build, files under rootDir that did not reach the package and
// `pkg:/` literals pointing at missing files are reported as warnings.
//
// Gates, in order (R1): (1) a blocking error diagnostic: plugin (BT9001, BT9002, BT9003, BT9004, BT9005), a parse error
// (or any bsc error with --fail-on-bsc-errors); (2)
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
const { writeBsConfig, instrumentFiles } = require('../config')
const report = require('./build-report')

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
  'net-render-thread': false, // hand-written BT_url( on the render thread (NET-BTURL-RT, ADR 0021): informational
  'wrap-target-unknown': true, // a configured dispatch function or Task entry that was not found (nothing wrapped)
  'parse-threw': true, // an invalid[].code, listed so the table is complete
})

// `accepted` (optional): a matcher over package paths built from instrument.strictAccept. An excluded-candidate entry in
// a file it matches is an excludes the user accepted on purpose, so it does not trip; every other kind is unaffected.
function tripsStrict(entry, accepted) {
  const rule = Object.prototype.hasOwnProperty.call(STRICT_TABLE, entry.kind) ? STRICT_TABLE[entry.kind] : true
  const trips = typeof rule === 'function' ? !!rule(entry) : !!rule
  if (trips && accepted && entry.kind === 'excluded-candidate' && accepted(entry.file)) return false
  return trips
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
  for (const key of ['dispatch', 'tasks']) {
    const v = state[key]
    if (v === undefined) continue
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) throw new Error(`instrument.state.${key} must be an array of strings`)
    if (v.length > CALLABLE_MAX_NAMES) throw new Error(`instrument.state.${key} must have at most ${CALLABLE_MAX_NAMES} names (got ${v.length})`)
    for (const n of v) {
      if (!CALLABLE_NAME.test(n) || n.length > CALLABLE_MAX_LEN) throw new Error(`instrument.state.${key} entries must be identifiers of at most ${CALLABLE_MAX_LEN} characters (got ${JSON.stringify(n)})`)
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
    ...(i.net && typeof i.net === 'object' && i.net.observe === true ? ['        netObserve: true'] : []),
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

// FR-PACKAGE-FILES: warn about files under rootDir that are not in the package and `pkg:/` literals that point at
// files that are not. Never fails the build: a read problem is a one-line note.
async function packageReport(zipPath, cfg, emit) {
  try {
    const JSZip = require('jszip')
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
    const np = report.notPackaged(cfg.rootDir, names, [cfg.stagingDir])
    if (np.total) {
      emit(`instrument build: warning: ${np.total} file(s) under rootDir are not in the package (instrument.files widens it; dotfiles, tests and tool config are left out on purpose):`)
      for (const g of np.missing.slice(0, 8)) emit(`  ${g.group}: ${g.count} not packaged`)
      if (np.missing.length > 8) emit(`  ... ${np.missing.length - 8} more folder(s)`)
    }
    const texts = []
    for (const n of names.filter((x) => /\.(brs|xml)$/i.test(x))) texts.push({ name: n, text: await zip.files[n].async('string') })
    const miss = report.missingPkgLiterals(texts, names)
    if (miss.length) {
      emit(`instrument build: warning: ${miss.length} pkg:/ path(s) in the code point at files that are not in the package:`)
      for (const m of miss.slice(0, 5)) emit(`  ${m.literal} (in ${m.file})`)
      if (miss.length > 5) emit(`  ... ${miss.length - 5} more`)
    }
  } catch (e) {
    emit(`instrument build: note: package file report skipped (${e.message})`)
  }
}

// Git facts of a directory ({ sha, branch, dirty }), or null when it is not a work tree or git fails (2 s per command).
function gitFacts(cwd) {
  const { execFile } = require('node:child_process')
  const git = (args) => new Promise((resolve) => {
    try { execFile('git', args, { cwd, timeout: 2000, encoding: 'utf8', windowsHide: true }, (err, out) => resolve(err ? null : String(out || '').trim())) } catch { resolve(null) }
  })
  return Promise.all([git(['rev-parse', '--short', 'HEAD']), git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['status', '--porcelain'])])
    .then(([sha, branch, porcelain]) => (sha && branch && porcelain != null ? { sha, branch, dirty: porcelain.length > 0 } : null))
    .catch(() => null)
}

// Add the built package to the builds store unless cfg.builds.record is false. A store error is one warning line and
// never fails the build. Returns { id, store, created } or null.
async function recordBuild({ cfg, out, strict, opts, log }) {
  if (cfg.builds && cfg.builds.record === false) return null
  try {
    const store = opts.store || require('../builds/store').openStore({ cfg, rootDir: opts.storeRootDir || cfg.rootDir })
    const git = opts.storeRootDir ? null : await gitFacts(cfg.rootDir)
    const r = await store.add(fs.readFileSync(out), {
      filename: path.basename(out), project: path.basename(opts.storeRootDir || cfg.rootDir || ''), git,
      source: { kind: 'build', net: !!opts.net, strict, from: opts.recordFrom ? path.basename(String(opts.recordFrom)) : null, fingerprint: opts.fingerprint || undefined },
    })
    log(`instrument build: recorded as build ${r.record.id}`)
    return { id: r.record.id, store, created: r.created }
  } catch (e) {
    log(`instrument build: warning: could not record the build (${e && e.message})`)
    return null
  }
}

// ---- --reuse: skip the rebuild when nothing the build reads has changed ----------------------------------------------
// The fingerprint is a sha256 over: every file under rootDir (sorted relative paths + content hashes; .git, node_modules,
// .brighttest, the staging dir and the output zip are left out), the brighttest config that shapes the build (instrument,
// sourceGlobs, diagnosticFilters), the baked hub address, the build flags (strict, net, failOnBscErrors), and the
// brighttest and brighterscript versions. It over-approximates on purpose: an extra input only causes a rebuild.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.brighttest'])
function walkFiles(root, skipAbs, rel = '', acc = []) {
  let ents
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return acc }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name
    const abs = path.join(root, r)
    if (skipAbs.has(abs)) continue
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(root, skipAbs, r, acc) } else if (e.isFile() || e.isSymbolicLink()) acc.push(r)
  }
  return acc
}
function ownVersion() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version } catch { return 'unknown' }
}
function pkgVersion(name) {
  try { return require(`${name}/package.json`).version } catch { return 'unknown' }
}
// Returns the hex fingerprint, or null when it cannot be computed with confidence (the caller then never reuses).
function sourceFingerprint(cfg, opts = {}) {
  try {
    const root = path.resolve(cfg.rootDir)
    const skipAbs = new Set([path.resolve(cfg.stagingDir || path.join(root, '.brighttest'))])
    if (opts.out) skipAbs.add(path.resolve(opts.out))
    const h = crypto.createHash('sha256')
    for (const rel of walkFiles(root, skipAbs)) {
      let data
      try { data = fs.readFileSync(path.join(root, rel)) } catch { continue } // dangling symlink: not packaged either
      h.update(`file\0${rel}\0${crypto.createHash('sha256').update(data).digest('hex')}\n`)
    }
    const { hubAddress } = require('./hub')
    const addr = opts.hub || hubAddress(cfg)
    h.update(JSON.stringify({
      instrument: cfg.instrument || {}, sourceGlobs: cfg.sourceGlobs || [], diagnosticFilters: cfg.diagnosticFilters || [],
      hub: { host: addr.host || null, port: addr.port },
      flags: { strict: opts.strict !== undefined && opts.strict !== null ? !!opts.strict : !!(cfg.instrument && cfg.instrument.strict), net: !!opts.net, failOnBscErrors: !!opts.failOnBscErrors },
      versions: { brighttest: ownVersion(), brighterscript: pkgVersion('brighterscript') },
    }))
    return h.digest('hex')
  } catch { return null }
}

// The newest stored build, when its recorded fingerprint, net flag and (for --net) hub token equal this build's. Else null.
function findReusable(cfg, opts = {}) {
  const fp = sourceFingerprint(cfg, opts)
  if (!fp) return null
  let store
  try { store = opts.store || require('../builds/store').openStore({ cfg, rootDir: cfg.rootDir }) } catch { return null }
  let rec
  try { rec = require('../builds/cli').latestBuilt(store) } catch { return null }
  if (!rec || rec.blob !== 'ok') return null
  const newest = rec.sources.filter((s) => s.kind === 'build').sort((a, b) => (a.at < b.at ? 1 : -1))[0]
  if (!newest || newest.fingerprint !== fp || !!newest.net !== !!opts.net) return null
  if (opts.net) {
    const { hubTokenFromEnv } = require('./hub')
    const mine = hubTokenFromEnv(opts.env || process.env)
    const tokens = require('./hub-token-store')
    let stored = null
    try { stored = JSON.parse(fs.readFileSync(tokens.entryPath(cfg.rootDir, rec.sha256), 'utf8')).token } catch { /* none */ }
    if (!mine || !stored || mine !== stored) return null
  }
  return { id: rec.id, label: rec.label, fingerprint: fp }
}

// --reuse with --sideload: install the stored package through `builds install` when findReusable matches.
// Returns { reused: false } (build as usual) or { reused: true, exitCode }.
async function tryReuse(cfg, opts, target, deps = {}) {
  const log = opts.log || ((l) => process.stderr.write(l + '\n'))
  const hit = findReusable(cfg, opts)
  if (!hit) { log('instrument build: --reuse: no matching stored build (source, flags or token changed); building'); return { reused: false } }
  log(`instrument build: --reuse: source unchanged, installing stored build ${hit.id} (no rebuild)`)
  const argv = ['install', hit.id, '--host', target.host]
  for (const k of ['wait', 'max', 'expect', 'as', 'purpose']) if (target[k] != null) argv.push(`--${k}`, String(target[k]))
  if (!opts.net) argv.push('--allow-token-mismatch') // a plain build's token is private to the build; the hub token check applies to --net builds
  const run = deps.install || require('../builds/cli').run
  const exitCode = await run(argv, { cwd: cfg.rootDir, env: opts.env || process.env, resolvePassword: () => target.password, ...(deps.installDeps || {}) })
  return { reused: true, exitCode }
}

async function build(cfg, opts = {}) {
  // FR-BUILD-FROM: opts.from (a built directory or zip) replaces rootDir for this build; the input is never written to.
  if (opts.from) {
    const log0 = opts.log || ((l) => process.stderr.write(l + '\n'))
    let src
    try { src = await require('./from-input').resolveFrom(opts.from, opts.fromLimits) } catch (e) {
      log0(`instrument build: ${e.message}`)
      log0('instrument build failed: 1 error(s), no package written')
      return { exitCode: EXIT_ERROR, out: null, errors: 1, strictTrips: [], informational: [], result: null, lines: [] }
    }
    try {
      const { from, fromLimits, ...rest } = opts
      void fromLimits
      // the build runs in a temp copy: the store and the source facts stay those of the real project
      return await build({ ...cfg, rootDir: src.dir }, { ...rest, storeRootDir: cfg.rootDir, recordFrom: from })
    } finally { src.cleanup() }
  }
  const log = opts.log || ((l) => process.stderr.write(l + '\n'))
  const instrument = cfg.instrument || {}
  try { require('../config').strictAcceptList(instrument) } catch (e) {
    log(`instrument build: ${e.message}`)
    log('instrument build failed: 1 error(s), no package written')
    return { exitCode: EXIT_ERROR, out: null, errors: 1, strictTrips: [], informational: [], result: null, lines: [] }
  }
  // fingerprint of the inputs, taken before the build touches anything; recorded with the stored build for --reuse
  if (!opts.storeRootDir && opts.fingerprint === undefined) opts = { ...opts, fingerprint: sourceFingerprint(cfg, opts) }
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

  let buildToken = crypto.randomBytes(16).toString('hex')
  // The simulator target passes its own per-run token (opts.token, 32 lowercase hex) and hub ({host, port}).
  // opts.token is the default build token; the --net block below still overrides it with BRIGHTTEST_HUB_TOKEN.
  if (opts.token !== undefined && opts.token !== null) {
    if (typeof opts.token !== 'string' || !/^[0-9a-f]{32}$/.test(opts.token)) {
      emit('instrument build: opts.token must be 32 lowercase hex characters')
      return fail(EXIT_ERROR, 1, null, { errors: 1 })
    }
    buildToken = opts.token
  }

  // NET-WIRE: `--net` bakes the operator's hub token (BRIGHTTEST_HUB_TOKEN) so the run's hub accepts the build; no
  // token means no build (never an empty or random token on this path).
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
    if (opts.hub) {
      const { host, port } = opts.hub
      const h = typeof host === 'string' ? host.trim() : ''
      if (!h || h.toLowerCase() === 'auto' || !Number.isInteger(port) || port < 1 || port > 65535) {
        emit('instrument build: opts.hub must be {host, port} with a host name or IPv4 address (not "auto") and a port 1-65535')
        return fail(EXIT_ERROR, 1, null, { errors: 1 })
      }
      addr = { host: h, port }
    } else try { addr = hubAddress(cfg) } catch (e) { emit(`instrument build: ${e.message}`); return fail(EXIT_ERROR, 1, null, { errors: 1 }) }
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
  const { bsconfig } = writeBsConfig({ ...cfg, instrumentFiles: instrumentGlobs(instrumentFiles(cfg)) }, 'instrument', { outFile: tmpZip, extraFiles: [{ src: cfgSrc, dest: BT_CONFIG_PKG }] })
  // BS1104 (a local named like an app function) inside our own injected runtime files is never the app's to fix: an app
  // function named like a runtime local (clamp, min, ...) must not fail the build. The app's own files keep the diagnostic.
  bsconfig.diagnosticFilters = [...(bsconfig.diagnosticFilters || []), { src: '/__brighttest__/**', codes: [1104] }]
  const pb = new bsc.ProgramBuilder()
  pb.plugins.add(plugin)
  for (const extra of opts.plugins || []) {
    if (typeof extra === 'string') bsconfig.plugins = [...bsconfig.plugins, path.resolve(cfg.rootDir, extra)]
    else pb.plugins.add(extra)
  }
  // bsc prints its own diagnostics; this command prints the gate lines instead
  pb.printDiagnostics = () => {}
  // bsc writes no package when it sees any error, so the advisory ones (whole-program validation, FR-BSC-GATE) are hidden
  // from it while it runs; build() reads the full list through origGetDiagnostics() afterwards.
  const failOnBsc = !!opts.failOnBscErrors
  const excludedMatch = createPlugin.makeMatcher([...createPlugin.DEFAULT_EXCLUDE, ...(Array.isArray(instrument.exclude) ? instrument.exclude : [])])
  const origGetDiagnostics = pb.getDiagnostics.bind(pb)
  if (!failOnBsc) {
    pb.getDiagnostics = () => {
      const all = origGetDiagnostics()
      const { blocking } = report.classify(all.filter((d) => d.severity === 1), { isExcluded: excludedMatch })
      const keep = new Set(blocking)
      return all.filter((d) => d.severity !== 1 || keep.has(d))
    }
  }
  let thrown = null
  try {
    await pb.run({ ...bsconfig, cwd: cfg.rootDir, logLevel: 'error' })
  } catch (e) { thrown = e }

  try {
    const result = plugin.getResult()
    const diags = origGetDiagnostics().filter((d) => d.severity === 1)
    const isStagedInvalid = (d) => d.code === 'BT9003' && /staged-output-invalid/.test(d.message || '')
    const others = diags.filter((d) => !isStagedInvalid(d))
    const nonInvalidDiag = (d) => {
      const f = report.pkgOf(d)
      const ln = d.range ? d.range.start.line + 1 : 0
      return `${d.code} ${f}${f ? ':' + ln : ''} ${String(d.message).split('\n')[0]}`
    }
    const { blocking, advisory } = report.classify(others, { failOnBsc, isExcluded: excludedMatch })
    // the histogram covers every numeric bsc code that was reported, blocking or not
    const bscDiags = [...blocking, ...advisory].filter((d) => !report.isPlugin(d))
    const printBscSummary = (asWarning) => {
      if (!bscDiags.length) return
      const h = report.histogram(bscDiags)
      emit(`instrument build: ${bscDiags.length} bsc diagnostic(s)${asWarning ? ' reported as warnings' : ''}: compiler checks, not Roku runtime errors${asWarning ? ' (the package is not affected)' : ''}`)
      emit(`  by code: ${h.codes.map(([c, n]) => `${c}=${n}`).join(', ')}`)
      if (h.line) emit(`  to silence them add to brighttest.json (also applies to the headless lanes): ${h.line}`)
      if (asWarning) emit('  pass --fail-on-bsc-errors to fail the build on them')
    }
    const WARN_LIST_MAX = 10
    const listAdvisory = () => {
      const list = opts.verbose ? advisory : advisory.slice(0, WARN_LIST_MAX)
      for (const d of list) emit(`warning: ${nonInvalidDiag(d)}`)
      if (advisory.length > list.length) emit(`  ... ${advisory.length - list.length} more (--verbose lists all)`)
    }

    // gates 1 and 2: blocking errors and BT9003. The BT9003 list is the plugin's own record; the diagnostics repeat it.
    if (blocking.length || result.invalid.length || thrown) {
      let n = 0
      for (const d of blocking) { emit(nonInvalidDiag(d)); n++ }
      for (const x of result.invalid) { emit(`BT9003 staged-output-invalid ${pos(x)} (bsc ${x.code}, ${x.kinds.join('+')})`); n++ }
      if (!n && thrown) { emit(`build error: ${thrown.message}`); n++ }
      if (!n) n = diags.length
      printBscSummary(false)
      return fail(EXIT_ERROR, n, result, { errors: n })
    }

    // gate 3: strict (R5 table)
    const acceptList = require('../config').strictAcceptList(instrument)
    const accepted = acceptList.length ? createPlugin.makeMatcher(acceptList) : null
    const trips = result.skipped.filter((e) => tripsStrict(e, accepted))
    const informational = result.skipped.filter((e) => !tripsStrict(e, accepted))
    if (strict && trips.length) {
      for (const e of trips) emit(`strict: ${e.kind} ${pos(e)} ${e.reason}`)
      return fail(EXIT_STRICT, trips.length, result, { strictTrips: trips, informational })
    }

    if (!fs.existsSync(tmpZip)) {
      emit('build error: brighterscript did not write a package')
      return fail(EXIT_ERROR, 1, result, { errors: 1 })
    }

    // warnings first, then the package report (read from the temp package before it moves)
    if (advisory.length) { listAdvisory(); printBscSummary(true) }
    await packageReport(tmpZip, cfg, emit)

    // only now does the package reach `out`
    moveFile(tmpZip, out)
    if (opts.net) {
      // keep the baked token per package so a lost shell does not force a rebuild (FR-HUB-TOKEN-STORE); never fatal
      try {
        const store = require('./hub-token-store')
        const sha = store.sha256File(out)
        store.storeToken(cfg.rootDir, sha, buildToken)
        log(`instrument build: hub token kept for package ${store.shaPrefix(sha)} (${path.relative(cfg.rootDir, store.storeDir(cfg.rootDir)) || '.'})`)
      } catch (e) { log(`instrument build: could not keep the hub token (${e.message})`) }
    }
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
    if (opts.verbose) for (const e of result.skipped) log(`  ${tripsStrict(e, accepted) ? 'note' : 'info'}: ${e.kind} ${pos(e)} ${e.reason}`)
    const record = await recordBuild({ cfg, out, strict, opts, log })
    return { exitCode: EXIT_OK, out, errors: 0, strictTrips: trips, informational, result, lines, record }
  } finally {
    rmQuiet(tmpZip)
    rmQuiet(genDir)
  }
}

module.exports = { build, sourceFingerprint, findReusable, tryReuse, instrumentGlobs, tripsStrict, renderBtConfig, validateStateConfig, STRICT_TABLE, BT_CONFIG_PKG, EXIT_OK, EXIT_ERROR, EXIT_STRICT }
