import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { openStore, sha256Hex } = require('../lib/builds/store')
const { loadConfig, BUILDS_DEFAULTS } = require('../lib/config')
const { makeZip, plainEntries, instrumentedEntries } = require('./support/zipgen')

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-store-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const zipN = (n, extra = []) => makeZip(plainEntries([{ name: 'source/n.brs', data: `' build ${n}\n` }, ...extra]))
const mk = (builds, extra = {}) => openStore({ cfg: { builds }, rootDir: null, home: tmp, env: { BRIGHTTEST_BUILDS_DIR: path.join(tmp, 's') }, ...extra })
const ago = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t) }

describe('location', () => {
  it('env var wins and must be absolute', () => {
    expect(mk({}).scope).toBe('custom')
    expect(() => openStore({ cfg: {}, env: { BRIGHTTEST_BUILDS_DIR: 'rel' } })).toThrow(/absolute/)
  })
  it('builds.dir is relative to the project root', () => {
    const s = openStore({ cfg: { builds: { dir: 'out/b' } }, rootDir: tmp, env: {} })
    expect(s).toMatchObject({ scope: 'custom', dir: path.join(tmp, 'out/b') })
  })
  it('project store when a project was found, else the user store', () => {
    expect(openStore({ cfg: {}, rootDir: tmp, env: {} })).toMatchObject({ scope: 'project', dir: path.join(tmp, '.brighttest', 'builds') })
    expect(openStore({ cfg: {}, rootDir: null, home: tmp, env: {} })).toMatchObject({ scope: 'user', dir: path.join(tmp, '.brighttest', 'builds') })
  })
  it('config defaults for the builds block', () => {
    expect(BUILDS_DEFAULTS).toEqual({ dir: null, record: true, maxCount: 30, maxTotalMB: 1024, maxZipMB: 64 })
    fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify({ builds: { maxCount: 5 } }))
    expect(loadConfig(tmp).builds).toEqual({ ...BUILDS_DEFAULTS, maxCount: 5 })
    fs.rmSync(path.join(tmp, 'brighttest.json'))
    expect(loadConfig(tmp).builds).toEqual(BUILDS_DEFAULTS)
  })
})

