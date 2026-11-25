import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

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
  await pb.run({
    cwd: lineshift, rootDir: lineshift, stagingDir: path.join(dir, 'staging'), createPackage: false, copyToStaging: true,
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
    expect(fs.existsSync(path.join(off.dir, 'bt-linemap.json'))).toBe(false)
    const explicit = await build('explicit-false', { lineMap: false })
    expect(fs.readFileSync(path.join(explicit.staging, 'source/net.brs'), 'utf8')).toBe(fs.readFileSync(path.join(off.staging, 'source/net.brs'), 'utf8'))
  })

  it('writes the map outside the staging dir for rewritten files only, and maps the crash line to the source line', async () => {
    const on = await build('on', { lineMap: true })
    expect(on.errors).toEqual([])
    const mapFile = path.join(on.dir, 'bt-linemap.json')
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

  it('a string value is a path relative to the project root', async () => {
    const target = path.join(tmp, 'custom', 'map.json')
    const on = await build('path', { lineMap: target })
    expect(on.errors).toEqual([])
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).files['source/net.brs'].length).toBeGreaterThan(0)
  })

  it.each([[42], ['  '], [{}], [['x']]])('an invalid value %j is a clear BT9006 error', async (value) => {
    const b = await build('bad-' + JSON.stringify(value), { lineMap: value })
    const d = b.errors.filter((e) => e.code === 'BT9006')
    expect(d.length).toBe(1)
    expect(d[0].message).toMatch(/instrument\.lineMap must be true, false or a non-empty file path/)
  })

  it('a path inside the staging dir is rejected (it would be packaged)', async () => {
    const dir = path.join(tmp, 'inside')
    const b = await build('inside', { lineMap: path.join(dir, 'staging', 'bt-linemap.json') })
    expect(b.errors.filter((e) => e.code === 'BT9006')[0].message).toMatch(/inside the staging dir/)
    expect(fs.existsSync(path.join(dir, 'staging', 'bt-linemap.json'))).toBe(false)
  })
})
