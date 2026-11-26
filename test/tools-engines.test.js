import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const E = require('../lib/engines.js')

let dir
function pkg(name, json) {
  const d = path.join(dir, 'node_modules', ...name.split('/'))
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, ...json }))
}
const STAMP = { upstream: 'brs-node@2.7.0', patches: { 'BRS-01': 1, 'BRS-03': 1, 'BRS-02': 1 }, nonDevice: ['BRS-02'] }
const __dirname_ = path.dirname(fileURLToPath(import.meta.url))
const P = () => ({ paths: [dir] })

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-eng-')); E.resetEngines(); E.resetBanner() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('resolveEngine', () => {
  it('auto picks patched and reads the stamp (caps + nonDevice)', () => {
    pkg('@ramonlobo/brs-node', { version: '2.7.0-bt.1', bin: { 'brs-cli': 'bin/x.js' }, brighttest: STAMP })
    pkg('brs-node', { version: '2.7.0', bin: { 'brs-cli': 'bin/x.js' } })
    const e = E.resolveEngine('brsNode', 'auto', P())
    expect(e).toMatchObject({ name: '@ramonlobo/brs-node', flavor: 'patched', version: '2.7.0-bt.1', nonDevice: ['BRS-02'] })
    expect(e.caps.sort()).toEqual(['BRS-01', 'BRS-02', 'BRS-03'])
  })
  it('stock mode picks stock with no stamp; caps come from UPSTREAM_SINCE <= version', () => {
    pkg('@ramonlobo/brs-node', { version: '2.7.0-bt.1', brighttest: STAMP })
    pkg('brs-node', { version: '2.8.0' })
    const table = { brsNode: { 'BRS-03': '2.8.0', 'BRS-04': '2.9.0' } }
    const e = E.resolveEngine('brsNode', 'stock', { ...P(), upstreamSince: table })
    expect(e).toMatchObject({ name: 'brs-node', flavor: 'stock', stamp: null, nonDevice: [] })
    expect(e.caps).toEqual(['BRS-03'])
  })
  it('auto falls back to stock when patched is missing', () => {
    pkg('rooibos-roku', { version: '5.17.0' })
    expect(E.resolveEngine('rooibos', 'auto', P())).toMatchObject({ name: 'rooibos-roku', flavor: 'stock' })
  })
  it('missing engine is a hard error with an install hint', () => {
    expect(() => E.resolveEngine('brsNode', 'stock', P())).toThrow(/npm i brs-node/)
    expect(() => E.resolveEngine('brsNode', 'auto', P())).toThrow(/not found/)
    try { E.resolveEngine('rooibos', 'patched', P()) } catch (e) { expect(e.code).toBe('ENGINE_MISSING') }
  })
  it('explicit patched never falls back to stock', () => {
    pkg('brs-node', { version: '2.7.0' })
    expect(() => E.resolveEngine('brsNode', 'patched', P())).toThrow(/@ramonlobo\/brs-node/)
  })
  it('explicit package name works; unknown name lists the valid names', () => {
    pkg('brs-node', { version: '2.7.0' })
    expect(E.resolveEngine('brsNode', 'brs-node', P()).name).toBe('brs-node')
    let err
    try { E.resolveEngine('brsNode', 'foo', P()) } catch (e) { err = e }
    expect(err.code).toBe('ENGINE_UNKNOWN')
    for (const n of ['auto', 'patched', 'stock', 'brs-node', '@ramonlobo/brs-node', 'rooibos-roku', '@ramonlobo/rooibos-roku']) expect(err.message).toContain(n)
  })
  it('compares versions', () => {
    expect(E.cmpVersion('2.7.0-bt.1', '2.7.0')).toBe(0)
    expect(E.cmpVersion('2.10.0', '2.9.9')).toBe(1)
    expect(E.cmpVersion('2.7.0', '2.8.0')).toBe(-1)
  })
})

