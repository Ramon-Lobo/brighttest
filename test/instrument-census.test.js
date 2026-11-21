import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const createPlugin = require('../lib/instrument/plugin.js')
const { census, renderMarkdown, write } = require('../lib/instrument/census.js')
const { INFORMATIONAL_KINDS } = createPlugin
const pluginPath = path.resolve(__dirname, '../lib/instrument/plugin.js')
const legacy = path.resolve(__dirname, '../examples/legacy-app')
const fx = (n) => path.resolve(__dirname, 'fixtures/instrument-plugin', n)
let tmp

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-census-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const write1 = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const key = (s) => `${s.kind}|${s.file}|${s.line}`

async function pluginSkipped(rootDir, name) {
  const pb = new ProgramBuilder()
  await pb.run({
    cwd: rootDir, rootDir, stagingDir: path.join(tmp, name), createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*', 'components/**/*'], plugins: [pluginPath], logLevel: 'error', autoImportComponentScript: false,
    diagnosticFilters: [1107, 1140, 1009],
  })
  return createPlugin.lastInstance.getResult().skipped
}

describe('census of examples/legacy-app', () => {
  let c
  beforeAll(async () => { c = await census(legacy) })

  it('counts equal EXPECTED-CENSUS.json', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(legacy, 'EXPECTED-CENSUS.json'), 'utf8'))
    expect(c.v).toBe(1)
    expect(c.counts).toEqual(expected)
  })
  it('finds Scenes with chains and init, and the synthesized plan for the init-less Scene', () => {
    const by = Object.fromEntries(c.scenes.map((s) => [s.component, s]))
    expect(Object.keys(by).sort()).toEqual(['BareScene', 'BaseScene', 'DerivedScene', 'LegacyScene'])
    expect(by.DerivedScene.extendsChain).toEqual(['BaseScene', 'Scene'])
    expect(by.BareScene).toMatchObject({ hasInit: false, plan: 'synthesize' })
    expect(by.LegacyScene).toMatchObject({ hasInit: true, plan: 'bootstrap', file: 'components/scenes/LegacyScene.xml' })
  })
  it('finds Tasks with their function names', () => {
    expect(c.tasks.map((t) => [t.component, t.functionName])).toEqual([['PerRequestTask', 'go'], ['ThreadTask', 'record'], ['WorkerTask', 'loop']])
  })
  it('finds m.global.addFields keys and registry sections with lines', () => {
    expect(c.globalFields.map((g) => g.name)).toEqual(expect.arrayContaining(['config', 'user', 'authToken', 'sessionId', 'password', 'launchCount', 'stress']))
    expect(c.globalFields.find((g) => g.name === 'user')).toMatchObject({ file: 'source/main.brs', line: 26 })
    expect(c.registrySections).toEqual([
      { name: 'legacy_session', file: 'components/scenes/LegacyScene.brs', line: 12 },
      { name: 'legacy_prefs', file: 'source/main.brs', line: 39 },
    ])
  })
  it('classifies setUrl and CreateObject sites with threads and coverage', () => {
    const s = (f) => c.network.setUrlSites.find((x) => x.file === f)
    expect(s('components/net/PerRequestTask.brs')).toMatchObject({ line: 9, thread: 'task:PerRequestTask', covered: true })
    expect(s('components/scenes/LegacyScene.brs')).toMatchObject({ line: 72, thread: 'render', covered: true })
    expect(s('source/vendor/VendorClient.brs')).toMatchObject({ covered: false })
    expect(c.network.createObjectSites.filter((x) => x.class === 'roUrlTransfer')).toHaveLength(3)
    expect(c.network.createObjectSites.find((x) => x.class === '<dynamic>')).toMatchObject({ file: 'components/net/WorkerTask.brs', line: 14, covered: false })
  })
  it('reports not-covered items: sync on render thread, dynamic CreateObject, excluded vendor, content-node URL', () => {
    const reasons = (f, line) => c.notCovered.filter((n) => n.file === f && n.line === line).map((n) => n.reason)
    expect(reasons('components/scenes/LegacyScene.brs', 73)).toEqual(['render-thread sync'])
    expect(reasons('components/net/WorkerTask.brs', 14)).toEqual(['dynamic CreateObject'])
    expect(reasons('source/vendor/VendorClient.brs', 5)).toEqual(['excluded'])
    expect(reasons('components/scenes/LegacyScene.brs', 8)).toEqual(['content-node URL'])
  })
  it('lists the vendor candidate as informational (excluded by default, ADR 0019 (d) R5) and finds no parse problems', () => {
    expect(c.skipped.filter((s) => !s.informational).map(key)).toEqual([])
    expect(c.skipped.filter((s) => s.informational).map(key)).toEqual(['excluded-candidate|source/vendor/VendorClient.brs|5'])
    expect(c.skipped.find((s) => s.kind === 'excluded-candidate')).toMatchObject({ excludedBy: 'default' })
    expect(c.parseErrors).toEqual([])
  })
  it('renders census.md with the same counts and a could-not-instrument section, and writes census.{json,md}', () => {
    const md = renderMarkdown(c)
    expect(md).toContain('Could not instrument (0)')
    expect(md).toContain('Informational (1)')
    expect(md).toContain('3 roUrlTransfer literals, 1 dynamic CreateObject, 4 sync get, 1 async get, 3 certificate calls')
    expect(md).toContain('## Scenes (4)')
    const out = write(c, path.join(tmp, 'out'))
    expect(JSON.parse(fs.readFileSync(out.json, 'utf8'))).toEqual(JSON.parse(JSON.stringify(c)))
    expect(fs.readFileSync(out.md, 'utf8')).toContain('# Instrumentation census: legacy-app')
  })
  it('does not modify the tree', async () => {
    const before = fs.readdirSync(legacy).sort()
    await census(legacy)
    expect(fs.readdirSync(legacy).sort()).toEqual(before)
  })
})

