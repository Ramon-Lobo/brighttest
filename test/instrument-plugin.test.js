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
  mergeManifest, makeMatcher, assertPluginOrder, missingPrivateApis, DEFAULT_EXCLUDE, RUNTIME_COVERAGE_EXCLUDE, RUNS_AFTER,
  RUNTIME_PKG, RUNTIME_SRC, SCENE_BUILTINS, INFORMATIONAL_KINDS,
} = createPlugin
const fixture = path.resolve(__dirname, 'fixtures/instrument-plugin/app')
const edge = path.resolve(__dirname, 'fixtures/instrument-plugin/edge')
const shapes = path.resolve(__dirname, 'fixtures/instrument-plugin/shapes')
const share = path.resolve(__dirname, 'fixtures/instrument-plugin/share')
const lineshift = path.resolve(__dirname, 'fixtures/instrument-plugin/lineshift')
const breakRewrite = path.resolve(__dirname, 'fixtures/instrument-plugin/break-rewrite.js')
const rooibosStub = path.resolve(__dirname, 'fixtures/instrument-plugin/rooibos-stub.js')
const rooibosPlugin = require.resolve('@ramonlobo/rooibos-roku/dist/plugin.js')

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

// `instances` are plugin objects added to the builder directly (bsc only loads path strings from `plugins`).
async function build(rootDir, outDir, plugins, extra = {}, instances = []) {
  const pb = new ProgramBuilder()
  for (const i of instances) pb.plugins.add(i)
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

  it('Scene init bootstrap goes on the signature line, the body follows unchanged', () => {
    const b = read(inst, 'components/base.brs').split('\n')
    expect(b[0]).toMatch(/^(sub|function) init\(\)( as void)? : BT_bootstrap\(m\.top\)$/i)
    expect(b[1]).toMatch(/^\s*print "base init"/)
    const d = read(inst, 'components/derived.brs').split('\n')
    expect(d[0]).toMatch(/: BT_bootstrap\(m\.top\)$/)
    expect(d[1]).toMatch(/^\s*print "derived init"/)
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

describe('item 1: BT_AGENT is defined by the plugin before parse', () => {
  let e
  beforeAll(async () => { e = await build(edge, path.join(tmp, 'edge'), [pluginPath]) })

  it('wraps the runtime and the synthesized stub in #if BT_AGENT', () => {
    expect(RUNTIME_SRC.startsWith('#if BT_AGENT\n')).toBe(true)
    expect(RUNTIME_SRC.trimEnd().endsWith('#end if')).toBe(true)
    expect(read(inst, 'components/bt/BT_init_BareScn.brs')).toMatch(/^#if BT_AGENT\n/)
  })
  it('the wrapped runtime survives into staging and compiles without errors', () => {
    const rt = read(inst, RUNTIME_PKG)
    expect(rt).toContain('#if BT_AGENT')
    expect(rt).toContain('function BT_url(')
    expect(inst.errors.map((x) => x.message)).toEqual([])
  })
  it('works when the source manifest has no bs_const at all', () => {
    expect(e.errors.filter((x) => x.code !== 'BT9001').map((x) => x.message)).toEqual([])
    expect(read(e, 'manifest')).toContain('bs_const=BT_AGENT=true')
  })
  it('user #if BT_AGENT blocks compile in (true branch kept in a rewritten file)', () => {
    const out = read(e, 'source/main.brs')
    expect(out).toContain('print "agent build"')
    expect(out).not.toContain('plain build')
  })
  it('the same user file does not compile its true branch in a plugin-off build', async () => {
    const off = await build(edge, path.join(tmp, 'edge-off'), [], { manifest: { bs_const: { BT_AGENT: false } } })
    expect(read(off, 'source/main.brs')).toContain('#if BT_AGENT')
  })
})

describe('item 2: manifest markers survive createPackage:true', () => {
  it('the zipped manifest has the markers and every original bs_const', async () => {
    const JSZip = require('jszip')
    const outFile = path.join(tmp, 'pkg', 'app.zip')
    await build(fixture, path.join(tmp, 'pkg-out'), [pluginPath], { createPackage: true, outFile })
    const zip = await JSZip.loadAsync(fs.readFileSync(outFile))
    const mf = await zip.file('manifest').async('string')
    expect(mf).toContain('bs_const=STRESS=false;VERBOSE_LOG=true;BT_AGENT=true')
    expect(mf).toContain('bt_instrumented=1')
    expect(mf).toBe(read(inst, 'manifest'))
  })
})

describe('item 3: plugin order', () => {
  it('reports an error diagnostic when rooibos is listed after the plugin', async () => {
    const b = await build(fixture, path.join(tmp, 'order-bad'), [pluginPath, rooibosStub])
    expect(b.errors.some((x) => x.code === 'BT9002' && /rooibos/.test(x.message))).toBe(true)
  })
  it('is quiet when rooibos is listed first', async () => {
    const b = await build(fixture, path.join(tmp, 'order-ok'), [rooibosStub, pluginPath])
    expect(b.errors.map((x) => x.message)).toEqual([])
  })
  it('with the real rooibos plugin: wrong order fails, right order keeps the coverage call sites identical', async () => {
    const rooibos = { isRecordingCodeCoverage: true, coverageExcludedFiles: RUNTIME_COVERAGE_EXCLUDE, testsFilePattern: '**/*.spec.*' }
    const countCc = (b) => {
      const out = {}
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((en) => {
        const f = path.join(d, en.name)
        if (en.isDirectory()) return walk(f)
        if (!f.endsWith('.brs')) return
        const n = (fs.readFileSync(f, 'utf8').match(/RBS_CC_/g) || []).length
        if (n) out[path.relative(b.staging, f)] = n
      })
      walk(b.staging)
      return out
    }
    const off = await build(fixture, path.join(tmp, 'rb-off'), [rooibosPlugin], { rooibos })
    const ok = await build(fixture, path.join(tmp, 'rb-ok'), [rooibosPlugin, pluginPath], { rooibos })
    const bad = await build(fixture, path.join(tmp, 'rb-bad'), [pluginPath, rooibosPlugin], { rooibos })
    expect(ok.errors.map((x) => x.message)).toEqual([])
    expect(countCc(ok)).toEqual(countCc(off))
    // the injected runtime does not count toward coverage
    expect(Object.keys(countCc(ok)).filter((f) => /[\\/]bt[\\/]/.test(f))).toEqual([])
    expect(bad.errors.some((x) => x.code === 'BT9002')).toBe(true)
  })
  it('the runtime package path is matched by the exported coverage exclude list', () => {
    expect(makeMatcher(RUNTIME_COVERAGE_EXCLUDE)('/' + RUNTIME_PKG)).toBe(true)
    expect(makeMatcher(RUNTIME_COVERAGE_EXCLUDE)('components/bt/BT_init_X.brs')).toBe(true)
    expect(makeMatcher(RUNTIME_COVERAGE_EXCLUDE)('source/main.brs')).toBe(false)
  })
})

describe('items 4, 5, 7, 9: skipped[] and the result schema', () => {
  let e
  beforeAll(async () => { e = await build(edge, path.join(tmp, 'edge2'), [pluginPath]) })
  const kinds = (r) => r.skipped.map((x) => x.kind).sort()

  it('result has schema 1 and every list, with stats kept', () => {
    const r = e.result
    expect(r.schema).toBe(1)
    for (const k of ['skipped', 'synthesized', 'bootstrapped', 'opInjected', 'excluded', 'inlineInitUnhandled']) expect(Array.isArray(r[k]), k).toBe(true)
    expect(r.stats.setUrl).toBe(1)
    expect(r.manifestWritten).toBe(true)
    for (const x of r.skipped) expect(['file', 'kind', 'line', 'reason']).toEqual(expect.arrayContaining(Object.keys(x).filter((k) => !['excludedBy', 'via', 'component'].includes(k)).sort()))
    for (const x of r.skipped) expect(Object.keys(x)).toEqual(expect.arrayContaining(['file', 'kind', 'line', 'reason']))
    expect(inst.result.schema).toBe(1)
  })
  it('records an empty init and leaves the file alone', () => {
    const s = e.result.skipped.find((x) => x.kind === 'empty-init')
    expect(s).toMatchObject({ file: 'components/empty.brs', line: 1 })
    expect(read(e, 'components/empty.brs')).not.toMatch(/BT_bootstrap/)
  })
  it('wraps an init that starts under #if or with a label (init-unsafe-first-statement is retired)', () => {
    expect(e.result.skipped.filter((x) => x.kind === 'init-unsafe-first-statement')).toEqual([])
    for (const f of ['components/ifscn.brs', 'components/labelscn.brs']) {
      expect(read(e, f).split('\n')[0]).toBe('sub init() : BT_bootstrap(m.top)')
    }
    expect(e.errors.map((x) => x.message)).toEqual([])
  })
  it('records indexed setUrl/getUrl and a bare getUrl, with their lines', () => {
    expect(e.result.skipped.find((x) => x.kind === 'indexed-seturl')).toMatchObject({ file: 'source/main.brs', line: 8 })
    expect(e.result.skipped.find((x) => x.kind === 'indexed-geturl')).toMatchObject({ file: 'source/main.brs', line: 9 })
    expect(e.result.skipped.find((x) => x.kind === 'bare-geturl')).toMatchObject({ file: 'source/main.brs', line: 10 })
    const out = read(e, 'source/main.brs')
    expect(out).toContain('o["setUrl"]("https://example.test/idx")')
    expect(out).toContain('o.setUrl(BT_url("https://example.test/dot"))')
    expect(out).not.toMatch(/BT_unurl/)
  })
  it('lists excluded files that contain candidate sites and leaves them untouched', () => {
    expect(e.result.excluded).toEqual([expect.objectContaining({ file: 'source/vendor/vend.brs' })])
    expect(kinds(e.result)).toContain('excluded-candidate')
    expect(read(e, 'source/vendor/vend.brs')).not.toMatch(/BT_url/)
  })
  it('handles built-in Scene subtypes and reports unknown Scene-like roots', () => {
    expect(SCENE_BUILTINS).toEqual(['scene', 'overhangpanelsetscene'])
    expect(e.result.bootstrapped.map((x) => x.file)).toContain('components/theme.brs')
    expect(e.result.skipped.find((x) => x.kind === 'unknown-scene-subtype')).toMatchObject({ file: 'components/OddScn.xml' })
  })
  it('the CDATA Scene in the main fixture is reported in skipped[] too', () => {
    expect(inst.result.skipped.find((x) => x.kind === 'inline-cdata-scene')).toMatchObject({ file: 'components/InlineScn.xml' })
  })
  it('records which init statements were bootstrapped and which components got BT_op', () => {
    expect(inst.result.bootstrapped.map((x) => x.file).sort()).toEqual(['components/base.brs', 'components/derived.brs'])
    expect(inst.result.opInjected).toContain('ChainA')
    expect(inst.result.opInjected).not.toContain('ChainB')
  })
  it('two Scenes sharing one init script prefix it once; the runtime guard makes it run once', () => {
    const shared = read(e, 'components/shared.brs')
    expect((shared.match(/BT_bootstrap\(m\.top\)/g) || []).length).toBe(1)
    expect(e.result.bootstrapped.filter((x) => x.file === 'components/shared.brs')).toHaveLength(1)
    expect(RUNTIME_SRC).toMatch(/if top\.hasField\("__bt_boot"\) then return/)
    expect(RUNTIME_SRC).toMatch(/if not top\.isSubtype\("Scene"\) then return/)
  })
})

describe('item 6: reserved runtime names', () => {
  it.each(['BT_url', 'bt_UNURL', 'BT_bootstrap'])('fails the build when the user defines %s', async (name) => {
    const dir = path.join(tmp, 'clash-' + name)
    fs.cpSync(fixture, dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'source/main.brs'), `\nfunction ${name}(a as dynamic) as dynamic\n    return a\nend function\n`)
    const b = await build(dir, path.join(tmp, 'clash-out-' + name), [pluginPath])
    expect(b.errors.some((e) => e.code === 'BT9001' && /is reserved/.test(e.message))).toBe(true)
  })
  it('does not flag an excluded file that defines a runtime name', async () => {
    const dir = path.join(tmp, 'clash-excl')
    fs.cpSync(fixture, dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'source/vendor/vend.brs'), '\nfunction BT_url(a as dynamic) as dynamic\n    return a\nend function\n')
    const b = await build(dir, path.join(tmp, 'clash-excl-out'), [pluginPath])
    expect(b.errors.some((e) => e.code === 'BT9001')).toBe(false)
  })
})

describe('item 8: one plugin instance per program', () => {
  it('a second beforeProgramValidate on the same program does not add a script twice', async () => {
    const plugin = createPlugin()
    const b = await build(fixture, path.join(tmp, 'twice'), [], {}, [plugin])
    const before = fs.readFileSync(path.join(b.staging, 'components/ChainA.xml'), 'utf8')
    plugin.beforeProgramValidate(b.pb.program)
    const runtimeTags = Object.values(b.pb.program.files).find((f) => f.componentName && f.componentName.text === 'ChainA')
      .scriptTagImports.filter((i) => i.pkgPath === RUNTIME_PKG)
    expect(runtimeTags).toHaveLength(1)
    expect((before.match(/BT_runtime\.brs/g) || []).length).toBe(1)
  })
  it('two factory instances keep separate results', async () => {
    const a = createPlugin(); const c = createPlugin()
    await build(fixture, path.join(tmp, 'sep-a'), [], {}, [a])
    expect(a.getResult().stats.setUrl).toBe(2)
    expect(c.getResult().stats.setUrl).toBe(0)
  })
})

describe('item 10: private API feature detection', () => {
  it('reports nothing on the resolved brighterscript', () => {
    expect(missingPrivateApis()).toEqual([])
    const xml = Object.values(inst.pb.program.files).find((f) => f.componentName)
    expect(missingPrivateApis(xml)).toEqual([])
  })
  it('names the missing API', () => {
    expect(missingPrivateApis({ parser: { references: {} }, ast: { component: {} } })).toEqual(expect.arrayContaining([
      'XmlFile#attachDependencyGraph', 'XmlFile#parser.references.scriptTagImports', 'XmlFile#ast.component.scripts',
    ]))
  })
})


// Builds the staged output again with the plugin off and nothing filtered: every BT_* call in the staged files must
// resolve in the scope of every component (a re-parse + validate of the package).
async function rebuildStaged(staging) {
  const pb = new ProgramBuilder()
  await pb.run({
    cwd: staging, rootDir: staging, stagingDir: path.join(staging, '..', 'restaged-' + path.basename(path.dirname(staging))),
    createPackage: false, copyToStaging: false, files: ['manifest', 'source/**/*', 'components/**/*'], plugins: [], logLevel: 'error',
    autoImportComponentScript: false,
  })
  return pb.program.getDiagnostics().filter((d) => d.severity === 1)
}

describe('TP-INS-22 (F1): bootstrap on the signature line for every kind of first statement', () => {
  let s
  beforeAll(async () => { s = await build(shapes, path.join(tmp, 'shapes'), [pluginPath]) })
  const files = ['ifblock', 'ifline', 'ifelse', 'label', 'cc', 'forscn', 'comment', 'slc', 'fnvoid']

  it('stages without any error and bootstraps every init once', () => {
    expect(s.errors.map((x) => `${x.code} ${x.message}`)).toEqual([])
    expect(s.result.invalid).toEqual([])
    expect(s.result.bootstrapped.map((x) => x.file).sort()).toEqual(files.map((f) => `components/${f}.brs`).sort())
    for (const f of files) {
      const out = read(s, `components/${f}.brs`)
      expect((out.match(/BT_bootstrap\(m\.top\)/g) || []).length, f).toBe(1)
    }
  })
  it('emits the call right after the signature and keeps the body on the following lines', () => {
    expect(read(s, 'components/ifblock.brs').split('\n').slice(0, 3)).toEqual(['sub init() : BT_bootstrap(m.top)', '    if m.top.id = "" then', '        m.top.id = "blk"'])
    expect(read(s, 'components/ifline.brs')).toMatch(/^sub init\(\) : BT_bootstrap\(m\.top\)\n\s+if m\.top\.id = "" then/)
    expect(read(s, 'components/ifelse.brs')).toMatch(/^sub init\(\) : BT_bootstrap\(m\.top\)\n\s+if /)
    expect(read(s, 'components/label.brs').split('\n').slice(0, 2)).toEqual(['sub init() : BT_bootstrap(m.top)', '    top:'])
    expect(read(s, 'components/forscn.brs')).toMatch(/^sub init\(\) : BT_bootstrap\(m\.top\)\n\s+for i = 0 to 2/)
    expect(read(s, 'components/comment.brs')).toMatch(/^sub init\(\) : BT_bootstrap\(m\.top\)\n\s+' leading comment/)
    expect(read(s, 'components/slc.brs').split('\n')[0]).toBe("sub init() : BT_bootstrap(m.top) ' trailing on the signature")
    expect(read(s, 'components/fnvoid.brs').split('\n')[0]).toBe('function init() as void : BT_bootstrap(m.top)')
    expect(read(s, 'components/cc.brs').split('\n')[0]).toBe('sub init() : BT_bootstrap(m.top)')
  })
  it('adds no line relative to the plugin-off all-AST build', async () => {
    const forcedShapes = await build(shapes, path.join(tmp, 'shapes-forced'), [forceTranspile])
    for (const f of files) {
      expect(lines(read(s, `components/${f}.brs`)), f).toBe(lines(read(forcedShapes, `components/${f}.brs`)))
    }
  })
  it('an empty-body init is reported (empty-init) and left alone', () => {
    expect(s.result.skipped.find((x) => x.kind === 'empty-init' && x.file === 'components/emptybody.brs')).toMatchObject({ line: 1 })
    expect(read(s, 'components/emptybody.brs')).not.toMatch(/BT_bootstrap/)
  })
  it('the staged package validates when built again with the plugin off', async () => {
    expect((await rebuildStaged(s.staging)).map((x) => `${x.code} ${x.message}`)).toEqual([])
  })
  it('fails the build with BT9003 staged-output-invalid when a rewrite emits invalid code', async () => {
    const pb = new ProgramBuilder()
    const plugin = createPlugin()
    pb.plugins.add(plugin)
    let thrown = null
    try {
      await pb.run({
        cwd: fixture, rootDir: fixture, stagingDir: path.join(tmp, 'broken', 'staging'), createPackage: false, copyToStaging: true,
        files: ['manifest', 'source/**/*', 'components/**/*'], plugins: [breakRewrite], logLevel: 'error', autoImportComponentScript: false,
        diagnosticFilters: [1107, 1140, 1009],
      })
    } catch (e) { thrown = e }
    expect(thrown).toBeNull() // bsc swallows a plugin throw (logs it); the error diagnostic is what makes the CLI exit 1
    expect(pb.getDiagnostics().some((x) => x.severity === 1 && x.code === 'BT9003')).toBe(true)
    const d = pb.program.getDiagnostics().find((x) => x.code === 'BT9003')
    expect(d.message).toMatch(/staged-output-invalid: source\/net\.brs:\d+ bsc \d+ .*\(rewrite: net\)/)
    expect(plugin.getResult().invalid[0]).toMatchObject({ file: 'source/net.brs', kinds: ['net'] })
    expect(plugin.getResult().invalid[0].line).toBeGreaterThan(0)
  })
  it('does not verify, nor fail on, files the plugin did not rewrite', () => {
    expect(inst.result.invalid).toEqual([])
  })
})

describe('TP-INS-24 (F3): init in an excluded file', () => {
  const opts = { instrument: { exclude: ['components/vendorui/**'] } }
  it('never synthesizes a second init and reports init-in-excluded-file', async () => {
    const b = await build(share, path.join(tmp, 'share-f3'), [pluginPath], opts)
    expect(b.errors.map((x) => `${x.code} ${x.message}`)).toEqual([])
    expect(b.result.skipped.find((x) => x.kind === 'init-in-excluded-file')).toMatchObject({ file: 'source/vendor/exinit.brs', line: 1 })
    expect(b.result.skipped.find((x) => x.kind === 'init-in-excluded-file').reason).toMatch(/ExInitScn/)
    expect(b.result.synthesized).not.toContain('ExInitScn')
    expect(fs.existsSync(path.join(b.staging, 'components/bt/BT_init_ExInitScn.brs'))).toBe(false)
    expect(read(b, 'source/vendor/exinit.brs')).toBe(fs.readFileSync(path.join(share, 'source/vendor/exinit.brs'), 'utf8'))
  })
})

describe('TP-INS-23 (F2): rewritten script shared with an excluded component', () => {
  const opts = { instrument: { exclude: ['components/vendorui/**'] } }
  let b
  let shareOff
  beforeAll(async () => {
    b = await build(share, path.join(tmp, 'share-f2'), [pluginPath], opts)
    shareOff = await build(share, path.join(tmp, 'share-off'), [], opts)
  })

  it('rewrites the shared file and gives the excluded Group the runtime import only', () => {
    expect(read(b, 'components/common.brs')).toContain('BT_url(')
    const g = read(b, 'components/vendorui/ExGroup.xml')
    expect(g).toContain('BT_runtime.brs')
    expect(g).not.toMatch(/BT_op/)
    expect(b.result.opInjected).not.toContain('ExGroup')
  })
  it('records the informational entry and a clean staged package', async () => {
    const e = b.result.skipped.find((x) => x.kind === 'rewritten-shared-with-excluded')
    expect(e).toMatchObject({ file: 'components/common.brs' })
    expect(e.reason).toMatch(/ExGroup/)
    expect(INFORMATIONAL_KINDS).toContain('rewritten-shared-with-excluded')
    expect(INFORMATIONAL_KINDS).not.toContain('init-shared-with-excluded-scene')
    expect((await rebuildStaged(b.staging)).map((x) => `${x.code} ${x.message}`)).toEqual([])
  })
  it('an excluded component that does not import a rewritten file is untouched', () => {
    expect(read(b, 'components/vendorui/ExScn.xml')).toBe(read(shareOff, 'components/vendorui/ExScn.xml'))
    expect(read(b, 'components/vendorui/ExScn.xml')).not.toMatch(/BT_runtime/)
  })
  it('does not wrap an init shared with an excluded Scene, and reports it', () => {
    expect(read(b, 'components/sharedinit.brs')).toBe(fs.readFileSync(path.join(share, 'components/sharedinit.brs'), 'utf8'))
    const s = b.result.skipped.filter((x) => x.kind === 'init-shared-with-excluded-scene')
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ file: 'components/sharedinit.brs', line: 1 })
    expect(s[0].reason).toMatch(/ExScn/)
    expect(b.result.bootstrapped.map((x) => x.file)).toEqual(['components/mainscn.brs'])
  })
})

describe('TP-INS-25 (F4): rewritten files are re-emitted, the line shift is the documented one', () => {
  let on; let off; let all
  beforeAll(async () => {
    off = await build(lineshift, path.join(tmp, 'ls-off'), [])
    all = await build(lineshift, path.join(tmp, 'ls-all'), [forceTranspile])
    on = await build(lineshift, path.join(tmp, 'ls-on'), [pluginPath])
  })
  const src = (f) => fs.readFileSync(path.join(lineshift, f), 'utf8')
  const unrewrite = (s) => s.replace(/BT_url\(("[^"]*")\)/g, '$1')
  const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1

  it('an unrewritten .brs file is byte-identical to the source', () => {
    expect(read(on, 'source/plain.brs')).toBe(src('source/plain.brs'))
  })
  it('a rewritten file equals the plugin-off all-AST build line for line (modulo the BT_url wrapper)', () => {
    expect(on.result.stats.setUrl).toBe(1)
    expect(unrewrite(read(on, 'source/net.brs'))).toBe(read(all, 'source/net.brs'))
  })
  it('the shift against the source exists (a change that silently restores source lines must update the ADR)', () => {
    const crashOn = lineOf(read(on, 'source/net.brs'), 'a.nope.deep')
    expect(crashOn).toBe(lineOf(read(all, 'source/net.brs'), 'a.nope.deep'))
    expect(crashOn).not.toBe(lineOf(src('source/net.brs'), 'a.nope.deep'))
    expect(lines(read(on, 'source/net.brs'))).not.toBe(lines(src('source/net.brs')))
    expect(read(off, 'source/net.brs')).toBe(src('source/net.brs')) // plugin off: copied verbatim
  })
})

// INS-F-T8: receiver heuristic (ADR 0019 Amendment A). Fixture `recv` is generic; every case names its receiver.
describe('net receiver heuristic', () => {
  const recv = path.resolve(__dirname, 'fixtures/instrument-plugin/recv')
  const receiverMod = require(path.resolve(__dirname, '../lib/instrument/receiver.js'))
  let d // default config
  const run = (name, instrument) => build(recv, path.join(tmp, name), [pluginPath], instrument ? { instrument } : {})
  beforeAll(async () => { d = await run('recv-default') })
  const rw = (b, file, receiver, kind = 'setUrl') => b.result.rewritten.filter((x) => x.file === file && x.receiver === receiver && x.kind === kind)
  const conf = (b, file, receiver, kind = 'setUrl') => (rw(b, file, receiver, kind)[0] || {}).confidence
  const sk = (b, kind, receiver) => b.result.skipped.filter((x) => x.kind === kind && x.reason.startsWith(receiver + '.'))
  const C = 'source/classes.brs'

  it('builds clean and keeps schema 1 with the new fields', () => {
    expect(d.errors).toEqual([])
    expect(d.result.schema).toBe(1)
    expect(Array.isArray(d.result.rewritten)).toBe(true)
    for (const x of d.result.rewritten) expect(Object.keys(x).sort()).toEqual(['confidence', 'file', 'kind', 'line', 'receiver'])
    for (const x of d.result.skipped) expect(Object.keys(x).sort()).toEqual(['file', 'kind', 'line', 'reason'])
    expect(Object.keys(d.result.stats.netRewrites).sort()).toEqual(['confirmed', 'excluded', 'likely', 'unknown'])
    const n = d.result.stats.netRewrites
    expect(n.confirmed + n.likely + n.unknown).toBe(d.result.rewritten.length)
  })
  it('1: a local from CreateObject("roUrlTransfer") is confirmed and getUrl is wrapped too', () => {
    expect(conf(d, C, 'x1')).toBe('confirmed')
    expect(conf(d, C, 'x1', 'getUrl')).toBe('confirmed')
    const out = read(d, C)
    expect(out).toContain('x1.setUrl(BT_url("http://a.test/1"))')
    expect(out).toMatch(/BT_unurl\(x1\.getUrl\(\)\)/)
    expect(out).toContain('x1.setUrl("http://a.test/1", "extra")') // arity gate unchanged
    expect(out).toContain('x1.getUrl("arg")')
  })
  it('2: the type string is case-insensitive; a direct CreateObject receiver is confirmed', () => {
    expect(conf(d, C, 'x2')).toBe('confirmed')
    expect(conf(d, C, 'CreateObject(...)')).toBe('confirmed')
  })
  it('3: m and m.top chains assigned in another function of the same file are confirmed', () => {
    expect(conf(d, C, 'm.xm')).toBe('confirmed')
    expect(conf(d, C, 'm.top.xt')).toBe('confirmed')
    expect(conf(d, C, 'm.xm', 'getUrl')).toBe('confirmed')
  })
  it('4: one copy hop is confirmed, two hops are unknown (still rewritten)', () => {
    expect(conf(d, C, 'b4')).toBe('confirmed')
    expect(conf(d, C, 'h3')).toBe('unknown')
    expect(read(d, C)).toContain('h3.setUrl(BT_url("http://a.test/4b"))')
  })
  it('5: typed parameter is likely, name-hint parameter is likely, untyped p is unknown and listed', () => {
    expect(conf(d, 'source/typed.bs', 't')).toBe('likely')
    expect(conf(d, C, 'xfer')).toBe('likely')
    expect(conf(d, C, 'p')).toBe('unknown')
    expect(conf(d, C, 'p', 'getUrl')).toBe('unknown')
  })
  it('6: a call-result receiver is unknown and rewritten', () => {
    expect(conf(d, C, 'getXfer()')).toBe('unknown')
    expect(read(d, C)).toContain('getXfer().setUrl(BT_url("http://a.test/6"))')
  })
  it('7: a user object, m.top, m.global, `new` and another declared type are excluded and not rewritten', () => {
    for (const r of ['o7', 'm.top', 'm.global']) expect(sk(d, 'net-receiver-excluded', r).length, r).toBeGreaterThan(0)
    expect(sk(d, 'net-receiver-excluded', 'o7').length).toBe(2) // setUrl and getUrl
    expect(sk(d, 'net-receiver-excluded', 'a2').length).toBe(1) // `a2 = new Api()` (a bare `new X().setUrl` does not parse on bsc 0.73.8)
    expect(sk(d, 'net-receiver-excluded', 's').length).toBe(1) // `s as string`
    const out = read(d, C)
    expect(out).toContain('o7.setUrl("http://a.test/7")')
    expect(out).toContain('m.top.setUrl("http://a.test/7b")')
    expect(out).not.toMatch(/BT_unurl\(o7/)
    expect(read(d, 'source/typed.brs')).toContain('a2.setUrl("http://a.test/t2")')
    expect(d.result.skipped.every((x) => x.kind !== 'net-receiver-excluded' || /not rewritten/.test(x.reason))).toBe(true)
  })
  it('8: conflicting assignments that include a transfer are unknown, still rewritten and listed', () => {
    expect(conf(d, C, 'z8')).toBe('unknown')
    expect(sk(d, 'net-receiver-excluded', 'z8')).toEqual([])
    expect(read(d, C)).toContain('z8.setUrl(BT_url("http://a.test/8"))')
  })
  it('8b: m fields are scoped to the enclosing class; a transfer field is never excluded by another class', () => {
    const K = 'source/cls.bs'
    expect(conf(d, K, 'm.http')).toBe('confirmed')            // Fetcher
    expect(conf(d, K, 'm.http', 'getUrl')).toBe('confirmed')
    expect(rw(d, K, 'm.http').length).toBe(1)                 // FakeClient's site is not rewritten
    expect(sk(d, 'net-receiver-excluded', 'm.http').length).toBe(1)
    const out = read(d, 'source/cls.brs')
    expect(out.match(/m\.http\.setUrl\(BT_url\(u\)\)/g).length).toBe(1)
    expect(out.match(/m\.http\.setUrl\(u\)/g).length).toBe(1)
  })
  it('8c: scalar literals assigned to a variable are not evidence of another type', () => {
    const S = 'source/scalars.brs'
    for (const r of ['xs', 'xn', 'ok']) {
      expect(conf(d, S, r), r).toBe('unknown')
      expect(read(d, S)).toContain(`${r}.setUrl(BT_url("http://a.test/s${{ xs: 1, xn: 2, ok: 3 }[r]}"))`)
    }
    expect(conf(d, S, 'only')).toBe('unknown') // a lone scalar assignment is no positive evidence either
    expect(sk(d, 'net-receiver-excluded', 'xs')).toEqual([])
    expect(receiverMod.createClassifier({}).analyzeFile(Object.values(d.pb.program.files).find((x) => x.pkgPath === S)).every((x) => x.cls !== 'excluded')).toBe(true)
  })
  it('9: net.unknown "report" skips unknown sites and strict-style filtering sees them; default does not', async () => {
    const r = await run('recv-report', { net: { unknown: 'report' } })
    expect(r.errors).toEqual([])
    expect(sk(r, 'net-receiver-unknown', 'p').length).toBe(2)
    expect(sk(r, 'net-receiver-unknown', 'getXfer()').length).toBe(1)
    expect(read(r, C)).toContain('getXfer().setUrl("http://a.test/6")')
    expect(rw(r, C, 'p')).toEqual([])
    expect(conf(r, C, 'x1')).toBe('confirmed')
    const couldNot = (b) => b.result.skipped.filter((x) => !INFORMATIONAL_KINDS.includes(x.kind)).map((x) => x.kind)
    expect(couldNot(r)).toContain('net-receiver-unknown') // what instrument.strict counts
    expect(couldNot(d)).not.toContain('net-receiver-unknown')
    expect(couldNot(d)).not.toContain('net-receiver-excluded')
    const bad = await run('recv-bad', { net: { unknown: 'bogus' } })
    expect(bad.errors.some((e) => e.code === 'BT9005')).toBe(true)
    expect(bad.errors.some((e) => e.code === 'BT9004')).toBe(false) // BT9004 is reserved for plugin-reused (INS-F-T2)
  })
  it('9b: an invalid instrument.net value or receivers list is a BT9005 error', async () => {
    const cases = [
      [0, /instrument\.net must be a boolean or an object/],
      [null, /instrument\.net must be a boolean or an object/],
      ['false', /instrument\.net must be a boolean or an object/],
      [[], /instrument\.net must be a boolean or an object/],
      [{ receivers: 'x' }, /receivers must be an object/],
      [{ receivers: { allow: 'o10' } }, /receivers\.allow must be an array of strings/],
      [{ receivers: { deny: [1] } }, /receivers\.deny must be an array of strings/],
      [{ receivers: { allow: null } }, /receivers\.allow must be an array of strings/],
    ]
    for (const [i, [net, re]] of cases.entries()) {
      const r = await run(`recv-badnet-${i}`, { net })
      const e = r.errors.filter((x) => x.code === 'BT9005')
      expect(e.length, JSON.stringify(net)).toBe(1)
      expect(e[0].message, JSON.stringify(net)).toMatch(re)
    }
    for (const net of [true, false, {}, { unknown: 'report', receivers: { allow: ['a'], deny: [] } }]) {
      expect((await run('recv-goodnet', { net })).errors.filter((x) => x.code === 'BT9005'), JSON.stringify(net)).toEqual([])
    }
  })
  it('10: allow overrides excluded, deny wins over allow, file#pattern scopes, overlaps are reported', async () => {
    const r = await run('recv-allow', {
      net: { receivers: { allow: ['o10', 'x11', 'source/allow.brs#fscope', 'm*'], deny: ['X11', '*.mockhttp', 'mockHTTP'] } },
    })
    const A = 'source/allow.brs'
    expect(conf(r, A, 'o10')).toBe('likely') // allow overrides excluded
    expect(rw(r, A, 'x11')).toEqual([])      // deny wins over allow
    expect(sk(r, 'net-receiver-excluded', 'x11')[0].reason).toMatch(/deny "X11"/)
    expect(conf(r, A, 'fscope')).toBe('likely')                   // file-scoped allow
    expect(rw(r, C, 'fscope')).toEqual([])                        // not in the other file
    expect(sk(r, 'net-receiver-excluded', 'fscope').length).toBe(1)
    expect(rw(r, A, 'mockHttp')).toEqual([])
    expect(r.result.netOverlaps).toContainEqual(expect.objectContaining({ file: A, receiver: 'x11', allow: 'x11', deny: 'X11' }))
    expect(conf(r, C, 'x1')).toBe('confirmed') // allow never downgrades confirmed
    expect(read(r, A)).toContain('o10.setUrl(BT_url("http://a.test/10"))')
  })
  it('default config: allow.brs user object excluded, name hint on the transfer is not needed', () => {
    expect(sk(d, 'net-receiver-excluded', 'o10').length).toBe(1)
    expect(conf(d, 'source/allow.brs', 'x11')).toBe('confirmed')
    expect(conf(d, 'source/allow.brs', 'mockHttp')).toBe('confirmed')
  })
  it('11: indexed and bare forms stay skipped as before; getUrl never disagrees with setUrl', () => {
    for (const rcv of ['x1', 'm.xm', 'p', 'x2']) {
      const s = rw(d, C, rcv, 'setUrl').map((x) => x.confidence)
      const g = rw(d, C, rcv, 'getUrl').map((x) => x.confidence)
      if (s.length && g.length) expect(g[0]).toBe(s[0])
    }
    for (const rcv of ['o7']) expect(sk(d, 'net-receiver-excluded', rcv).map((x) => /getUrl/.test(x.reason))).toContain(true)
  })
  it('12: rewritten lines keep their statement lines against the all-AST baseline; one walk per file', async () => {
    const forced = await build(recv, path.join(tmp, 'recv-forced'), [forceTranspile])
    for (const f of ['source/classes.brs', 'source/allow.brs']) {
      const a = read(d, f).split('\n')
      const b = read(forced, f).split('\n')
      expect(a.length, f).toBe(b.length)
      a.forEach((l, i) => {
        expect(l.replace(/BT_url\(("[^"]*")\)/g, '$1').replace(/BT_unurl\((.*?\.getUrl\(\))\)/g, '$1'), `${f}:${i + 1}`).toBe(b[i])
      })
    }
    // Walk budget over the whole plugin build (same as the pre-heuristic base 2c2ca3c): 2 per rewritten file (classify +
    // transpile), 1 per excluded file that has candidate sites (classify only).
    // The spy counts every walk of a file's AST during a build; the plugin's share is the difference to a plugin-off build.
    const walksOf = async (name, plugins, extra) => {
      const counts = new Map()
      const spy = { name: 'walk-spy', afterFileParse: (f) => {
        if (!f.ast || !f.pkgPath) return
        const orig = f.ast.walk.bind(f.ast)
        f.ast.walk = (...a) => { counts.set(f.pkgPath, (counts.get(f.pkgPath) || 0) + 1); return orig(...a) }
      } }
      const r = await build(recv, path.join(tmp, name), plugins, extra, [spy])
      expect(r.errors).toEqual([])
      return counts
    }
    const off = await walksOf('recv-walks-off', [], {})
    const on = await walksOf('recv-walks-on', [pluginPath], { instrument: { exclude: ['source/allow.brs'] } })
    const own = (f) => (on.get(f) || 0) - (off.get(f) || 0)
    for (const f of ['source/classes.brs', 'source/cls.bs', 'source/scalars.brs']) expect(own(f), f).toBe(2)
    expect(own('source/allow.brs')).toBe(1)
  })
  it('13: classifier is deterministic and feature detection reports nothing on 0.73.8', () => {
    expect(receiverMod.missingApis()).toEqual([])
    expect(missingPrivateApis(undefined, undefined)).toEqual([])
    const file = Object.values(d.pb.program.files).find((x) => x.pkgPath === 'source/classes.brs')
    const sites = receiverMod.createClassifier({}).analyzeFile(file).filter((s) => s.eligible)
    const again = receiverMod.createClassifier({}).analyzeFile(file).filter((s) => s.eligible)
    expect(again.length).toBe(sites.length)
    expect(again.map((s) => [s.line, s.receiver, s.cls, s.reason])).toEqual(sites.map((s) => [s.line, s.receiver, s.cls, s.reason]))
    expect(new Set(sites.map((s) => s.cls))).toEqual(new Set(['confirmed', 'likely', 'unknown', 'excluded']))
  })
})
