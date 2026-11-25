import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { parseArgs } = require('../bin/cli.js')
const { writeBsConfig, findNetSpecs } = require('../lib/config.js')
const nh = require('../lib/instrument/net-headless.js')
const headless = require('../lib/headless.js')

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-nethl-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const cfgAt = (root, over = {}) => ({
  rootDir: root, sourceGlobs: ['manifest', 'source/**/*'], testsFilePattern: '**/*.spec.bs', stagingDir: path.join(root, '.brighttest'), ...over,
})
const put = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const quiet = { log: () => {}, warn: () => {} }

describe('parseArgs net flags', () => {
  it('has no net options by default', () => {
    const o = parseArgs([])
    expect(o.netRecord).toBeUndefined()
    expect(o.netUnmatched).toBeUndefined()
  })
  it('--net-record without a value is true, with a file is the file', () => {
    expect(parseArgs(['--net-record']).netRecord).toBe(true)
    expect(parseArgs(['--net-record', '--no-sgnode']).netRecord).toBe(true)
    expect(parseArgs(['--net-record', 'out/x.har']).netRecord).toBe('out/x.har')
    expect(parseArgs(['--net-record=out/y.har']).netRecord).toBe('out/y.har')
  })
  it('--net-unmatched takes a policy in both forms', () => {
    expect(parseArgs(['--net-unmatched', 'passthrough']).netUnmatched).toBe('passthrough')
    expect(parseArgs(['--net-unmatched=fail']).netUnmatched).toBe('fail')
  })
})

describe('findNetSpecs and the device lane skip', () => {
  it('finds specs that use BTNet_ and their suite names', () => {
    put('source/tests/A.spec.bs', '@suite("alpha")\nBTNet_reset()\n')
    put('source/tests/B.spec.bs', '@suite("beta")\n')
    expect(findNetSpecs(cfgAt(tmp))).toEqual([{ path: 'source/tests/A.spec.bs', suites: ['alpha'] }])
  })
  it('the device bsconfig drops those specs; headless keeps them', () => {
    put('manifest', 'title=x\n')
    put('source/tests/A.spec.bs', '@suite("alpha")\nBTNet_reset()\n')
    const log = []
    const orig = console.log; console.log = (m) => log.push(m)
    let dev, hl
    try { dev = writeBsConfig(cfgAt(tmp), 'device'); hl = writeBsConfig(cfgAt(tmp), 'headless') } finally { console.log = orig }
    const read = (p) => JSON.parse(fs.readFileSync(p.bsconfigPath, 'utf8'))
    expect(read(dev).files).toContain('!source/tests/A.spec.bs')
    expect(read(hl).files).not.toContain('!source/tests/A.spec.bs')
    expect(log.join('\n')).toContain('skipped (headless-only network fixtures): source/tests/A.spec.bs')
  })
})

describe('writeBsConfig with extra.net', () => {
  it('adds the instrument plugin, options and a BT_config.brs pointing at the hub', () => {
    put('manifest', 'title=x\n')
    const { bsconfigPath } = writeBsConfig(cfgAt(tmp, { instrument: { strict: true, net: { fixtures: ['a.json'] } } }), 'headless', { net: { token: 'a'.repeat(32), host: '127.0.0.1', port: 4321 } })
    const bs = JSON.parse(fs.readFileSync(bsconfigPath, 'utf8'))
    expect(bs.plugins.length).toBe(2)
    expect(bs.plugins[1]).toMatch(/instrument[\\/]plugin\.js$/)
    expect(bs.instrument).toMatchObject({ net: { fixtures: ['a.json'] }, scene: false, op: false })
    expect(bs.instrument.strict).toBeUndefined()
    const entry = bs.files.find((f) => f && f.dest === 'source/bt/BT_config.brs')
    const src = fs.readFileSync(entry.src, 'utf8')
    expect(src).toContain('port: 4321')
    expect(src).toContain('a'.repeat(32))
  })
  it('without extra.net the bsconfig is unchanged (one plugin, no instrument block)', () => {
    put('manifest', 'title=x\n')
    const { bsconfigPath } = writeBsConfig(cfgAt(tmp), 'headless')
    const bs = JSON.parse(fs.readFileSync(bsconfigPath, 'utf8'))
    expect(bs.plugins.length).toBe(1)
    expect(bs.instrument).toBeUndefined()
  })
})