describe('add, dedupe, edit, remove', () => {
  it('adds a build with a record, a blob and 0600/0700 modes', async () => {
    const s = mk({})
    const buf = zipN(1)
    const r = await s.add(buf, { filename: '../../evil/app one.zip', source: { kind: 'upload' } })
    expect(r).toMatchObject({ created: true, deduped: false })
    expect(r.record).toMatchObject({ v: 1, filename: 'app one.zip', label: 'Sample App 1.4.118', kind: 'store', pinned: false, installCount: 0 })
    expect(r.record.id).toBe('b' + sha256Hex(buf).slice(0, 12))
    expect(fs.readFileSync(path.join(s.dir, 'blobs', sha256Hex(buf) + '.zip')).equals(buf)).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(path.join(s.dir, 'records', r.record.id + '.json')).mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') expect(fs.statSync(path.join(s.dir, 'blobs', sha256Hex(buf) + '.zip')).mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') expect(fs.statSync(s.dir).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(path.join(s.dir, 'tmp'))).toEqual([])
    expect(fs.existsSync(path.join(s.dir, '.lock'))).toBe(false)
    expect(JSON.stringify(r.record)).not.toContain(tmp) // no absolute paths
  })
  it('refuses bad packages before writing anything', async () => {
    const s = mk({ maxZipMB: 1 })
    await expect(s.add(Buffer.from('nope'), {})).rejects.toMatchObject({ code: 'BUILD_INVALID_ZIP' })
    await expect(s.add(makeZip([{ name: '../x', data: '' }]), {})).rejects.toMatchObject({ code: 'BUILD_UNSAFE_ZIP' })
    await expect(s.add(makeZip([{ name: 'a/manifest', data: 'x' }]), {})).rejects.toMatchObject({ code: 'BUILD_NO_MANIFEST' })
    await expect(s.add(Buffer.alloc(1024 * 1024 + 1), {})).rejects.toMatchObject({ code: 'BUILD_TOO_LARGE' })
    expect(s.list().builds).toEqual([])
    expect(fs.existsSync(path.join(s.dir, 'blobs')) ? fs.readdirSync(path.join(s.dir, 'blobs')) : []).toEqual([])
  })
  it('dedupes the same bytes: one blob, one record, a new source, label and pin kept', async () => {
    const s = mk({})
    const buf = zipN(1)
    const a = await s.add(buf, { filename: 'a.zip', source: { kind: 'upload' } })
    await s.edit(a.record.id, { label: 'mine', pinned: true, notes: 'n', tags: ['qa'] })
    const b = await s.add(buf, { filename: 'other.zip', source: { kind: 'build', net: true, from: '/abs/in/dir' } })
    expect(b).toMatchObject({ created: false, deduped: true })
    expect(b.record).toMatchObject({ label: 'mine', pinned: true, notes: 'n', tags: ['qa'], filename: 'a.zip' })
    expect(b.record.sources.map((x) => x.kind)).toEqual(['upload', 'build'])
    expect(b.record.sources[1]).toMatchObject({ net: true, strict: false, from: 'dir' })
    expect(s.list().builds).toHaveLength(1)
    expect(fs.readdirSync(path.join(s.dir, 'blobs'))).toHaveLength(1)
  })
  it('caps sources at 20', async () => {
    const s = mk({})
    for (let i = 0; i < 25; i++) await s.add(zipN(1), { source: { kind: 'cli-add' } })
    expect(s.list().builds[0].sources).toHaveLength(20)
  })
  it('records the kind of an instrumented package', async () => {
    const r = await mk({}).add(makeZip(instrumentedEntries()), {})
    expect(r.record).toMatchObject({ kind: 'instrumented' })
    expect(r.record.markerKinds).toContain('runtime-file')
    expect(JSON.stringify(r.record)).not.toContain('0123456789abcdef')
  })
  it('project field only in the user store', async () => {
    const user = openStore({ cfg: {}, home: tmp, env: {} })
    expect((await user.add(zipN(1), { project: '/x/sample-app' })).record.project).toBe('sample-app')
    expect((await mk({}).add(zipN(2), { project: 'p' })).record.project).toBeNull()
  })
  it('edit validates fields', async () => {
    const s = mk({})
    const { record } = await s.add(zipN(1), {})
    await expect(s.edit(record.id, { tags: ['Bad Tag'] })).rejects.toMatchObject({ code: 'BUILD_INVALID_FIELD' })
    await expect(s.edit(record.id, { tags: Array(17).fill('a') })).rejects.toMatchObject({ code: 'BUILD_INVALID_FIELD' })
    await expect(s.edit(record.id, { notes: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'BUILD_INVALID_FIELD' })
    await expect(s.edit(record.id, { pinned: 'yes' })).rejects.toMatchObject({ code: 'BUILD_INVALID_FIELD' })
    await expect(s.edit(record.id, { label: '' })).rejects.toMatchObject({ code: 'BUILD_INVALID_FIELD' })
    await expect(s.edit('b00000000000', {})).rejects.toMatchObject({ code: 'BUILD_NOT_FOUND' })
    expect((await s.edit(record.id, { tags: ['a', 'a', 'b.c'], notes: 'ok' })).tags).toEqual(['a', 'b.c'])
  })
  it('get by prefix: unique ok, short null, ambiguous throws', async () => {
    const s = mk({})
    const seen = new Map()
    let pair = null
    for (let i = 0; !pair; i++) {
      const buf = zipN(i)
      const pre = sha256Hex(buf).slice(0, 3) // id prefix 'b' + 3 hex: collisions turn up after about 80 zips
      if (seen.has(pre)) pair = [seen.get(pre), buf]
      else seen.set(pre, buf)
    }
    const [x, y] = [(await s.add(pair[0], {})).record.id, (await s.add(pair[1], {})).record.id]
    expect(s.get(x).id).toBe(x)
    expect(s.get(x.slice(0, 9)).id).toBe(x)
    expect(s.get(sha256Hex(pair[1]).slice(0, 10)).id).toBe(y)
    expect(() => s.get(x.slice(0, 4))).toThrow(expect.objectContaining({ code: 'BUILD_AMBIGUOUS', ids: expect.arrayContaining([x, y]) }))
    expect(s.get('bbb')).toBeNull()
    expect(s.get('zzzzzz')).toBeNull()
  })
  it('remove deletes record and blob; pinned needs force', async () => {
    const s = mk({})
    const { record } = await s.add(zipN(1), {})
    await s.edit(record.id, { pinned: true })
    await expect(s.remove(record.id)).rejects.toMatchObject({ code: 'BUILD_PINNED' })
    expect(await s.remove(record.id, { force: true })).toMatchObject({ removed: true })
    expect(s.list().builds).toEqual([])
    expect(fs.readdirSync(path.join(s.dir, 'blobs'))).toEqual([])
  })
  it('recordInstall appends, counts and drops unknown fields; dropped for a removed build', async () => {
    const s = mk({})
    const { record } = await s.add(zipN(1), {})
    await s.recordInstall(record.id, { via: 'cli', host: '10.0.0.5', ok: false, durationMs: 5, error: { step: 'upload', code: 'NETWORK', message: 'x', password: 'sekrit' }, password: 'sekrit' })
    const r = await s.recordInstall(record.id, { via: 'studio', host: '10.0.0.5', ok: true, active: true })
    expect(r).toMatchObject({ installCount: 2, failCount: 1, lastInstall: { host: '10.0.0.5', ok: true } })
    expect(JSON.stringify(s.list().builds)).not.toContain('sekrit')
    await s.remove(record.id)
    expect(await s.recordInstall(record.id, { ok: true })).toBeNull()
  })
})

