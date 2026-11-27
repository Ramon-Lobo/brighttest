'use strict'
// brighttest instrument build --sideload (INS-F-T5): installs the built package on a device through the Roku dev
// installer (POST /plugin_install on port 80, HTTP Digest, user "rokudev"), under the device lease.
//
//   sideload(cfg, { zip, host, password, wait, max, expect, as, purpose }, deps?) -> Promise<exitCode>
//
// Steps: take the lease (never bypassed) -> TCP-80 gate -> install -> on an installer failure send Delete once and
// retry the install once -> verify the dev channel is active (GET :8060/query/active-app, polled briefly; a package that
// installs but whose channel exits at launch, e.g. one without source/main.brs, exits 1). Exit codes: 0 installed, 1 install/auth/connectivity failure, 2 usage, and the lease codes
// (75 busy/timeout, 77 lost, 78 lease dir). The password is never printed, logged or written.
// After a successful install (identical included) it records the build in the lease dir (lib/device-installed.js, opts.via:
// cli | studio | mcp); a record failure is a warning only.
//
// installPackage() is the lease-free core (never throws, takes no lease; the CLI and Studio hold the lease and pass
// `signal`, `leaseCheck` and `onStep`). sideload() is the CLI wrapper: lease, install, log, history. installLastBuild()
// re-installs the most recent recorded build for a device host through installPackage().
//
// deps (tests): { fetch, tcpProbe(host, port, ms), acquireForLane, log(line), sleep(ms), activeTries }
const fs = require('node:fs')
const net = require('node:net')
const { digestFetch, multipart, parseActiveApp } = require('../e2e/ecp')

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const USER = 'rokudev'
const INSTALLER_PORT = 80
const ECP_PORT = 8060
const ACTIVE_TRIES = 8
const ACTIVE_GAP_MS = 1000
const DEV_CHANNEL_ID = 'dev'

function tcpProbe(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok) => { s.destroy(); resolve(ok) }
    s.setTimeout(ms, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

// Classify the installer's HTML reply (or HTTP status).
function parseInstallerReply(status, html) {
  const text = String(html || '')
  if (status === 401) return { ok: false, kind: 'auth', message: 'device rejected the dev password (HTTP 401)' }
  if (/Install Success/i.test(text)) return { ok: true }
  if (/Identical to previous version/i.test(text)) return { ok: true, identical: true }
  const fail = /Install Failure:\s*([^<\r\n]+)/i.exec(text)
  if (fail) return { ok: false, kind: 'install', message: fail[1].trim() }
  const compile = /Compilation Failed/i.exec(text)
  if (compile) return { ok: false, kind: 'install', message: 'Compilation Failed' }
  if (status >= 400) return { ok: false, kind: 'http', message: `installer returned HTTP ${status}` }
  return { ok: false, kind: 'install', message: 'installer reply not recognized (no "Install Success")' }
}

const installFields = (zipData) => [
  { name: 'mysubmit', value: 'Replace' },
  { name: 'archive', filename: 'app.zip', contentType: 'application/zip', data: zipData },
]
const deleteFields = () => [
  { name: 'mysubmit', value: 'Delete' },
  { name: 'archive', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0) },
]

// An identical package is not replaced, so the installer may not relaunch it: ask ECP to launch the dev channel once.
async function relaunchDev({ fetchFn, host }) {
  try { await fetchFn(`http://${host}:${ECP_PORT}/launch/${DEV_CHANNEL_ID}`, { method: 'POST' }) } catch { /* waitActive reports the real state */ }
}

// Poll /query/active-app until the dev channel is in front (the install auto-launches it) or the tries run out.
async function waitActive({ fetchFn, host, sleep, tries }) {
  let last = null
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(ACTIVE_GAP_MS)
    try {
      const r = await fetchFn(`http://${host}:${ECP_PORT}/query/active-app`, { method: 'GET' })
      if (r.status === 200) {
        last = parseActiveApp(await r.text())
        if (last.id === DEV_CHANNEL_ID) return { ok: true, app: last }
      } else last = { error: `HTTP ${r.status}` }
    } catch (e) { last = { error: e.message } }
  }
  return { ok: false, app: last }
}

const CODES = ['OK', 'UNREACHABLE', 'AUTH', 'INSTALL_FAILED', 'NETWORK', 'NOT_ACTIVE', 'CANCELLED', 'LEASE_LOST']

const mask = (text, password) => (password ? String(text).split(password).join('***') : String(text))

