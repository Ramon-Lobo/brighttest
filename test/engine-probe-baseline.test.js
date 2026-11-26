import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SCRIPT = path.resolve(__dirname, 'engine-probes', 'baseline.js')
const { fingerprint, diffLines } = require(SCRIPT)
const BASELINE = path.resolve(__dirname, 'engine-probes', 'baseline-patched.txt')

const api = (status = 'caught') => ({
  results: [{ cat: 'globals', name: 'Foo', code: 0, ms: 12, timeout: false, recs: [{ kind: 'global', name: 'Foo', status, extra: 'sig', diag: [] }] }],
})
const beh = (rnd = '1') => ({
  language: [{ id: 'aa', status: 'ran', match: true, actual: '1' }],
  behavior: { core: { complete: true, count: 2, values: { 'misc.rnd': rnd, 'misc.x': 'y' } } },
})

describe('engine probe baseline', () => {
  it('ignores volatile fields (timings, random values) when fingerprinting', () => {
    const a = fingerprint(api(), beh('1'))
    const b = fingerprint({ results: [{ ...api().results[0], ms: 999 }] }, beh('2'))
    expect(b).toEqual(a)
    expect(a.some((l) => l.includes('misc.rnd'))).toBe(false)
  })

  it('reports a changed capability status as one removed and one added line', () => {
    const d = diffLines(fingerprint(api('caught'), beh()), fingerprint(api('missing'), beh()))
    expect(d.removed).toHaveLength(1)
    expect(d.added).toHaveLength(1)
    expect(d.added[0]).toContain('missing')
  })

  it('diff exits 0 without --strict and 1 with it when the probe differs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-base-'))
    try {
      const w = (n, o) => { const p = path.join(dir, n); fs.writeFileSync(p, JSON.stringify(o)); return p }
      const base = path.join(dir, 'base.txt')
      fs.writeFileSync(base, fingerprint(api('caught'), beh()).join('\n') + '\n')
      const args = [SCRIPT, 'diff', base, w('api.json', api('missing')), w('beh.json', beh())]
      expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(0)
      const strict = spawnSync(process.execPath, [...args, '--strict'], { encoding: 'utf8' })
      expect(strict.status).toBe(1)
      expect(strict.stdout).toContain('1 removed, 1 added')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('notices a change that is only in the probe message text', () => {
    const changed = { results: [{ ...api().results[0], recs: [{ ...api().results[0].recs[0], extra: 'another signature' }] }] }
    const d = diffLines(fingerprint(api(), beh()), fingerprint(changed, beh()))
    expect(d.removed).toHaveLength(1)
    expect(d.added).toHaveLength(1)
  })

  it('the baseline header names the engine version pinned in package.json', () => {
    const header = fs.readFileSync(BASELINE, 'utf8').split('\n')[0]
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'))
    expect(header).toBe(`# engine @ramonlobo/brs-node@${pkg.dependencies['@ramonlobo/brs-node']}`)
  })

  it('the committed baseline is non-empty, sorted and unique', () => {
    const lines = fs.readFileSync(BASELINE, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    expect(lines.length).toBeGreaterThan(1000)
    expect(lines).toEqual([...new Set(lines)].sort())
    expect(lines.some((l) => l.startsWith('api components/'))).toBe(true)
    expect(lines.some((l) => l.startsWith('lang '))).toBe(true)
    expect(lines.some((l) => l.startsWith('behavior core '))).toBe(true)
  })
})
