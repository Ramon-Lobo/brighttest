import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { makeZip, plainEntries } = require('./support/zipgen')
const { run } = require('../lib/builds/cli')
const { fakeInstaller, toLocal } = require('./fixtures/fake-installer')

const CLI = path.resolve(__dirname, '../bin/cli.js')
const PW = 'sentinel-pw-7431'
const zipN = (n) => makeZip(plainEntries([{ name: 'source/n.brs', data: `' build ${n}\n` }]))
let tmp, store, work, leaseDir
const outputs = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bcli-'))
  store = path.join(tmp, 'store')
  work = path.join(tmp, 'work')
  leaseDir = path.join(tmp, 'lease')
  fs.mkdirSync(work)
  fs.mkdirSync(leaseDir)
  fs.writeFileSync(path.join(work, 'a.zip'), zipN(1))
  fs.writeFileSync(path.join(work, 'b.zip'), zipN(2))
  fs.writeFileSync(path.join(work, 'bad.zip'), 'not a zip')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const cli = (args, extraEnv = {}) => {
  const env = { ...process.env, BRIGHTTEST_BUILDS_DIR: store, BRIGHTTEST_LEASE_DIR: leaseDir, ROKU_PASSWORD: PW, ...extraEnv }
  delete env.ROKU_HOST
  Object.assign(env, extraEnv)
  const r = spawnSync(process.execPath, [CLI, 'builds', ...args], { cwd: work, env, encoding: 'utf8', timeout: 30000 })
  outputs.push(r.stdout, r.stderr)
  return r
}
const json = (args, env) => JSON.parse(cli([...args, '--json'], env).stdout)

