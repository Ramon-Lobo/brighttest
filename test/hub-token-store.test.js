import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const store = require('../lib/instrument/hub-token-store')
const cli = path.resolve(__dirname, '../bin/cli.js')
const TOKEN = 'ab'.repeat(16)
const OTHER = 'cd'.repeat(16)
let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hts-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const sha = (s) => store.sha256Hex(Buffer.from(s))

describe('hub token store', () => {
  it('writes a 0600 file keyed by the package sha256 with only token, sha and timestamp', () => {
    const h = sha('zip-a')
    const file = store.storeToken(root, h, TOKEN)
    expect(file).toBe(path.join(root, '.brighttest', 'hub-tokens', `${h}.json`))
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(Object.keys(j).sort()).toEqual(['createdAt', 'sha256', 'token'])
    expect(j).toMatchObject({ sha256: h, token: TOKEN })
  })
  it('leaves no tmp file behind (tmp + rename)', () => {
    store.storeToken(root, sha('a'), TOKEN)
    expect(fs.readdirSync(path.join(root, '.brighttest', 'hub-tokens')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('readLatest follows the newest build', () => {
    store.storeToken(root, sha('a'), TOKEN)
    store.storeToken(root, sha('b'), OTHER)
    expect(store.readLatest(root)).toMatchObject({ sha256: sha('b'), token: OTHER })
  })
  it('ensure generates when empty, then reuses', () => {
    const a = store.ensureToken(root)
    expect(a.created).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(a.file).mode & 0o777).toBe(0o600)
    const b = store.ensureToken(root)
    expect(b).toMatchObject({ created: false, file: a.file })
    expect(store.readLatest(root).token).toMatch(/^[0-9a-f]{32}$/)
  })
  it('ensure reuses the token of the latest build', () => {
    store.storeToken(root, sha('a'), TOKEN)
    expect(store.ensureToken(root)).toMatchObject({ created: false, sha256: sha('a') })
  })
  it('refuses a bad hash, a relative root and a malformed token', () => {
    expect(() => store.storeToken(root, '../../evil', TOKEN)).toThrow(/64 lowercase hex/)
    expect(() => store.storeToken('relative/dir', sha('a'), TOKEN)).toThrow(/absolute/)
    expect(() => store.storeToken(root, sha('a'), 'nope')).toThrow(/32 lowercase hex/)
    expect(fs.existsSync(path.join(root, '.brighttest'))).toBe(false)
  })
  it('mismatch message names the 12 char sha prefix, how to fix it, and no token', () => {
    const h = sha('a')
    const m = store.mismatchMessage(h)
    expect(m).toContain(h.slice(0, 12))
    expect(m).not.toContain(h.slice(0, 13))
    expect(m).toContain('net token --ensure')
    expect(m).toContain('instrument build --net')
    expect(m).not.toContain(TOKEN)
  })
  it('latestSha is null with no store', () => { expect(store.latestSha(root)).toBe(null) })
})

describe('net token --ensure', () => {
  const run = (cwd, env) => spawnSync(process.execPath, [cli, 'net', 'token', '--ensure'], { cwd, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_HUB_TOKEN: '', ...env } })
  it('needs --ensure', () => {
    expect(spawnSync(process.execPath, [cli, 'net', 'token'], { cwd: root, encoding: 'utf8' }).status).toBe(2)
  })
  it('creates then reuses, never printing the token', () => {
    const a = run(root, {})
    expect(a.status).toBe(0)
    expect(a.stdout).toMatch(/^created hub token: \.brighttest[\\/]hub-tokens[\\/]pending\.json/)
    const tok = JSON.parse(fs.readFileSync(path.join(root, '.brighttest/hub-tokens/pending.json'), 'utf8')).token
    const b = run(root, {})
    expect(b.stdout).toMatch(/^reused hub token/)
    for (const r of [a, b]) { expect(r.stdout + r.stderr).not.toContain(tok) }
  })
  it('reuses the token of a stored build and shows its sha prefix', () => {
    const h = sha('zip')
    store.storeToken(root, h, TOKEN)
    const r = run(root, {})
    expect(r.stdout).toContain(`reused hub token`)
    expect(r.stdout).toContain(h.slice(0, 12))
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
  })
  it('does nothing when the variable is already set', () => {
    const r = run(root, { BRIGHTTEST_HUB_TOKEN: TOKEN })
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
    expect(fs.existsSync(path.join(root, '.brighttest'))).toBe(false)
  })
})
