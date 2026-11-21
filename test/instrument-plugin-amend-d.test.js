import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ADR 0019 Amendment (d), INS-F-T2 plugin-patch commit: R2, R3, R4, R5, xml-parse-failed, Scene list, callfunc-seturl,
// namespaced BT_url, feature-detect, virtual stub path.
const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const pluginPath = path.resolve(__dirname, '../lib/instrument/plugin.js')
const createPlugin = require(pluginPath)
const { SKIP_KINDS, INFORMATIONAL_KINDS, missingPrivateApis, SCENE_BUILTINS } = createPlugin
const fx = (n) => path.resolve(__dirname, 'fixtures/instrument-plugin', n)
const lateEdit = fx('late-body-edit.js')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-amend-d-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function build(rootDir, name, plugins = [], extra = {}, plugin = createPlugin()) {
  const pb = new ProgramBuilder()
  pb.plugins.add(plugin)
  await pb.run({
    cwd: rootDir, rootDir, stagingDir: path.join(tmp, name, 'staging'), createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*', 'components/**/*'], plugins, logLevel: 'error', autoImportComponentScript: false,
    diagnosticFilters: [1107, 1140, 1009], ...extra,
  })
  const errors = pb.program.getDiagnostics().filter((d) => d.severity === 1)
  return { pb, plugin, errors, staging: path.join(tmp, name, 'staging'), result: plugin.getResult() }
}
const read = (b, rel) => fs.readFileSync(path.join(b.staging, rel), 'utf8')
function mkapp(name, files) {
  const dir = path.join(tmp, 'src-' + name)
  for (const [rel, text] of Object.entries({ manifest: 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
const comp = (name, ext, scripts = []) => `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n${scripts.map((s) => `  <script type="text/brightscript" uri="pkg:/${s}" />\n`).join('')}</component>\n`

describe('R3: the init body view composes with later plugins', () => {
  it('a plugin after ours that replaces the body statements keeps its edit and our bootstrap call', async () => {
    const b = await build(fx('extends-group'), 'r3', [lateEdit])
    expect(b.errors.map((e) => e.message)).toEqual([])
    const out = read(b, 'components/base.brs')
    expect(out).toMatch(/sub init\(\) : BT_bootstrap\(m\.top\)\s*\n\s*print "late-edit"\s*\n\s*print "base init"/)
    expect(b.result.invalid).toEqual([])
  })
})

describe('R2: BT9004 plugin-reused', () => {
  it('a second Program built with the same plugin instance reports BT9004 and does not double the lists', async () => {
    const plugin = createPlugin()
    const first = await build(fx('extends-group'), 'r2a', [], {}, plugin)
    expect(first.errors.filter((e) => e.code === 'BT9004')).toEqual([])
    const n = first.result.bootstrapped.length
    expect(n).toBe(1)
    const second = await build(fx('extends-group'), 'r2b', [], {}, plugin)
    expect(second.errors.some((e) => e.code === 'BT9004')).toBe(true)
    expect(second.errors.find((e) => e.code === 'BT9004').message).toMatch(/new Program per instrumented build/)
    expect(second.result.bootstrapped).toHaveLength(n)
  })
  it('a second transpile on the same program reports BT9004', async () => {
    const b = await build(fx('extends-group'), 'r2c')
    expect(b.errors.filter((e) => e.code === 'BT9004')).toEqual([])
    b.plugin.beforeProgramTranspile(b.pb.program)
    expect(b.pb.program.getDiagnostics().some((e) => e.code === 'BT9004')).toBe(true)
    expect(b.plugin.getResult().bootstrapped).toHaveLength(1)
  })
})

describe('R4: an excluded Scene that extends an instrumented Scene', () => {
  const opts = { instrument: { exclude: ['components/excl/**'] } }
  it('does not wrap the base init, reports init-shared-with-excluded-scene via extends, strict-relevant', async () => {
    const b = await build(fx('extends'), 'r4a', [], opts)
    expect(b.errors.map((e) => e.message)).toEqual([])
    expect(read(b, 'components/base.brs')).not.toMatch(/BT_bootstrap/)
    expect(b.result.bootstrapped).toEqual([])
    const s = b.result.skipped.find((x) => x.kind === 'init-shared-with-excluded-scene' && x.file === 'components/base.brs')
    expect(s).toMatchObject({ via: 'extends', component: 'Child', line: 1 })
    expect(s.reason).toMatch(/Child/)
    expect(INFORMATIONAL_KINDS).not.toContain('init-shared-with-excluded-scene')
  })
  it('does not synthesize an init for a base Scene with an excluded descendant', async () => {
    const b = await build(fx('extends'), 'r4b', [], opts)
    expect(b.result.synthesized).not.toContain('Base2')
    expect(fs.existsSync(path.join(b.staging, 'components/bt/BT_init_Base2.brs'))).toBe(false)
    expect(b.result.skipped.find((x) => x.kind === 'init-shared-with-excluded-scene' && x.file === 'components/Base2.xml'))
      .toMatchObject({ via: 'extends', component: 'Child2' })
  })
  it('without the exclude, Base is bootstrapped once and Base2 is synthesized', async () => {
    const b = await build(fx('extends'), 'r4c')
    expect(b.result.bootstrapped.filter((x) => x.file === 'components/base.brs')).toHaveLength(1)
    expect(read(b, 'components/base.brs')).toMatch(/BT_bootstrap/)
    expect(b.result.skipped.some((x) => x.kind === 'init-shared-with-excluded-scene')).toBe(false)
  })
  it('an excluded non-Scene descendant leaves the wrap in place', async () => {
    const b = await build(fx('extends-group'), 'r4d', [], opts)
    expect(read(b, 'components/base.brs')).toMatch(/BT_bootstrap/)
    expect(b.result.skipped.some((x) => x.kind === 'init-shared-with-excluded-scene')).toBe(false)
  })
  it('the import-based F2 entry carries via "import"', async () => {
    const b = await build(fx('share'), 'r4e', [], { instrument: { exclude: ['components/vendorui/**'] } })
    expect(b.result.skipped.find((x) => x.kind === 'init-shared-with-excluded-scene')).toMatchObject({ via: 'import', component: 'ExScn' })
  })
})

describe('R5: excludedBy on excluded-candidate', () => {
  const src = 'sub f(x as object)\n    x.setUrl("http://127.0.0.1:1/a")\nend sub\n'
  it('is "default" for default-excluded paths (also when a user glob matches too) and "user" otherwise', async () => {
    const dir = mkapp('r5', {
      'source/main.brs': 'sub main()\nend sub\n',
      'source/rooibos/TestRunner.brs': src,
      'source/vendor2/x.brs': src,
      'source/vendor/y.brs': src,
    })
    const b = await build(dir, 'r5', [], { instrument: { exclude: ['source/vendor2/**', 'source/vendor/**'] } })
    const by = (f) => b.result.skipped.find((x) => x.kind === 'excluded-candidate' && x.file === f)
    expect(by('source/rooibos/TestRunner.brs')).toMatchObject({ excludedBy: 'default' })
    expect(by('source/vendor/y.brs')).toMatchObject({ excludedBy: 'default' })
    expect(by('source/vendor2/x.brs')).toMatchObject({ excludedBy: 'user' })
  })
})

describe('xml-parse-failed', () => {
  it('is reported for a component XML that bsc cannot parse', async () => {
    const dir = mkapp('badxml', {
      'source/main.brs': 'sub main()\nend sub\n',
      'components/Broken.xml': '<?xml version="1.0" encoding="utf-8" ?>\n<component name="Broken" extends="Group">\n  <script type="text/brightscript" uri="pkg:/a.brs"\n</component>\n',
      'components/Fine.xml': comp('Fine', 'Group'),
    })
    const b = await build(dir, 'badxml')
    const e = b.result.skipped.filter((x) => x.kind === 'xml-parse-failed')
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ file: 'components/Broken.xml' })
    expect(e[0].line).toBeGreaterThan(0)
    expect(e[0].reason).toBeTruthy()
  })
})

describe('built-in Scene subtype list', () => {
  const mk = (name, root) => mkapp(name, { 'source/main.brs': 'sub main()\nend sub\n', 'components/A.xml': comp('A', root) })
  it('exports an explicit list', () => {
    expect(SCENE_BUILTINS).toEqual(['scene', 'overhangpanelsetscene'])
  })
  it('reports an unknown built-in root even when its name does not contain "scene"', async () => {
    const b = await build(mk('odd1', 'MysteryRoot'), 'odd1')
    expect(b.result.skipped.find((x) => x.kind === 'unknown-scene-subtype')).toMatchObject({ file: 'components/A.xml' })
  })
  it('does not report known built-in non-Scene roots or known Scene roots', async () => {
    for (const root of ['Group', 'Node', 'Task', 'LayoutGroup', 'Rectangle', 'ContentNode', 'Scene', 'OverhangPanelSetScene']) {
      const b = await build(mk('root-' + root, root), 'root-' + root)
      expect(b.result.skipped.filter((x) => x.kind === 'unknown-scene-subtype'), root).toEqual([])
    }
  })
})

describe('callfunc-seturl (informational)', () => {
  it('reports callFunc("setUrl", u) and never rewrites it', async () => {
    const dir = mkapp('cf', {
      'source/main.brs': 'sub main()\nend sub\n',
      'source/cf.brs': 'sub f(n as object, u as string)\n    n.callFunc("SetUrl", u)\n    n.callFunc("other", u)\nend sub\n',
    })
    const b = await build(dir, 'cf')
    const e = b.result.skipped.filter((x) => x.kind === 'callfunc-seturl')
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ file: 'source/cf.brs', line: 2 })
    expect(read(b, 'source/cf.brs')).not.toMatch(/BT_url/)
    expect(INFORMATIONAL_KINDS).toContain('callfunc-seturl')
    expect(SKIP_KINDS).toContain('callfunc-seturl')
  })
})