// One install attempt: the installer's classified reply, or a network failure that keeps the errno as `cause`.
async function attempt({ fetchFn, host, password, zipData, signal }) {
  try {
    const { body, contentType } = multipart(installFields(zipData))
    const r = await digestFetch(`http://${host}:${INSTALLER_PORT}/plugin_install`, '/plugin_install', {
      user: USER, password, method: 'POST', body, headers: { 'Content-Type': contentType }, fetchFn, signal,
    })
    return parseInstallerReply(r.status, await r.text().catch(() => ''))
  } catch (e) {
    return { ok: false, kind: 'network', cause: e && e.code ? String(e.code) : null, message: mask(e && e.message, password) }
  }
}

// The lease-free install core. Never throws; the result is JSON-safe and never holds the password.
//   installPackage({ host, password, zipData, signal, leaseCheck, onStep, fetchFn, tcpProbe, sleep, activeTries })
//     -> { ok, code, step, cause?, message, active, identical, app?, durationMs, retried }
//   code: OK | UNREACHABLE | AUTH | INSTALL_FAILED | NETWORK (cause = errno) | NOT_ACTIVE | CANCELLED | LEASE_LOST
//   signal: AbortSignal, checked before each step and passed to the requests (aborting the upload client-side does not
//   stop the device). leaseCheck(): false when the caller's lease was lost; checked before each step.
//   onStep({ step: 'probe'|'upload'|'delete-retry'|'verify-active', at, message? }) reports progress.
async function installPackage(o = {}) {
  const t0 = Date.now()
  const { host, password, zipData, signal, leaseCheck, onStep } = o
  const fetchFn = o.fetchFn || o.fetch || fetch
  const state = { step: 'probe', retried: false }
  const done = (code, message, extra = {}) => ({
    ok: code === 'OK', code, step: state.step, message: mask(message, password), active: code === 'OK',
    identical: false, durationMs: Date.now() - t0, retried: state.retried, ...extra,
  })
  // Before each step: cancelled or lease lost end the install here.
  const stop = (step) => {
    state.step = step
    if (signal && signal.aborted) return done('CANCELLED', 'cancelled before the next install step')
    if (typeof leaseCheck === 'function') {
      let ok = true
      try { ok = leaseCheck() !== false } catch { ok = false }
      if (!ok) return done('LEASE_LOST', 'the device lease was lost during the install')
    }
    return null
  }
  const step = (name, extra) => { try { if (onStep) onStep({ step: name, at: new Date().toISOString(), ...extra }) } catch { /* progress only */ } }
  try {
    if (!host || !password || !Buffer.isBuffer(zipData)) return done('INSTALL_FAILED', 'installPackage needs host, password and zipData (a Buffer)', { step: 'input' })
    let s = stop('probe'); if (s) return s
    step('probe')
    if (!(await (o.tcpProbe || tcpProbe)(host, INSTALLER_PORT, 3000))) {
      return done('UNREACHABLE', `${host}:${INSTALLER_PORT} is not reachable; enable Developer Mode on the device and check the network`)
    }
    s = stop('upload'); if (s) return s
    step('upload')
    let r = await attempt({ fetchFn, host, password, zipData, signal })
    if (!r.ok && r.kind !== 'auth' && !(signal && signal.aborted)) {
      state.retried = true
      s = stop('delete-retry'); if (s) return s
      step('delete-retry', { message: r.message })
      try {
        const { body, contentType } = multipart(deleteFields())
        await digestFetch(`http://${host}:${INSTALLER_PORT}/plugin_install`, '/plugin_install', {
          user: USER, password, method: 'POST', body, headers: { 'Content-Type': contentType }, fetchFn, signal,
        })
      } catch { /* the retry reports the real state */ }
      s = stop('upload'); if (s) return s
      r = await attempt({ fetchFn, host, password, zipData, signal })
    }
    if (!r.ok) {
      if (signal && signal.aborted) return done('CANCELLED', 'cancelled during the install request')
      if (r.kind === 'auth') return done('AUTH', r.message)
      if (r.kind === 'network') return done('NETWORK', r.message, r.cause ? { cause: r.cause } : {})
      return done('INSTALL_FAILED', r.message)
    }
    const identical = !!r.identical
    s = stop('verify-active'); if (s) return Object.assign(s, { identical })
    step('verify-active')
    if (identical) await relaunchDev({ fetchFn, host })
    const act = await waitActive({
      fetchFn, host, tries: o.activeTries || ACTIVE_TRIES,
      sleep: o.sleep || ((ms) => new Promise((res) => setTimeout(res, ms))),
    })
    if (!act.ok) {
      if (signal && signal.aborted) return done('CANCELLED', 'cancelled while verifying the dev channel', { identical })
      const seen = act.app && act.app.error ? `active-app query failed (${act.app.error})` : `active app is ${act.app && (act.app.id || act.app.name) ? `"${act.app.id || act.app.name}"` : 'none'}`
      return done('NOT_ACTIVE', identical
        ? `the identical package is installed but the dev channel did not start after a relaunch (${seen})`
        : `the dev channel is not active (${seen}); the channel likely exited at launch`, { identical })
    }
    return done('OK', identical ? 'identical package already installed; relaunched the dev channel' : 'installed; dev channel active', { identical, app: act.app })
  } catch (e) {
    return done('NETWORK', String(e && e.message), { cause: e && e.code ? String(e.code) : null })
  }
}

