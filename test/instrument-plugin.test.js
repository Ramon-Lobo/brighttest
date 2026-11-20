import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const pluginPath = path.resolve(__dirname, '../lib/instrument/plugin.js')
const createPlugin = require(pluginPath)
const {
  mergeManifest, makeMatcher, assertPluginOrder, DEFAULT_EXCLUDE, RUNTIME_COVERAGE_EXCLUDE, RUNS_AFTER,
} = createPlugin
const fixture = path.resolve(__dirname, 'fixtures/instrument-plugin/app')

let tmp
let base
let inst
let forced
// bsc copies an unedited .brs verbatim but re-emits an edited one from the AST (inline `if` becomes a block, AA
// literals expand). The line-stability baseline is therefore a build where every file is AST-transpiled anyway,
// which is also the situation under the Rooibos coverage processor.
const forceTranspile = path.resolve(__dirname, 'fixtures/instrument-plugin/force-transpile.js')
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-instrument-'))
  base = await build(fixture, path.join(tmp, 'base'), [])
  forced = await build(fixture, path.join(tmp, 'forced'), [forceTranspile])
  inst = await build(fixture, path.join(tmp, 'inst'), [pluginPath])
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function build(rootDir, outDir, plugins, extra = {}) {
  const pb = new ProgramBuilder()
  await pb.run({
    cwd: rootDir, rootDir, stagingDir: path.join(outDir, 'staging'), createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*', 'components/**/*'], plugins, logLevel: 'error', autoImportComponentScript: false,
    diagnosticFilters: [1107, 1140, 1009], ...extra,
  })
  const errors = pb.program.getDiagnostics().filter((d) => d.severity === 1)
  return { pb, staging: path.join(outDir, 'staging'), errors, result: createPlugin.lastInstance && createPlugin.lastInstance.getResult() }
}
const read = (b, rel) => fs.readFileSync(path.join(b.staging, rel), 'utf8')
const lines = (s) => s.replace(/\n+$/, '').split('\n').length

describe('constants and matcher', () => {
  it('exports the coverage exclude list for the runtime', () => {
    expect(RUNTIME_COVERAGE_EXCLUDE).toEqual(['**/source/bt/**', '**/components/bt/**'])
  })
  it('default excludes cover vendor, rooibos, roku_modules, bt dirs and specs', () => {
    const m = makeMatcher(DEFAULT_EXCLUDE)
    for (const p of ['source/vendor/a/b.brs', 'source/rooibos/x.brs', 'roku_modules/p/x.brs', 'components/bt/a.brs',
      'source/bt/a.brs', 'source/Foo.spec.bs', 'source/tests/Foo.spec.brs', 'components/rooibosScene.xml']) expect(m(p), p).toBe(true)
    for (const p of ['source/main.brs', 'components/Scene.brs', 'source/btx/a.brs', 'source/vendors.brs']) expect(m(p), p).toBe(false)
  })
  it('glob matcher handles ** at any depth, * and ?', () => {
    expect(makeMatcher(['**/a/**'])('x/y/a/z.brs')).toBe(true)
    expect(makeMatcher(['**/a/**'])('a/z.brs')).toBe(true)
    expect(makeMatcher(['s/*.brs'])('s/a/b.brs')).toBe(false)
    expect(makeMatcher(['s/?.brs'])('s/a.brs')).toBe(true)
  })
})

describe('plugin order contract', () => {
  it('advertises runsAfter rooibos', () => {
    expect(RUNS_AFTER).toBe('rooibos')
    expect(createPlugin().runsAfter).toBe('rooibos')
  })
  it('assertPluginOrder accepts rooibos first and rejects the reverse', () => {
    expect(assertPluginOrder(['/n/@x/rooibos-roku/dist/plugin.js', pluginPath])).toBe(true)
    expect(() => assertPluginOrder([pluginPath, '/n/@x/rooibos-roku/dist/plugin.js'])).toThrow(/after the rooibos/)
    expect(assertPluginOrder([pluginPath])).toBe(true)
  })
})

describe('mergeManifest', () => {
  it('keeps every bs_const entry, adds BT_AGENT=true and the marker, changes nothing else', () => {
    const src = 'title=T\nbs_const=A=1;B=false\nmajor_version=2\n'
    expect(mergeManifest(src)).toBe('title=T\nbs_const=A=1;B=false;BT_AGENT=true\nmajor_version=2\nbt_instrumented=1\n')
  })
  it('creates bs_const when absent and overrides an existing BT_AGENT', () => {
    expect(mergeManifest('title=T\n')).toBe('title=T\nbs_const=BT_AGENT=true\nbt_instrumented=1\n')
    expect(mergeManifest('bs_const=BT_AGENT=false;X=1\n')).toBe('bs_const=X=1;BT_AGENT=true\nbt_instrumented=1\n')
  })
  it('is idempotent and preserves CRLF', () => {
    const once = mergeManifest('title=T\r\nbs_const=X=1\r\n')
    expect(once).toBe('title=T\r\nbs_const=X=1;BT_AGENT=true\r\nbt_instrumented=1\r\n')
    expect(mergeManifest(once)).toBe(once)
  })
})

