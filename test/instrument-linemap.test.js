import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const createPlugin = require(path.resolve(__dirname, '../lib/instrument/plugin.js'))
const lineshift = path.resolve(__dirname, 'fixtures/instrument-plugin/lineshift')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-linemap-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function build(name, instrument, extra = {}) {
  const plugin = createPlugin()
  const pb = new ProgramBuilder()
  pb.plugins.add(plugin)
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  await pb.run({
    cwd: dir, rootDir: lineshift, stagingDir: path.join(dir, 'staging'), createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*'], plugins: [], logLevel: 'error', autoImportComponentScript: false,
    diagnosticFilters: [1107, 1140, 1009], ...(instrument === undefined ? {} : { instrument }), ...extra,
  })
  return { dir, staging: path.join(dir, 'staging'), plugin, result: plugin.getResult(), errors: pb.program.getDiagnostics().filter((d) => d.severity === 1) }
}
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1
const src = (f) => fs.readFileSync(path.join(lineshift, f), 'utf8')

describe('instrument.lineMap', () => {
  it('is off by default: no map file, no lineMap in the result, staged output unchanged', async () => {
    const off = await build('default')
    expect(off.errors).toEqual([])
    expect(off.result.lineMap).toBeUndefined()
    expect(fs.existsSync(path.join(off.dir, 'out', 'bt-linemap.json'))).toBe(false)
    const explicit = await build('explicit-false', { lineMap: false })
    expect(fs.readFileSync(path.join(explicit.staging, 'source/net.brs'), 'utf8')).toBe(fs.readFileSync(path.join(off.staging, 'source/net.brs'), 'utf8'))
  })

  it('writes the map outside the staging dir for rewritten files only, and maps the crash line to the source line', async () => {
    const on = await build('on', { lineMap: true })
    expect(on.errors).toEqual([])
    const mapFile = path.join(on.dir, 'out', 'bt-linemap.json')
    expect(on.result.lineMap).toBe(mapFile)
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
    expect(map.schema).toBe(1)
    expect(Object.keys(map.files)).toContain('source/net.brs')
    expect(Object.keys(map.files)).not.toContain('source/plain.brs') // unrewritten
    const staged = fs.readFileSync(path.join(on.staging, 'source/net.brs'), 'utf8')
    const crashStaged = lineOf(staged, 'a.nope.deep')
    const crashSrc = lineOf(src('source/net.brs'), 'a.nope.deep')
    expect(crashStaged).not.toBe(crashSrc) // the shift exists, so the map is needed
    const hit = map.files['source/net.brs'].find((e) => e[0] === crashStaged)
    expect(hit).toEqual([crashStaged, crashSrc])
    // statements after the expanded inline `if` and AA map back too
    const callStaged = lineOf(staged, 'setUrl')
    expect(map.files['source/net.brs'].find((e) => e[0] === callStaged)[1]).toBe(lineOf(src('source/net.brs'), 'setUrl'))
    // the map is not part of the staged output
    expect(fs.existsSync(path.join(on.staging, 'bt-linemap.json'))).toBe(false)
    expect(fs.readdirSync(path.join(on.staging, 'source')).filter((f) => f.endsWith('.map'))).toEqual([])
  })

  it('turning the map on does not change the staged files', async () => {
    const off = await build('same-off')
    const on = await build('same-on', { lineMap: true })
    for (const f of ['source/net.brs', 'source/plain.brs', 'source/main.brs']) {
      expect(fs.readFileSync(path.join(on.staging, f), 'utf8')).toBe(fs.readFileSync(path.join(off.staging, f), 'utf8'))
    }
  })

  it('a relative path resolves against cwd (not rootDir) and the file is written there', async () => {
    const on = await build('rel', { lineMap: 'maps/m.json' })
    expect(on.errors).toEqual([])
    const target = path.join(on.dir, 'maps', 'm.json')
    expect(on.result.lineMap).toBe(target)
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).files['source/net.brs'].length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(lineshift, 'maps'))).toBe(false)
  })

  it('an absolute path is used as given', async () => {
    const target = path.join(tmp, 'custom', 'map.json')
    const on = await build('abs', { lineMap: target })
    expect(on.errors).toEqual([])
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).files['source/net.brs'].length).toBeGreaterThan(0)
  })

  it('every staged line from the first mapped one on has an entry (fill forward) and entries are ascending', async () => {
    const on = await build('fill', { lineMap: true })
    const staged = fs.readFileSync(path.join(on.staging, 'source/net.brs'), 'utf8').replace(/\n$/, '').split('\n')
    const e = JSON.parse(fs.readFileSync(on.result.lineMap, 'utf8')).files['source/net.brs']
    expect(e.map((x) => x[0])).toEqual(staged.map((_, i) => i + 1).slice(e[0][0] - 1))
    for (let i = 1; i < e.length; i++) expect(e[i][1]).toBeGreaterThanOrEqual(e[i - 1][1])
  })

  it.each([[42], ['  '], [{}], [['x']]])('an invalid value %j is a clear BT9006 error', async (value) => {
    const b = await build('bad-' + JSON.stringify(value), { lineMap: value })
    const d = b.errors.filter((e) => e.code === 'BT9006')
    expect(d.length).toBe(1)
    expect(d[0].message).toMatch(/instrument\.lineMap must be true, false or a non-empty file path/)
    expect(b.result.lineMap).toBeUndefined()
  })

  it('a path inside the staging dir is rejected (it would be packaged)', async () => {
    const dir = path.join(tmp, 'inside')
    const b = await build('inside', { lineMap: path.join(dir, 'staging', 'bt-linemap.json') })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
    expect(fs.existsSync(path.join(dir, 'staging', 'bt-linemap.json'))).toBe(false)
  })

  it('a relative path into the staging dir is rejected', async () => {
    const b = await build('inside-rel', { lineMap: 'staging/x/bt-linemap.json' })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
  })

  it('a sibling dir sharing the staging name prefix is allowed (no string-prefix match)', async () => {
    const dir = path.join(tmp, 'prefix')
    const b = await build('prefix', { lineMap: path.join(dir, 'staging-maps', 'm.json') })
    expect(b.errors).toEqual([])
    expect(fs.existsSync(path.join(dir, 'staging-maps', 'm.json'))).toBe(true)
  })

  it('a symlink into the staging dir is rejected', async () => {
    const dir = path.join(tmp, 'sym')
    fs.mkdirSync(path.join(dir, 'staging'), { recursive: true })
    fs.symlinkSync(path.join(dir, 'staging'), path.join(dir, 'maps'))
    const b = await build('sym', { lineMap: 'maps/bt-linemap.json' })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
    expect(fs.readdirSync(path.join(dir, 'staging'))).not.toContain('bt-linemap.json')
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('a case variant of the staging dir is rejected', async () => {
    const dir = path.join(tmp, 'case')
    const b = await build('case', { lineMap: path.join(dir, 'STAGING', 'bt-linemap.json') })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
  })

  it('a path inside rootDir (outside the output dir) is rejected: the next build would package it', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'root-'))
    fs.cpSync(lineshift, root, { recursive: true })
    const plugin = createPlugin()
    const pb = new ProgramBuilder()
    pb.plugins.add(plugin)
    await pb.run({
      cwd: root, rootDir: root, stagingDir: path.join(root, 'build', 'staging'), createPackage: false, files: ['**/*'], plugins: [],
      logLevel: 'error', autoImportComponentScript: false, diagnosticFilters: [1107, 1140, 1009], instrument: { lineMap: 'bt-linemap.json' },
    })
    expect(pb.program.getDiagnostics().filter((d) => d.code === 'BT9006')[0].message).toMatch(/inside rootDir/)
    expect(fs.existsSync(path.join(root, 'bt-linemap.json'))).toBe(false)
  })

  it('true with createPackage and an outFile writes the map beside the zip and not into it', async () => {
    const dir = path.join(tmp, 'zip')
    const outFile = path.join(dir, 'dist', 'app.zip')
    const on = await build('zip', { lineMap: true }, { createPackage: true, outFile })
    expect(on.errors).toEqual([])
    expect(on.result.lineMap).toBe(path.join(dir, 'dist', 'bt-linemap.json'))
    expect(fs.existsSync(on.result.lineMap)).toBe(true)
    const listing = execFileSync('unzip', ['-Z1', outFile]).toString().split('\n')
    expect(listing).toContain('source/net.brs')
    expect(listing.filter((l) => /linemap/i.test(l))).toEqual([])
  })

  it('with no stagingDir the map goes to the output dir and is claimed only once written', async () => {
    const dir = path.join(tmp, 'nostage')
    fs.mkdirSync(dir, { recursive: true })
    const plugin = createPlugin()
    const pb = new ProgramBuilder()
    pb.plugins.add(plugin)
    await pb.run({
      cwd: dir, rootDir: lineshift, createPackage: false, retainStagingDir: false, files: ['manifest', 'source/**/*'], plugins: [],
      logLevel: 'error', autoImportComponentScript: false, diagnosticFilters: [1107, 1140, 1009], instrument: { lineMap: true },
    })
    const r = plugin.getResult()
    expect(r.lineMap).toBe(path.join(dir, 'out', 'bt-linemap.json'))
    expect(fs.existsSync(r.lineMap)).toBe(true)
  })

  describe('a failed map write', () => {
    const merged = (b) => fs.readFileSync(path.join(b.staging, 'manifest'), 'utf8')
    const expectBroken = (b) => {
      const d = b.errors.filter((e) => e.code === 'BT9006')
      expect(d.length).toBe(1)
      expect(d[0].message).toMatch(/could not write/)
      // the manifest merge still ran, and no lineMap is claimed
      expect(merged(b)).toMatch(/bt_instrumented=1/)
      expect(merged(b)).toMatch(/BT_AGENT=true/)
      expect(b.result.lineMap).toBeUndefined()
    }
    it('a directory target is a BT9006 and the manifest is still merged', async () => {
      const target = path.join(tmp, 'wr-dir', 'bt-linemap.json')
      fs.mkdirSync(target, { recursive: true })
      expectBroken(await build('wr-dir', { lineMap: target }))
    })
    it('a parent that is a file is a BT9006 and the manifest is still merged', async () => {
      const parent = path.join(tmp, 'wr-file-parent')
      fs.writeFileSync(parent, 'x')
      expectBroken(await build('wr-file', { lineMap: path.join(parent, 'bt-linemap.json') }))
    })
    it.runIf(process.platform !== 'win32' && process.getuid && process.getuid() !== 0)('an unwritable directory is a BT9006 and the manifest is still merged', async () => {
      const ro = path.join(tmp, 'wr-ro-parent')
      fs.mkdirSync(ro)
      fs.chmodSync(ro, 0o500)
      try { expectBroken(await build('wr-ro', { lineMap: path.join(ro, 'sub', 'bt-linemap.json') })) } finally { fs.chmodSync(ro, 0o700) }
    })
  })

  it('a rewritten file that ends in a sourceMappingURL comment maps without a false BT9006', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'smu-'))
    fs.mkdirSync(path.join(root, 'source'))
    fs.writeFileSync(path.join(root, 'manifest'), 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n')
    fs.writeFileSync(path.join(root, 'source', 'main.brs'), 'sub main()\nend sub\n')
    fs.writeFileSync(path.join(root, 'source', 'lib.brs'), 'sub lib()\n  u = CreateObject("roUrlTransfer")\n  u.setUrl("http://127.0.0.1:1/c")\nend sub\n\'//# sourceMappingURL=./lib.brs.map\n')
    const plugin = createPlugin()
    const pb = new ProgramBuilder()
    pb.plugins.add(plugin)
    const dir = path.join(tmp, 'smu-out')
    fs.mkdirSync(dir, { recursive: true })
    await pb.run({
      cwd: dir, rootDir: root, stagingDir: path.join(dir, 'staging'), createPackage: false, files: ['manifest', 'source/**/*'], plugins: [],
      logLevel: 'error', autoImportComponentScript: false, diagnosticFilters: [1107, 1140, 1009], instrument: { lineMap: true },
    })
    expect(pb.program.getDiagnostics().filter((d) => d.severity === 1).map((d) => d.message)).toEqual([])
    expect(plugin.getResult().rewritten.map((x) => x.file)).toContain('source/lib.brs')
    const m = JSON.parse(fs.readFileSync(plugin.getResult().lineMap, 'utf8'))
    expect(m.files['source/lib.brs'].length).toBeGreaterThan(0)
  })

  it('a dangling symlink into the staging dir is rejected', async () => {
    const dir = path.join(tmp, 'dangle')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(path.join(dir, 'staging', 'not-yet'), path.join(dir, 'maps'))
    const b = await build('dangle', { lineMap: 'maps/bt-linemap.json' })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
    expect(fs.existsSync(path.join(dir, 'staging', 'not-yet', 'bt-linemap.json'))).toBe(false)
  })

  it('a child dir named with leading dots is not mistaken for a parent escape', async () => {
    const dir = path.join(tmp, 'dots')
    // staging is cwd/staging; target dir `staging/..m` is inside it and must be rejected
    const b = await build('dots', { lineMap: path.join(dir, 'staging', '..m', 'bt-linemap.json') })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
  })
})
