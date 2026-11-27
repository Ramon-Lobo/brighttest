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

// One digest-authenticated POST: a bodyless challenge, then the archive once (see digestFetch; no keep-alive reuse).
async function post(fetchFn, host, password, fields) {
  const { body, contentType } = multipart(fields)
  const r = await digestFetch(`http://${host}:${INSTALLER_PORT}/plugin_install`, '/plugin_install', {
    user: USER, password, method: 'POST', body, headers: { 'Content-Type': contentType }, fetchFn,
  })
  return { status: r.status, html: await r.text().catch(() => '') }
}

const installFields = (zipData) => [
  { name: 'mysubmit', value: 'Replace' },
  { name: 'archive', filename: 'app.zip', contentType: 'application/zip', data: zipData },
]
const deleteFields = () => [
  { name: 'mysubmit', value: 'Delete' },
  { name: 'archive', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0) },
]

async function install({ fetchFn, host, password, zipData, log }) {
  const attempt = async () => {
    try { const x = await post(fetchFn, host, password, installFields(zipData)); return parseInstallerReply(x.status, x.html) } catch (e) {
      return { ok: false, kind: 'network', message: String(e.message).split(password).join('***') }
    }
  }
  let r = await attempt()
  if (r.ok || r.kind === 'auth') return r
  log(`instrument sideload: install failed (${r.message}); deleting the installed app and retrying once`)
  try { await post(fetchFn, host, password, deleteFields()) } catch { /* the retry reports the real state */ }
  return attempt()
}

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

// Write installed.json + the 'installed' event on every key the lease holds. Runs inside the install that holds the
// lease (no new lease, no spawn); a failure is a warning, never an install failure.
function recordInstalled({ l, facts, opts, identical, deps, log, password }) {
  try {
    const installed = require('../device-installed')
    const keys = l ? (Array.isArray(l.keys) && l.keys.length ? l.keys : l.key ? [l.key] : []) : []
    const agent = opts.as || process.env.BRIGHTTEST_AGENT || (l && l.record && l.record.holder && l.record.holder.agent) || null
    const entry = installed.buildEntry({ facts, agent, via: opts.via, identical })
    const r = (deps.recordInstall || installed.recordInstall)({ dir: deps.installedDir, keys, entry })
    if (r && r.ok === false) log(`instrument sideload: warning: could not record the installed build (${r.error})`.split(password).join('***'))
  } catch (e) {
    log(`instrument sideload: warning: could not record the installed build (${String(e && e.message)})`.split(password).join('***'))
  }
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
    const probe = deps.tcpProbe || tcpProbe
    if (!(await probe(host, INSTALLER_PORT, 3000))) {
      log(`instrument sideload: ${host}:${INSTALLER_PORT} is not reachable; enable Developer Mode on the device and check the network`)
      return EXIT_FAIL
    }
    const r = await install({ fetchFn: deps.fetch || fetch, host, password, zipData: fs.readFileSync(zip), log })
    if (!r.ok) {
      log(`instrument sideload: ${r.kind === 'auth' ? 'authentication failed' : r.kind === 'network' ? 'installer request failed' : 'install failed'}: ${r.message}`.split(password).join('***'))
      return EXIT_FAIL
    }
    if (r.identical) await relaunchDev({ fetchFn: deps.fetch || fetch, host })
    const act = await waitActive({
      fetchFn: deps.fetch || fetch, host, tries: deps.activeTries || ACTIVE_TRIES,
      sleep: deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms))),
    })
    if (!act.ok) {
      const seen = act.app && act.app.error ? `active-app query failed (${act.app.error})` : `active app is ${act.app && (act.app.id || act.app.name) ? `"${act.app.id || act.app.name}"` : 'none'}`
      log((r.identical
        ? `instrument sideload: ${zip} on ${host}: the identical package is installed but the dev channel did not start after a relaunch (${seen})`
        : `instrument sideload: installed ${zip} on ${host} but the dev channel is not active (${seen}); the channel likely exited at launch`).split(password).join('***'))
      log('instrument sideload: fix: make sure the package contains source/main.brs (do not exclude it in sourceGlobs) and that main() starts a screen; check the device debug console (port 8085) for a crash')
      return EXIT_FAIL
    }
    recordInstalled({ l, facts, opts, identical: !!r.identical, deps, log, password })
    log(r.identical
      ? `instrument sideload: ${zip} on ${host}: identical package already installed; relaunched the dev channel`
      : `instrument sideload: installed ${zip} on ${host}; dev channel active`)
    return EXIT_OK
  } catch (e) {
    log(`instrument sideload: ${String(e.message).split(password).join('***')}`)
    return EXIT_FAIL
  } finally {
    if (l) l.release()
  }
}

module.exports = { sideload, parseInstallerReply, tcpProbe }
