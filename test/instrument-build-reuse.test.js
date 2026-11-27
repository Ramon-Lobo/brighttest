import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// LMA-T12: `instrument build --sideload --reuse` skips the rebuild when the source fingerprint, flags and hub token match
// the newest stored build. Real builds of a tiny generic app into a temp store; the installer is a fake.
const require = createRequire(import.meta.url)
const { build, sourceFingerprint, findReusable, tryReuse } = require('../lib/instrument/build')
const { loadConfig } = require('../lib/config')
const { openStore } = require('../lib/builds/store')

const TOKEN_A = 'a'.repeat(32)
const TOKEN_B = 'b'.repeat(32)
let tmp, n = 0
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-reuse-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function mkapp() {
  const id = ++n
  const dir = path.join(tmp, 'app' + id)
  const files = {
    manifest: 'title=sample\nmajor_version=1\nminor_version=0\nbuild_version=1\n',
    'source/main.brs': 'sub main()\n    print "hi"\nend sub\n',
    'brighttest.json': JSON.stringify({ instrument: { hub: { host: '192.0.2.9', port: 8790 } } }),
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  const cfg = { ...loadConfig(dir), rootDir: dir, stagingDir: path.join(tmp, 'stage' + id) }
  const store = openStore({ cfg, rootDir: dir, env: { BRIGHTTEST_BUILDS_DIR: path.join(tmp, 'store' + id) } })
  const out = path.join(tmp, 'out' + id + '.zip')
  return { dir, cfg, store, out, env: {} }
}
const doBuild = (a, extra = {}) => build(a.cfg, { out: a.out, log: () => {}, store: a.store, env: a.env, ...extra })
const reusable = (a, extra = {}) => findReusable(a.cfg, { out: a.out, store: a.store, env: a.env, ...extra })

describe('source fingerprint', () => {
  it('is stable across runs and ignores the output and staging directories', async () => {
    const a = mkapp()
    const f1 = sourceFingerprint(a.cfg, { out: a.out })
    expect(f1).toMatch(/^[0-9a-f]{64}$/)
    expect(sourceFingerprint(a.cfg, { out: a.out })).toBe(f1)
    fs.mkdirSync(a.cfg.stagingDir, { recursive: true })
    fs.writeFileSync(path.join(a.cfg.stagingDir, 'junk.txt'), 'x')
    fs.mkdirSync(path.join(a.dir, 'build-out'))
    const inside = path.join(a.dir, 'build-out', 'app.zip')
    const g1 = sourceFingerprint(a.cfg, { out: inside })
    fs.writeFileSync(inside, 'package bytes')
    expect(g1).toBe(f1)
    expect(sourceFingerprint(a.cfg, { out: inside })).toBe(f1)
  })

  it('changes with a source file, a flag or the config', () => {
    const a = mkapp()
    const f = sourceFingerprint(a.cfg)
    expect(sourceFingerprint(a.cfg, { net: true })).not.toBe(f)
    expect(sourceFingerprint(a.cfg, { strict: true })).not.toBe(f)
    expect(sourceFingerprint({ ...a.cfg, instrument: { ...a.cfg.instrument, exclude: ['x/**'] } })).not.toBe(f)
    fs.writeFileSync(path.join(a.dir, 'source/main.brs'), 'sub main()\n    print "changed"\nend sub\n')
    expect(sourceFingerprint(a.cfg)).not.toBe(f)
  })
})

describe('--reuse decision', () => {
  it('no stored build: nothing to reuse', () => {
    expect(reusable(mkapp())).toBeNull()
  })

  it('a match reuses the stored build', async () => {
    const a = mkapp()
    const r = await doBuild(a)
    expect(r.exitCode).toBe(0)
    expect(reusable(a)).toMatchObject({ id: r.record.id })
  })

  it('a changed source file rebuilds', async () => {
    const a = mkapp()
    await doBuild(a)
    fs.writeFileSync(path.join(a.dir, 'source/main.brs'), 'sub main()\n    print "edited"\nend sub\n')
    expect(reusable(a)).toBeNull()
  })

  it('a changed flag rebuilds', async () => {
    const a = mkapp()
    await doBuild(a)
    expect(reusable(a, { strict: true })).toBeNull()
    expect(reusable(a, { failOnBscErrors: true })).toBeNull()
    expect(reusable(a, { net: true, env: { BRIGHTTEST_HUB_TOKEN: TOKEN_A } })).toBeNull()
  })

  it('--net: same hub token reuses, a different token rebuilds', async () => {
    const a = mkapp()
    a.env = { BRIGHTTEST_HUB_TOKEN: TOKEN_A }
    const r = await doBuild(a, { net: true })
    expect(r.exitCode).toBe(0)
    expect(reusable(a, { net: true })).toMatchObject({ id: r.record.id })
    expect(reusable(a, { net: true, env: { BRIGHTTEST_HUB_TOKEN: TOKEN_B } })).toBeNull()
    expect(reusable(a, { net: true, env: {} })).toBeNull()
  })

  it('a missing blob rebuilds', async () => {
    const a = mkapp()
    const r = await doBuild(a)
    expect(r.exitCode).toBe(0)
    for (const f of fs.readdirSync(path.join(a.store.dir, 'blobs'))) fs.rmSync(path.join(a.store.dir, 'blobs', f))
    expect(reusable(a)).toBeNull()
  })
})

describe('tryReuse', () => {
  const target = { host: '192.0.2.5', password: 'sentinel-pw', as: 'dev#1' }

  it('match: installs the stored build by id, no rebuild', async () => {
    const a = mkapp()
    const r = await doBuild(a)
    const before = fs.statSync(a.out).mtimeMs
    const calls = []
    const lines = []
    const res = await tryReuse(a.cfg, { out: a.out, store: a.store, env: a.env, log: (l) => lines.push(l) }, target, { install: async (argv, d) => { calls.push({ argv, pw: d.resolvePassword(), implicit: d.tokenAllowImplicit }); return 0 } })
    expect(res).toEqual({ reused: true, exitCode: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].argv.slice(0, 4)).toEqual(['install', r.record.id, '--host', '192.0.2.5'])
    expect(calls[0].argv).toContain('--allow-token-mismatch')
    expect(calls[0].implicit).toBe(true)
    expect(fs.statSync(a.out).mtimeMs).toBe(before)
    expect(lines.join('\n')).toMatch(/no rebuild/)
    expect(JSON.stringify(calls[0].argv) + lines.join('')).not.toContain('sentinel-pw')
  })

  it('--net match does not allow a token mismatch', async () => {
    const a = mkapp()
    a.env = { BRIGHTTEST_HUB_TOKEN: TOKEN_A }
    await doBuild(a, { net: true })
    const calls = []
    const res = await tryReuse(a.cfg, { out: a.out, store: a.store, env: a.env, net: true, log: () => {} }, target, { install: async (argv) => { calls.push(argv); return 0 } })
    expect(res.reused).toBe(true)
    expect(calls[0]).not.toContain('--allow-token-mismatch')
  })

  it('changed source: no install, caller builds', async () => {
    const a = mkapp()
    await doBuild(a)
    fs.writeFileSync(path.join(a.dir, 'manifest'), 'title=sample\nmajor_version=2\nminor_version=0\nbuild_version=1\n')
    let called = false
    const res = await tryReuse(a.cfg, { out: a.out, store: a.store, env: a.env, log: () => {} }, target, { install: async () => { called = true; return 0 } })
    expect(res).toEqual({ reused: false })
    expect(called).toBe(false)
  })
})

describe('without --reuse', () => {
  it('a build still writes the package and records it (plus a fingerprint)', async () => {
    const a = mkapp()
    const r = await doBuild(a)
    expect(r.exitCode).toBe(0)
    expect(fs.existsSync(a.out)).toBe(true)
    expect(a.store.get(r.record.id).sources[0]).toMatchObject({ kind: 'build', net: false })
  })
})
