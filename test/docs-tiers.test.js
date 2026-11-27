import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const t = require('../scripts/docs-tiers')

let dir
const put = (rel) => {
  const f = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '# x\n')
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tiers-'))
  for (const r of ['index.md', 'guide/studio.md', 'guide/mcp.md', 'changelog.md', 'guide/_part.md', 'public/a.md', '.vitepress/n.md',
    'lite/index.md', 'lite/guide/studio.md', 'lite/guide/mcp.md', 'lite/cheat-sheet.md']) put(r)
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('tierMap', () => {
  test('splits tiered, lite-only and full-only pages and skips hidden dirs and underscore files', () => {
    expect(t.tierMap(dir)).toEqual({
      tiered: ['guide/mcp.md', 'guide/studio.md', 'index.md'],
      liteOnly: ['cheat-sheet.md'],
      fullOnly: ['changelog.md'],
    })
  })

  test('with no docs/lite everything is full-only and nothing is rewritten', () => {
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tiers-none-'))
    try {
      fs.writeFileSync(path.join(none, 'index.md'), '# x\n')
      const m = t.tierMap(none)
      expect(m).toEqual({ tiered: [], liteOnly: [], fullOnly: ['index.md'] })
      expect(t.rewritesFor(m)).toEqual({})
    } finally { fs.rmSync(none, { recursive: true, force: true }) }
  })
})

describe('rewritesFor', () => {
  test('lite goes to the usual URL, the full page to full/, lite-only to the usual URL', () => {
    expect(t.rewritesFor(t.tierMap(dir))).toEqual({
      'lite/cheat-sheet.md': 'cheat-sheet.md',
      'lite/guide/mcp.md': 'guide/mcp.md',
      'guide/mcp.md': 'full/guide/mcp.md',
      'lite/guide/studio.md': 'guide/studio.md',
      'guide/studio.md': 'full/guide/studio.md',
      'lite/index.md': 'index.md',
      'index.md': 'full/index.md',
    })
  })
})

describe('twinOf', () => {
  test('lite page with a full twin maps to the full source; lite-only has none; full stays', () => {
    const m = t.tierMap(dir)
    expect(t.twinOf('lite/guide/studio.md', m)).toBe('guide/studio.md')
    expect(t.twinOf('lite/cheat-sheet.md', m)).toBeNull()
    expect(t.twinOf('guide/studio.md', m)).toBe('guide/studio.md')
    expect(t.twinOf('changelog.md', m)).toBe('changelog.md')
  })
})

describe('fullLink and prefixFull', () => {
  const m = { tiered: ['guide/studio.md', 'index.md', 'e2e/index.md'], liteOnly: [], fullOnly: ['changelog.md'] }

  test('prefixes tiered absolute links only, keeping anchors', () => {
    expect(t.fullLink('/guide/studio', m)).toBe('/full/guide/studio')
    expect(t.fullLink('/guide/studio#a', m)).toBe('/full/guide/studio#a')
    expect(t.fullLink('/guide/studio.md', m)).toBe('/full/guide/studio')
    expect(t.fullLink('/', m)).toBe('/full/')
    expect(t.fullLink('/e2e/', m)).toBe('/full/e2e/')
    expect(t.fullLink('/changelog', m)).toBe('/changelog')
    expect(t.fullLink('./studio', m)).toBe('./studio')
    expect(t.fullLink('https://example.test/guide/studio', m)).toBe('https://example.test/guide/studio')
    expect(t.fullLink('/full/guide/studio', m)).toBe('/full/guide/studio')
  })

  test('prefixFull returns a copy and leaves untiered links alone', () => {
    const side = [{ text: 'A', items: [{ text: 'S', link: '/guide/studio' }, { text: 'C', link: '/changelog' }] }]
    const out = t.prefixFull(side, m)
    expect(out[0].items.map((i) => i.link)).toEqual(['/full/guide/studio', '/changelog'])
    expect(side[0].items[0].link).toBe('/guide/studio')
  })
})
