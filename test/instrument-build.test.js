import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

// INS-F-T2: lib/instrument/build.js gates (ADR 0019 Amendment (d) R1, R5), the generated BT_config.brs and the config lane.
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { build, tripsStrict, renderBtConfig, validateStateConfig, STRICT_TABLE } = require('../lib/instrument/build')
const { verify } = require('../lib/instrument/verify')
const { loadConfig, writeBsConfig } = require('../lib/config')
const createPlugin = require('../lib/instrument/plugin')
const fx = (n) => path.resolve(__dirname, 'fixtures/instrument-plugin', n)
const breakRewrite = fx('break-rewrite.js')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ibuild-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true })
  return to
}
function mkapp(name, files, config) {
  const dir = path.join(tmp, 'app-' + name)
  const all = { manifest: 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n', 'source/main.brs': 'sub main()\nend sub\n', ...files }
  if (config) all['brighttest.json'] = JSON.stringify(config)
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
const cfgFor = (dir, name, extra = {}) => ({ ...loadConfig(dir), stagingDir: path.join(tmp, 'stage-' + name), ...extra })
const run = (dir, name, opts = {}, cfgExtra = {}) => {
  const lines = []
  return build(cfgFor(dir, name, cfgExtra), { log: (l) => lines.push(l), out: path.join(tmp, 'out-' + name + '.zip'), ...opts })
    .then((r) => ({ ...r, log: lines, out: opts.out || path.join(tmp, 'out-' + name + '.zip') }))
}
const hashTree = (dir) => {
  const h = crypto.createHash('sha1')
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else h.update(path.relative(dir, p)).update(fs.readFileSync(p))
  })
  walk(dir)
  return h.digest('hex')
}
const zipText = async (zipPath, entry) => {
  const z = await JSZip.loadAsync(fs.readFileSync(zipPath))
  const f = z.file(entry)
  return f ? f.async('string') : null
}
const tmpLeft = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.tmp\.zip$/.test(n)) : []

describe('instrument build: main kept, specs dropped', () => {
  it('keeps source/main.brs even when sourceGlobs negate it, and excludes source/tests/**', async () => {
    const dir = mkapp('mainkept', { 'source/tests/A.spec.brs': "sub spec()\nend sub\n" })
    const r = await run(dir, 'mainkept', {}, { sourceGlobs: ['manifest', 'source/**/*', '!source/main.brs'] })
    expect(r.exitCode).toBe(0)
    const z = await JSZip.loadAsync(fs.readFileSync(r.out))
    const names = Object.keys(z.files)
    expect(names).toContain('source/main.brs')
    expect(names.filter((n) => n.startsWith('source/tests/'))).toEqual([])
  })
  it('instrumentGlobs: drops the main negation, adds the tests negation once', () => {
    const { instrumentGlobs } = require('../lib/instrument/build')
    expect(instrumentGlobs(['source/**/*', '!source/main.brs'])).toEqual(['source/**/*', '!source/tests/**'])
    expect(instrumentGlobs(['a', '!source/tests/**'])).toEqual(['a', '!source/tests/**'])
  })
})

