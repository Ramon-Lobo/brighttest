'use strict'
// Build store (ADR 0052): packages copied to blobs/<sha256>.zip, one record per build in records/<id>.json, a short
// store lock for writers, readers lock-free (every file is published by rename).
//
// openStore({ cfg, rootDir, env, home, lockWaitMs }) -> store
//   rootDir: the project root when a brighttest.json was found, else falsy (user store). `cfg.builds` carries the
//   caps (BUILDS_DEFAULTS fill gaps). Reads are synchronous; writes (add, recordInstall, edit, remove, prune) are async
//   because they wait for the lock.
//   store: { scope, dir, list(), get(idOrPrefix), blob(id), add(buf, opts), recordInstall(id, result), edit(id, patch),
//            remove(id, { force }), prune({ dryRun, protect }) }
// Errors carry `.code`: BUILD_TOO_LARGE, BUILD_INVALID_ZIP, BUILD_UNSAFE_ZIP, BUILD_NO_MANIFEST, BUILD_AMBIGUOUS,
// BUILD_PINNED, BUILD_INVALID_FIELD, BUILD_BLOB_MISSING, BUILD_BLOB_CORRUPT, STORE_LOCKED, STORE_WRITE_FAILED.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { inspectPackage, sha256Hex } = require('./inspect')

const MB = 1024 * 1024
const HOUR = 3600 * 1000
const LOCK_STALE_MS = 60 * 1000
const DEFAULTS = Object.freeze({ dir: null, record: true, maxCount: 30, maxTotalMB: 1024, maxZipMB: 64 })
const ID_RE = /^b[0-9a-f]{12}$/
const SHA_RE = /^[0-9a-f]{64}$/
const TAG_RE = /^[a-z0-9._-]{1,32}$/
const SOURCE_KINDS = ['build', 'upload', 'cli-add']
const INSTALL_VIAS = ['studio', 'cli', 'build']
const SOURCES_MAX = 20
const INSTALLS_MAX = 20

const fail = (code, msg, extra) => Object.assign(new Error(msg), { code }, extra)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idOf = (sha) => 'b' + sha.slice(0, 12)
const iso = (d) => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z')

// Disk errors become STORE_WRITE_FAILED with the errno and no path.
function writeFailed(e) {
  return fail('STORE_WRITE_FAILED', `could not write the build store (${e.code || 'error'})`, { errno: e.code || null })
}

function sanitizeFilename(name) {
  let b = String(name == null ? '' : name).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (b.length > 255) b = b.slice(0, 255)
  return b || 'package.zip'
}
const baseOrNull = (s) => (s == null || s === '' ? null : sanitizeFilename(s))

function resolveLocation({ cfg, rootDir, env, home }) {
  const b = (cfg && cfg.builds) || {}
  const fromEnv = env && env.BRIGHTTEST_BUILDS_DIR
  if (fromEnv) {
    if (!path.isAbsolute(fromEnv)) throw fail('BUILD_INVALID_FIELD', 'BRIGHTTEST_BUILDS_DIR must be an absolute path')
    return { scope: 'custom', dir: fromEnv }
  }
  if (b.dir) return { scope: 'custom', dir: path.resolve(rootDir || process.cwd(), b.dir) }
  if (rootDir) return { scope: 'project', dir: path.join(rootDir, '.brighttest', 'builds') }
  return { scope: 'user', dir: path.join(home || os.homedir(), '.brighttest', 'builds') }
}

function validRecord(r, file) {
  return !!r && typeof r === 'object' && r.v === 1 && ID_RE.test(r.id) && file === r.id + '.json' && SHA_RE.test(r.sha256) &&
    idOf(r.sha256) === r.id && Number.isFinite(r.size) && typeof r.filename === 'string' && typeof r.label === 'string' &&
    typeof r.pinned === 'boolean' && Array.isArray(r.sources) && Array.isArray(r.installs) && Array.isArray(r.tags) &&
    typeof r.lastUsedAt === 'string' && typeof r.createdAt === 'string'
}