describe('engineMode precedence', () => {
  it('defaults to auto; config applies; env beats config and records the override', () => {
    expect(E.engineMode('brsNode', { env: {}, cfg: {} })).toMatchObject({ mode: 'auto', source: 'default' })
    expect(E.engineMode('brsNode', { env: {}, cfg: { engines: { brsNode: 'stock' } } })).toMatchObject({ mode: 'stock', source: 'config' })
    expect(E.engineMode('brsNode', { env: { BRIGHTTEST_ENGINES: 'patched' }, cfg: { engines: { brsNode: 'stock' } } }))
      .toMatchObject({ mode: 'patched', source: 'env', overrides: 'stock' })
  })
})

describe('BRIGHTTEST_ENGINES naming a package', () => {
  const both = () => {
    pkg('@ramonlobo/brs-node', { version: '2.7.0-bt.1', bin: { 'brs-cli': 'x.js' }, brighttest: STAMP })
    pkg('brs-node', { version: '2.7.0', bin: { 'brs-cli': 'x.js' } })
    pkg('@ramonlobo/rooibos-roku', { version: '5.17.0-bt.1', bin: { rooibos: 'x.js' }, brighttest: { patches: {} } })
    pkg('rooibos-roku', { version: '5.17.0', bin: { rooibos: 'x.js' } })
  }
  const viaEnv = (kind, name) => E.engineFor(kind, {}, { ...P(), env: { BRIGHTTEST_ENGINES: name } })
  it('each kind resolves its own package of the named flavor', () => {
    both()
    expect(viaEnv('brsNode', '@ramonlobo/brs-node').name).toBe('@ramonlobo/brs-node')
    expect(viaEnv('rooibos', '@ramonlobo/brs-node').name).toBe('@ramonlobo/rooibos-roku')
    expect(viaEnv('brsNode', 'rooibos-roku').name).toBe('brs-node')
    expect(viaEnv('rooibos', 'rooibos-roku').name).toBe('rooibos-roku')
  })
  it('unset env still resolves auto (patched first)', () => {
    both()
    expect(E.engineFor('rooibos', {}, { ...P(), env: {} }).name).toBe('@ramonlobo/rooibos-roku')
  })
})

describe('banner', () => {
  it('names name, version and flavor for both engines; marks non-device and env override', () => {
    pkg('@ramonlobo/brs-node', { version: '2.7.0-bt.1', brighttest: STAMP })
    pkg('@ramonlobo/rooibos-roku', { version: '5.17.0-bt.1', brighttest: { patches: { 'ROO-04': 1 } } })
    const lines = []
    const line = E.printBanner({ engines: { brsNode: 'stock' } }, (s) => lines.push(s), { ...P(), env: { BRIGHTTEST_ENGINES: 'patched' } })
    expect(line).toContain('engine: @ramonlobo/brs-node@2.7.0-bt.1 (patched: BRS-01, BRS-03; non-device: BRS-02')
    expect(line).toContain("env overrides config 'stock'")
    expect(line).toContain('rooibos 5.17.0-bt.1 (patched: ROO-04')
    expect(lines).toHaveLength(1)
    expect(E.printBanner({}, (s) => lines.push(s), { ...P() })).toBeNull() // once per run
  })
  it('shows stock', () => {
    pkg('brs-node', { version: '2.7.0' }); pkg('rooibos-roku', { version: '5.17.0' })
    const line = E.printBanner({}, () => {}, { ...P(), env: { BRIGHTTEST_ENGINES: 'stock' } })
    expect(line).toBe('engine: brs-node@2.7.0 (stock) · rooibos 5.17.0 (stock)')
  })
})

describe('sites', () => {
  it('no lib file hard-codes the scoped engine names outside engines.js', () => {
    const skip = new Set(['engines.js'])
    for (const f of fs.readdirSync(path.join(__dirname_, '../lib')).filter((x) => x.endsWith('.js') && !skip.has(x))) {
      expect(fs.readFileSync(path.join(__dirname_, '../lib', f), 'utf8'), f).not.toMatch(/(resolveBin|resolvePackageMain)\('@ramonlobo\//)
    }
  })
})