describe('prune', () => {
  const addAt = async (s, n, lastUsed) => {
    const { record } = await s.add(zipN(n), { protect: ['*'] })
    const f = path.join(s.dir, 'records', record.id + '.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    j.lastUsedAt = lastUsed
    fs.writeFileSync(f, JSON.stringify(j))
    return record.id
  }
  it('removes unpinned least recently used first, down to maxCount, keeping the one just added', async () => {
    const s = mk({ maxCount: 100 })
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await addAt(s, i, `2026-01-0${i + 1}T00:00:00Z`))
    const small = mk({ maxCount: 3 })
    const dry = await small.prune({ dryRun: true })
    expect(dry.removed).toEqual([ids[0], ids[1]])
    expect(small.list().builds).toHaveLength(5)
    const res = await small.prune()
    expect(res.removed).toEqual([ids[0], ids[1]])
    expect(small.list().builds.map((b) => b.id).sort()).toEqual([ids[2], ids[3], ids[4]].sort())
    expect(fs.readdirSync(path.join(s.dir, 'blobs'))).toHaveLength(3)
  })
  it('add prunes automatically and never removes the build just added, even when it is the oldest', async () => {
    const s = mk({ maxCount: 2 })
    const t = Date.now()
    const a = await addAt(mk({ maxCount: 100 }), 1, '2026-01-01T00:00:00Z')
    await addAt(mk({ maxCount: 100 }), 2, '2026-01-02T00:00:00Z')
    const r = await s.add(zipN(3), {})
    expect(r.pruned).toEqual([a])
    expect(s.list().builds).toHaveLength(2)
    expect(s.get(r.record.id)).not.toBeNull()
    expect(Date.now() - t).toBeLessThan(10000)
  })
  it('pinned builds are kept, and over-cap pinned size warns on add', async () => {
    const s = mk({ maxCount: 1 })
    const a = await addAt(s, 1, '2026-01-01T00:00:00Z')
    await s.edit(a, { pinned: true })
    const b = await addAt(s, 2, '2026-01-02T00:00:00Z')
    const r = await s.add(zipN(3), {})
    expect(r.pruned).toEqual([b])
    expect(s.get(a)).not.toBeNull()
    const tiny = openStore({ cfg: { builds: { maxTotalMB: 0 } }, env: { BRIGHTTEST_BUILDS_DIR: path.join(tmp, 'tiny') } })
    const w = await tiny.add(zipN(4), {})
    expect(w.warnings.join(' ')).toBe('') // nothing pinned yet
    await tiny.edit(w.record.id, { pinned: true })
    const w2 = await tiny.prune()
    expect(w2.warnings[0]).toMatch(/pinned builds use \d+ MB, over the 0 MB cap/)
    expect(tiny.get(w.record.id)).not.toBeNull()
  })
  it('total size cap removes LRU first', async () => {
    const s = mk({ maxCount: 100 })
    const a = await addAt(s, 1, '2026-01-01T00:00:00Z')
    const b = await addAt(s, 2, '2026-01-02T00:00:00Z')
    const r = await mk({ maxTotalMB: 0 }).prune()
    expect(r.removed).toEqual([a, b])
  })
  it('sweeps old orphan blobs and old tmp files, keeps young ones', async () => {
    const s = mk({})
    await s.add(zipN(1), {})
    const orphanOld = path.join(s.dir, 'blobs', 'a'.repeat(64) + '.zip')
    const orphanNew = path.join(s.dir, 'blobs', 'c'.repeat(64) + '.zip')
    const tmpOld = path.join(s.dir, 'tmp', 'old.tmp')
    const tmpNew = path.join(s.dir, 'tmp', 'new.tmp')
    for (const f of [orphanOld, orphanNew, tmpOld, tmpNew]) fs.writeFileSync(f, 'x')
    ago(orphanOld, 2 * 3600e3); ago(tmpOld, 2 * 3600e3)
    const r = await s.prune()
    expect(r.swept.sort()).toEqual(['a'.repeat(64) + '.zip', 'old.tmp'].sort())
    expect(fs.existsSync(orphanNew) && fs.existsSync(tmpNew)).toBe(true)
    expect(fs.existsSync(orphanOld) || fs.existsSync(tmpOld)).toBe(false)
    expect(s.list().builds).toHaveLength(1)
  })
})