describe('instrument build: success path', () => {
  const src = () => path.join(tmp, 'good')
  beforeAll(() => { copyTree(fx('extends-group'), src()) })

  it('writes the package to --out, leaves the user tree untouched and verify flags it', async () => {
    const before = hashTree(src())
    const r = await run(src(), 'good')
    expect(r.exitCode).toBe(0)
    expect(fs.existsSync(r.out)).toBe(true)
    expect(hashTree(src())).toBe(before)
    expect(fs.existsSync(path.join(src(), 'source/bt'))).toBe(false)
    expect(tmpLeft(path.dirname(r.out))).toEqual([])
    const mf = await zipText(r.out, 'manifest')
    expect(mf).toContain('bt_instrumented=1')
    expect(mf).toContain('BT_AGENT=true')
    expect((await verify(r.out)).exitCode).toBe(3)
    expect(r.log.join('\n')).toMatch(/instrument build: wrote /)
    expect(await zipText(r.out, 'components/base.brs')).toMatch(/BT_bootstrap/)
  })

  it('bakes a fresh 128-bit token into source/bt/BT_config.brs per build and never prints it', async () => {
    const a = await run(src(), 'tok-a')
    const b = await run(src(), 'tok-b')
    const pick = async (z) => /token:\s*"([0-9a-f]{32})"/.exec(await zipText(z, 'source/bt/BT_config.brs'))
    const ta = await pick(a.out); const tb = await pick(b.out)
    expect(ta && tb).toBeTruthy()
    expect(ta[1]).not.toBe(tb[1])
    for (const r of [a, b]) for (const t of [ta[1], tb[1]]) expect(r.log.join('\n')).not.toContain(t)
    expect((await zipText(a.out, 'source/bt/BT_config.brs')).match(/token:/g)).toHaveLength(1)
    // the generated file does not survive in the staging dir
    const stage = path.join(tmp, 'stage-tok-a', 'instrument')
    expect(fs.readdirSync(stage).filter((n) => n.startsWith('gen-'))).toEqual([])
  })

  it('renders BT_config with hub, features and caps from the instrument block', () => {
    const t = renderBtConfig('0'.repeat(32), { hub: { host: '10.0.0.2', port: 9000 }, net: false, state: { caps: { depth: 3 } } })
    expect(t).toContain('hub: { host: "10.0.0.2", port: 9000 }')
    expect(t).toContain('features: { net: false, state: true, op: true }')
    expect(t).toContain('depth: 3, arrayItems: 50, stringBytes: 2048')
    expect(t.startsWith('#if BT_AGENT')).toBe(true)
  })

  it('emits redact.paths, publish.maxBytes and publish.intervalMs when set, nothing when unset (BT-CFG-EMIT)', () => {
    const z = '0'.repeat(32)
    const t = renderBtConfig(z, { state: { redact: { paths: ['global.user.x', 'registry.dummy.*'] }, publish: { maxBytes: 4096, intervalMs: 250 } } })
    expect(t).toContain('redact: { paths: ["global.user.x", "registry.dummy.*"] }')
    expect(t).toContain('publish: { maxBytes: 4096, intervalMs: 250 }')
    expect(renderBtConfig(z, { state: { publish: { intervalMs: 300 } } })).toContain('publish: { intervalMs: 300 }')
    expect(renderBtConfig(z, { state: { redact: { paths: [] } } })).toContain('redact: { paths: [] }')
    const base = renderBtConfig(z, { state: { caps: { depth: 3 } } })
    for (const inst of [undefined, {}, { state: {} }, { state: { redact: {}, publish: {} } }, { state: { publish: { label: true } } }]) {
      const o = renderBtConfig(z, inst)
      expect(o).not.toContain('redact'); expect(o).not.toContain('publish')
    }
    expect(renderBtConfig(z, { state: { caps: { depth: 3 }, redact: {}, publish: {} } })).toBe(base)
  })

  it('emits callFuncAllow from instrument.state.callable, nothing when unset (STA-S-T6-F1)', () => {
    const z = '0'.repeat(32)
    const t = renderBtConfig(z, { state: { callable: ['resetCounter', 'ns_BT_url'] } })
    expect(t).toContain('        callFuncAllow: ["resetCounter", "ns_BT_url"]\n')
    expect(renderBtConfig(z, { state: { callable: [] } })).not.toContain('callFuncAllow')
    const base = renderBtConfig(z, { state: { caps: { depth: 3 } } })
    expect(base).not.toContain('callFuncAllow')
    expect(renderBtConfig(z, { state: { caps: { depth: 3 }, callable: [] } })).toBe(base)
    expect(() => validateStateConfig({ state: { callable: ['a_b', 'bt_reset', '_x1'] } })).not.toThrow()
  })

  it('snapshots the BT_config fragment with callFuncAllow', () => {
    const t = renderBtConfig('0'.repeat(32), { hub: { host: '10.0.0.2', port: 9000 }, state: { registrySections: ['prefs'], callable: ['resetHome'] } })
    expect(t).toBe([
      '#if BT_AGENT',
      "' brighttest instrument config. Generated for this build only; not part of the source tree.",
      'function BT_config() as object',
      '    return {',
      `        token: "${'0'.repeat(32)}"`,
      '        hub: { host: "10.0.0.2", port: 9000 }',
      '        features: { net: true, state: true, op: true }',
      '        registrySections: ["prefs"]',
      '        callFuncAllow: ["resetHome"]',
      '        caps: { depth: 6, arrayItems: 50, stringBytes: 2048 }',
      '    }',
      'end function',
      '#end if',
      '',
    ].join('\n'))
  })

  it.each([
    ['instrument.state.callable must be an array of strings', 'resetHome'],
    ['instrument.state.callable must be an array of strings', ['a', 3]],
    ['instrument.state.callable entries must be identifiers', ['bad name']],
    ['instrument.state.callable entries must be identifiers', ['x.fn']],
    ['instrument.state.callable entries must be identifiers', ['1abc']],
    ['instrument.state.callable entries must be identifiers', ['a'.repeat(65)]],
    ['instrument.state.callable entries must be identifiers', ['']],
    ['instrument.state.callable has a duplicate name', ['go', 'GO']],
    ['instrument.state.callable must have at most 64 names', Array.from({ length: 65 }, (_, i) => 'f' + i)],
  ])('rejects instrument.state.callable (%s)', (msg, v) => {
    expect(() => validateStateConfig({ state: { callable: v } })).toThrow(msg)
  })

  it.each([
    ['instrument.state.redact.paths', { redact: { paths: 'a.b' } }],
    ['instrument.state.redact.paths', { redact: { paths: ['a', 3] } }],
    ['instrument.state.publish.maxBytes', { publish: { maxBytes: '4096' } }],
    ['instrument.state.publish.intervalMs', { publish: { intervalMs: 2.5 } }],
  ])('fails the build naming %s on a wrong type', async (key, state) => {
    const name = 'cfgbad-' + Math.random().toString(36).slice(2, 8)
    const dir = mkapp(name, {}, { instrument: { state } })
    const r = await run(dir, name)
    expect(r.exitCode).not.toBe(0)
    expect(r.out === null || !fs.existsSync(r.out)).toBe(true)
    expect(r.log.join('\n')).toContain(key)
  })

  it.each([
    ['maxBytes', 1024, true], ['maxBytes', 1048576, true], ['maxBytes', 1023, false], ['maxBytes', 1048577, false],
    ['intervalMs', 100, true], ['intervalMs', 60000, true], ['intervalMs', 99, false], ['intervalMs', 60001, false],
  ])('publish.%s=%s range check (accepted: %s)', (k, v, ok) => {
    const call = () => validateStateConfig({ state: { publish: { [k]: v } } })
    if (ok) return expect(call).not.toThrow()
    expect(call).toThrow(`instrument.state.publish.${k} must be an integer from`)
    expect(call).toThrow(`(got ${v})`)
  })

  it('names the full key for string and non-integer publish values', () => {
    expect(() => validateStateConfig({ state: { publish: { maxBytes: '4096' } } })).toThrow('instrument.state.publish.maxBytes')
    expect(() => validateStateConfig({ state: { publish: { intervalMs: 2.5 } } })).toThrow('instrument.state.publish.intervalMs')
  })

  it('bakes the four settings into the built package', async () => {
    const dir = mkapp('cfgok', {}, { instrument: { state: { redact: { paths: ['global.dummy'] }, publish: { maxBytes: 2048, intervalMs: 200 } } } })
    const r = await run(dir, 'cfgok')
    expect(r.exitCode).toBe(0)
    const t = await zipText(r.out, 'source/bt/BT_config.brs')
    expect(t).toContain('redact: { paths: ["global.dummy"] }')
    expect(t).toContain('publish: { maxBytes: 2048, intervalMs: 200 }')
  })

  it('emits registrySections into BT_config, and nothing when none are configured (STA-S-T1b)', () => {
    const t = renderBtConfig('0'.repeat(32), { state: { registrySections: ['prefs', ' auth ', '', 7] } })
    expect(t).toContain('registrySections: ["prefs", "auth"]')
    for (const inst of [undefined, {}, { state: {} }, { state: { registrySections: [] } }, { state: { registrySections: 'x' } }]) {
      expect(renderBtConfig('0'.repeat(32), inst)).not.toContain('registrySections')
    }
    // byte-identical to the pre-registry output when no sections are set
    expect(renderBtConfig('0'.repeat(32), { state: { caps: { depth: 3 } } })).toBe(renderBtConfig('0'.repeat(32), { state: { caps: { depth: 3 }, registrySections: [] } }))
  })

  it('never passes deploy to bsc and keeps the instrument lane config clean', () => {
    const cfg = cfgFor(src(), 'lane')
    cfg.instrument = { strict: true, exclude: ['x/**'] }
    const { bsconfig, bsconfigPath } = writeBsConfig(cfg, 'instrument', { outFile: '/o/p.zip' })
    expect(bsconfig.deploy).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(bsconfigPath, 'utf8')).deploy).toBeUndefined()
    expect(bsconfig).toMatchObject({ createPackage: true, outFile: '/o/p.zip', plugins: [], instrument: { exclude: ['x/**'] } })
    expect(bsconfig.instrument.strict).toBeUndefined()
    expect(bsconfig.rooibos).toBeUndefined()
  })
})

