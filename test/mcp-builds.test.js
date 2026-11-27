import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { openStore } = require('../lib/builds/store')
const { makeZip, plainEntries } = require('./support/zipgen')
import { startMcp, payload, cleanupMcp, tmpdir } from './fixtures/mcp-harness.js'

afterEach(cleanupMcp)

const zipN = (n) => makeZip(plainEntries([{ name: 'source/n.brs', data: `' build ${n}\n` }]))

async function seeded() {
  const cwd = tmpdir('bt-mcp-builds-')
  const store = openStore({ cfg: {}, rootDir: cwd, env: {} })
  const a = (await store.add(zipN(1), { filename: 'one.zip', source: { kind: 'cli-add' } })).record
  const b = (await store.add(zipN(2), { filename: 'two.zip', source: { kind: 'cli-add' } })).record
  await store.edit(b.id, { pinned: true, tags: ['rc'] })
  await store.recordInstall(a.id, { via: 'cli', host: '10.9.8.7', ok: true, durationMs: 5, active: true })
  const c = startMcp({ cwd })
  await c.initialize()
  return { c, cwd, a, b }
}

describe('builds_list', () => {
  it('lists records without a host or a path, and takes no lease', async () => {
    const { c, cwd, a, b } = await seeded()
    const res = await c.tool('builds_list')
    const text = JSON.stringify(res.result)
    const d = payload(res)
    expect(d.total).toBe(2)
    expect(d.builds.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
    expect(d.builds.find((x) => x.id === b.id)).toMatchObject({ pinned: true, tags: ['rc'], kind: expect.any(String) })
    expect(d.builds.find((x) => x.id === a.id).lastInstall.ok).toBe(true)
    expect(text).not.toContain('10.9.8.7')
    expect(text).not.toContain(cwd)
    expect(text).not.toContain(path.join('.brighttest', 'builds'))
    expect(c.server.session.lease).toBe(null)
  })
  it('filters and limits', async () => {
    const { c, b } = await seeded()
    expect(payload(await c.tool('builds_list', { pinned: true })).builds.map((x) => x.id)).toEqual([b.id])
    expect(payload(await c.tool('builds_list', { tag: 'nope' })).builds).toEqual([])
    const l = payload(await c.tool('builds_list', { limit: 1 }))
    expect(l.builds.length).toBe(1)
    expect(l.truncated).toBe(true)
  })
  it('rejects an unknown kind and extra parameters', async () => {
    const { c } = await seeded()
    expect((await c.tool('builds_list', { kind: 'x' })).result.isError).toBe(true)
    expect((await c.tool('builds_list', { host: '1.2.3.4' })).error.code).toBe(-32602)
  })
})