// Write installed.json + the 'installed' event on every key the lease holds. Runs inside the install that holds the
// lease (no new lease, no spawn); a failure is a warning, never an install failure. Returns { entry, keys } or null.
function recordInstalled({ l, facts, opts, identical, deps, log, password }) {
  try {
    const installed = require('../device-installed')
    const keys = l ? (Array.isArray(l.keys) && l.keys.length ? l.keys : l.key ? [l.key] : []) : []
    const agent = opts.as || process.env.BRIGHTTEST_AGENT || (l && l.record && l.record.holder && l.record.holder.agent) || null
    const entry = installed.buildEntry({ facts, agent, via: opts.via, identical })
    const r = (deps.recordInstall || installed.recordInstall)({ dir: deps.installedDir, keys, entry })
    if (r && r.ok === false) log(mask(`instrument sideload: warning: could not record the installed build (${r.error})`, password))
    return { entry, keys }
  } catch (e) {
    log(mask(`instrument sideload: warning: could not record the installed build (${String(e && e.message)})`, password))
    return null
  }
}

// The build now on the device, from installed.json (the keys the lease holds), else the entry just written.
function onDeviceNow({ rec, deps }) {
  try {
    const installed = require('../device-installed')
    const read = rec.keys.length ? installed.readInstalled({ dir: deps.installedDir, keys: rec.keys }) : null
    const entry = read || rec.entry
    return { entry, text: installed.describeInstalled(entry) }
  } catch { return null }
}

// Append the install result to the build record ({ store, id, via }); a store error is one warning line, never a failure.
async function recordToStore({ record, host, res, log, password }) {
  if (!record || !record.store || !record.id) return
  try {
    const result = { via: record.via || 'build', host, ok: res.ok, durationMs: res.durationMs, active: res.active }
    if (!res.ok) result.error = { step: res.step, code: res.code, cause: res.cause || null, message: res.message }
    await record.store.recordInstall(record.id, result)
  } catch (e) { log(mask(`instrument sideload: warning: could not add the install to the build record (${String(e && e.message)})`, password)) }
}

async function sideload(cfg, opts, deps = {}) {
  const log = deps.log || ((l) => process.stderr.write(l + '\n'))
  const { zip, host, password } = opts
  if (!host) { log('[brighttest instrument] --sideload needs --host <ip> (no cached-device guess)'); return EXIT_USAGE }
  if (!password) { log('[brighttest instrument] --sideload needs the dev password in ROKU_PASSWORD'); return EXIT_USAGE }
  if (!zip || !fs.existsSync(zip)) { log(`[brighttest instrument] no package to sideload at ${zip}`); return EXIT_FAIL }

  // Installed-record facts (package hash, manifest, git) are read before the lease: async, in memory, never under it.
  const installed = require('../device-installed')
  let facts = null
  try { facts = await (deps.collectFacts || installed.collectFacts)({ zipData: fs.readFileSync(zip), cwd: opts.cwd }) } catch { /* the record is best-effort */ }

  const acquire = deps.acquireForLane || require('../device-command').acquireForLane
  const got = await acquire({
    cfg, opts: { as: opts.as, wait: opts.wait, max: opts.max, expect: opts.expect, purpose: opts.purpose || 'instrument sideload' },
    host, password, purpose: 'instrument sideload', command: ['brighttest', 'instrument', 'build', '--sideload'],
    allowBypass: false,
  })
  if (got.code != null) return got.code
  const l = got.lease
  try {
    const res = await installPackage({
      host, password, zipData: fs.readFileSync(zip), signal: deps.signal, leaseCheck: () => !(l && l.lost),
      fetchFn: deps.fetch || fetch, tcpProbe: deps.tcpProbe, sleep: deps.sleep, activeTries: deps.activeTries,
      onStep: (e) => {
        if (e.step === 'delete-retry') log(`instrument sideload: install failed (${e.message}); deleting the installed app and retrying once`)
      },
    })
    await recordToStore({ record: opts.record, host, res, log, password })
    if (res.code === 'LEASE_LOST') { log(`instrument sideload: ${res.message}`); return 77 }
    if (!res.ok) {
      if (res.code === 'UNREACHABLE' || res.code === 'CANCELLED') log(`instrument sideload: ${res.message}`)
      else if (res.code === 'NOT_ACTIVE') {
        log(res.identical
          ? `instrument sideload: ${zip} on ${host}: ${res.message}`
          : `instrument sideload: installed ${zip} on ${host} but ${res.message}`)
        log('instrument sideload: fix: make sure the package contains source/main.brs (do not exclude it in sourceGlobs) and that main() starts a screen; check the device debug console (port 8085) for a crash')
      } else {
        log(`instrument sideload: ${res.code === 'AUTH' ? 'authentication failed' : res.code === 'NETWORK' ? 'installer request failed' : 'install failed'}: ${res.message}`)
      }
      return EXIT_FAIL
    }
    const rec = recordInstalled({ l, facts, opts, identical: res.identical, deps, log, password })
    log(res.identical
      ? `instrument sideload: ${zip} on ${host}: identical package already installed; relaunched the dev channel`
      : `instrument sideload: installed ${zip} on ${host}; dev channel active`)
    const now = rec && onDeviceNow({ rec, deps })
    if (now) log(`instrument sideload: on the device now: ${now.text}`)
    return EXIT_OK
  } catch (e) {
    log(`instrument sideload: ${mask(e.message, password)}`)
    return EXIT_FAIL
  } finally {
    if (l) l.release()
  }
}

