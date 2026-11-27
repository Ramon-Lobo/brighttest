import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// FR-BUILD-FROM: instrument build --from <dir|zip>
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { resolveFrom } = require('../lib/instrument/from-input')
const { parseInstrumentArgs } = require('../bin/cli')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-from-t-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const FILES = {
  manifest: 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n',
  'source/main.brs': 'sub main()\n    print "hi"\nend sub\n',
  'images/logo.png': 'png',
}
function mkdir(name, files = FILES) {
  const dir = path.join(tmp, name)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
async function mkzip(name, files = FILES, raw = []) {
  const z = new JSZip()
  for (const [rel, text] of Object.entries(files)) z.file(rel, text)
  for (const rel of raw) z.file(rel, 'x') // names JSZip would keep as given
  const p = path.join(tmp, name)
  fs.writeFileSync(p, await z.generateAsync({ type: 'nodebuffer' }))
  return p
}

describe('parseInstrumentArgs --from', () => {
  it('parses both forms and a missing value', () => {
    expect(parseInstrumentArgs(['build', '--from', 'dist']).from).toBe('dist')
    expect(parseInstrumentArgs(['build', '--from=a.zip']).from).toBe('a.zip')
    expect(parseInstrumentArgs(['build', '--from']).unknown).toEqual(['--from (needs a value)'])
  })
})

describe('resolveFrom', () => {
  it('accepts a directory with manifest and source/ without copying it', async () => {
    const dir = mkdir('d-ok')
    const r = await resolveFrom(dir)
    expect(r).toMatchObject({ dir, kind: 'dir' })
    r.cleanup()
    expect(fs.existsSync(dir)).toBe(true)
  })
  it('accepts components/ without source/', async () => {
    const dir = mkdir('d-comp', { manifest: FILES.manifest, 'components/a.xml': '<x/>' })
    await expect(resolveFrom(dir)).resolves.toMatchObject({ kind: 'dir' })
  })
  it('refuses a directory without a manifest', async () => {
    const dir = mkdir('d-nomanifest', { 'source/main.brs': 'x' })
    await expect(resolveFrom(dir)).rejects.toThrow(/no manifest at the top level/)
  })
  it('refuses a directory with a manifest but no source/ or components/', async () => {
    const dir = mkdir('d-nosrc', { manifest: FILES.manifest })
    await expect(resolveFrom(dir)).rejects.toThrow(/no source\/ or components\//)
  })
  it('refuses a missing path and a non-zip file', async () => {
    await expect(resolveFrom(path.join(tmp, 'nope'))).rejects.toThrow(/no such file or directory/)
    const f = path.join(tmp, 'a.txt'); fs.writeFileSync(f, 'x')
    await expect(resolveFrom(f)).rejects.toThrow(/expected a directory or a .zip/)
  })
  it('unpacks a zip into a fresh temp dir and cleans it up', async () => {
    const z = await mkzip('ok.zip')
    const r = await resolveFrom(z)
    expect(r.kind).toBe('zip')
    expect(r.dir.startsWith(path.join(tmp, 'ok.zip'))).toBe(false)
    expect(fs.readFileSync(path.join(r.dir, 'source/main.brs'), 'utf8')).toBe(FILES['source/main.brs'])
    r.cleanup()
    expect(fs.existsSync(r.dir)).toBe(false)
  })
  it('refuses a ".." entry and writes nothing', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bt-from-')).length
    const z = await mkzip('dots.zip', FILES, ['source/../../evil.txt'])
    await expect(resolveFrom(z)).rejects.toThrow(/escapes the package|absolute path/)
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bt-from-')).length).toBe(before)
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false)
  })
  it('refuses an absolute entry', async () => {
    const z = await mkzip('abs.zip', FILES, ['/etc/evil.txt'])
    await expect(resolveFrom(z)).rejects.toThrow(/absolute path/)
  })
  it('refuses an oversized zip (unpacked size and entry count)', async () => {
    const z = await mkzip('big.zip', { ...FILES, 'images/big.bin': 'x'.repeat(5000) })
    await expect(resolveFrom(z, { maxBytes: 1000 })).rejects.toThrow(/cap/)
    await expect(resolveFrom(z, { maxEntries: 2 })).rejects.toThrow(/more than 2 entries/)
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bt-from-') && fs.existsSync(path.join(os.tmpdir(), n, 'images/big.bin'))).length).toBe(0)
  })
  it('refuses a zip whose manifest is in a subfolder, and a corrupt zip', async () => {
    const z = await mkzip('nested.zip', { 'app/manifest': FILES.manifest, 'app/source/main.brs': 'x' })
    await expect(resolveFrom(z)).rejects.toThrow(/no manifest at the top level/)
    const bad = path.join(tmp, 'bad.zip'); fs.writeFileSync(bad, 'not a zip')
    await expect(resolveFrom(bad)).rejects.toThrow(/not a readable zip/)
  })
})
