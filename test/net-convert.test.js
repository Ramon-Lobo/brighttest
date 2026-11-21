import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const R = require('../lib/instrument/net-rules.js')
const C = require('../lib/instrument/net-convert.js')
const nh = require('../lib/instrument/net-headless.js')
const { parseNetArgs } = require('../bin/cli.js')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const HAR = path.join(HERE, 'fixtures', 'net-convert', 'sample.har')

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-netconv-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('convertHar', () => {
  const res = C.convertFile(HAR)
  it('makes one rule per entry with deterministic ids', () => {
    expect(res.rules.map((r) => r.id)).toEqual(['har-1', 'har-2', 'har-3', 'har-4', 'har-5'])
    expect(C.convertFile(HAR)).toEqual(res)
  })
  it('uses json for JSON bodies and keeps status and method', () => {
    expect(res.rules[0]).toMatchObject({ method: 'GET', status: 200, json: { title: 'Hero' } })
    expect(res.rules[4]).toMatchObject({ method: 'POST', status: 204 })
  })
  it('limits repeated method+url to one use each, in order', () => {
    expect(res.rules[1].times).toBe(1)
    expect(res.rules[2].times).toBeUndefined()
  })
  it('keeps redacted values redacted and notes them', () => {
    const text = JSON.stringify(res.rules[3])
    expect(res.rules[3].url).toContain('token=*')
    expect(res.rules[3].headers['set-cookie']).toBe('')
    expect(text).toContain('<redacted:name>')
    expect(res.notes.map((n) => n.id)).toEqual(['har-4'])
  })
  it('output loads through the real validator and replays in order', () => {
    const file = path.join(tmp, 'out.rules.json')
    fs.writeFileSync(file, JSON.stringify({ rules: res.rules }))
    const set = R.createRuleSet({ root: tmp })
    set.addConfig(R.loadRulesFile(file), { source: 'fixture' })
    const hit = (m, u) => set.match({ method: m, url: u, headers: {}, body: '' })
    expect(hit('GET', 'https://api.example.test/v1/home').response.json).toEqual({ title: 'Hero' })
    expect(hit('GET', 'https://api.example.test/v1/poll').response.status).toBe(202)
    expect(hit('GET', 'https://api.example.test/v1/poll').response.status).toBe(200)
    expect(hit('GET', 'https://api.example.test/v1/me?token=abc').response.status).toBe(200)
    expect(hit('GET', 'https://api.example.test/v1/other')).toBeNull()
  })
})

describe('net convert CLI body', () => {
  const sink = () => { const o = { out: [], err: [] }; o.log = (m) => o.out.push(m); o.errf = (m) => o.err.push(m); return o }
  it('parses args', () => {
    expect(parseNetArgs(['convert', 'a.har', '-o', 'r.json'])).toMatchObject({ action: 'convert', file: 'a.har', out: 'r.json' })
  })
  it('writes the rules file with -o', () => {
    const s = sink(); const out = path.join(tmp, 'r', 'x.rules.json')
    expect(C.run({ file: HAR, out }, { log: s.log, err: s.errf })).toBe(0)
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).rules).toHaveLength(5)
  })
  it('exits non-zero for a missing, unparseable or non-HAR input', () => {
    const bad = path.join(tmp, 'bad.json'); fs.writeFileSync(bad, '{"a":1}')
    const junk = path.join(tmp, 'junk.har'); fs.writeFileSync(junk, 'nope')
    for (const f of [path.join(tmp, 'missing.har'), bad, junk]) {
      const s = sink()
      expect(C.run({ file: f }, { log: s.log, err: s.errf })).toBe(1)
      expect(s.err.join('\n')).toMatch(/net convert:/)
    }
    expect(C.run({}, { err: () => {} })).toBe(2)
  })
})

describe('unmatched summary', () => {
  it('lists unmatched requests as method and path with a count', () => {
    const cfg = { rootDir: tmp, sourceGlobs: [], stagingDir: path.join(tmp, '.brighttest'), instrument: { net: true } }
    const lines = []
    const s = nh.prepare(cfg, {}, { log: (m) => lines.push(m), warn: () => {} })
    s.events.push({ v: 1, ts: 't', kind: 'net.error', data: { kind: 'unmatched', detail: 'GET https://h.example.test/a/b?secret=1' } })
    s.events.push({ v: 1, ts: 't', kind: 'net.error', data: { kind: 'unmatched', detail: 'POST https://h.example.test/c' } })
    const r = s.finish()
    const text = lines.join('\n')
    expect(text).toContain('Unmatched requests (2)')
    expect(text).toContain('    GET /a/b')
    expect(text).toContain('    POST /c')
    expect(text).not.toContain('Unmatched requests (2)\n    GET https')
    expect(r.unmatched).toEqual(['GET /a/b', 'POST /c'])
  })
})