describe('quarantine and integrity', () => {
  it('moves unreadable and invalid records to quarantine once, keeps the good ones', async () => {
    const s = mk({})
    const { record } = await s.add(zipN(1), {})
    fs.writeFileSync(path.join(s.dir, 'records', 'b111111111111.json'), '{ not json')
    fs.writeFileSync(path.join(s.dir, 'records', 'b222222222222.json'), JSON.stringify({ v: 1, id: 'b222222222222' }))
    fs.writeFileSync(path.join(s.dir, 'records', 'b333333333333.json'), JSON.stringify({ ...record, id: 'b999999999999' }))
    const first = s.list()
    expect(first.builds.map((b) => b.id)).toEqual([record.id])
    expect(first.warnings).toHaveLength(3)
    expect(fs.readdirSync(path.join(s.dir, 'quarantine'))).toHaveLength(3)
    expect(fs.readdirSync(path.join(s.dir, 'records'))).toEqual([record.id + '.json'])
    expect(s.list().warnings).toEqual([]) // reported once
  })
  it('a missing blob marks the record missing and blob() says so', async () => {
    const s = mk({})
    const { record } = await s.add(zipN(1), {})
    fs.unlinkSync(path.join(s.dir, 'blobs', record.sha256 + '.zip'))
    expect(s.list().builds[0].blob).toBe('missing')
    expect(() => s.blob(record.id)).toThrow(expect.objectContaining({ code: 'BUILD_BLOB_MISSING' }))
  })
  it('a hash mismatch refuses blob() with BUILD_BLOB_CORRUPT and marks it', async () => {
    const s = mk({})
    const buf = zipN(1)
    const { record } = await s.add(buf, {})
    expect(s.blob(record.id).equals(buf)).toBe(true)
    fs.writeFileSync(path.join(s.dir, 'blobs', record.sha256 + '.zip'), Buffer.concat([buf, Buffer.from('x')]))
    expect(() => s.blob(record.id)).toThrow(expect.objectContaining({ code: 'BUILD_BLOB_CORRUPT' }))
    expect(s.list().builds[0].blob).toBe('corrupt')
  })
  it('re-adding the same bytes heals a blob of the wrong size', async () => {
    const s = mk({})
    const buf = zipN(1)
    const { record } = await s.add(buf, {})
    fs.writeFileSync(path.join(s.dir, 'blobs', record.sha256 + '.zip'), 'junk')
    await s.add(buf, {})
    expect(s.blob(record.id).equals(buf)).toBe(true)
  })
})

