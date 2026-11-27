import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// FR-PACKAGE-FILES + FR-BSC-GATE: the instrument lane packages everything the Roku packager would, and bsc whole-program
// validation errors (1140/1104/1067/1068/1054 ...) are warnings unless --fail-on-bsc-errors.
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { build } = require('../lib/instrument/build')
const { loadConfig, writeBsConfig, instrumentFiles } = require('../lib/config')
const report = require('../lib/instrument/build-report')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ipkg-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const MANIFEST = 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n'
// Constructs bsc validation rejects although the device ships them (the old build failed on all of these).
const SHIPPABLE_BUT_INVALID = [
  'sub main()',
  '    unknownFn()', // 1140 cannot find function
  '    clamp = 1', // 1104 local named like a scoped function
  '    print helper(1, 2, 3)', // 1002 argument count
  '    print "pkg:/images/logo.png"',
  '    print "pkg:/images/gone.png"', // literal that points at a file that is not shipped
  'end sub',
  'function clamp(a)',
  '    return a',
  'end function',
  'function helper(a)',
  '    return a',
  'end function',
  '',
].join('\n')

function mkapp(name, files, config) {
  const dir = path.join(tmp, 'app-' + name)
  const all = { manifest: MANIFEST, 'source/main.brs': SHIPPABLE_BUT_INVALID, 'images/logo.png': 'png', 'images/b.png': 'png', 'fonts/f.ttf': 'ttf', 'config.json': '{}', ...files }
  if (config) all['brighttest.json'] = JSON.stringify(config)
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
const run = async (dir, name, opts = {}, cfgExtra = {}) => {
  const lines = []
  const cfg = { ...loadConfig(dir), rootDir: dir, stagingDir: path.join(tmp, 'stage-' + name), ...cfgExtra }
  const out = path.join(tmp, 'out-' + name + '.zip')
  const r = await build(cfg, { log: (l) => lines.push(l), out, ...opts })
  return { ...r, log: lines, out }
}
const entries = async (zip) => Object.keys((await JSZip.loadAsync(fs.readFileSync(zip))).files).filter((n) => !n.endsWith('/'))

describe('FR-PACKAGE-FILES: package contents', () => {
  it('ships images, fonts, root files and callee files outside source/ and components/', async () => {
    const dir = mkapp('files', {
      'components/MyScene.xml': '<?xml version="1.0" encoding="utf-8" ?>\n<component name="MyScene" extends="Scene">\n<script type="text/brightscript" uri="pkg:/lib/util.brs" />\n</component>\n',
      'lib/util.brs': 'function utilThing()\n    return 1\nend function\n',
      'source/tests/A.spec.brs': 'sub spec()\nend sub\n',
      '.hidden/x.txt': 'x',
      '.DS_Store': 'x',
    })
    const r = await run(dir, 'files')
    expect(r.exitCode).toBe(0)
    const names = await entries(r.out)
    for (const n of ['images/logo.png', 'images/b.png', 'fonts/f.ttf', 'config.json', 'lib/util.brs', 'manifest', 'source/main.brs']) expect(names).toContain(n)
    expect(names.filter((n) => /tests\/|\.hidden|DS_Store|brighttest\.json/.test(n))).toEqual([])
    expect(r.log.join('\n')).not.toMatch(/not packaged/)
  })

  it('with the old compile-only list as instrument.files, warns with per-folder counts and missing pkg:/ literals', async () => {
    const dir = mkapp('narrow', {}, { instrument: { files: ['manifest', 'source/**/*', 'components/**/*'] } })
    const r = await run(dir, 'narrow')
    expect(r.exitCode).toBe(0)
    const text = r.log.join('\n')
    expect(text).toMatch(/images\/: 2 not packaged/)
    expect(text).toMatch(/fonts\/: 1 not packaged/)
    expect(text).toMatch(/\(root\): 1 not packaged/)
    expect(text).toMatch(/pkg:\/images\/logo\.png \(in source\/main\.brs\)/)
    expect(text).toMatch(/pkg:\/images\/gone\.png/)
    expect(await entries(r.out)).not.toContain('images/logo.png')
  })

  it('instrument.files does not change the headless lanes sourceGlobs', () => {
    const dir = mkapp('lanes', {}, { instrument: { files: ['manifest', 'images/**/*'] } })
    const cfg = { ...loadConfig(dir), rootDir: dir, stagingDir: path.join(tmp, 'stage-lanes') }
    const head = JSON.parse(fs.readFileSync(writeBsConfig(cfg, 'headless').bsconfigPath, 'utf8'))
    expect(head.files).toEqual(['manifest', 'source/**/*', 'components/**/*'])
    expect(instrumentFiles(cfg)).toEqual(['manifest', 'images/**/*'])
    const ins = writeBsConfig(cfg, 'instrument').bsconfig
    expect(ins.files).toEqual(['manifest', 'images/**/*'])
    expect(ins.instrument.files).toBeUndefined()
  })

  it('default files excludes the staging dir when it sits inside rootDir', () => {
    const dir = mkapp('stagein', {})
    const g = instrumentFiles({ rootDir: dir, stagingDir: path.join(dir, 'build-out'), instrument: {} })
    expect(g).toContain('!build-out/**')
    expect(g[0]).toBe('**/*')
  })
})

describe('FR-BSC-GATE: bsc validation errors', () => {
  it('builds (exit 0) with warnings, a histogram and a paste-ready diagnosticFilters line', async () => {
    const dir = mkapp('gate', {})
    const r = await run(dir, 'gate')
    expect(r.exitCode).toBe(0)
    expect(fs.existsSync(r.out)).toBe(true)
    const text = r.log.join('\n')
    expect(text).toMatch(/warning: 1140 source[\\/]main\.brs:2/)
    expect(text).toMatch(/by code: .*1140=1/)
    expect(text).toMatch(/"diagnosticFilters": \[\d{4}(, \d{4})*\]/)
    expect(text).toMatch(/compiler checks, not Roku runtime errors/)
    expect(text).toMatch(/--fail-on-bsc-errors/)
  })

  it('--fail-on-bsc-errors restores the strict behaviour and still prints the histogram and filter line', async () => {
    const dir = mkapp('gate-strict', {})
    const r = await run(dir, 'gate-strict', { failOnBscErrors: true })
    expect(r.exitCode).toBe(1)
    expect(fs.existsSync(r.out)).toBe(false)
    const text = r.log.join('\n')
    expect(text).toMatch(/^1140 source[\\/]main\.brs:2/m)
    expect(text).toMatch(/"diagnosticFilters": \[/)
    expect(text).toMatch(/no package written/)
  })

  it('diagnosticFilters in brighttest.json silences the codes (no warnings)', async () => {
    const dir = mkapp('gate-filter', {}, { diagnosticFilters: [1140, 1104, 1002] })
    const r = await run(dir, 'gate-filter')
    expect(r.exitCode).toBe(0)
    expect(r.log.join('\n')).not.toMatch(/warning: 1\d{3}/)
  })

  it('a parse error in an app file still fails the build', async () => {
    const dir = mkapp('gate-parse', { 'source/broken.brs': 'sub broken()\n    if then\nend sub\n' })
    const r = await run(dir, 'gate-parse')
    expect(r.exitCode).toBe(1)
    expect(r.log.join('\n')).toMatch(/source[\\/]broken\.brs/)
    expect(fs.existsSync(r.out)).toBe(false)
  })

  it('a plugin error (BT9xxx) still fails the build', async () => {
    const dir = path.join(tmp, 'app-gate-plugin')
    fs.cpSync(path.resolve(__dirname, 'fixtures/instrument-plugin/app'), dir, { recursive: true })
    const r = await run(dir, 'gate-plugin', { plugins: [path.resolve(__dirname, 'fixtures/instrument-plugin/break-rewrite.js')] }, { diagnosticFilters: [1140, 1009] })
    expect(r.exitCode).toBe(1)
    expect(r.log.join('\n')).toMatch(/BT9003/)
  })
})

describe('build-report helpers', () => {
  const d = (code, file, line, severity = 1) => ({ code, severity, file: { pkgPath: file }, range: { start: { line: line - 1, character: 0 } }, message: 'm' })
  it('dedupes the same file:line:code across scopes and classifies', () => {
    const { blocking, advisory } = report.classify([d(1140, 'a.brs', 3), d(1140, 'a.brs', 3), d('BT9001', 'b.brs', 1), d(1104, 'a.brs', 4)])
    expect(advisory.map((x) => x.code)).toEqual([1140, 1104])
    expect(blocking.map((x) => x.code)).toEqual(['BT9001'])
    expect(report.classify([d(1140, 'a.brs', 3)], { failOnBsc: true }).blocking).toHaveLength(1)
  })
  it('histogram sorts by count and lists codes ascending in the filter line', () => {
    const h = report.histogram([d(1140, 'a', 1), d(1140, 'a', 2), d(1104, 'a', 3), d('BT9001', 'a', 4)])
    expect(h.codes).toEqual([[1140, 2], [1104, 1]])
    expect(h.line).toBe('"diagnosticFilters": [1104, 1140]')
  })
})
