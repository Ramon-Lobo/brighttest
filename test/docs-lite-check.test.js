import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const { extract, check, proseWarnings } = require('../scripts/docs-lite-check.js')
const root = path.resolve(__dirname, '..')

const GOOD_LITE = [
  '# Probe', '', '::: info At a glance', 'Short.', ':::', '',
  '## Run it', '', 'Use `brighttest doctor --json` and EXAMPLE_TOKEN; it exits 2 after 30 s.', '',
  '## Related', '', '- [Other](/other)', '', '**Full guide:** [Probe](full:/probe)', '',
].join('\n')
const GOOD_FULL = [
  '# Probe', '', '## Run it', '', 'Use `brighttest doctor --json` and EXAMPLE_TOKEN; it exits 2 after 30 s.', '',
].join('\n')

describe('docs-lite-check (fixtures)', () => {
  let dir
  const write = (rel, text) => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
  }
  const run = (extra = {}) => check({ docsDir: dir, liteOnly: [], fullOnly: [], ...extra })
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-lite-check-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('passes when every token is present and the structure is complete', () => {
    write('probe.md', GOOD_FULL)
    write('lite/probe.md', GOOD_LITE)
    const r = run()
    expect(r.failures).toEqual([])
    expect(r.pages).toBe(1)
    expect(r.tokens).toBeGreaterThan(3)
  })

  it('fails on a missing token', () => {
    write('probe.md', GOOD_FULL + '\nAlso `--example-flag` and MISSING_CODE.\n')
    write('lite/probe.md', GOOD_LITE)
    const msgs = run().failures.map((f) => f.message)
    expect(msgs).toContain('missing flag --example-flag')
    expect(msgs).toContain('missing code MISSING_CODE')
  })

  it('accepts a renamed heading with a covers comment', () => {
    write('probe.md', GOOD_FULL + '\n## Original title\n')
    write('lite/probe.md', GOOD_LITE + '\n<!-- covers: Original title -->\n')
    expect(run().failures).toEqual([])
  })

  it('fails on a missing structural element', () => {
    write('probe.md', GOOD_FULL)
    write('lite/probe.md', GOOD_LITE.replace('::: info At a glance', '::: tip Hint').replace('## Related', '## See also'))
    const msgs = run().failures.filter((f) => f.kind === 'structure').map((f) => f.message)
    expect(msgs).toEqual(['no "At a glance" box', 'no "Related" section'])
  })

  it('fails on an unlisted lite-only page and accepts a listed one', () => {
    write('probe.md', GOOD_FULL)
    write('lite/probe.md', GOOD_LITE)
    write('lite/extra.md', '# Extra\n\n::: info At a glance\nx\n:::\n')
    expect(run().failures.map((f) => f.kind)).toEqual(['twin'])
    expect(run({ liteOnly: ['extra.md'] }).failures).toEqual([])
  })

  it('fails on a full page with no lite page unless it is listed as full-only', () => {
    write('probe.md', GOOD_FULL)
    write('lite/probe.md', GOOD_LITE)
    write('solo.md', '# Solo\n')
    expect(run().failures.map((f) => f.kind)).toEqual(['lite-missing'])
    expect(run({ fullOnly: ['solo.md'] }).failures).toEqual([])
  })

  it('suppresses a token with an ignore entry and fails an entry with an empty reason', () => {
    write('probe.md', GOOD_FULL + '\nAlso MISSING_CODE.\n')
    write('lite/probe.md', GOOD_LITE)
    const ok = run({ ignore: { 'probe.md': { MISSING_CODE: 'internal detail' } } })
    expect(ok.failures).toEqual([])
    expect(ok.ignored).toBe(1)
    const star = run({ ignore: { '*': { MISSING_CODE: 'internal detail' } } })
    expect(star.failures).toEqual([])
    const bad = run({ ignore: { 'probe.md': { MISSING_CODE: ' ' } } })
    expect(bad.failures.map((f) => f.kind).sort()).toEqual(['ignore', 'missing-token'])
  })

  it('reports prose warnings only with strict', () => {
    write('probe.md', GOOD_FULL)
    write('lite/probe.md', GOOD_LITE + '\n' + Array(6).fill('one more line of prose here').join('\n') + '\n')
    expect(run().warnings).toEqual([])
    const r = run({ strict: true })
    expect(r.failures).toEqual([])
    expect(r.warnings.length).toBe(1)
    expect(proseWarnings('a\nb\nc\nd\ne\n').length).toBe(1)
  })
})

describe('docs-lite-check (real repo)', () => {
  // Token counts printed by the planning tool coverage.mjs --json for the same pages (update when these pages change).
  const parity = { 'guide/studio.md': 139, 'e2e/flows.md': 36, 'guide/cli-reference.md': 201 }
  for (const [page, count] of Object.entries(parity)) {
    it(`extracts the same token count as coverage.mjs for ${page}`, () => {
      const md = fs.readFileSync(path.join(root, 'docs', page), 'utf8')
      expect(extract(md, page).size).toBe(count)
    })
  }

  it('passes on the real docs tree', () => {
    const ignoreFile = path.join(root, 'docs/.vitepress/lite-coverage-ignore.json')
    const ignore = JSON.parse(fs.readFileSync(ignoreFile, 'utf8'))
    const r = check({ docsDir: path.join(root, 'docs'), ignore, strict: true })
    expect(r.failures).toEqual([])
    if (r.warnings.length) console.warn(`docs-lite-check: ${r.warnings.length} prose warnings`)
  })
})
