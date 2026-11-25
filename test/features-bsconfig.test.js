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
      const bad = bsconfigUncertainty(dir)
      expect(bad).toHaveLength(1)
      expect(bad[0].kind).toBe('bsconfig-not-read')
      expect(bad[0].detail).toContain('not read bsconfig.json')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('bsconfig hardening', () => {
  const tmp = (fn) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bsc-')); try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) } }
  const put = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body)) }

  it('parses a bsconfig with a leading BOM', () => tmp((dir) => {
    put(dir, 'bsconfig.json', '\uFEFF// c\n{ "plugins": ["p1",], }')
    expect(readBsconfig(dir).plugins).toEqual(['p1'])
  }))

  it('treats an array src entry as a custom files list', () => tmp((dir) => {
    put(dir, 'bsconfig.json', { files: ['source/**/*.*', { src: ['a/**', 'b/**'], dest: 'x' }] })
    const u = bsconfigUncertainty(dir)
    expect(u.map((i) => i.kind)).toEqual(['bsconfig-files'])
    expect(u[0].detail).toContain('a/**|b/**=>x')
  }))

  it('treats a default-looking object entry and negated globs as custom', () => tmp((dir) => {
    put(dir, 'bsconfig.json', { files: [{ src: 'source/**/*.*', dest: 'source' }] })
    expect(bsconfigUncertainty(dir)).toHaveLength(1)
    put(dir, 'bsconfig.json', { files: ['source/**/*.*', '!source/skip.brs'] })
    expect(bsconfigUncertainty(dir)).toHaveLength(1)
  }))

  it('follows extends for plugins and files, child wins', () => tmp((dir) => {
    put(dir, 'base/bsconfig.base.json', { plugins: ['base-plugin'], files: ['extra/**'] })
    put(dir, 'bsconfig.json', { extends: 'base/bsconfig.base.json' })
    const u = bsconfigUncertainty(dir)
    expect(u.map((i) => i.kind).sort()).toEqual(['bsconfig-files', 'bsconfig-plugins'])
    put(dir, 'bsconfig.json', { extends: 'base/bsconfig.base.json', plugins: [] })
    expect(bsconfigUncertainty(dir).map((i) => i.kind)).toEqual(['bsconfig-files'])
  }))

  it('does not follow extends outside the root or past the depth cap, and says so', () => tmp((dir) => {
    put(dir, 'bsconfig.json', { extends: '../outside.json' })
    expect(bsconfigUncertainty(dir)[0]).toMatchObject({ kind: 'bsconfig-not-read' })
    for (let i = 0; i < 8; i++) put(dir, `c${i}.json`, { extends: `c${i + 1}.json` })
    put(dir, 'bsconfig.json', { extends: 'c0.json' })
    expect(bsconfigUncertainty(dir).some((i) => /deeper than/.test(i.detail))).toBe(true)
  }))

  it('reports a symlinked or oversize bsconfig.json as not read', () => tmp((dir) => {
    put(dir, 'real.json', { plugins: ['p'] })
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'bsconfig.json'))
    expect(bsconfigUncertainty(dir)[0].kind).toBe('bsconfig-not-read')
    fs.unlinkSync(path.join(dir, 'bsconfig.json'))
    put(dir, 'bsconfig.json', ' '.repeat(2 * 1024 * 1024 + 10))
    expect(bsconfigUncertainty(dir)[0].detail).toContain('not read bsconfig.json')
  }))

  it('sanitises echoed names: control chars, length, count, non-strings, empty', () => tmp((dir) => {
    const many = Array.from({ length: 12 }, (_, i) => `p${i}`)
    put(dir, 'bsconfig.json', { plugins: ['a\u0007b\nc', 'x'.repeat(500), 42, null, {}, '', ...many] })
    const b = readBsconfig(dir)
    expect(b.plugins[0]).toBe('abc')
    expect(b.plugins[1].length).toBe(121)
    expect(b.plugins.slice(2, 6)).toEqual(['(non-string plugin)', '(non-string plugin)', '(unnamed plugin)', '(unnamed)'])
    const d = bsconfigUncertainty(dir)[0].detail
    expect(d).not.toMatch(/[\x00-\x1f]/)
    expect(d).not.toContain('[object Object]')
    expect(d.endsWith(', …')).toBe(true)
    expect(d).not.toContain('p5')
  }))

  it('does not alter string contents when stripping trailing commas or comments', () => tmp((dir) => {
    put(dir, 'bsconfig.json', '{ "plugins": ["a,]b", "c//d", "e,}"], }')
    expect(readBsconfig(dir).plugins).toEqual(['a,]b', 'c//d', 'e,}'])
  }))

  it('names the effective base when a bsconfig rootDir is set', () => tmp((dir) => {
    put(dir, 'bsconfig.json', { rootDir: 'app', files: ['extra/**'] })
    expect(bsconfigUncertainty(dir)[0].detail).toContain('rootDir "app"')
  }))
})
