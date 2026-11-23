import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadConfig, writeBsConfig } = require('../lib/config')
const { census } = require('../lib/instrument/census')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-excl-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const mk = (name, cfg) => {
  const d = path.join(tmp, name)
  fs.mkdirSync(path.join(d, 'source/vendor'), { recursive: true })
  fs.writeFileSync(path.join(d, 'manifest'), 'title=T\n')
  fs.writeFileSync(path.join(d, 'source/vendor/v.brs'), 'sub v(x as object)\n  x.setUrl("http://h/")\nend sub\n')
  fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify(cfg))
  return d
}

describe('instrumentExclude alias', () => {
  it('top-level only: lands in instrument.exclude', () => {
    const c = loadConfig(mk('a', { instrumentExclude: ['source/vendor/**'] }))
    expect(c.instrument.exclude).toEqual(['source/vendor/**'])
  })
  it('instrument.exclude only: unchanged', () => {
    const c = loadConfig(mk('b', { instrument: { exclude: ['x/**'] } }))
    expect(c.instrument.exclude).toEqual(['x/**'])
  })
  it('neither: no exclude key', () => {
    expect(loadConfig(mk('n', {})).instrument.exclude).toBeUndefined()
  })
  it('both: deduplicated union', () => {
    const c = loadConfig(mk('c', { instrument: { exclude: ['x/**', 'y/**'] }, instrumentExclude: ['y/**', 'z/**'] }))
    expect(c.instrument.exclude).toEqual(['x/**', 'y/**', 'z/**'])
  })
  it('census and build bsconfig see the same list', async () => {
    const d = mk('d', { instrumentExclude: ['source/vendor/**'] })
    const cfg = loadConfig(d)
    cfg.stagingDir = path.join(d, '.brighttest')
    const { bsconfig } = writeBsConfig(cfg, 'instrument', { outFile: path.join(d, 'o.zip') })
    expect(bsconfig.instrument.exclude).toEqual(['source/vendor/**'])
    const cen = await census(d)
    expect(cen.network.setUrlSites[0].covered).toBe(false)
    expect(cen.skipped.map((s) => s.kind)).toEqual(['excluded-candidate'])
  })
})
