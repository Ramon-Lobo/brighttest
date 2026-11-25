import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const af = require('../scripts/docs-agent-files')
const ROOT = path.resolve(__dirname, '..')
const DOCS = path.join(ROOT, 'docs')
const BASE = '/brighttest/'
const ORIGIN = 'https://docs.example.test'

describe('cleanBody', () => {
  test('containers become blockquotes, code-group labels survive, badges and toc go', () => {
    const out = af.cleanBody([
      '# T', '', '[[toc]]', '', '::: warning Careful', 'Do not.', ':::', '',
      '::: code-group', '```sh [npm]', 'npm i', '```', '```sh [pnpm]', 'pnpm i', '```', ':::', '',
      'Item <Badge type="tip" text="New" />', '<!-- hidden -->',
      '```js{1,2}', '::: not-a-container', '```', '',
      '<script setup>', 'const a = 1', '</script>', 'end',
    ].join('\n'))
    expect(out).toContain('> **Warning: Careful**')
    expect(out).toContain('> Do not.')
    expect(out).toContain('**npm**')
    expect(out).toContain('**pnpm**')
    expect(out).toContain('Item (New)')
    expect(out).toContain('::: not-a-container') // untouched inside a fence
    expect(out).toContain('```js\n')
    expect(out).not.toMatch(/\[\[toc\]\]|<!--|<script|const a = 1|code-group/)
    expect(out.trim().endsWith('end')).toBe(true)
  })

  test('rewriteLinks skips code and handles titles, images and definitions', () => {
    const out = af.rewriteLinks('[a](/x) `[b](/y)` ![i](/img.png "t")\n[ref]: /z\n```\n[c](/w)\n```', (u) => 'R' + u)
    expect(out).toBe('[a](R/x) `[b](/y)` ![i](R/img.png "t")\n[ref]: R/z\n```\n[c](/w)\n```')
  })
})

// One real VitePress build of the released docs into a temp dir, shared by the checks below.
describe('built agent-readable docs', () => {
  let out
  let sources
  const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', '.vitepress', 'public'].includes(e.name)) return []
    const r = rel ? `${rel}/${e.name}` : e.name
    return e.isDirectory() ? walk(path.join(d, e.name), r) : e.name.endsWith('.md') ? [r] : []
  })

  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-agent-'))
    sources = walk(DOCS).sort()
    const bin = path.join(ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
    const r = spawnSync(process.execPath, [bin, 'build', DOCS, '--base', BASE, '--outDir', out], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_DOCS_CHANNEL: 'release', BRIGHTTEST_DOCS_ORIGIN: ORIGIN }, maxBuffer: 64 * 1024 * 1024,
    })
    if (r.status !== 0) throw new Error('docs build failed: ' + (r.stderr || r.stdout).split('\n').slice(-12).join('\n'))
  }, 180000)
  afterAll(() => { if (out) fs.rmSync(out, { recursive: true, force: true }) })

  const read = (...p) => fs.readFileSync(path.join(out, ...p), 'utf8')

  test('every source page has a .md twin, and nothing extra', () => {
    const built = walk(out).sort()
    expect(built).toEqual(sources)
  })

  test('twins are not stale: each starts with its source title and has plain Markdown only', () => {
    for (const rel of sources) {
      const twin = read(...rel.split('/'))
      expect(twin.trim().length, rel).toBeGreaterThan(20)
      expect(twin.startsWith('# '), rel).toBe(true)
      const src = af.splitFrontmatter(fs.readFileSync(path.join(DOCS, ...rel.split('/')), 'utf8')).body
      // A distinctive source line (first non-empty prose line after the heading) must be carried over.
      const probe = src.split(/\r?\n/).find((l) => /^[A-Za-z`*].{40,}/.test(l.trim()) && !/[[\](){}<>:]/.test(l))
      if (probe) expect(twin, rel).toContain(probe.trim())
    }
  })

  test('no Vue, container, include or script markup outside code fences', () => {
    for (const rel of sources) {
      const twin = read(...rel.split('/'))
      let inFence = false
      twin.split('\n').forEach((line, i) => {
        if (/^\s*(>\s*)?(```|~~~)/.test(line)) inFence = !inFence
        if (inFence) return
        const prose = line.replace(/`[^`]*`/g, '')
        const where = `${rel}:${i + 1}`
        expect(prose, where).not.toMatch(/<\/?(script|style|template|Badge)\b/i)
        expect(prose, where).not.toMatch(/^\s*(>\s*)?:::/)
        expect(prose, where).not.toMatch(/<!--|\[\[toc\]\]|\{\{.*\}\}/)
      })
    }
  })

  test('llms.txt: llmstxt.org shape, every link resolves to a generated twin, every page listed', () => {
    const txt = read('llms.txt')
    const lines = txt.split('\n')
    expect(lines[0]).toBe('# brighttest')
    expect(lines[2].startsWith('> ')).toBe(true)
    expect(txt).toMatch(/^## /m)
    const links = [...txt.matchAll(/^- \[[^\]]+\]\((\S+?)\)(?:: .+)?$/gm)].map((m) => m[1])
    expect(links.length).toBe(sources.length)
    for (const l of links) {
      expect(l.startsWith(ORIGIN + BASE), l).toBe(true)
      const rel = l.slice((ORIGIN + BASE).length)
      expect(fs.existsSync(path.join(out, ...rel.split('/'))), l).toBe(true)
    }
    expect(new Set(links.map((l) => l.slice((ORIGIN + BASE).length))).size).toBe(sources.length)
    expect(txt).not.toMatch(/\/next\//)
  })

  test('links inside twins resolve to generated files or assets', () => {
    const re = /\]\((https:\/\/docs\.example\.test\/brighttest\/[^)\s#?]+)/g
    for (const rel of sources) {
      for (const m of read(...rel.split('/')).matchAll(re)) {
        const f = m[1].slice((ORIGIN + BASE).length)
        expect(fs.existsSync(path.join(out, ...f.split('/'))), `${rel} -> ${f}`).toBe(true)
      }
    }
  })

  test('each HTML page advertises its .md twin', () => {
    const html = read('guide', 'studio.html')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/brighttest/guide/studio.md">')
    expect(read('index.html')).toContain('href="/brighttest/index.md"')
    expect(read('writing-tests', 'index.html')).toContain('href="/brighttest/writing-tests/index.md"')
  })

  test('deny-list check is clean over the generated output', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-denylist.js'), '--allow-missing', '--path', out, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    expect(r.status, r.stdout.slice(0, 500) + r.stderr.slice(0, 500)).toBe(0)
  })
})

describe('next channel', () => {
  test('writes no agent files and no alternate link', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-agent-next-'))
    try {
      const bin = path.join(ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
      const r = spawnSync(process.execPath, [bin, 'build', DOCS, '--base', '/brighttest/next/', '--outDir', out], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_DOCS_CHANNEL: 'next' }, maxBuffer: 64 * 1024 * 1024,
      })
      expect(r.status).toBe(0)
      expect(fs.existsSync(path.join(out, 'llms.txt'))).toBe(false)
      expect(fs.existsSync(path.join(out, 'guide', 'studio.md'))).toBe(false)
      expect(fs.readFileSync(path.join(out, 'guide', 'studio.html'), 'utf8')).not.toContain('text/markdown')
    } finally { fs.rmSync(out, { recursive: true, force: true }) }
  }, 180000)
})