describe('census skipped-report contract (ADR 0019 decision 5)', () => {
  let scratch
  beforeAll(async () => {
    scratch = path.join(tmp, 'skips'); fs.mkdirSync(scratch)
    write1(scratch, 'manifest', 'title=T\nmajor_version=1\n')
    write1(scratch, 'components/EmptyScene.xml', '<component name="EmptyScene" extends="Scene"><script type="text/brightscript" uri="EmptyScene.brs"/></component>\n')
    write1(scratch, 'components/EmptyScene.brs', 'sub init()\nend sub\n')
    write1(scratch, 'components/CdataScene.xml', '<?xml version="1.0"?>\n<component name="CdataScene" extends="Scene">\n  <script type="text/brightscript"><![CDATA[\n    sub init()\n      print "x"\n    end sub\n  ]]></script>\n</component>\n')
    write1(scratch, 'components/OddScene.xml', '<component name="OddScene" extends="FancyHeroScene"/>\n')
    write1(scratch, 'components/PanelScene.xml', '<component name="PanelScene" extends="OverhangPanelSetScene"><script type="text/brightscript" uri="PanelScene.brs"/></component>\n')
    write1(scratch, 'components/PanelScene.brs', 'sub init()\n  print "p"\nend sub\n')
    write1(scratch, 'source/net.brs', 'sub fetch(x as object)\n  x["setUrl"]("http://127.0.0.1:1/a")\n  x.getUrl()\n  x.setUrl("http://127.0.0.1:1/b")\nend sub\n')
  })
  it('records each class with kind, file, line and reason', async () => {
    const c = await census(scratch)
    const hard = c.skipped.filter((s) => !s.informational)
    expect(hard.map(key).sort()).toEqual([
      'bare-geturl|source/net.brs|3',
      'empty-init|components/EmptyScene.brs|1',
      'indexed-seturl|source/net.brs|2',
      'inline-cdata-scene|components/CdataScene.xml|3',
      'unknown-scene-subtype|components/OddScene.xml|1',
    ])
    for (const s of c.skipped) expect(s.reason).toBeTruthy()
  })
  it('inline-CDATA Scenes are report-only: recorded with the script tag line and no rewrite plan', async () => {
    const c = await census(scratch)
    expect(c.inlineCdataScenes).toEqual([{ component: 'CdataScene', file: 'components/CdataScene.xml', scriptLine: 3, initDetected: true, note: 'state agent unavailable for this Scene' }])
    expect(c.scenes.find((s) => s.component === 'CdataScene').plan).toBe('skipped:inline-cdata-scene')
    expect(c.scenes.find((s) => s.component === 'PanelScene').plan).toBe('bootstrap')
    expect(renderMarkdown(c)).toContain('Inline CDATA Scenes (report only, 1)')
  })
  it('matches the plugin getResult().skipped on the same tree (same kind+file+line keys)', async () => {
    const c = await census(scratch)
    const plug = await pluginSkipped(scratch, 'plug-skips')
    const hard = (l) => l.filter((s) => !INFORMATIONAL_KINDS.includes(s.kind)).map(key).sort()
    expect(hard(c.skipped)).toEqual(hard(plug))
  })
})

