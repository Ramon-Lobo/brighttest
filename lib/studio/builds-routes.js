'use strict'
// Studio Builds routes (STUDIO-BUILDS-T3; design studio-builds.md 5.3-5.5 and 7). One handler for /api/builds/*:
// list, get, upload (raw zip), edit, delete, download, install job (SSE progress, cancel, replay) and the dev channel
// that is on the device now. The store and install core are lib/builds/** and lib/instrument/sideload.js; this file
// only maps them to HTTP.
//
//   const builds = create({ cfg, rootDir, env, sl, d, seams })   d = server hooks (see below)
//   await builds.handle(p, req, res, url, { gate })               true when the route was answered
//   builds.active()   -> the install job in flight ({ jobId, buildId }) or null (the run route refuses while it is set)
//   builds.close()
//
// d: { sim(), device(), host(), password(), hasTarget(), activeRun() -> { id } | null, leaseDir }
// seams (tests): { store, installPackage, collectFacts, installOpts: { fetchFn, tcpProbe, sleep, activeTries }, now }
//
// Secrets: the dev password, Studio's hub token and a package's baked token never leave this file. Every string in a
// response body or SSE event is scrubbed of them first; the token check answers an enum only.
const crypto = require('node:crypto')
const path = require('node:path')
const { hubTokenFromEnv } = require('../instrument/hub')
const { parseApps } = require('../e2e/ecp')

const JOB_KEEP_MS = 10 * 60 * 1000
const JOBS_MAX = 20
const STREAMS_MAX = 8
const JSON_BODY_MAX = 64 * 1024
const MB = 1024 * 1024
const TOKEN_ENUM_BLOCKING = new Set(['mismatch', 'no-studio-token'])
const STATUS = {
  BUILD_TOO_LARGE: 413, BUILD_INVALID_ZIP: 422, BUILD_UNSAFE_ZIP: 422, BUILD_NO_MANIFEST: 422,
  STORE_LOCKED: 503, STORE_WRITE_FAILED: 507, BUILD_NOT_FOUND: 404, BUILD_AMBIGUOUS: 409, BUILD_PINNED: 409,
  BUILD_INVALID_FIELD: 400, BUILD_BLOB_MISSING: 410, BUILD_BLOB_CORRUPT: 409,
}