describe('reserved names and feature detect', () => {
  it('a namespaced BT_url does not trip BT9001, a global one does', async () => {
    const ok = mkapp('ns-ok', { 'source/main.brs': 'sub main()\nend sub\n', 'source/ns.bs': 'namespace x\n    function BT_url(u as string) as string\n        return u\n    end function\nend namespace\n' })
    expect((await build(ok, 'ns-ok')).errors.filter((e) => e.code === 'BT9001')).toEqual([])
    const bad = mkapp('ns-bad', { 'source/main.brs': 'sub main()\nend sub\n', 'source/g.brs': 'function bt_URL(u as string) as string\n    return u\nend function\n' })
    expect((await build(bad, 'ns-bad')).errors.filter((e) => e.code === 'BT9001')).toHaveLength(1)
  })
  it('missingPrivateApis names Program#plugins.plugins when it is absent', () => {
    expect(missingPrivateApis(undefined, { plugins: {} })).toContain('Program#plugins.plugins')
    expect(missingPrivateApis(undefined, { plugins: { plugins: [] } })).not.toContain('Program#plugins.plugins')
  })
  it('the synthesized stub and runtime use a fixed virtual path, independent of the cwd', async () => {
    const before = process.cwd()
    try {
      process.chdir(tmp)
      const b = await build(fx('extends'), 'virt')
      const stub = b.pb.program.getFile('components/bt/BT_init_Base2.brs')
      const rt = b.pb.program.getFile('source/bt/BT_runtime.brs')
      expect(stub.srcPath.replace(/\\/g, '/')).toMatch(/^([A-Za-z]:)?\/__brighttest__\/components\/bt\/BT_init_Base2\.brs$/)
      expect(rt.srcPath.replace(/\\/g, '/')).toMatch(/^([A-Za-z]:)?\/__brighttest__\/__bt_runtime__\.brs$/)
    } finally { process.chdir(before) }
  })
})

describe('SKIP_KINDS', () => {
  it('lists every kind the plugin source can emit through skip()/skipOnce()', () => {
    const src = fs.readFileSync(pluginPath, 'utf8')
    const found = new Set([...src.matchAll(/\bskip(?:Once)?\(\s*'([a-z-]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('-')))
    found.add('indexed-seturl'); found.add('indexed-geturl') // built as 'indexed-' + name
    for (const k of found) expect(SKIP_KINDS, k).toContain(k)
    for (const k of SKIP_KINDS) expect(found.has(k), k).toBe(true)
  })
})
