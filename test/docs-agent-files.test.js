import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { spawnDocsBuild } from './support/docs-build-lock.js'

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
    if (['node_modules', '.vitepress', 'public'].includes(e.name) || (!rel && e.name === 'lite')) return []
    const r = rel ? `${rel}/${e.name}` : e.name
    return e.isDirectory() ? walk(path.join(d, e.name), r) : e.name.endsWith('.md') ? [r] : []
  })

  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-agent-'))
    sources = walk(DOCS).sort()
    const bin = path.join(ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
    const r = spawnDocsBuild(process.execPath, [bin, 'build', DOCS, '--base', BASE, '--outDir', out], {
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
      const r = spawnDocsBuild(process.execPath, [bin, 'build', DOCS, '--base', '/brighttest/next/', '--outDir', out], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_DOCS_CHANNEL: 'next' }, maxBuffer: 64 * 1024 * 1024,
      })
      expect(r.status).toBe(0)
      expect(fs.existsSync(path.join(out, 'llms.txt'))).toBe(false)
      expect(fs.existsSync(path.join(out, 'guide', 'studio.md'))).toBe(false)
      expect(fs.readFileSync(path.join(out, 'guide', 'studio.html'), 'utf8')).not.toContain('text/markdown')
    } finally { fs.rmSync(out, { recursive: true, force: true }) }
  }, 180000)
})

// Two-tier docs (ADR 0061): a fixture copy of the docs with two throwaway lite pages. Lite pages are served at the
// usual URLs, the full page at /full/, twins carry the full text, and every HTML page points at the full twin.
describe('built two-tier docs (fixture)', () => {
  let root
  let out
  const read = (...p) => fs.readFileSync(path.join(out, ...p), 'utf8')
  const exists = (...p) => fs.existsSync(path.join(out, ...p))

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tier-fixture-'))) // real path: VitePress resolves links by path, a symlinked tmp dir breaks them
    out = path.join(root, 'dist')
    fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(root, 'scripts'))
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'))
    fs.cpSync(DOCS, path.join(root, 'docs'), { recursive: true, filter: (s) => !/\.vitepress[\\/](\.temp|cache|dist)/.test(s) })
    const lite = (rel, body) => {
      const f = path.join(root, 'docs', 'lite', ...rel.split('/'))
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, body)
    }
    lite('guide/instrument.md', '# Instrumented builds (short)\n\nLITE-ONLY-MARKER paragraph for the fixture tier page.\n\n[Lease](./device-lease) and [adopting](/guide/adopting).\n\n**Full guide:** [Instrumented builds](full:/guide/instrument)\n')
    lite('guide/device-lease.md', '# Device lease (short)\n\nLite page.\n\n**Full guide:** [Device lease](full:/guide/device-lease)\n')
    lite('guide/assess.md', '# Assess (short)\n\nLite.\n\n**Full guide:** [Assess](full:/guide/assess)\n')
    lite('cheat-sheet.md', '# Cheat sheet\n\nA lite-only page.\n')
    const bin = path.join(ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
    const r = spawnDocsBuild(process.execPath, [bin, 'build', path.join(root, 'docs'), '--base', BASE, '--outDir', out], {
      cwd: root, encoding: 'utf8', env: { ...process.env, BRIGHTTEST_DOCS_CHANNEL: 'release', BRIGHTTEST_DOCS_ORIGIN: ORIGIN }, maxBuffer: 64 * 1024 * 1024,
    })
    if (r.status !== 0) throw new Error('fixture docs build failed: ' + (r.stderr || r.stdout).split('\n').slice(-12).join('\n'))
  }, 600000)
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })

  test('lite pages at the usual URL, full pages under full/, untiered pages unchanged', () => {
    expect(read('guide', 'instrument.html')).toContain('LITE-ONLY-MARKER')
    expect(read('full', 'guide', 'instrument.html')).not.toContain('LITE-ONLY-MARKER')
    expect(exists('cheat-sheet.html')).toBe(true)
    expect(exists('full', 'cheat-sheet.html')).toBe(false)
    expect(exists('changelog.html')).toBe(true)
    expect(exists('full', 'changelog.html')).toBe(false)
    expect(exists('lite')).toBe(false)
  })

  test('twins are the full text at the usual path; none under full/, none for lite-only pages', () => {
    const twin = read('guide', 'instrument.md')
    expect(twin).not.toContain('LITE-ONLY-MARKER')
    expect(twin).toContain(af.splitFrontmatter(fs.readFileSync(path.join(DOCS, 'guide', 'instrument.md'), 'utf8')).body.split(/\r?\n/).find((l) => /^[A-Za-z`*].{40,}/.test(l.trim()) && !/[[\](){}<>:]/.test(l)).trim())
    expect(exists('full', 'guide', 'instrument.md')).toBe(false)
    expect(exists('cheat-sheet.md')).toBe(false)
    expect(exists('lite')).toBe(false)
  })

  test('llms.txt lists full pages and says so', () => {
    const txt = read('llms.txt')
    expect(txt).toContain('These pages are the full documentation')
    expect(txt).toContain(`${ORIGIN}${BASE}guide/instrument.md)`)
    expect(txt).not.toMatch(/\]\([^)]*(\/full\/|cheat-sheet|lite\/)/)
  })

  test('lite and full HTML both point their alternate link at the full twin; lite-only has none', () => {
    const alt = `<link rel="alternate" type="text/markdown" href="${BASE}guide/instrument.md"`
    expect(read('guide', 'instrument.html')).toContain(alt)
    expect(read('full', 'guide', 'instrument.html')).toContain(alt)
    expect(read('cheat-sheet.html')).not.toContain('rel="alternate" type="text/markdown"')
  })

  test('canonical is the routed URL of each tier', () => {
    expect(read('guide', 'instrument.html')).toContain(`<link rel="canonical" href="${ORIGIN}${BASE}guide/instrument"`)
    expect(read('full', 'guide', 'instrument.html')).toContain(`<link rel="canonical" href="${ORIGIN}${BASE}full/guide/instrument"`)
  })

  test('the full: scheme resolves to /full/, same tab', () => {
    const html = read('guide', 'instrument.html')
    expect(html).toContain(`href="${BASE}full/guide/instrument"`)
    expect(html).not.toContain('href="full:')
  })

  test('absolute links inside a full page to a tiered page stay in full/', () => {
    // docs/guide/assess.md links /guide/instrument#apps-with-... (tiered in this fixture). The nav stays lite.
    const html = read('full', 'guide', 'assess.html')
    expect(html).toContain(`href="${BASE}full/guide/instrument#apps-with-their-own-build-step-from"`)
    expect(html).not.toContain(`href="${BASE}guide/instrument#`)
  })
  test('relative links in a full page to a full-only page resolve to the usual URL (no dead /full/ link)', () => {
    // docs/guide/instrument.md has [..](./examples); examples is not tiered, so it lives at /guide/examples only.
    const html = read('full', 'guide', 'instrument.html')
    expect(html).toContain(`href="${BASE}guide/examples"`)
    expect(html).not.toContain(`href="./examples"`)
  })
})