// The most recent recorded build that installed OK on this host (store records carry lastInstall.host), or null.
function lastBuildForHost(store, host) {
  try {
    const hit = store.list().builds
      .filter((b) => b.lastInstall && b.lastInstall.ok && b.lastInstall.host === host)
      .sort((a, b) => (a.lastInstall.at < b.lastInstall.at ? 1 : a.lastInstall.at > b.lastInstall.at ? -1 : 0))
    return hit[0] || null
  } catch { return null }
}

// "Install the last build I used" (lease-free; the caller holds the lease). Never throws. Reads the blob from the store,
// installs it through installPackage(), appends the result to the build record and, when `lease` (an object with
// `keys`) is given and the install succeeded, writes installed.json. The result adds { build, onDevice } to the
// installPackage() result: onDevice = { entry, text } read back from installed.json (null when unknown).
//   installLastBuild({ store, host, password, via, lease, as, cwd, installedDir, keys, signal, leaseCheck, onStep, ...seams })
async function installLastBuild(o = {}) {
  const fail = (code, message) => ({ ok: false, code, step: 'select', message, active: false, identical: false, durationMs: 0, retried: false, build: null, onDevice: null })
  try {
    const { store, host, password } = o
    if (!store || !host || !password) return fail('INSTALL_FAILED', 'installLastBuild needs store, host and password')
    const b = lastBuildForHost(store, host)
    if (!b) return fail('NO_BUILD', `no recorded build has been installed on ${host} yet`)
    let zipData
    try { zipData = store.blob(b.id) } catch (e) { return { ...fail(e.code || 'BUILD_BLOB_MISSING', mask(e.message, password)), build: { id: b.id, label: b.label } } }
    const installed = require('../device-installed')
    let facts = null
    try { facts = await installed.collectFacts({ zipData, cwd: o.cwd }) } catch { /* best-effort */ }
    const res = await installPackage({ ...o, zipData })
    await recordToStore({ record: { store, id: b.id, via: o.via === 'studio' ? 'studio' : 'cli' }, host, res, log: () => {}, password })
    let onDevice = null
    if (res.ok) {
      const l = o.lease || (o.keys ? { keys: o.keys } : null)
      const rec = recordInstalled({ l, facts, opts: { as: o.as, via: o.via }, identical: res.identical, deps: { installedDir: o.installedDir }, log: () => {}, password })
      if (rec) {
        const keys = rec.keys.length ? rec.keys : (() => { try { return installed.keysForHost(host) } catch { return [] } })()
        onDevice = onDeviceNow({ rec: { ...rec, keys }, deps: { installedDir: o.installedDir } })
      }
    }
    return { ...res, build: { id: b.id, label: b.label, sha256: b.sha256 }, onDevice }
  } catch (e) {
    return fail('INSTALL_FAILED', String(e && e.message))
  }
}

module.exports = { sideload, installPackage, installLastBuild, lastBuildForHost, parseInstallerReply, tcpProbe, recordInstalled, CODES }
