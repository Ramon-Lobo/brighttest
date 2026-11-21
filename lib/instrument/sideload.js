'use strict'
// brighttest instrument build --sideload (INS-F-T5): installs the built package on a device through the Roku dev
// installer (POST /plugin_install on port 80, HTTP Digest, user "rokudev"), under the device lease.
//
//   sideload(cfg, { zip, host, password, wait, max, expect, as, purpose }, deps?) -> Promise<exitCode>
//
// Steps: take the lease (never bypassed) -> TCP-80 gate -> install -> on an installer failure send Delete once and
// retry the install once. Exit codes: 0 installed, 1 install/auth/connectivity failure, 2 usage, and the lease codes
// (75 busy/timeout, 77 lost, 78 lease dir). The password is never printed, logged or written.
//
// deps (tests): { fetch, tcpProbe(host, port, ms), acquireForLane, log(line) }
const fs = require('node:fs')
const net = require('node:net')
const { buildDigestHeader, parseChallenge, multipart } = require('../e2e/ecp')

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2
const USER = 'rokudev'
const INSTALLER_PORT = 80

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
  if (/Install Success/i.test(text) || /Identical to previous version/i.test(text)) return { ok: true }
  const fail = /Install Failure:\s*([^<\r\n]+)/i.exec(text)
  if (fail) return { ok: false, kind: 'install', message: fail[1].trim() }
  const compile = /Compilation Failed/i.exec(text)
  if (compile) return { ok: false, kind: 'install', message: 'Compilation Failed' }
  if (status >= 400) return { ok: false, kind: 'http', message: `installer returned HTTP ${status}` }
  return { ok: false, kind: 'install', message: 'installer reply not recognized (no "Install Success")' }
}

async function post(fetchFn, host, password, fields) {
  const uri = '/plugin_install'
  const url = `http://${host}:${INSTALLER_PORT}${uri}`
  const { body, contentType } = multipart(fields)
  const headers = { 'Content-Type': contentType }
  const first = await fetchFn(url, { method: 'POST', body, headers })
  if (first.status !== 401) return { status: first.status, html: await first.text().catch(() => '') }
  const challenge = parseChallenge(first.headers.get('www-authenticate'))
  const auth = buildDigestHeader({ user: USER, password, method: 'POST', uri, challenge })
  const second = await fetchFn(url, { method: 'POST', body, headers: { ...headers, Authorization: auth } })
  return { status: second.status, html: await second.text().catch(() => '') }
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
  const attempt = async () => { const x = await post(fetchFn, host, password, installFields(zipData)); return parseInstallerReply(x.status, x.html) }
  let r = await attempt()
  if (r.ok || r.kind === 'auth') return r
  log(`instrument sideload: install failed (${r.message}); deleting the installed app and retrying once`)
  try { await post(fetchFn, host, password, deleteFields()) } catch { /* the retry reports the real state */ }
  return attempt()
}

async function sideload(cfg, opts, deps = {}) {
  const log = deps.log || ((l) => process.stderr.write(l + '\n'))
  const { zip, host, password } = opts
  if (!host) { log('[brighttest instrument] --sideload needs --host <ip> (no cached-device guess)'); return EXIT_USAGE }
  if (!password) { log('[brighttest instrument] --sideload needs the dev password in ROKU_PASSWORD'); return EXIT_USAGE }
  if (!zip || !fs.existsSync(zip)) { log(`[brighttest instrument] no package to sideload at ${zip}`); return EXIT_FAIL }

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
      log(`instrument sideload: ${r.kind === 'auth' ? 'authentication failed' : 'install failed'}: ${r.message}`.split(password).join('***'))
      return EXIT_FAIL
    }
    log(`instrument sideload: installed ${zip} on ${host}`)
    return EXIT_OK
  } catch (e) {
    log(`instrument sideload: ${String(e.message).split(password).join('***')}`)
    return EXIT_FAIL
  } finally {
    if (l) l.release()
  }
}

module.exports = { sideload, parseInstallerReply, tcpProbe }