describe('instrument build: R1 gates leave no package', () => {
  it('BT9003 staged-output-invalid: exit 1, the documented stderr lines, nothing at --out, temp removed', async () => {
    const app = copyTree(fx('app'), path.join(tmp, 'bad'))
    const r = await run(app, 'bad', { plugins: [breakRewrite] }, { diagnosticFilters: [1140, 1009] })
    expect(r.exitCode).toBe(1)
    expect(r.log.some((l) => /^BT9003 staged-output-invalid source\/net\.brs:\d+ \(bsc \d+, net\)$/.test(l))).toBe(true)
    expect(r.log[r.log.length - 1]).toMatch(/^instrument build failed: \d+ error\(s\), no package written$/)
    expect(fs.existsSync(r.out)).toBe(false)
    expect(tmpLeft(path.dirname(r.out))).toEqual([])
  })

  it('a previous good package at --out is left untouched by a failing build', async () => {
    const good = copyTree(fx('app'), path.join(tmp, 'good2'))
    const out = path.join(tmp, 'keep.zip')
    const ok = await run(good, 'keep-ok', { out }, { diagnosticFilters: [1140, 1009] })
    expect(ok.exitCode).toBe(0)
    const h = crypto.createHash('sha1').update(fs.readFileSync(out)).digest('hex')
    const bad = await run(good, 'keep-bad', { out, plugins: [breakRewrite] }, { diagnosticFilters: [1140, 1009] })
    expect(bad.exitCode).toBe(1)
    expect(crypto.createHash('sha1').update(fs.readFileSync(out)).digest('hex')).toBe(h)
  })

  it('a bsc error diagnostic stops the build (exit 1, no package)', async () => {
    const app = mkapp('syntax', { 'source/bad.brs': 'sub f()\n    x = = 1\nend sub\n' })
    const r = await run(app, 'syntax')
    expect(r.exitCode).toBe(1)
    expect(fs.existsSync(r.out)).toBe(false)
    expect(r.log[r.log.length - 1]).toMatch(/no package written$/)
    expect(r.log.length).toBeGreaterThan(1)
  })

  it('a plugin error diagnostic (BT9001 reserved name) stops the build', async () => {
    const app = mkapp('reserved', { 'source/r.brs': 'function BT_config() as object\n    return {}\nend function\n' })
    const r = await run(app, 'reserved')
    expect(r.exitCode).toBe(1)
    expect(r.log.join('\n')).toMatch(/BT9001/)
    expect(fs.existsSync(r.out)).toBe(false)
  })
})