describe('staged build through the bsc ProgramBuilder', () => {
  it('builds without errors both ways', () => {
    expect(base.errors.map((e) => e.message)).toEqual([])
    expect(inst.errors.map((e) => e.message)).toEqual([])
  })

  it('staged manifest has original bs_const, BT_AGENT and the marker', () => {
    const mf = read(inst, 'manifest')
    expect(mf).toContain('bs_const=STRESS=false;VERBOSE_LOG=true;BT_AGENT=true')
    expect(mf).toContain('bt_instrumented=1')
    expect(read(base, 'manifest')).not.toContain('bt_instrumented')
  })

  it('setUrl rewrites (single arg, any case) and leaves other arities alone', () => {
    const out = read(inst, 'source/net.brs')
    expect(out).toContain('x.setUrl(BT_url("https://" + host + "/a"))')
    expect(out).toMatch(/\.SETURL\(BT_url\(/i)
    expect(out).toContain('o.setUrl("a", "b")')
    expect(inst.result.stats.setUrl).toBe(2)
  })

  it('getUrl rewrites inside if, print, AA literal and return; arguments are not rewritten', () => {
    const out = read(inst, 'source/net.brs')
    expect(out).toMatch(/if BT_unurl\(x\.getUrl\(\)\) = ""/)
    expect(out).toMatch(/print "u=" \+ BT_unurl\(x\.GetUrl\(\)\)/)
    expect(out).toMatch(/a: BT_unurl\(x\.getUrl\(\)\)/)
    expect(out).toMatch(/return BT_unurl\(x\.getUrl\(\)\)/)
    expect(out).toContain('z = o.getUrl("x")')
    expect(out).not.toMatch(/BT_unurl\(BT_unurl/)
    expect(inst.result.stats.getUrl).toBe(4)
  })

  it('does not touch excluded files (vendor, spec, source/bt)', () => {
    for (const rel of ['source/vendor/vend.brs', 'source/other.spec.brs', 'source/bt/BT_existing.brs']) {
      expect(read(inst, rel), rel).toBe(read(base, rel))
    }
  })

  it('custom exclude globs from the instrument config key are honored', async () => {
    const b = await build(fixture, path.join(tmp, 'ex'), [pluginPath], { instrument: { exclude: ['source/net.brs'] } })
    expect(read(b, 'source/net.brs')).toBe(read(base, 'source/net.brs'))
  })

  it('keeps line counts of every user .brs identical to an AST-transpiled plugin-off build', () => {
    const files = ['source/main.brs', 'source/net.brs', 'components/base.brs', 'components/derived.brs']
    for (const f of files) expect(lines(read(inst, f)), f).toBe(lines(read(forced, f)))
  })

  it('Scene init prepend uses the same-line form', () => {
    const b = read(inst, 'components/base.brs').split('\n')
    expect(b[1]).toMatch(/^\s*BT_bootstrap\(m\.top\) : print "base init"/)
    const d = read(inst, 'components/derived.brs').split('\n')
    expect(d[1]).toMatch(/^\s*BT_bootstrap\(m\.top\) : print "derived init"/)
    expect(inst.result.stats.initPrepend).toBe(2)
  })

  it('synthesizes an init only for the Scene without one', () => {
    expect(inst.result.synthesized).toEqual(['BareScn'])
    expect(fs.existsSync(path.join(inst.staging, 'components/bt/BT_init_BareScn.brs'))).toBe(true)
    expect(read(inst, 'components/bt/BT_init_BareScn.brs')).toContain('BT_bootstrap(m.top)')
    expect(fs.existsSync(path.join(inst.staging, 'components/bt/BT_init_DerivedScn.brs'))).toBe(false)
  })

  it('counts an inline CDATA Scene init and does not rewrite or synthesize it', () => {
    expect(inst.result.inlineInitUnhandled).toEqual(['InlineScn'])
    expect(inst.result.stats.inlineInitUnhandled).toBe(1)
    expect(fs.existsSync(path.join(inst.staging, 'components/bt/BT_init_InlineScn.brs'))).toBe(false)
    expect(read(inst, 'components/InlineScn.xml')).not.toMatch(/BT_bootstrap/)
  })

  it('BT_op guard: only the chain root is injected, descendants are skipped', () => {
    const a = read(inst, 'components/ChainA.xml')
    expect(a).toMatch(/<function name="BT_op"/)
    expect((a.match(/BT_runtime\.brs/g) || []).length).toBe(1)
    for (const n of ['ChainB', 'ChainC']) {
      const x = read(inst, `components/${n}.xml`)
      expect(x, n).not.toMatch(/BT_op/)
      expect(x, n).not.toMatch(/BT_runtime/)
    }
    // ChainB (1 skipped: ancestor ChainA), ChainC (ancestors A,B declared) and DerivedScn (ancestor BaseScn)
    expect(inst.result.stats.opSkippedInherited).toBe(3)
  })

  it('fails with a clear diagnostic when the user defines BT_op', async () => {
    const dir = path.join(tmp, 'clash')
    fs.cpSync(fixture, dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'source/main.brs'), '\nfunction BT_op(a as dynamic) as dynamic\n    return a\nend function\n')
    const b = await build(dir, path.join(tmp, 'clash-out'), [pluginPath])
    expect(b.errors.some((e) => e.code === 'BT9001' && /BT_op is reserved/.test(e.message))).toBe(true)
  })
})
