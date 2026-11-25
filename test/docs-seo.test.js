import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const seo = require('../scripts/docs-seo')
const ROOT = path.resolve(__dirname, '..')
const DOCS = path.join(ROOT, 'docs')
const BIN = path.join(ROOT, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
const ORIGIN = 'https://docs.example.test'

function build(channel, base, out) {
  const env = { ...process.env, BRIGHTTEST_DOCS_CHANNEL: channel }
  if (channel === 'release') env.BRIGHTTEST_DOCS_ORIGIN = ORIGIN
  const r = spawnSync(process.execPath, [BIN, 'build', DOCS, '--base', base, '--outDir', out], { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('docs build failed: ' + (r.stderr || r.stdout).split('\n').slice(-12).join('\n'))
}
const count = (s, re) => (s.match(re) || []).length
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))

describe('seo helpers', () => {
  test('safeJson cannot close the script element', () => {
    const s = seo.safeJson({ a: '</script><script>alert(1)</script><!-- & \u2028' })
    expect(s).not.toMatch(/<|>|&|\u2028/)
    expect(JSON.parse(s).a).toContain('</script>')
  })
  test('pageUrl gives clean absolute URLs', () => {
    expect(seo.pageUrl(ORIGIN, '/b/', 'index.md')).toBe(ORIGIN + '/b/')
    expect(seo.pageUrl(ORIGIN, '/b/', 'guide/studio.md')).toBe(ORIGIN + '/b/guide/studio')
    expect(seo.pageUrl(ORIGIN, '/b/', 'e2e/index.md')).toBe(ORIGIN + '/b/e2e/')
  })
})

describe('built released docs', () => {
  let out
  const read = (...p) => fs.readFileSync(path.join(out, ...p), 'utf8')
  beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-seo-')); build('release', '/brighttest/', out) }, 180000)
  afterAll(() => { if (out) fs.rmSync(out, { recursive: true, force: true }) })

  test('every page has exactly one canonical with the right absolute URL', () => {
    const pages = [['index.html', ''], ['guide/studio.html', 'guide/studio'], ['e2e/index.html', 'e2e/']]
    for (const [file, route] of pages) {
      const html = read(...file.split('/'))
      expect(count(html, /<link rel="canonical"/g), file).toBe(1)
      expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/brighttest/${route}">`)
      expect(html).not.toContain('noindex')
    }
  })

  test('citation meta tags are present once', () => {
    const html = read('guide', 'studio.html')
    for (const re of [/<meta name="author" content="[^"]+"/g, /<meta property="og:title"/g, /<meta property="og:description"/g,
      /<meta property="og:type" content="article"/g, /<meta property="og:url" content="https:\/\/docs\.example\.test\/brighttest\/guide\/studio"/g,
      /<meta name="twitter:card" content="summary"/g, /<meta name="description"/g]) {
      expect(count(html, re), String(re)).toBe(1)
    }
    expect(html).toMatch(/<meta property="article:modified_time" content="\d{4}-\d\d-\d\dT[^"]+Z"/)
    expect(read('index.html')).toContain('<meta property="og:type" content="website"')
  })

  test('JSON-LD parses and has the required fields', () => {
    const [art] = ldBlocks(read('guide', 'studio.html'))
    expect(ldBlocks(read('guide', 'studio.html'))).toHaveLength(1)
    expect(art['@type']).toBe('TechArticle')
    for (const k of ['headline', 'description', 'author', 'publisher', 'mainEntityOfPage', 'url']) expect(art[k], k).toBeTruthy()
    expect(art.url).toBe(`${ORIGIN}/brighttest/guide/studio`)
    expect(art.mainEntityOfPage['@id']).toBe(art.url)
    const home = ldBlocks(read('index.html'))
    expect(home).toHaveLength(2)
    const site = home.find((b) => b['@type'] === 'SoftwareSourceCode')
    for (const k of ['name', 'description', 'license', 'codeRepository', 'programmingLanguage', 'url']) expect(site[k], k).toBeTruthy()
    expect(site.license).toContain('MIT')
    expect(site.url).toBe(`${ORIGIN}/brighttest/`)
  })

  test('head output is clean under the deny-list check', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-denylist.js'), '--allow-missing', '--path', out, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    expect(r.status, r.stdout.slice(0, 500) + r.stderr.slice(0, 500)).toBe(0)
  })
})

describe('built next channel', () => {
  let out
  beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-seo-next-')); build('next', '/brighttest/next/', out) }, 180000)
  afterAll(() => { if (out) fs.rmSync(out, { recursive: true, force: true }) })
  test('no canonical, no JSON-LD, still noindex', () => {
    for (const f of [['index.html'], ['guide', 'studio.html']]) {
      const html = fs.readFileSync(path.join(out, ...f), 'utf8')
      expect(html).not.toContain('rel="canonical"')
      expect(html).not.toContain('application/ld+json')
      expect(html).toContain('<meta name="robots" content="noindex">')
    }
  })
})