describe('instrument build: strict (R5 table)', () => {
  const setUrl = 'sub f(x as object)\n    x.setUrl("http://127.0.0.1:1/a")\nend sub\n'
  it('a Rooibos-style default-excluded candidate does not trip strict (informational)', async () => {
    const app = mkapp('rooibos', { 'source/rooibos/TestRunner.brs': setUrl })
    const r = await run(app, 'rooibos', { strict: true })
    expect(r.exitCode).toBe(0)
    expect(fs.existsSync(r.out)).toBe(true)
    expect(r.informational.find((e) => e.kind === 'excluded-candidate')).toMatchObject({ excludedBy: 'default' })
    expect(r.strictTrips).toEqual([])
  })
  it('a user-excluded candidate trips strict: exit 4, strict line, no package', async () => {
    const app = mkapp('userex', { 'source/vendor2/x.brs': setUrl }, { instrument: { exclude: ['source/vendor2/**'] } })
    const r = await run(app, 'userex', { strict: true })
    expect(r.exitCode).toBe(4)
    expect(r.log.some((l) => /^strict: excluded-candidate source\/vendor2\/x\.brs:2 /.test(l))).toBe(true)
    expect(r.log[r.log.length - 1]).toBe('instrument build failed: 1 error(s), no package written')
    expect(fs.existsSync(r.out)).toBe(false)
    const off = await run(app, 'userex-off', { strict: false })
    expect(off.exitCode).toBe(0)
  })
  it('strict comes from instrument.strict in brighttest.json; the default is off', async () => {
    const files = { 'components/S.xml': '<?xml version="1.0" encoding="utf-8" ?>\n<component name="S" extends="Scene">\n  <script type="text/brightscript" uri="pkg:/components/s.brs" />\n</component>\n', 'components/s.brs': 'sub init()\nend sub\n' }
    const off = mkapp('empty-off', files)
    expect(loadConfig(off).instrument.strict).toBe(false)
    expect((await run(off, 'empty-off')).exitCode).toBe(0)
    const on = mkapp('empty-on', files, { instrument: { strict: true } })
    expect(loadConfig(on).instrument.strict).toBe(true)
    const r = await run(on, 'empty-on')
    expect(r.exitCode).toBe(4)
    expect(r.log.some((l) => /^strict: empty-init components\/s\.brs:1 /.test(l))).toBe(true)
    expect((await run(on, 'empty-on-flag', { strict: false })).exitCode).toBe(0)
  })
  it('errors win over strict: exit 1', async () => {
    const app = mkapp('both', { 'source/vendor2/x.brs': setUrl, 'source/bad.brs': 'sub f()\n    x = = 1\nend sub\n' }, { instrument: { exclude: ['source/vendor2/**'] } })
    expect((await run(app, 'both', { strict: true })).exitCode).toBe(1)
  })
})

