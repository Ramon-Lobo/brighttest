import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'

// The deny-list check: a generic synthetic corpus with every planted value listed in seeded.json. After redact, no
// planted value may survive in any variant; verify must find every planted item on the raw corpus.
const require = createRequire(import.meta.url)
const R = require('../lib/redact')
const DIR = path.resolve(__dirname, 'fixtures', 'issue')
const files = fs.readdirSync(path.join(DIR, 'raw')).sort()
const raw = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(DIR, 'raw', f), 'utf8')]))
const seeded = JSON.parse(fs.readFileSync(path.join(DIR, 'seeded.json'), 'utf8'))

const makeCtx = (extra = {}) => R.createContext({
  ci: false,
  knownSecrets: [{ name: 'ROKU_PASSWORD', value: 'SEEDED-PASSWORD-0001' }],
  denyTerms: ['Examplecorp', 'Sample Channel'],
  projectRoots: ['/home/devuser-seeded/work/examplecorp-app'],
  homeDirs: [],
  ...extra,
})
const redactAll = (ctx) => {
  const out = R.redact(files.map((f) => ({ name: f, text: raw[f] })), ctx)
  return Object.fromEntries(out.map((o) => [o.name, o.text]))
}
const alnum = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const variants = (v) => [v, v.toLowerCase(), encodeURIComponent(v), Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64').replace(/=+$/, '')]
const survivors = (outputs) => {
  const found = []
  for (const s of seeded) {
    const text = outputs[s.file]
    const lc = text.toLowerCase()
    for (const v of variants(s.value)) if (lc.includes(v.toLowerCase())) found.push(`${s.file}: ${s.kind} (variant)`)
    if (alnum(s.value).length >= 8 && alnum(text).includes(alnum(s.value))) found.push(`${s.file}: ${s.kind} (separator variant)`)
  }
  return [...new Set(found)]
}

describe('survivor corpus', () => {
  test('the corpus and seeded list agree (every seeded value is in its raw file)', () => {
    for (const s of seeded) expect(raw[s.file], s.file).toContain(s.value)
  })

  test('no seeded value survives redact, in any variant', () => {
    expect(survivors(redactAll(makeCtx()))).toEqual([])
  })

  test('verify on the redacted corpus finds nothing', () => {
    const out = redactAll(makeCtx())
    for (const f of files) expect(R.verify(out[f], makeCtx()), f).toEqual([])
  })

  test('verify on the raw corpus finds every seeded item (recall 100%)', () => {
    const missed = []
    for (const s of seeded) {
      const lines = raw[s.file].split('\n')
      const idx = lines.findIndex((l) => l.includes(s.value))
      const leaks = R.verify(raw[s.file], makeCtx())
      if (!leaks.some((l) => l.kind === s.kind && (l.line === idx + 1 || (s.kind === 'private-key' && l.line >= idx - 1)))) missed.push(`${s.file}:${idx + 1} ${s.kind}`)
    }
    expect(missed).toEqual([])
  })

  test('verify output never contains a seeded value', () => {
    const all = JSON.stringify(files.map((f) => R.verify(raw[f], makeCtx())))
    for (const s of seeded) expect(all).not.toContain(s.value)
  })

  test('kept facts stay in the corpus after redact', () => {
    const out = redactAll(makeCtx())
    expect(out['instrument-build.log']).toContain('0.8.0-rc.0')
    expect(out['instrument-build.log']).toContain('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    expect(out['instrument-build.log']).toContain('http://127.0.0.1:4891/')
    expect(out['doctor-output.txt']).toContain('16.0.4.4116')
    expect(out['log-tail.txt']).toContain('&hFF')
  })

  test('line count is preserved for every file', () => {
    const out = redactAll(makeCtx())
    for (const f of files) expect(out[f].split('\n').length, f).toBe(raw[f].split('\n').length)
  })

  test('a deliberately weakened detector makes the guard fail (it bites)', () => {
    for (const kind of ['ipv4', 'deny-term', 'device-id', 'kv-secret']) {
      const weak = redactAll(makeCtx({ disable: [kind] }))
      expect(survivors(weak).length, `disabling ${kind} must leave a survivor`).toBeGreaterThan(0)
      // and verify (which ignores the disable list) still sees it
      const leaks = files.flatMap((f) => R.verify(weak[f], makeCtx({ disable: [kind] })))
      expect(leaks.some((l) => l.kind === kind), `verify finds ${kind}`).toBe(true)
    }
  })
})
