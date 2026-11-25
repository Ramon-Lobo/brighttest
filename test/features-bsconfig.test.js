import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { buildGraph } = require('../lib/features/graph')
const { readBsconfig, bsconfigUncertainty } = require('../lib/features/bsconfig')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GLOBS = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'bsconfig-globs')
const CYCLES = path.join(ROOT, 'test', 'fixtures', 'feature-graph', 'cycles')

describe('bsconfig plugins and files globs in the feature graph (reported, not honoured)', () => {
  it('reads plugins and files from a commented bsconfig with a trailing comma', () => {
    const b = readBsconfig(GLOBS)
    expect(b.plugins).toEqual(['@example/generator-plugin', 'local-plugin'])
    expect(b.files).toContain('extra/**/*.brs')
  })

  it('reports plugins and a custom files list as uncertainty', async () => {
    const g = await buildGraph(GLOBS)
    expect(g.uncertainty.counts['bsconfig-plugins']).toBe(1)
    expect(g.uncertainty.counts['bsconfig-files']).toBe(1)
    const p = g.uncertainty.items.find((i) => i.kind === 'bsconfig-plugins')
    expect(p.at).toBe('bsconfig.json')
    expect(p.detail).toContain('@example/generator-plugin, local-plugin')
    const f = g.uncertainty.items.find((i) => i.kind === 'bsconfig-files')
    expect(f.detail).toContain('extra/**/*.brs')
  })

  it('stays silent without a bsconfig, and for a default-equivalent files list with no plugins', () => {
    expect(bsconfigUncertainty(CYCLES)).toEqual([])
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bsc-'))
    try {
      fs.writeFileSync(path.join(dir, 'bsconfig.json'), JSON.stringify({ files: ['source/**/*.*', 'components/**/*.*', 'manifest'], plugins: [] }))
      expect(bsconfigUncertainty(dir)).toEqual([])
      fs.writeFileSync(path.join(dir, 'bsconfig.json'), '{ not json')
      expect(bsconfigUncertainty(dir)).toEqual([])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
