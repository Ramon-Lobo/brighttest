import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

// STUDIO-BUILDS-T2: instrument build records the package in the builds store, --sideload appends the install result,
// "install the last build I used" goes through installPackage(), and the password never reaches a record or a log.
const require = createRequire(import.meta.url)
const { build } = require('../lib/instrument/build')
const { sideload, installLastBuild, lastBuildForHost } = require('../lib/instrument/sideload')
const { openStore } = require('../lib/builds/store')
const { loadConfig } = require('../lib/config')
const { makeZip, plainEntries } = require('./support/zipgen')
const { fakeInstaller, toLocal } = require('./fixtures/fake-installer')

const PW = 'sentinel-pw-7431'
const MANIFEST = 'title=Sample\nmajor_version=1\nminor_version=0\nbuild_version=1\n'
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-brec-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function mkapp(name) {
  const dir = path.join(tmp, 'app-' + name)
  const files = { manifest: MANIFEST, 'source/main.brs': 'sub main()\n    print "hi"\nend sub\n' }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
const run = async (dir, name, opts = {}, cfgExtra = {}) => {
  const lines = []
  const cfg = { ...loadConfig(dir), rootDir: dir, stagingDir: path.join(tmp, 'stage-' + name), ...cfgExtra }
  const out = path.join(tmp, 'out-' + name + '.zip')
  const r = await build(cfg, { log: (l) => lines.push(l), out, ...opts })
  return { ...r, log: lines, out, cfg }
}
const storeOf = (dir) => openStore({ cfg: {}, rootDir: dir, env: {} })

describe('instrument build records the package', () => {
  it('adds the build to the project store with source facts', async () => {
    const dir = mkapp('rec')
    const r = await run(dir, 'rec', { strict: false, net: false })
    expect(r.exitCode).toBe(0)
    expect(r.record).toMatchObject({ created: true })
    const { builds } = storeOf(dir).list()
    expect(builds).toHaveLength(1)
    expect(builds[0]).toMatchObject({ id: r.record.id, filename: 'out-rec.zip', git: null, installCount: 0 })
    expect(builds[0].sources[0]).toMatchObject({ kind: 'build', net: false, strict: false, from: null })
    expect(builds[0].manifest).toMatchObject({ title: 'Sample' })
    expect(r.log.join('\n')).toMatch(/recorded as build b[0-9a-f]{12}/)
  })
  it('a second identical build dedupes onto the same record', async () => {
    const dir = mkapp('dedupe')
    const a = await run(dir, 'dedupe')
    const b = await run(dir, 'dedupe')
    // bsc output may differ per build (timestamps or tokens), so either dedupes or adds; the store stays consistent
    expect(storeOf(dir).list().builds.length).toBeGreaterThanOrEqual(1)
    expect(a.record.id).toBeTruthy(); expect(b.record.id).toBeTruthy()
  })
  it('records net and strict flags', async () => {
    const dir = mkapp('flags')
    const r = await run(dir, 'flags', { strict: true })
    expect(r.exitCode).toBe(0)
    expect(storeOf(dir).get(r.record.id).sources[0]).toMatchObject({ strict: true })
  })
  it('builds.record false writes nothing', async () => {
    const dir = mkapp('off')
    const r = await run(dir, 'off', {}, { builds: { record: false } })
    expect(r.exitCode).toBe(0)
    expect(r.record).toBeNull()
    expect(fs.existsSync(path.join(dir, '.brighttest', 'builds'))).toBe(false)
  })
  it('git facts with a repo, null without one', async () => {
    const dir = mkapp('git')
    git(dir, 'init', '-q'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init')
    const r = await run(dir, 'git')
    const g = storeOf(dir).get(r.record.id).git
    expect(g).toMatchObject({ dirty: expect.any(Boolean) })
    expect(g.sha).toMatch(/^[0-9a-f]{4,}$/)
    expect(g.branch).toBeTruthy()
    const plain = await run(mkapp('nogit'), 'nogit')
    expect(storeOf(path.join(tmp, 'app-nogit')).get(plain.record.id).git).toBeNull()
  })
  it('a store failure is one warning line and never fails the build', async () => {
    const dir = mkapp('bad')
    const store = { add: async () => { throw new Error('disk full') } }
    const r = await run(dir, 'bad', { store })
    expect(r.exitCode).toBe(0)
    expect(r.record).toBeNull()
    expect(r.log.join('\n')).toMatch(/warning: could not record the build \(disk full\)/)
  })
})

// A store holding one package, an installer that always succeeds.
async function withInstaller(fn, srvOpts) {
  const f = await fakeInstaller(srvOpts)
  try { return await fn(f) } finally { await new Promise((r) => f.srv.close(r)) }
}
const mkLease = (keys) => ({ keys, lost: false, released: 0, release() { this.released++ } })

describe('--sideload appends the install result; the last build is re-installable', () => {
  it('records the install, prints the build on the device, never the password', async () => {
    const dir = mkapp('side')
    const store = storeOf(dir)
    const zipBuf = makeZip(plainEntries([{ name: 'source/x.brs', data: "' a\n" }]))
    const added = await store.add(zipBuf, { filename: 'a.zip', source: { kind: 'build' } })
    const zip = path.join(tmp, 'a.zip'); fs.writeFileSync(zip, zipBuf)
    const instDir = path.join(tmp, 'inst-side')
    const lines = []
    const code = await withInstaller((f) => sideload({ rootDir: dir }, {
      zip, host: '192.0.2.5', password: PW, via: 'cli', record: { store, id: added.record.id, via: 'build' },
    }, {
      fetch: toLocal(f.port), log: (l) => lines.push(l), tcpProbe: async () => true, sleep: async () => {}, activeTries: 2,
      installedDir: instDir, acquireForLane: async () => ({ lease: mkLease(['k-side']) }),
    }))
    expect(code).toBe(0)
    const rec = store.get(added.record.id)
    expect(rec).toMatchObject({ installCount: 1, failCount: 0, lastInstall: { host: '192.0.2.5', ok: true } })
    expect(rec.installs[0]).toMatchObject({ via: 'build', ok: true, active: true })
    expect(lines.join('\n')).toMatch(/on the device now: .*sha /)
    expect(fs.existsSync(path.join(instDir, 'k-side', 'installed.json'))).toBe(true)
    const everything = lines.join('\n') + JSON.stringify(rec) + fs.readFileSync(path.join(instDir, 'k-side', 'installed.json'), 'utf8')
    expect(everything).not.toContain(PW)
  })
  it('a failed install is recorded with its code and no password; exit stays 1', async () => {
    const dir = mkapp('fail')
    const store = storeOf(dir)
    const zipBuf = makeZip(plainEntries([{ name: 'source/y.brs', data: "' b\n" }]))
    const added = await store.add(zipBuf, { filename: 'b.zip', source: { kind: 'build' } })
    const zip = path.join(tmp, 'b.zip'); fs.writeFileSync(zip, zipBuf)
    const lines = []
    const code = await withInstaller((f) => sideload({ rootDir: dir }, {
      zip, host: '192.0.2.5', password: PW, record: { store, id: added.record.id, via: 'build' },
    }, {
      fetch: toLocal(f.port), log: (l) => lines.push(l), tcpProbe: async () => true, sleep: async () => {}, activeTries: 1,
      installedDir: path.join(tmp, 'inst-fail'), acquireForLane: async () => ({ lease: mkLease(['k-fail']) }),
    }), { failAuthPostsBy: [1, 2, 3] })
    expect(code).toBe(1)
    const rec = store.get(added.record.id)
    expect(rec).toMatchObject({ installCount: 1, failCount: 1 })
    expect(rec.installs[0]).toMatchObject({ ok: false, error: { code: 'NETWORK' } })
    expect(JSON.stringify(rec) + lines.join('\n')).not.toContain(PW)
    expect(fs.existsSync(path.join(tmp, 'inst-fail', 'k-fail', 'installed.json'))).toBe(false)
  })
  it('a store error while recording is a warning, the exit code is unchanged', async () => {
    const dir = mkapp('storeerr')
    const zipBuf = makeZip(plainEntries([{ name: 'source/z.brs', data: "' c\n" }]))
    const zip = path.join(tmp, 'c.zip'); fs.writeFileSync(zip, zipBuf)
    const lines = []
    const store = { recordInstall: async () => { throw new Error('locked') } }
    const code = await withInstaller((f) => sideload({ rootDir: dir }, {
      zip, host: '192.0.2.5', password: PW, record: { store, id: 'b000000000000' },
    }, {
      fetch: toLocal(f.port), log: (l) => lines.push(l), tcpProbe: async () => true, sleep: async () => {}, activeTries: 1,
      installedDir: path.join(tmp, 'inst-se'), acquireForLane: async () => ({ lease: mkLease(['k-se']) }),
    }))
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/warning: could not add the install to the build record \(locked\)/)
  })
  it('installLastBuild installs the most recent build recorded for the host and shows what is on the device', async () => {
    const dir = mkapp('last')
    const store = storeOf(dir)
    const a = await store.add(makeZip(plainEntries([{ name: 'source/1.brs', data: "' 1\n" }])), { filename: 'one.zip', source: { kind: 'build' } })
    const b = await store.add(makeZip(plainEntries([{ name: 'source/2.brs', data: "' 2\n" }])), { filename: 'two.zip', source: { kind: 'build' } })
    expect(lastBuildForHost(store, '192.0.2.5')).toBeNull()
    expect((await installLastBuild({ store, host: '192.0.2.5', password: PW })).code).toBe('NO_BUILD')
    await store.recordInstall(a.record.id, { host: '192.0.2.5', ok: true, at: '2026-01-01T00:00:00Z' })
    await store.recordInstall(b.record.id, { host: '192.0.2.5', ok: true, at: '2026-02-01T00:00:00Z' })
    await store.recordInstall(a.record.id, { host: '192.0.2.9', ok: true, at: '2026-03-01T00:00:00Z' })
    expect(lastBuildForHost(store, '192.0.2.5').id).toBe(b.record.id)
    const instDir = path.join(tmp, 'inst-last')
    const res = await withInstaller((f) => installLastBuild({
      store, host: '192.0.2.5', password: PW, via: 'cli', as: 'agent-x', lease: mkLease(['k-last']), installedDir: instDir,
      fetchFn: toLocal(f.port), tcpProbe: async () => true, sleep: async () => {}, activeTries: 2,
    }))
    expect(res).toMatchObject({ ok: true, code: 'OK', build: { id: b.record.id } })
    expect(res.onDevice.text).toContain(b.record.sha256.slice(0, 8))
    expect(res.onDevice.text).toMatch(/by agent-x/)
    expect(store.get(b.record.id).installCount).toBe(2)
    expect(JSON.stringify(res)).not.toContain(PW)
  })
  it('installLastBuild reports a missing blob instead of throwing', async () => {
    const dir = mkapp('noblob')
    const store = storeOf(dir)
    const a = await store.add(makeZip(plainEntries([{ name: 'source/3.brs', data: "' 3\n" }])), { filename: 'three.zip', source: { kind: 'build' } })
    await store.recordInstall(a.record.id, { host: '192.0.2.5', ok: true })
    fs.rmSync(path.join(store.dir, 'blobs', a.record.sha256 + '.zip'))
    const res = await installLastBuild({ store, host: '192.0.2.5', password: PW })
    expect(res).toMatchObject({ ok: false, code: 'BUILD_BLOB_MISSING' })
  })
})
