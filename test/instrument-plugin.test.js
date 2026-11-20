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
    for (const x of r.skipped) expect(Object.keys(x).sort()).toEqual(['file', 'kind', 'line', 'reason'])
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