describe('builds cli (spawned, temp store)', () => {
  it('shows help in the main help and exits 2 on an unknown action', () => {
    const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
    expect(h.stdout).toMatch(/brighttest builds list\|show/)
    expect(cli(['nope']).status).toBe(2)
    expect(cli(['--help']).status).toBe(0)
  })

  it('add, list, show, edit, pin, rm', () => {
    const a = cli(['add', 'a.zip', '--label', 'first', '--tag', 'qa', '--json'])
    expect(a.status).toBe(0)
    const add = JSON.parse(a.stdout)
    expect(add).toMatchObject({ created: true, build: { label: 'first', tags: ['qa'] } })
    const id = add.build.id
    expect(cli(['add', 'a.zip']).stdout).toMatch(/already in the store/)
    cli(['add', 'b.zip'])

    const list = json(['list'])
    expect(list.store.scope).toBe('custom')
    expect(list.builds).toHaveLength(2)
    expect(json(['list', '--tag', 'qa']).builds.map((b) => b.id)).toEqual([id])
    expect(json(['show', id.slice(0, 6)])).toMatchObject({ id, label: 'first' })
    expect(cli(['show', 'bffff']).status).toBe(2)

    expect(cli(['edit', id, '--note', 'hello', '--untag', 'qa', '--tag', 'x']).status).toBe(0)
    expect(json(['show', id])).toMatchObject({ notes: 'hello', tags: ['x'] })
    expect(cli(['edit', id]).status).toBe(2)
    expect(cli(['pin', id]).status).toBe(0)
    expect(cli(['rm', id]).status).toBe(1) // pinned
    expect(cli(['unpin', id]).status).toBe(0)
    expect(cli(['rm', id]).status).toBe(0)
    expect(cli(['rm', id]).status).toBe(2)
    expect(json(['prune', '--dry-run'])).toMatchObject({ dryRun: true, removed: [] })
  })

  it('maps rejected packages, bad store paths and a missing host', () => {
    expect(cli(['add', 'bad.zip']).status).toBe(5)
    expect(cli(['add', 'missing.zip']).status).toBe(2)
    expect(cli(['list'], { BRIGHTTEST_BUILDS_DIR: 'relative/dir' }).status).toBe(78)
    const r = cli(['install', '--latest'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--host/)
    expect(r.stderr).toMatch(/ROKU_HOST/)
    expect(cli(['install', 'b.zip', '--host', '192.0.2.9'], { ROKU_PASSWORD: '' }).status).toBe(2)
  })

  it('install --latest with no recorded build exits 2', () => {
    expect(cli(['install', '--latest', '--host', '192.0.2.9']).status).toBe(2)
  })
})

describe('builds install (in process, fake installer and lease)', () => {
  const mkDeps = (f, extra = {}) => {
    const lines = []
    const lease = { released: 0, release() { lease.released++ } }
    return {
      lines, lease,
      deps: {
        cwd: work, env: { BRIGHTTEST_BUILDS_DIR: store, ROKU_HOST: '192.0.2.5', ...(extra.env || {}) },
        resolvePassword: () => PW, out: (l) => lines.push(l), err: (l) => lines.push(l), log: (l) => lines.push(l),
        fetch: toLocal(f.port), tcpProbe: async () => true, sleep: async () => {}, activeTries: 2,
        installedDir: path.join(tmp, 'installed'),
        acquireForLane: async () => (extra.leaseCode ? { code: extra.leaseCode } : { lease }),
      },
    }
  }

  it('installs a zip path, an id prefix and --latest; records the result; releases the lease', async () => {
    const f = await fakeInstaller()
    try {
      const m = mkDeps(f)
      expect(await run(['install', 'b.zip', '--json'], m.deps)).toBe(0)
      const res = JSON.parse(m.lines.filter((l) => l.startsWith('{')).join('\n').match(/\{[\s\S]*\}/)[0])
      expect(res).toMatchObject({ ok: true, exitCode: 0, recorded: true, install: { via: 'cli', ok: true } })
      expect(m.lease.released).toBe(1)
      expect(f.log.reqs.some((r) => r.authed && r.submit === 'Replace')).toBe(true)

      const m2 = mkDeps(f)
      expect(await run(['install', res.id.slice(0, 6)], m2.deps)).toBe(0)
      const rec = require('../lib/builds/store').openStore({ cfg: {}, env: { BRIGHTTEST_BUILDS_DIR: store } }).get(res.id)
      expect(rec.installCount).toBe(2)

      // --latest needs a build source: this store only has cli-add records
      expect(await run(['install', '--latest'], mkDeps(f).deps)).toBe(2)
      const st = require('../lib/builds/store').openStore({ cfg: {}, env: { BRIGHTTEST_BUILDS_DIR: store } })
      await st.add(zipN(3), { filename: 'built.zip', source: { kind: 'build' } })
      const m3 = mkDeps(f)
      expect(await run(['install', '--latest', '--json'], m3.deps)).toBe(0)
      const latest = st.list().builds.find((b) => b.filename === 'built.zip')
      expect(st.get(latest.id).installCount).toBe(1)
    } finally { f.srv.close() }
  })

  it('maps lease busy to 75 and an installer failure to 1', async () => {
    const f = await fakeInstaller()
    try {
      expect(await run(['install', 'b.zip'], mkDeps(f, { leaseCode: 75 }).deps)).toBe(75)
      expect(await run(['install', 'b.zip'], mkDeps(f, { leaseCode: 78 }).deps)).toBe(78)
      const m = mkDeps(f)
      m.deps.tcpProbe = async () => false
      expect(await run(['install', 'b.zip'], m.deps)).toBe(1)
      expect(m.lease.released).toBe(1)
    } finally { f.srv.close() }
  })

  it('token check: enum-only refusal, --allow-token-mismatch, env then .env, never echoes the token', async () => {
    const { instrumentedEntries } = require('./support/zipgen')
    const TOK = '0123456789abcdef0123456789abcdef' // the token baked into the fixture package
    const OTHER = 'fedcba9876543210fedcba9876543210'
    fs.writeFileSync(path.join(work, 'inst.zip'), makeZip(instrumentedEntries()))
    const f = await fakeInstaller()
    const all = []
    try {
      const go = async (args, env) => { const m = mkDeps(f, { env }); const code = await run(args, m.deps); all.push(...m.lines); return { code, lines: m.lines } }
      // mismatch: refused, enum only, nothing installed
      let r = await go(['install', 'inst.zip'], { BRIGHTTEST_HUB_TOKEN: OTHER })
      expect(r.code).toBe(2)
      expect(r.lines.join('\n')).toMatch(/TOKEN_MISMATCH \(mismatch\)/)
      // no token configured at all
      r = await go(['install', 'inst.zip', '--json'], {})
      expect(r.code).toBe(2)
      expect(JSON.parse(r.lines.filter((l) => l.startsWith('{'))[0])).toMatchObject({ error: 'TOKEN_MISMATCH', tokenCheck: 'no-studio-token' })
      // allowed: proceeds with a warning that names only the enum
      r = await go(['install', 'inst.zip', '--allow-token-mismatch'], { BRIGHTTEST_HUB_TOKEN: OTHER })
      expect(r.code).toBe(0)
      expect(r.lines.join('\n')).toMatch(/warning: TOKEN_MISMATCH \(mismatch\) allowed/)
      // match from the environment: no warning
      r = await go(['install', 'inst.zip'], { BRIGHTTEST_HUB_TOKEN: TOK })
      expect(r.code).toBe(0)
      expect(r.lines.join('\n')).not.toMatch(/TOKEN_MISMATCH/)
      // match from the project .env when the environment has none
      fs.writeFileSync(path.join(work, '.env'), `BRIGHTTEST_HUB_TOKEN=${TOK}\n`)
      try {
        r = await go(['install', 'inst.zip'], {})
        expect(r.code).toBe(0)
        // environment wins over .env
        r = await go(['install', 'inst.zip'], { BRIGHTTEST_HUB_TOKEN: OTHER })
        expect(r.code).toBe(2)
      } finally { fs.rmSync(path.join(work, '.env'), { force: true }) }
      // a non-instrumented build is not checked
      expect((await go(['install', 'b.zip'], { BRIGHTTEST_HUB_TOKEN: OTHER })).code).toBe(0)
      for (const t of [TOK, OTHER]) expect(all.join('\n')).not.toContain(t)
    } finally { f.srv.close() }
  })

  it('rejects a corrupt blob with 5 before taking the lease', async () => {
    const f = await fakeInstaller()
    try {
      const st = require('../lib/builds/store').openStore({ cfg: {}, env: { BRIGHTTEST_BUILDS_DIR: store } })
      const r = await st.add(zipN(9), { filename: 'c.zip' })
      fs.writeFileSync(path.join(st.dir, 'blobs', r.record.sha256 + '.zip'), 'tampered')
      let acquired = 0
      const m = mkDeps(f)
      m.deps.acquireForLane = async () => { acquired++; return { lease: m.lease } }
      expect(await run(['install', r.record.id], m.deps)).toBe(5)
      expect(acquired).toBe(0)
    } finally { f.srv.close() }
  })

  it('never prints the password', () => {
    const all = outputs.join('\n')
    expect(all).not.toContain(PW)
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    for (const p of walk(store).filter((x) => x.includes('records'))) expect(fs.readFileSync(p, 'utf8')).not.toContain(PW)
  })
})