function create({ cfg = null, rootDir = process.cwd(), env = process.env, sl, d, seams = {} } = {}) {
  let storeObj = null
  const store = () => {
    if (!storeObj) storeObj = seams.store || require('../builds/store').openStore({ cfg, rootDir, env })
    return storeObj
  }
  const jobs = new Map()
  let active = null // the install job in flight
  let streams = 0
  const timers = new Set()
  const installPackage = seams.installPackage || require('../instrument/sideload').installPackage
  const collectFacts = seams.collectFacts || require('../device-installed').collectFacts

  // --- secrets ------------------------------------------------------------------------------------------------
  const extra = new Set() // package tokens seen by an install in this process
  const secrets = () => {
    const out = [d.password && d.password(), hubTokenFromEnv(env), ...extra].filter((s) => typeof s === 'string' && s.length >= 4)
    return out
  }
  const scrubStr = (s) => secrets().reduce((t, x) => t.split(x).join('***'), String(s))
  const scrub = (v) => {
    if (typeof v === 'string') return scrubStr(v)
    if (Array.isArray(v)) return v.map(scrub)
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = scrub(v[k]); return o }
    return v
  }

  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(scrub(obj)))
    return true
  }
  const fail = (res, status, code, message, more) => send(res, status, { error: message, code, ...(more || {}) })
  const storeFail = (res, e) => {
    const code = e && e.code
    if (code === 'BUILD_INVALID_FIELD') return fail(res, 400, 'BAD_FIELD', e.message)
    if (STATUS[code]) return fail(res, STATUS[code], code, e.message, code === 'BUILD_AMBIGUOUS' ? { ids: e.ids } : undefined)
    return fail(res, 500, 'INTERNAL', 'builds route failed')
  }

  function readJson(req) {
    return new Promise((resolve) => {
      const chunks = []
      let n = 0
      let over = false
      req.on('data', (c) => { n += c.length; if (n > JSON_BODY_MAX) over = true; else chunks.push(c) })
      req.on('error', () => resolve({ bad: true }))
      req.on('end', () => {
        if (over) return resolve({ bad: true })
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve({ value: {} })
        try {
          const v = JSON.parse(text)
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : { bad: true })
        } catch { resolve({ bad: true }) }
      })
    })
  }

  // The raw upload body with a hard cap. Resolves a Buffer, or null once the 413 was sent.
  function readZip(req, res, max) {
    return new Promise((resolve) => {
      const tooLarge = () => {
        const msg = `over the ${max / MB} MB limit (builds.maxZipMB)`
        res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' })
        res.end(JSON.stringify({ error: msg, code: 'BUILD_TOO_LARGE' }), () => { try { req.destroy() } catch { /* gone */ } })
        resolve(null)
      }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > max) return tooLarge()
      const chunks = []
      let n = 0
      let stopped = false
      req.on('data', (c) => {
        if (stopped) return
        n += c.length
        if (n > max) { stopped = true; chunks.length = 0; tooLarge(); return }
        chunks.push(c)
      })
      req.on('end', () => { if (!stopped) resolve(Buffer.concat(chunks)) })
      req.on('error', () => { if (!stopped) { stopped = true; resolve(null) } })
    })
  }

  // --- token check (enum only) ------------------------------------------------------------------------------------
  function tokenCheck(info) {
    if (!info || info.kind !== 'instrumented') return 'not-instrumented'
    let t = null
    try { t = info.tokenOf() } catch { return 'unreadable' }
    if (!t) return 'unreadable'
    extra.add(t)
    const mine = hubTokenFromEnv(env)
    if (!mine) return 'no-studio-token'
    const a = Buffer.from(t)
    const b = Buffer.from(mine)
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'match' : 'mismatch'
  }

  // --- jobs -------------------------------------------------------------------------------------------------------
  const frame = (ev) => `data: ${JSON.stringify(scrub(ev))}\n\n`
  function emit(job, ev) {
    job.events.push(ev)
    for (const r of job.subs) { try { r.write(frame(ev)) } catch { /* closed */ } }
  }
  function finish(job, result) {
    job.done = true
    job.result = result
    emit(job, { type: 'done', ok: !!result.ok, result })
    for (const r of [...job.subs]) { try { r.end() } catch { /* closed */ } }
    job.subs.clear()
    if (active === job) active = null
    const t = setTimeout(() => { timers.delete(t); jobs.delete(job.jobId) }, seams.jobKeepMs || JOB_KEEP_MS)
    if (t.unref) t.unref()
    timers.add(t)
    // bound the map: drop the oldest finished jobs past the cap
    const finished = [...jobs.values()].filter((j) => j.done)
    for (const j of finished.slice(0, Math.max(0, finished.length - JOBS_MAX))) jobs.delete(j.jobId)
  }

  const LATE = new Set(['upload', 'delete-retry', 'verify-active'])
  async function runJob(job, { zipData, facts, host }) {
    let result
    try {
      result = await sl.during(async (leaseSignal) => {
        const signal = AbortSignal.any([leaseSignal, job.ac.signal])
        const password = d.password()
        const res = await installPackage({
          host, password, zipData, signal, leaseCheck: () => sl.holding, ...(seams.installOpts || {}),
          onStep: (e) => {
            if (e.step === 'upload') job.uploadStarted = true
            emit(job, { type: 'step', step: e.step, at: e.at })
            if (e.step === 'delete-retry') emit(job, { type: 'log', line: `install failed (${e.message || 'no detail'}); deleting the installed app and retrying once` })
          },
        })
        if (res.ok) {
          try {
            require('../instrument/sideload').recordInstalled({
              l: sl.lease, facts, opts: { via: 'studio', as: process.env.BRIGHTTEST_AGENT },
              identical: res.identical, deps: { installedDir: d.leaseDir }, log: () => {}, password,
            })
          } catch { /* the installed record is best-effort */ }
        }
        return res
      })
    } catch (e) {
      result = { ok: false, code: 'INSTALL_FAILED', step: 'install', message: String(e && e.message), active: false, identical: false, durationMs: 0, retried: false }
    }
    if (result.code === 'CANCELLED' && (LATE.has(result.step) || job.uploadStarted)) {
      result = { ...result, message: 'cancelled; the device may still finish installing' }
    }
    result = { ...result, buildId: job.buildId, tokenCheck: job.tokenCheck }
    try {
      const rr = { via: 'studio', host, ok: result.ok, durationMs: result.durationMs, active: result.active }
      if (!result.ok) rr.error = { step: result.step, code: result.code, cause: result.cause || null, message: scrubStr(result.message) }
      await store().recordInstall(job.buildId, rr)
    } catch { /* a store error never changes the install result */ }
    finish(job, scrub(result))
  }

  // --- routes -----------------------------------------------------------------------------------------------------
  const view = (r) => ({ ...r, installing: !!(active && active.buildId === r.id) })

  function list(res) {
    const s = store()
    const { builds, warnings } = s.list()
    return send(res, 200, {
      store: { scope: s.scope, dir: s.dir, count: builds.length, totalBytes: builds.reduce((n, b) => n + (b.size || 0), 0), caps: s.caps },
      builds: builds.map(view), warnings,
    })
  }

  async function upload(req, res, url) {
    const s = store()
    const max = s.caps.maxZipMB * MB
    const buf = await readZip(req, res, max)
    if (!buf) return true
    let filename = null
    try { filename = req.headers['x-build-filename'] ? decodeURIComponent(String(req.headers['x-build-filename'])) : null } catch { filename = null }
    try {
      const r = await s.add(buf, { filename, source: { kind: 'upload' }, project: path.basename(rootDir) })
      let rec = r.record
      const label = url.searchParams.get('label')
      if (label) { try { rec = await s.edit(rec.id, { label }) } catch { /* keep the default label */ } }
      return send(res, r.created ? 201 : 200, r.created
        ? { build: view(rec), created: true, warnings: r.warnings }
        : { build: view(rec), created: false, deduped: true, warnings: r.warnings })
    } catch (e) { return storeFail(res, e) }
  }

  function lookup(res, id) {
    let rec
    try { rec = store().get(id) } catch (e) { storeFail(res, e); return null }
    if (!rec) { fail(res, 404, 'BUILD_NOT_FOUND', `no build "${String(id).slice(0, 64)}"`); return null }
    return rec
  }

  async function edit(req, res, id) {
    const b = await readJson(req)
    if (b.bad) return fail(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    const bad = Object.keys(b.value).filter((k) => !['label', 'notes', 'tags', 'pinned'].includes(k))
    if (bad.length) return fail(res, 400, 'BAD_FIELD', `unknown field: ${bad.map((k) => k.slice(0, 32)).join(', ')}`)
    const rec = lookup(res, id)
    if (!rec) return true
    try { return send(res, 200, view(await store().edit(rec.id, b.value))) } catch (e) { return storeFail(res, e) }
  }

  async function remove(req, res, id) {
    const b = await readJson(req)
    if (b.bad) return fail(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    const rec = lookup(res, id)
    if (!rec) return true
    if (active && active.buildId === rec.id) return fail(res, 409, 'BUILD_BUSY', 'the build is being installed', { jobId: active.jobId })
    try {
      const r = await store().remove(rec.id, { force: b.value.force === true })
      return send(res, 200, { ok: true, removed: !!r.removed, id: rec.id })
    } catch (e) { return storeFail(res, e) }
  }

  function download(res, id) {
    const rec = lookup(res, id)
    if (!rec) return true
    let buf
    try { buf = store().blob(rec.id) } catch (e) { return storeFail(res, e) }
    const name = String(rec.filename || `${rec.id}.zip`).replace(/[^\w.\- ]/g, '_') || `${rec.id}.zip`
    res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(String(rec.filename || name))}`,
    })
    res.end(buf)
    return true
  }

  async function install(req, res, id, ctx) {
    const b = await readJson(req)
    if (b.bad) return fail(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    if (d.sim()) return fail(res, 409, 'SIMULATOR_TARGET', 'install needs a device; Studio targets the simulator')
    if (!d.hasTarget()) return fail(res, 400, 'NO_DEVICE', 'no device connected')
    const rec = lookup(res, id)
    if (!rec) return true
    let zipData
    let info
    let facts = null
    try {
      zipData = store().blob(rec.id)
      info = await require('../builds/inspect').inspectPackage(zipData)
    } catch (e) { return storeFail(res, e.code ? e : Object.assign(e, { code: 'BUILD_BLOB_CORRUPT' })) }
    try { facts = await collectFacts({ zipData, cwd: rootDir }) } catch { /* the installed record is best-effort */ }
    // From here to the reservation there is no await: two requests cannot both pass.
    const run = d.activeRun()
    if (run) return fail(res, 409, 'RUN_IN_PROGRESS', 'a run is in progress', { runId: run.id })
    if (active) return fail(res, 409, 'INSTALL_IN_PROGRESS', 'an install is already in progress', { jobId: active.jobId })
    const tc = tokenCheck(info)
    if (TOKEN_ENUM_BLOCKING.has(tc) && b.value.allowTokenMismatch !== true) {
      return fail(res, 409, 'TOKEN_MISMATCH', 'this build was made with a different hub token (or Studio has none); install anyway with allowTokenMismatch', { tokenCheck: tc })
    }
    const job = { jobId: crypto.randomBytes(8).toString('hex'), buildId: rec.id, tokenCheck: tc, events: [], subs: new Set(), done: false, result: null, ac: new AbortController(), uploadStarted: false, startedAt: new Date().toISOString() }
    active = job
    try {
      if (!(await ctx.gate(true))) { active = null; return true } // 423 already sent
    } catch (e) { active = null; throw e }
    const host = d.host()
    if (!host) { active = null; return fail(res, 400, 'NO_DEVICE', 'no device connected') }
    jobs.set(job.jobId, job)
    send(res, 202, { jobId: job.jobId, tokenCheck: tc })
    runJob(job, { zipData, facts, host }).catch(() => finish(job, { ok: false, code: 'INSTALL_FAILED', step: 'install', message: 'install job failed', active: false, buildId: job.buildId, tokenCheck: tc }))
    return true
  }

  function stream(req, res, jobId) {
    const job = jobs.get(jobId)
    if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'no such install job (jobs are kept for 10 minutes)')
    if (streams >= STREAMS_MAX) return fail(res, 429, 'BUSY', 'too many open streams')
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    for (const ev of job.events) res.write(frame(ev)) // replay what the page missed
    if (job.done) { res.end(); return true }
    streams++
    job.subs.add(res)
    res.on('close', () => { if (job.subs.delete(res)) streams-- ; else if (!res.writableEnded) streams-- })
    return true
  }

  function cancel(res, jobId) {
    const job = jobs.get(jobId)
    if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'no such install job')
    if (job.done) return fail(res, 409, 'NOT_RUNNING', 'the install already finished')
    job.ac.abort('cancelled by user')
    return send(res, 200, { cancelling: true })
  }

  // What is on the device now: installed.json (lease dir), then the project store, then /query/apps.
  async function current(res, ctx) {
    if (d.sim()) return fail(res, 409, 'SIMULATOR_TARGET', 'there is no device channel on the simulator')
    if (!d.hasTarget()) return fail(res, 400, 'NO_DEVICE', 'no device connected')
    if (!(await ctx.gate(false))) return true
    const host = d.host()
    const dev = d.device()
    if (!host || !dev) return fail(res, 400, 'NO_DEVICE', 'no device connected')
    const out = { host, device: null, devApp: null, active: null, build: null, match: 'none', source: null }
    try { const i = await dev.deviceInfo(); out.device = { model: i.model || null, name: i.name || null } } catch { /* unreachable */ }
    try {
      const r = await dev.ecpGet('/query/apps')
      const app = r.status === 200 ? parseApps(r.text).find((a) => a.id === 'dev') : null
      if (app) out.devApp = { title: app.name, version: app.version }
    } catch { /* unreachable: no dev app known */ }
    try { const a = await dev.activeApp(); out.active = { id: a.id, name: a.name, home: !!a.home } } catch { /* unknown */ }

    // 1. the lease-dir record
    let manifest = null
    try {
      const inst = require('../device-installed')
      const keys = (sl.lease && (sl.lease.keys && sl.lease.keys.length ? sl.lease.keys : sl.lease.key ? [sl.lease.key] : [])) || []
      const ks = keys.length ? keys : inst.keysForHost(host, require('../devices').resolveEcpPort(null), env)
      const e = inst.readInstalled({ dir: d.leaseDir, keys: ks, env })
      if (e) {
        out.source = 'installed'
        out.installed = { at: e.at, via: e.via, text: inst.describeInstalled(e) }
        manifest = e.manifest || {}
        const hit = store().list().builds.find((b) => b.sha256 === e.sha256)
        if (hit) out.build = { id: hit.id, label: hit.label }
      }
    } catch { /* fall through */ }
    // 2. the store's newest successful install on this host
    if (!out.source) {
      try {
        const hit = require('../instrument/sideload').lastBuildForHost(store(), host)
        if (hit) { out.source = 'store'; out.build = { id: hit.id, label: hit.label }; manifest = hit.manifest || {} }
      } catch { /* none */ }
    }
    // 3. match against what the device reports
    if (!out.devApp) out.match = 'none'
    else if (!manifest) out.match = 'unknown'
    else if (!out.devApp.version) out.match = 'probable'
    else out.match = out.devApp.title === manifest.title && out.devApp.version === manifest.version ? 'confirmed' : 'unknown'
    if (out.match === 'unknown') out.build = null
    return send(res, 200, out)
  }

  async function handle(p, req, res, url, ctx) {
    if (p !== '/api/builds' && !p.startsWith('/api/builds/')) return false
    const rest = p.slice('/api/builds'.length).replace(/^\//, '')
    const parts = rest ? rest.split('/') : []
    const m = req.method
    const not = (allowed) => fail(res, 405, 'METHOD_NOT_ALLOWED', `use ${allowed}`)
    try {
      if (!parts.length) return m === 'GET' ? list(res) : m === 'POST' ? await upload(req, res, url) : not('GET or POST')
      if (parts[0] === 'current' && parts.length === 1) return m === 'GET' ? await current(res, ctx) : not('GET')
      if (parts[0] === 'jobs') {
        if (parts.length === 2) return m === 'GET' ? stream(req, res, parts[1]) : not('GET')
        if (parts.length === 3 && parts[2] === 'cancel') return m === 'POST' ? cancel(res, parts[1]) : not('POST')
        return fail(res, 404, 'NOT_FOUND', 'unknown route')
      }
      const id = decodeURIComponent(parts[0])
      if (parts.length === 1) {
        if (m === 'GET') { const r = lookup(res, id); return r ? send(res, 200, view(r)) : true }
        if (m === 'PATCH') return await edit(req, res, id)
        if (m === 'DELETE') return await remove(req, res, id)
        return not('GET, PATCH or DELETE')
      }
      if (parts.length === 2 && parts[1] === 'download') return m === 'GET' ? download(res, id) : not('GET')
      if (parts.length === 2 && parts[1] === 'install') return m === 'POST' ? await install(req, res, id, ctx) : not('POST')
      return fail(res, 404, 'NOT_FOUND', 'unknown route')
    } catch (e) {
      if (res.headersSent) { try { res.end() } catch { /* closed */ } return true }
      return storeFail(res, e && e.code ? e : Object.assign(new Error('builds route failed'), { code: 'INTERNAL' }))
    }
  }

  function close() {
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const j of jobs.values()) { try { j.ac.abort('studio stopped') } catch { /* done */ } for (const r of j.subs) { try { r.end() } catch { /* closed */ } } }
  }

  return { handle, active: () => active, close }
}

module.exports = { create }
