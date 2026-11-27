'use strict'
// Keeps the hub token an instrumented build baked in, per package (sha256 of the zip bytes), so a lost shell does not
// force a rebuild. Files live under <rootDir>/.brighttest/hub-tokens/, mode 0600, written tmp + rename. A file holds
// only the token, the package sha256 and a timestamp. Nothing here ever logs or returns a token to a printer.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TOKEN_RE = /^[0-9a-f]{32}$/
const SHA_RE = /^[0-9a-f]{64}$/
const PENDING = 'pending'
const LATEST = 'latest'

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sha256File = (file) => sha256Hex(fs.readFileSync(file))

function storeDir(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new Error('hub token store: rootDir must be an absolute path')
  return path.join(path.resolve(rootDir), '.brighttest', 'hub-tokens')
}

// Every file path is built here from a validated name, and must stay inside the store directory.
function entryPath(rootDir, name) {
  if (name !== PENDING && name !== LATEST && !SHA_RE.test(name)) throw new Error('hub token store: the package hash must be 64 lowercase hex characters')
  const dir = storeDir(rootDir)
  const file = path.join(dir, `${name}.json`)
  if (path.dirname(file) !== dir) throw new Error('hub token store: path outside the store directory refused')
  return file
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } finally { try { fs.rmSync(tmp, { force: true }) } catch { /* gone */ } }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// Store the token baked into the package with this sha256 and make it the latest. Returns the file path.
function storeToken(rootDir, sha256, token) {
  if (!TOKEN_RE.test(token || '')) throw new Error('hub token store: the token must be 32 lowercase hex characters')
  const file = entryPath(rootDir, sha256)
  writeAtomic(file, { sha256, token, createdAt: new Date().toISOString() })
  writeAtomic(entryPath(rootDir, LATEST), { sha256, updatedAt: new Date().toISOString() })
  return file
}

// { sha256, token, file } for the latest stored build, else for a pending (generated, not yet built) token, else null.
function readLatest(rootDir) {
  const ptr = readJson(entryPath(rootDir, LATEST))
  if (ptr && SHA_RE.test(ptr.sha256 || '')) {
    const file = entryPath(rootDir, ptr.sha256)
    const e = readJson(file)
    if (e && TOKEN_RE.test(e.token || '')) return { sha256: ptr.sha256, token: e.token, file }
  }
  const file = entryPath(rootDir, PENDING)
  const p = readJson(file)
  if (p && TOKEN_RE.test(p.token || '')) return { sha256: null, token: p.token, file }
  return null
}

// Reuse the stored token or generate and store one. Returns { created, sha256, file } and never the token.
function ensureToken(rootDir) {
  const found = readLatest(rootDir)
  if (found) return { created: false, sha256: found.sha256, file: found.file }
  const file = entryPath(rootDir, PENDING)
  writeAtomic(file, { sha256: null, token: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString() })
  return { created: true, sha256: null, file }
}

const shaPrefix = (sha256) => (sha256 ? sha256.slice(0, 12) : 'none yet')

// The text for a build-token versus hub-token mismatch. Names the package, never a token.
function mismatchMessage(sha256) {
  return `the token baked into package ${shaPrefix(sha256)} differs from the hub token (BRIGHTTEST_HUB_TOKEN). `
    + 'Run `brighttest net token --ensure`, export the token from the file it names, then rebuild with `brighttest instrument build --net`.'
}

// The package a run should name in that message: the latest stored build, or null.
function latestSha(rootDir) {
  try { const l = readLatest(rootDir); return l ? l.sha256 : null } catch { return null }
}

module.exports = { sha256Hex, sha256File, storeDir, entryPath, storeToken, readLatest, ensureToken, shaPrefix, mismatchMessage, latestSha, TOKEN_RE }
