'use strict'
// Installed-build record per device (LMA-T7, ADR 0057): `<leaseDir>/<key>/installed.json` plus an `installed` event in
// that key's events.log, written by the process that just installed a package (it already holds the lease: nothing
// here takes it, and nothing here runs spawnSync).
//
//   collectFacts({ zipData, cwd, deps }) -> Promise<{ sha256, size, manifest, git }>   (async, call BEFORE acquiring)
//   buildEntry({ facts, agent, via, identical, now }) -> entry
//   recordInstall({ dir, keys, entry, env, fs }) -> { ok, written, error? }              never throws
//   readInstalled({ dir, keys, fs }) -> entry | null                                      newest across keys
//   describeInstalled(entry, now) -> one line ("unknown" when there is no record)
//
// The record holds only: schema, at, sha256, size, manifest title/version, via, identical and by{agent, worktree, branch,
// commit, dirty}. Never the device password, the hub token, any hash of either, or the lease id.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const SCHEMA = 'brighttest-installed/v1'
const FILE = 'installed.json'
const VIAS = new Set(['cli', 'studio', 'mcp'])
const GIT_TIMEOUT_MS = 2000
const MAX_STR = 300

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const str = (v) => (typeof v === 'string' && v ? v.slice(0, MAX_STR) : null)

function git(args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }, (err, out) => resolve(err ? null : String(out || '').trim()))
    } catch { resolve(null) }
  })
}

// Git facts of the cwd (2 s timeouts, any failure gives null). Async: never blocks while a lease is held.
async function gitFacts(cwd) {
  const [worktree, branch, commit, porcelain] = await Promise.all([
    git(['rev-parse', '--show-toplevel'], cwd), git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['rev-parse', '--short', 'HEAD'], cwd), git(['status', '--porcelain'], cwd),
  ])
  return { worktree: worktree || null, branch: branch || null, commit: commit || null, dirty: porcelain == null ? null : porcelain.length > 0 }
}

// sha256 and size of the bytes; manifest title/version read in memory (fail-soft: null fields on any problem).
async function packageFacts(zipData) {
  const out = { sha256: sha256Hex(zipData), size: zipData.length, manifest: { title: null, version: null } }
  try {
    const m = (await require('./builds/inspect').inspectPackage(zipData)).manifest
    out.manifest = { title: str(m.title), version: str(m.version) }
  } catch { /* not a readable package: keep the hash */ }
  return out
}

async function collectFacts({ zipData, cwd } = {}) {
  const pkg = Buffer.isBuffer(zipData) ? await packageFacts(zipData) : { sha256: null, size: null, manifest: { title: null, version: null } }
  let g = { worktree: null, branch: null, commit: null, dirty: null }
  try { g = await gitFacts(cwd || process.cwd()) } catch { /* null git facts */ }
  return { ...pkg, git: g }
}

function buildEntry({ facts, agent, via, identical, now } = {}) {
  const f = facts || {}
  const g = f.git || {}
  const m = f.manifest || {}
  return {
    schema: SCHEMA,
    at: new Date(now != null ? now : Date.now()).toISOString(),
    sha256: typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : null,
    size: Number.isFinite(f.size) ? f.size : null,
    manifest: { title: str(m.title), version: str(m.version) },
    via: VIAS.has(via) ? via : 'cli',
    identical: !!identical,
    by: { agent: str(agent), worktree: str(g.worktree), branch: str(g.branch), commit: str(g.commit), dirty: typeof g.dirty === 'boolean' ? g.dirty : null },
  }
}

function recordInstall({ dir, keys, entry, env = process.env, fs: io = fs } = {}) {
  const lease = require('./device-lease')
  const written = []
  try {
    if (!entry || !Array.isArray(keys) || !keys.length) return { ok: true, written }
    const root = path.resolve(dir || lease.defaultDir(env))
    const store = lease.createStore({ dir: root, env, fs: io })
    let firstErr = null
    for (const key of keys) {
      try {
        const kd = path.join(root, key)
        io.mkdirSync(kd, { recursive: true, mode: 0o700 })
        const target = path.join(kd, FILE)
        const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
        try {
          io.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 })
          io.renameSync(tmp, target)
        } catch (e) { try { io.unlinkSync(tmp) } catch { /* gone */ } throw e }
        store.logEvent(key, { ev: 'installed', ...entry })
        written.push(key)
      } catch (e) { firstErr = firstErr || e }
    }
    return firstErr ? { ok: false, written, error: String(firstErr.message || firstErr) } : { ok: true, written }
  } catch (e) { return { ok: false, written, error: String(e && e.message || e) } }
}

function parseEntry(text) {
  try {
    const e = JSON.parse(text)
    if (!e || typeof e !== 'object' || e.schema !== SCHEMA) return null
    return e
  } catch { return null }
}

function readInstalled({ dir, keys, fs: io = fs, env = process.env } = {}) {
  let best = null
  try {
    const root = path.resolve(dir || require('./device-lease').defaultDir(env))
    for (const key of keys || []) {
      let text
      try { text = io.readFileSync(path.join(root, key, FILE), 'utf8') } catch { continue }
      const e = parseEntry(text)
      if (e && (!best || String(e.at) > String(best.at))) best = e
    }
  } catch { /* no record */ }
  return best
}

const clean = (v, n = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').slice(0, n)

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function describeInstalled(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return 'unknown'
  const m = entry.manifest || {}
  const by = entry.by || {}
  const name = [clean(m.title), clean(m.version)].filter(Boolean).join(' ') || 'unnamed package'
  const sha = typeof entry.sha256 === 'string' ? clean(entry.sha256, 8) : ''
  const wt = [by.worktree ? path.basename(clean(by.worktree, 200)) : '', by.commit ? '@' + clean(by.commit, 12) : ''].filter(Boolean).join(' ')
  const where = [wt, by.dirty ? 'dirty' : ''].filter(Boolean).join(', ')
  const bits = [name]
  if (sha) bits.push(`sha ${sha}`)
  if (by.agent) bits.push(`by ${clean(by.agent, 40)}${where ? ` (${where})` : ''}`)
  const t = Date.parse(entry.at)
  if (Number.isFinite(t)) bits.push(ago(now - t))
  return bits.join(' · ')
}

// The keys a host can be recorded under, no network: remembered identity key and the address key.
function keysForHost(host, port, env = process.env) {
  const lease = require('./device-lease')
  const keys = []
  try {
    const k = require('./device-identity').recalledKey(lease.defaultDir(env), host, port)
    if (k) keys.push(k)
  } catch { /* none */ }
  try { keys.push(lease.keyFromAddress(lease.stripHostPasswords(String(host)).trim(), port)) } catch { /* none */ }
  return keys
}

module.exports = { SCHEMA, FILE, collectFacts, buildEntry, recordInstall, readInstalled, describeInstalled, keysForHost, sha256Hex }
