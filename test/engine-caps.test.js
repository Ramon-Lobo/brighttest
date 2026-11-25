import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const C = require('../lib/engine-caps.js')
const E = require('../lib/engines.js')

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-caps-')); E.resetEngines() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const eng = (over) => ({ flavor: 'patched', caps: [], nonDevice: [], stamp: { patches: {} }, ...over })
const probe = (caps) => ({ ok: true, caps, ms: 1 })

describe('compareCaps', () => {
  it('agrees when metadata and probe match; BRS-02 is flagged non-device', () => {
    const r = C.compareCaps(eng({ caps: ['BRS-02', 'BRS-03'], nonDevice: ['BRS-02'] }), probe({ 'BRS-02': 1, 'BRS-03': 1, 'BRS-01': 0 }))
    expect(r.mismatches).toEqual([])
    expect(r.rows.find((x) => x.id === 'BRS-02')).toMatchObject({ metadata: true, probe: true, nonDevice: true })
  })
  it('flags a claimed capability the probe does not show (also unprobed ids)', () => {
    const r = C.compareCaps(eng({ caps: ['BRS-06'] }), probe({}))
    expect(r.mismatches.map((x) => x.id)).toEqual(['BRS-06'])
  })
  it('BRS-07 and BRS-08 are CLI-level: metadata only, no probe column, never a mismatch', () => {
    const r = C.compareCaps(eng({ caps: ['BRS-07', 'BRS-08'] }), probe({}))
    expect(r.mismatches).toEqual([])
    expect(r.rows.find((x) => x.id === 'BRS-07')).toMatchObject({ metadata: true, probe: null })
    expect(r.rows.find((x) => x.id === 'BRS-08')).toMatchObject({ metadata: true, probe: null })
  })
  it('flags a capability the probe shows but metadata lacks', () => {
    const r = C.compareCaps(eng({ caps: [] }), probe({ 'BRS-03': 1 }))
    expect(r.mismatches.map((x) => x.id)).toEqual(['BRS-03'])
  })
  it('stock: BRS-02 absent on both sides is not a mismatch', () => {
    const r = C.compareCaps(eng({ flavor: 'stock', stamp: null }), probe({ 'BRS-02': 0 }))
    expect(r.mismatches).toEqual([])
    expect(r.rows.find((x) => x.id === 'BRS-02')).toMatchObject({ metadata: false, probe: false, nonDevice: true })
  })
  it('unstamped patched build has no metadata to contradict', () => {
    const r = C.compareCaps(eng({ stamp: null }), probe({ 'BRS-02': 1 }))
    expect(r.metadataKnown).toBe(false)
    expect(r.mismatches).toEqual([])
  })
})

describe('findForceUpperCaseUse / warnNonDeviceUse', () => {
  function project() {
    fs.mkdirSync(path.join(dir, 'source', 'tests'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'source', 'tests', 'Title.spec.bs'), "a = 1\n\nl.forceUpperCase = true\n")
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'y.brs'), 'forceUpperCase\n')
    fs.writeFileSync(path.join(dir, 'source', 'other.brs'), 'print 1\n')
  }
  function engine(name, json) {
    const d = path.join(dir, 'node_modules', ...name.split('/'))
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, ...json }))
  }
  it('reports file:line and skips node_modules', () => {
    project()
    expect(C.findForceUpperCaseUse(dir)).toEqual([{ file: 'source/tests/Title.spec.bs', line: 3 }])
  })
  it('warns on stderr for a patched engine with BRS-02', () => {
    project()
    engine('@ramonlobo/brs-node', { version: '2.7.0-bt.1', brighttest: { patches: { 'BRS-02': 1 }, nonDevice: ['BRS-02'] } })
    const out = []
    const lines = C.warnNonDeviceUse({ rootDir: dir }, { err: (s) => out.push(s), opts: { paths: [dir] } })
    expect(lines).toHaveLength(1)
    expect(out.join('')).toMatch(/^nondevice-field: Label\.forceUpperCase used in source\/tests\/Title\.spec\.bs:3 \(non-device behavior/)
  })
  it('stays silent on stock and when the project does not use the field', () => {
    project()
    engine('brs-node', { version: '2.7.0' })
    expect(C.warnNonDeviceUse({ rootDir: dir }, { err: () => {}, opts: { paths: [dir] } })).toEqual([])
    fs.rmSync(path.join(dir, 'source', 'tests'), { recursive: true })
    engine('@ramonlobo/brs-node', { version: '2.7.0-bt.1', brighttest: { patches: { 'BRS-02': 1 } } })
    expect(C.warnNonDeviceUse({ rootDir: dir }, { err: () => {}, opts: { paths: [dir], } })).toEqual([])
  })
})