function openStore(opts) {
  const { cfg, env = process.env, now = () => Date.now() } = opts || {}
  const caps = Object.assign({}, DEFAULTS, (cfg && cfg.builds) || {})
  const loc = resolveLocation({ cfg, rootDir: opts && opts.rootDir, env, home: opts && opts.home })
  const dir = loc.dir
  const P = {
    blobs: path.join(dir, 'blobs'), records: path.join(dir, 'records'), tmp: path.join(dir, 'tmp'),
    quarantine: path.join(dir, 'quarantine'), lock: path.join(dir, '.lock'),
  }
  const lockWaitMs = opts && opts.lockWaitMs != null ? opts.lockWaitMs : 5000
  const corrupt = new Set() // ids whose blob failed a hash check this session
  const blobPath = (sha) => path.join(P.blobs, sha + '.zip')
  const recordPath = (id) => path.join(P.records, id + '.json')

  function ensureDirs() {
    try {
      for (const d of [dir, P.blobs, P.records, P.tmp, P.quarantine]) {
        fs.mkdirSync(d, { recursive: true, mode: 0o700 })
        fs.chmodSync(d, 0o700)
      }
    } catch (e) { throw writeFailed(e) }
  }

  // tmp + rename, mode 0600; the temp file is removed on failure.
  function atomicWrite(dest, data) {
    ensureDirs()
    const t = path.join(P.tmp, `${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(t, data, { mode: 0o600 })
      fs.renameSync(t, dest)
    } catch (e) {
      try { fs.unlinkSync(t) } catch (_) { /* gone */ }
      throw writeFailed(e)
    }
  }

  function readRecordFile(file) {
    const full = path.join(P.records, file)
    let r
    try { r = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (e) { r = null }
    return validRecord(r, file) ? r : null
  }

  function quarantine(file) {
    try {
      fs.mkdirSync(P.quarantine, { recursive: true, mode: 0o700 })
      fs.renameSync(path.join(P.records, file), path.join(P.quarantine, `${file}.${now()}`))
    } catch (_) { /* another process moved it */ }
  }

  function blobState(r) {
    if (corrupt.has(r.id)) return 'corrupt'
    return fs.existsSync(blobPath(r.sha256)) ? 'ok' : 'missing'
  }

  function list() {
    const builds = []
    const warnings = []
    let files = []
    try { files = fs.readdirSync(P.records).filter((f) => f.endsWith('.json')) } catch (e) { /* no store yet */ }
    for (const f of files) {
      const r = readRecordFile(f)
      if (!r) {
        if (fs.existsSync(path.join(P.records, f))) { quarantine(f); warnings.push(`unreadable record ${f} moved to quarantine`) }
        continue
      }
      builds.push(Object.assign({}, r, { blob: blobState(r) }))
    }
    builds.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : a.id < b.id ? -1 : 1))
    return { builds, warnings }
  }

  // Exact id, or a unique prefix of 4+ characters of the id or the sha256. null when nothing matches.
  function get(q) {
    q = String(q == null ? '' : q).toLowerCase()
    if (q.length < 4) return null
    const { builds } = list()
    const hits = builds.filter((r) => r.id === q || r.id.startsWith(q) || r.sha256.startsWith(q))
    const exact = hits.find((r) => r.id === q)
    if (exact) return exact
    if (hits.length > 1) throw fail('BUILD_AMBIGUOUS', `"${q}" matches ${hits.length} builds`, { ids: hits.map((r) => r.id) })
    return hits[0] || null
  }

  function blob(id) {
    const r = get(id)
    if (!r) throw fail('BUILD_NOT_FOUND', `no build "${id}"`)
    let buf
    try { buf = fs.readFileSync(blobPath(r.sha256)) } catch (e) { throw fail('BUILD_BLOB_MISSING', 'the package file is missing from the store') }
    if (sha256Hex(buf) !== r.sha256) {
      corrupt.add(r.id)
      throw fail('BUILD_BLOB_CORRUPT', 'the stored package does not match its hash')
    }
    return buf
  }

  // --- lock ---
  function lockIsStale(content) {
    let info = null
    try { info = JSON.parse(content) } catch (_) { /* unparsable: judge by mtime below */ }
    if (!info || typeof info.at !== 'string') {
      try { return now() - fs.statSync(P.lock).mtimeMs > LOCK_STALE_MS } catch (_) { return true }
    }
    if (now() - Date.parse(info.at) > LOCK_STALE_MS) return true
    if (info.hostname === os.hostname() && Number.isInteger(info.pid)) {
      try { process.kill(info.pid, 0) } catch (e) { if (e.code === 'ESRCH') return true }
    }
    return false
  }

  // Moves a stale lock aside (rename is atomic: one breaker wins). If what was moved is not what was judged stale,
  // a live lock was taken in between: put it back.
  function breakStale(content) {
    const aside = `${P.lock}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
    try { fs.renameSync(P.lock, aside) } catch (_) { return }
    let moved = null
    try { moved = fs.readFileSync(aside, 'utf8') } catch (_) { /* ignore */ }
    if (moved !== content) { try { fs.linkSync(aside, P.lock) } catch (_) { /* someone else holds it now */ } }
    try { fs.unlinkSync(aside) } catch (_) { /* ignore */ }
  }

  async function withLock(fn) {
    ensureDirs()
    const deadline = Date.now() + lockWaitMs
    let fd
    for (;;) {
      try {
        fd = fs.openSync(P.lock, 'wx', 0o600)
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: iso(now()) }))
        break
      } catch (e) {
        if (fd != null) { try { fs.closeSync(fd) } catch (_) { /* ignore */ } try { fs.unlinkSync(P.lock) } catch (_) { /* ignore */ } throw writeFailed(e) }
        if (e.code !== 'EEXIST') throw writeFailed(e)
        let content = null
        try { content = fs.readFileSync(P.lock, 'utf8') } catch (_) { /* released meanwhile */ }
        if (content != null && lockIsStale(content)) { breakStale(content); continue }
        if (Date.now() >= deadline) throw fail('STORE_LOCKED', 'the store is busy; try again')
        await sleep(50)
      }
    }
    try { fs.closeSync(fd) } catch (_) { /* ignore */ }
    try { return await fn() } finally { try { fs.unlinkSync(P.lock) } catch (_) { /* ignore */ } }
  }

  const writeRecord = (r) => atomicWrite(recordPath(r.id), JSON.stringify(r, null, 2) + '\n')
  const readRecord = (id) => readRecordFile(id + '.json')

  function removeFiles(r) {
    try { fs.unlinkSync(recordPath(r.id)) } catch (_) { /* gone */ }
    try { fs.unlinkSync(blobPath(r.sha256)) } catch (_) { /* gone */ }
    corrupt.delete(r.id)
  }

  // Prune under an already held lock. Never removes pinned builds or ids in `protect`.
  function pruneLocked({ dryRun, protect = [] } = {}) {
    const all = list().builds
    const removed = []
    const warnings = []
    const unpinned = all.filter((r) => !r.pinned).sort((a, b) =>
      a.lastUsedAt < b.lastUsedAt ? -1 : a.lastUsedAt > b.lastUsedAt ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
    let count = unpinned.length
    let total = all.reduce((n, r) => n + r.size, 0)
    const maxBytes = caps.maxTotalMB * MB
    for (const r of unpinned) {
      if (count <= caps.maxCount && total <= maxBytes) break
      if (protect.includes(r.id)) continue
      removed.push(r.id)
      count--
      total -= r.size
      if (!dryRun) removeFiles(r)
    }
    const pinnedBytes = all.filter((r) => r.pinned).reduce((n, r) => n + r.size, 0)
    if (pinnedBytes > maxBytes) warnings.push(`pinned builds use ${Math.round(pinnedBytes / MB)} MB, over the ${caps.maxTotalMB} MB cap`)

    // sweep: orphan blobs and stale temp files older than 1 h (younger orphans may be a writer between blob and record)
    const swept = []
    const known = new Set(all.filter((r) => !removed.includes(r.id) || dryRun).map((r) => r.sha256 + '.zip'))
    const sweepDir = (d, keep) => {
      let names = []
      try { names = fs.readdirSync(d) } catch (_) { return }
      for (const n of names) {
        if (keep && keep(n)) continue
        try {
          if (now() - fs.statSync(path.join(d, n)).mtimeMs <= HOUR) continue
          swept.push(n)
          if (!dryRun) fs.unlinkSync(path.join(d, n))
        } catch (_) { /* raced */ }
      }
    }
    sweepDir(P.blobs, (n) => known.has(n))
    sweepDir(P.tmp)
    return { removed, swept, warnings }
  }

  async function prune(o) {
    return withLock(async () => pruneLocked(o || {}))
  }

  function cleanSource(s, at) {
    const kind = SOURCE_KINDS.includes(s && s.kind) ? s.kind : 'cli-add'
    const out = { kind, at }
    if (kind === 'build') {
      out.net = !!s.net
      out.strict = !!s.strict
      out.from = baseOrNull(s.from)
      if (typeof s.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(s.fingerprint)) out.fingerprint = s.fingerprint // source fingerprint (instrument build --reuse)
    }
    return out
  }

  async function add(buf, o = {}) {
    if (!Buffer.isBuffer(buf)) throw fail('BUILD_INVALID_ZIP', 'input is not a buffer')
    if (buf.length > caps.maxZipMB * MB) throw fail('BUILD_TOO_LARGE', `over the ${caps.maxZipMB} MB limit (builds.maxZipMB)`)
    const info = await inspectPackage(buf) // throws before anything is written
    const id = idOf(info.sha256)
    const filename = sanitizeFilename(o.filename)
    const at = iso(now())

    // the blob is written before the lock: content-addressed, so concurrent writers produce the same file
    const ensureBlob = () => {
      let ok = false
      try { ok = fs.statSync(blobPath(info.sha256)).size === buf.length } catch (_) { /* absent */ }
      if (!ok) atomicWrite(blobPath(info.sha256), buf)
    }
    ensureBlob()

    return withLock(async () => {
      ensureBlob() // a concurrent prune or remove may have taken the blob since
      const source = cleanSource(o.source, at)
      let r = readRecord(id)
      let created = false
      if (r) {
        r.sources = r.sources.concat(source).slice(-SOURCES_MAX)
        r.lastUsedAt = at
        corrupt.delete(id)
      } else {
        created = true
        const m = info.manifest
        const g = o.git
        r = {
          v: 1, id, sha256: info.sha256, size: info.size, filename,
          label: m.title ? `${m.title}${m.version ? ' ' + m.version : ''}` : filename,
          notes: '', tags: [], pinned: false,
          project: loc.scope === 'user' ? baseOrNull(o.project) : null,
          createdAt: at, lastUsedAt: at, sources: [source],
          kind: info.kind, markerCount: info.markerCount, markerKinds: info.markerKinds, manifest: m,
          git: g && typeof g === 'object' ? { sha: g.sha == null ? null : String(g.sha).slice(0, 40), branch: baseOrNull(g.branch), dirty: !!g.dirty } : null,
          installs: [], installCount: 0, failCount: 0, lastInstall: null,
        }
      }
      writeRecord(r)
      const pr = pruneLocked({ protect: [id].concat(o.protect || []) })
      return { record: Object.assign({}, r, { blob: 'ok' }), created, deduped: !created, warnings: pr.warnings, pruned: pr.removed }
    })
  }

  const cleanStr = (v, max) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max))

  async function recordInstall(idOrPrefix, result = {}) {
    const found = get(idOrPrefix)
    if (!found) return null // the build was removed meanwhile: the result is dropped
    return withLock(async () => {
      const r = readRecord(found.id)
      if (!r) return null
      const at = typeof result.at === 'string' ? result.at : iso(now())
      const e = result.error && typeof result.error === 'object' ? result.error : null
      const inst = {
        at, via: INSTALL_VIAS.includes(result.via) ? result.via : 'cli',
        host: cleanStr(result.host, 255), device: cleanStr(result.device, 255), model: cleanStr(result.model, 64),
        ok: !!result.ok, durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null, active: !!result.active,
      }
      if (e) inst.error = { step: cleanStr(e.step, 64), code: cleanStr(e.code, 64), cause: cleanStr(e.cause, 128), message: cleanStr(e.message, 512) }
      r.installs = r.installs.concat(inst).slice(-INSTALLS_MAX)
      r.installCount = (r.installCount || 0) + 1
      if (!inst.ok) r.failCount = (r.failCount || 0) + 1
      r.lastInstall = { at, host: inst.host, ok: inst.ok }
      r.lastUsedAt = r.lastUsedAt > at ? r.lastUsedAt : at
      writeRecord(r)
      return Object.assign({}, r, { blob: blobState(r) })
    })
  }

  async function edit(idOrPrefix, patch = {}) {
    const found = get(idOrPrefix)
    if (!found) throw fail('BUILD_NOT_FOUND', `no build "${idOrPrefix}"`)
    const next = {}
    if ('label' in patch) {
      if (typeof patch.label !== 'string' || !patch.label.trim() || patch.label.length > 200) throw fail('BUILD_INVALID_FIELD', 'label must be 1 to 200 characters')
      next.label = patch.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    }
    if ('notes' in patch) {
      if (typeof patch.notes !== 'string' || Buffer.byteLength(patch.notes) > 4096) throw fail('BUILD_INVALID_FIELD', 'notes must be at most 4 KB')
      next.notes = patch.notes
    }
    if ('tags' in patch) {
      if (!Array.isArray(patch.tags) || patch.tags.length > 16 || !patch.tags.every((t) => typeof t === 'string' && TAG_RE.test(t))) {
        throw fail('BUILD_INVALID_FIELD', 'tags: up to 16 of [a-z0-9._-]{1,32}')
      }
      next.tags = [...new Set(patch.tags)]
    }
    if ('pinned' in patch) {
      if (typeof patch.pinned !== 'boolean') throw fail('BUILD_INVALID_FIELD', 'pinned must be a boolean')
      next.pinned = patch.pinned
    }
    return withLock(async () => {
      const r = readRecord(found.id)
      if (!r) throw fail('BUILD_NOT_FOUND', `no build "${idOrPrefix}"`)
      Object.assign(r, next)
      writeRecord(r)
      return Object.assign({}, r, { blob: blobState(r) })
    })
  }

  async function remove(idOrPrefix, o = {}) {
    const found = get(idOrPrefix)
    if (!found) throw fail('BUILD_NOT_FOUND', `no build "${idOrPrefix}"`)
    return withLock(async () => {
      const r = readRecord(found.id)
      if (!r) return { removed: false }
      if (r.pinned && !o.force) throw fail('BUILD_PINNED', 'the build is pinned; unpin it or use force')
      removeFiles(r)
      return { removed: true, id: r.id }
    })
  }

  return { scope: loc.scope, dir, caps, list, get, blob, add, recordInstall, edit, remove, prune }
}

module.exports = { openStore, sha256Hex, DEFAULTS }