describe('strict table', () => {
  it('has a key for every kind the plugin can emit', () => {
    for (const k of createPlugin.SKIP_KINDS) expect(Object.keys(STRICT_TABLE), k).toContain(k)
  })
  it('agrees with the ADR table', () => {
    const t = (kind, extra) => tripsStrict({ kind, ...extra })
    expect(t('excluded-candidate', { excludedBy: 'user' })).toBe(true)
    expect(t('excluded-candidate', { excludedBy: 'default' })).toBe(false)
    for (const k of ['empty-init', 'inline-cdata-scene', 'unknown-scene-subtype', 'init-in-excluded-file', 'init-shared-with-excluded-scene', 'indexed-seturl', 'bare-geturl', 'net-receiver-unknown', 'xml-parse-failed', 'parse-threw']) expect(t(k), k).toBe(true)
    expect(t('init-shared-with-excluded-scene', { via: 'extends' })).toBe(true)
    for (const k of ['rewritten-shared-with-excluded', 'net-receiver-excluded', 'callfunc-seturl']) expect(t(k), k).toBe(false)
    expect(t('some-future-kind')).toBe(true) // fail closed
  })
  it('informational kinds of the plugin never trip', () => {
    for (const k of createPlugin.INFORMATIONAL_KINDS) expect(tripsStrict({ kind: k }), k).toBe(false)
  })
})

describe('NET-N-T14 renderBtConfig netObserve', () => {
  it('emits netObserve only for instrument.net.observe === true', () => {
    expect(renderBtConfig('0'.repeat(32), { net: { observe: true } })).toContain('        netObserve: true\n')
    expect(renderBtConfig('0'.repeat(32), { net: true })).not.toContain('netObserve')
    expect(renderBtConfig('0'.repeat(32), {})).not.toContain('netObserve')
  })
})