describe('census vs the plugin on the plugin fixtures (drift guard)', () => {
  for (const name of ['app', 'edge', 'share', 'shapes']) {
    it(`fixture "${name}": same could-not-instrument keys`, async () => {
      const c = await census(fx(name))
      const plug = await pluginSkipped(fx(name), 'plug-' + name)
      // census scope excludes test folders and *.spec.* (EXPECTED-CENSUS ground-truth scope); the plugin sees them
      const hard = (l) => l.filter((s) => !INFORMATIONAL_KINDS.includes(s.kind) && !/\.spec\.|(^|\/)tests?\//i.test(s.file)).map(key).sort()
      expect(hard(c.skipped)).toEqual(hard(plug))
    })
  }
})

describe('census config and edge cases', () => {
  it('config exclude globs flag matching files as excluded', async () => {
    const dir = path.join(tmp, 'cfg'); fs.mkdirSync(dir)
    write1(dir, 'manifest', 'title=T\n')
    write1(dir, 'source/lib/a.brs', 'sub a(x as object)\n  x.setUrl("http://h/")\nend sub\n')
    const open = await census(dir, { config: {} })
    expect(open.network.setUrlSites[0].covered).toBe(true)
    const closed = await census(dir, { config: { instrumentExclude: ['source/lib/**'] } })
    expect(closed.network.setUrlSites[0].covered).toBe(false)
    expect(closed.skipped.map((s) => s.kind)).toEqual(['excluded-candidate'])
  })
  it('an app with no network code produces empty network sections, not an error', async () => {
    const dir = path.join(tmp, 'plain'); fs.mkdirSync(dir)
    write1(dir, 'manifest', 'title=T\n')
    write1(dir, 'source/main.brs', 'sub main()\n  print "hi"\nend sub\n')
    const c = await census(dir)
    expect(c.network).toEqual({ setUrlSites: [], createObjectSites: [] })
    expect(c.notCovered).toEqual([])
    expect(c.skipped).toEqual([])
  })
  it('rejects a missing root', async () => {
    await expect(census(path.join(tmp, 'nope'))).rejects.toThrow(/not a directory/)
  })
})

describe('census mirrors ADR 0019 Amendment (d)', () => {
  it('excluded-candidate carries excludedBy and default ones are informational; callfunc-seturl; CDATA setUrl; extends', async () => {
    const dir = path.join(tmp, 'amend-d'); fs.mkdirSync(dir)
    const u = 'sub f(x as object)\n  x.setUrl("http://h/")\nend sub\n'
    write1(dir, 'manifest', 'title=T\n')
    write1(dir, 'source/rooibos/Runner.brs', u)
    write1(dir, 'source/mine/x.brs', u + 'sub g(n as object)\n  n.callFunc("setUrl", "u")\nend sub\n')
    write1(dir, 'components/Base.xml', '<component name="Base" extends="Scene"><script type="text/brightscript" uri="Base.brs"/></component>\n')
    write1(dir, 'components/Base.brs', 'sub init()\n  print "b"\nend sub\n')
    write1(dir, 'components/excl/Kid.xml', '<component name="Kid" extends="Base"/>\n')
    write1(dir, 'components/Cd.xml', '<?xml version="1.0"?>\n<component name="Cd" extends="Group">\n  <script type="text/brightscript"><![CDATA[\n    sub f(x)\n      x.setUrl("http://h/")\n    end sub\n  ]]></script>\n</component>\n')
    const c = await census(dir, { config: { instrument: { exclude: ['source/mine/**', 'components/excl/**'] } } })
    expect(c.skipped.find((s) => s.kind === 'excluded-candidate' && s.file.includes('rooibos'))).toMatchObject({ excludedBy: 'default', informational: true })
    expect(c.skipped.find((s) => s.kind === 'excluded-candidate' && s.file.includes('mine'))).toMatchObject({ excludedBy: 'user', informational: false })
    expect(c.skipped.filter((s) => s.kind === 'callfunc-seturl')).toEqual([])
    expect(c.skipped.find((s) => s.kind === 'init-shared-with-excluded-scene')).toMatchObject({ via: 'extends', component: 'Kid', file: 'components/Base.brs' })
    expect(c.inlineCdataSetUrl).toEqual([{ component: 'Cd', file: 'components/Cd.xml', line: 5 }])
    expect(renderMarkdown(c)).toContain('setUrl in inline CDATA')
  })
  it('reports callfunc-seturl in a non-excluded file', async () => {
    const dir = path.join(tmp, 'amend-d2'); fs.mkdirSync(dir)
    write1(dir, 'manifest', 'title=T\n')
    write1(dir, 'source/x.brs', 'sub g(n as object)\n  n.callFunc("SetUrl", "u")\nend sub\n')
    const c = await census(dir)
    expect(c.skipped.find((s) => s.kind === 'callfunc-seturl')).toMatchObject({ file: 'source/x.brs', line: 2, informational: true })
  })
})