describe('lock', () => {
  const lockFile = (s) => path.join(s.dir, '.lock')
  it('a held lock times out with STORE_LOCKED', async () => {
    const s = mk({}, { lockWaitMs: 150 })
    await s.add(zipN(1), {})
    fs.writeFileSync(lockFile(s), JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }))
    await expect(s.add(zipN(2), {})).rejects.toMatchObject({ code: 'STORE_LOCKED' })
    expect(fs.existsSync(lockFile(s))).toBe(true) // not ours: untouched
  })
  it('a lock of a dead pid on this host is stale and replaced', async () => {
    const s = mk({})
    await s.add(zipN(1), {})
    fs.writeFileSync(lockFile(s), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), at: new Date().toISOString() }))
    await s.add(zipN(2), {})
    expect(s.list().builds).toHaveLength(2)
    expect(fs.existsSync(lockFile(s))).toBe(false)
  })
  it('a lock older than 60 s is stale', async () => {
    const s = mk({})
    await s.add(zipN(1), {})
    fs.writeFileSync(lockFile(s), JSON.stringify({ pid: process.pid, hostname: 'elsewhere', at: new Date(Date.now() - 61000).toISOString() }))
    await s.add(zipN(2), {})
    expect(s.list().builds).toHaveLength(2)
  })
  it('a young lock from another host is respected', async () => {
    const s = mk({}, { lockWaitMs: 150 })
    await s.add(zipN(1), {})
    fs.writeFileSync(lockFile(s), JSON.stringify({ pid: 1, hostname: 'elsewhere', at: new Date().toISOString() }))
    await expect(s.add(zipN(2), {})).rejects.toMatchObject({ code: 'STORE_LOCKED' })
  })
  it('write failures are STORE_WRITE_FAILED with the errno and no path', async () => {
    const blocker = path.join(tmp, 'file')
    fs.writeFileSync(blocker, 'x')
    const s = openStore({ cfg: {}, env: { BRIGHTTEST_BUILDS_DIR: path.join(blocker, 'sub') } })
    const e = await s.add(zipN(1), {}).catch((x) => x)
    expect(e.code).toBe('STORE_WRITE_FAILED')
    expect(e.errno).toBeTruthy()
    expect(e.message).not.toContain(tmp)
  })

  it('two child processes adding 20 builds each: no lost record, no corrupt file', async () => {
    const dir = path.join(tmp, 'shared')
    const script = path.join(tmp, 'child.js')
    fs.writeFileSync(script, `
      const { openStore } = require(${JSON.stringify(path.resolve(__dirname, '../lib/builds/store'))})
      const { makeZip, plainEntries } = require(${JSON.stringify(path.resolve(__dirname, 'support/zipgen'))})
      const [who, n] = [process.argv[2], Number(process.argv[3])]
      ;(async () => {
        const s = openStore({ cfg: { builds: { maxCount: 100 } }, env: { BRIGHTTEST_BUILDS_DIR: ${JSON.stringify(dir)} } })
        for (let i = 0; i < n; i++) await s.add(makeZip(plainEntries([{ name: 'source/n.brs', data: who + i }])), { source: { kind: 'cli-add' } })
      })().then(() => process.exit(0), (e) => { console.error(e.code || e.message); process.exit(1) })
    `)
    const run = (who) => new Promise((resolve) => {
      const c = spawn(process.execPath, [script, who, '20'], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      c.stderr.on('data', (d) => { err += d })
      const timer = setTimeout(() => { c.kill('SIGKILL') }, 60000)
      c.on('exit', (code, sig) => { clearTimeout(timer); resolve({ code, sig, err }) })
    })
    const results = await Promise.all([run('a'), run('b')])
    expect(results).toEqual([{ code: 0, sig: null, err: '' }, { code: 0, sig: null, err: '' }])
    const s = openStore({ cfg: { builds: { maxCount: 100 } }, env: { BRIGHTTEST_BUILDS_DIR: dir } })
    const { builds, warnings } = s.list()
    expect(warnings).toEqual([])
    expect(builds).toHaveLength(40)
    for (const b of builds) expect(sha256Hex(s.blob(b.id))).toBe(b.sha256)
    expect(fs.readdirSync(path.join(dir, 'blobs'))).toHaveLength(40)
    expect(fs.readdirSync(path.join(dir, 'records'))).toHaveLength(40)
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([])
    expect(fs.readdirSync(path.join(dir, 'quarantine'))).toEqual([])
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false)
  }, 90000)
})
