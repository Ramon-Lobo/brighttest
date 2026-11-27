import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/builds.js')
const mk = (o) => ({ id: 'b1', label: 'Alpha', filename: 'a.zip', notes: '', tags: [], pinned: false, kind: 'store', size: 10, createdAt: '2026-11-01T00:00:00Z', sources: [{ kind: 'upload' }], manifest: { version: '1.0.0' }, sha256: 'abcdef0123456789', ...o })

describe('builds.js helpers', () => {
  it('filters by text, kind, source, pinned and tag', async () => {
    const { filterBuilds } = await load()
    const l = [mk({ id: 'a' }), mk({ id: 'b', label: 'Beta', kind: 'instrumented', tags: ['qa'], sources: [{ kind: 'cli-add' }], pinned: true, notes: 'smoke run' })]
    expect(filterBuilds(l, { q: 'beta' }).map((b) => b.id)).toEqual(['b'])
    expect(filterBuilds(l, { q: 'SMOKE' }).map((b) => b.id)).toEqual(['b'])
    expect(filterBuilds(l, { q: 'abcdef01' }).length).toBe(2)
    expect(filterBuilds(l, { kind: 'instrumented' }).map((b) => b.id)).toEqual(['b'])
    expect(filterBuilds(l, { source: 'cli' }).map((b) => b.id)).toEqual(['b'])
    expect(filterBuilds(l, { pinned: true }).map((b) => b.id)).toEqual(['b'])
    expect(filterBuilds(l, { tag: 'qa' }).map((b) => b.id)).toEqual(['b'])
  })
  it('sorts with pinned first', async () => {
    const { sortBuilds } = await load()
    const l = [mk({ id: 'a', label: 'B', size: 5, createdAt: '2026-11-02T00:00:00Z' }), mk({ id: 'b', label: 'A', size: 9 }), mk({ id: 'c', label: 'C', pinned: true, size: 1 })]
    expect(sortBuilds(l, 'newest').map((b) => b.id)).toEqual(['c', 'a', 'b'])
    expect(sortBuilds(l, 'label').map((b) => b.id)).toEqual(['c', 'b', 'a'])
    expect(sortBuilds(l, 'size').map((b) => b.id)).toEqual(['c', 'b', 'a'])
  })
  it('prechecks, explains upload and install failures', async () => {
    const h = await load()
    expect(h.precheck({ name: 'x.txt', size: 1 }, 64)).toMatch(/\.zip/)
    expect(h.precheck({ name: 'x.zip', size: 3 * 1024 * 1024 }, 2)).toMatch(/2 MB/)
    expect(h.precheck({ name: 'x.ZIP', size: 1 }, 2)).toBe('')
    expect(h.uploadError('BUILD_NO_MANIFEST')).toMatch(/manifest/)
    expect(h.installError(423, { code: 'LOCKED', error: 'in use by x' }).kind).toBe('locked')
    expect(h.installError(409, { code: 'TOKEN_MISMATCH', tokenCheck: 'mismatch' }).kind).toBe('token')
    expect(h.failureText({ code: 'AUTH', message: 'm' }).hint).toMatch(/401/)
  })
  it('words the device strip for each state', async () => {
    const { currentLine } = await load()
    expect(currentLine(null, { sim: true })).toMatch(/simulator/)
    expect(currentLine({ error: 'x' })).toBe('no device')
    expect(currentLine({ host: 'h', device: { name: 'Den' }, match: 'none' })).toMatch(/no dev channel/)
    expect(currentLine({ host: 'h', device: { name: 'Den' }, match: 'unknown' })).toMatch(/unknown build/)
    expect(currentLine({ host: 'h', device: { name: 'Den' }, match: 'confirmed', build: { id: 'b3f9a1c0d7e2b', label: 'Sample' } })).toMatch(/Sample \(b3f9a1c\)/)
  })
  it('remembers the skip-confirm choice', async () => {
    const { loadPrefs, savePrefs, needsConfirm } = await load()
    const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
    expect(loadPrefs(st)).toEqual({ confirm: true })
    savePrefs(st, { confirm: false })
    expect(mem.get('bt.studio.builds')).toBe('{"v":1,"confirm":false}')
    expect(needsConfirm(loadPrefs(st), false)).toBe(false)
    expect(needsConfirm(loadPrefs(st), true)).toBe(true)
  })
})