describe('net-headless isActive / prepare', () => {
  it('is inactive without flags, config or BTNet_ specs', () => {
    put('source/tests/A.spec.bs', '@suite("a")\n')
    expect(nh.isActive(cfgAt(tmp), {})).toBe(false)
    expect(nh.prepare(cfgAt(tmp), {}, quiet)).toBe(null)
  })
  it('is active for flags, instrument.net true / fixture keys, and BTNet_ specs', () => {
    expect(nh.isActive(cfgAt(tmp), { netUnmatched: 'fail' })).toBe(true)
    expect(nh.isActive(cfgAt(tmp), { netRecord: true })).toBe(true)
    expect(nh.isActive(cfgAt(tmp, { instrument: { net: true } }), {})).toBe(true)
    expect(nh.isActive(cfgAt(tmp, { instrument: { net: { fixtures: [] } } }), {})).toBe(true)
    expect(nh.isActive(cfgAt(tmp, { instrument: { net: { receivers: { allow: [] } } } }), {})).toBe(false)
    put('source/tests/A.spec.bs', 'BTNet_reset()\n')
    expect(nh.isActive(cfgAt(tmp), {})).toBe(true)
  })
  it('loads fixtures in order and refuses globs that match nothing or escape the root', () => {
    put('fx/a.rules.json', JSON.stringify([{ url: 'https://h.example/a', status: 200 }]))
    put('fx/b.rules.json', JSON.stringify({ rules: [{ url: 'https://h.example/b', status: 201 }] }))
    const s = nh.prepare(cfgAt(tmp, { instrument: { net: { fixtures: ['fx/*.rules.json'] } } }), {}, quiet)
    expect(s.ruleSet.configCount()).toBe(2)
    expect(() => nh.prepare(cfgAt(tmp, { instrument: { net: { fixtures: ['nope/*.json'] } } }), {}, quiet)).toThrow(/matched no files/)
    expect(() => nh.prepare(cfgAt(tmp, { instrument: { net: { fixtures: ['../x.json'] } } }), {}, quiet)).toThrow(/inside the project root/)
    s.finish()
  })
  it('--net-record needs upstreamHosts; --net-unmatched is validated', () => {
    expect(() => nh.prepare(cfgAt(tmp), { netRecord: true }, quiet)).toThrow(/upstreamHosts/)
    expect(() => nh.prepare(cfgAt(tmp), { netUnmatched: 'bogus' }, quiet)).toThrow(/--net-unmatched/)
  })
  it('finish writes last-run.ndjson (redacted events) and the HAR when recording', () => {
    const cfg = cfgAt(tmp, { instrument: { net: { upstreamHosts: ['h.example'] } } })
    const har = path.join(tmp, 'rec.har')
    const lines = []
    const s = nh.prepare(cfg, { netRecord: har }, { log: (m) => lines.push(m), warn: () => {} })
    expect(lines.join('\n')).toContain('upstream hosts: h.example')
    s.events.push({ v: 1, ts: 't', kind: 'net.error', data: { kind: 'unmatched', detail: 'GET https://h.example/z' } })
    const r = s.finish()
    expect(r.failing.length).toBe(1)
    expect(fs.readFileSync(path.join(tmp, '.brighttest/net/last-run.ndjson'), 'utf8')).toContain('"unmatched"')
    expect(JSON.parse(fs.readFileSync(har, 'utf8')).log.version).toBe('1.2')
    expect(lines.join('\n')).toContain('Network failures (1)')
  })
})

describe('headless.withHub with a net session', () => {
  it('uses the session token and mounts its proxy', async () => {
    const seen = {}
    const hubMod = require('../lib/instrument/hub.js')
    const deps = { startHub: async (o) => { seen.o = o; return hubMod.startHub(o) }, localLease: hubMod.localLease }
    const proxy = { handle: async () => {} }
    await headless.withHub(async (hub) => { expect(hub.port).toBeGreaterThan(0) }, deps, { token: 'tok', proxy })
    expect(seen.o.tokens).toEqual(['tok'])
    expect(seen.o.netProxy).toBe(proxy)
  })
})

describe('isActive only counts BTNet_ specs that would run', () => {
  const suite = (ann, body = 'BTNet_mock({ url: "x" })') => `${ann}\nclass S\n  sub t()\n    ${body}\n  end sub\nend class\n`
  const active = (over) => nh.isActive(cfgAt(tmp, over))
  it('a non-ignored BTNet_ suite triggers', () => {
    put('source/a.spec.bs', suite('@suite("A")'))
    expect(active()).toBe(true)
  })
  it('an ignored suite does not trigger (either annotation order)', () => {
    put('source/a.spec.bs', suite('@suite("A")\n@ignore'))
    expect(active()).toBe(false)
    put('source/a.spec.bs', suite('@ignore\n@suite("A")'))
    expect(active()).toBe(false)
    expect(findNetSpecs(cfgAt(tmp)).length).toBe(1) // the device lane still drops it
  })
  it('mixed file: ignored BTNet_ suite plus a running BTNet_ suite triggers; plus a running plain suite does not', () => {
    put('source/a.spec.bs', suite('@suite("A")\n@ignore') + suite('@suite("B")'))
    expect(active()).toBe(true)
    put('source/a.spec.bs', suite('@suite("A")\n@ignore') + suite('@suite("B")', 'print 1'))
    expect(active()).toBe(false)
  })
  it('@ignore in a comment or string is not a marker', () => {
    put('source/a.spec.bs', suite("@suite(\"A\")\n' @ignore\n@tags(\"@ignore\")"))
    expect(active()).toBe(true)
  })
  it('BTNet_ only in a comment or string does not trigger', () => {
    put('source/a.spec.bs', suite('@suite("A")', "print \"BTNet_mock\" ' BTNet_fault"))
    expect(active()).toBe(false)
  })
  it('handles CRLF line endings', () => {
    put('source/a.spec.bs', suite('@suite("A")\n@ignore').replace(/\n/g, '\r\n'))
    expect(active()).toBe(false)
  })
  it('honours testsFilePattern, with Windows separators in the pattern', () => {
    put('source/a.spec.bs', suite('@suite("A")'))
    put('other/b.spec.bs', suite('@suite("B")'))
    expect(active({ testsFilePattern: 'other\\**\\*.spec.bs' })).toBe(true)
    expect(active({ testsFilePattern: 'nowhere\\**\\*.spec.bs' })).toBe(false)
    expect(active({ testsFilePattern: ['**/*.spec.bs', '!source/**'] })).toBe(true)
    fs.rmSync(path.join(tmp, 'other'), { recursive: true })
    expect(active({ testsFilePattern: ['**/*.spec.bs', '!source\\**'] })).toBe(false)
  })
  it('explicit instrument.net still activates', () => {
    put('source/a.spec.bs', suite('@suite("A")\n@ignore'))
    expect(active({ instrument: { net: true } })).toBe(true)
  })
})
