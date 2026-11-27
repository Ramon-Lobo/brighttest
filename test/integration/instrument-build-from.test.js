import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// FR-BUILD-FROM: the real CLI builds a prebuilt directory / zip into the same package layout as a normal build.
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const cli = path.resolve(__dirname, '../../bin/cli.js')
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-from-i-')) })
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
async function mkzip(name, files = FILES) {
  const z = new JSZip()
  for (const [rel, text] of Object.entries(files)) z.file(rel, text)
  const p = path.join(tmp, name)
  fs.writeFileSync(p, await z.generateAsync({ type: 'nodebuffer' }))
  return p
}
const names = async (zip) => Object.keys((await JSZip.loadAsync(fs.readFileSync(zip))).files).filter((n) => !n.endsWith('/')).sort()
const run = (cwd, args) => spawnSync(process.execPath, [cli, 'instrument', 'build', ...args], { cwd, encoding: 'utf8' })

describe('instrument build --from (CLI)', () => {
  it('a built directory produces the same package layout as a normal build of that tree, and the input is untouched', async () => {
    const built = mkdir('b-dir')
    const proj = mkdir('b-proj', { 'brighttest.json': '{}' }) // cwd with no app of its own
    const normalApp = mkdir('b-normal', { ...FILES, 'brighttest.json': '{}' })
    const a = run(normalApp, ['--out', path.join(tmp, 'normal.zip')])
    expect(a.status, a.stderr).toBe(0)
    const before = fs.readdirSync(built).sort()
    const b = run(proj, ['--from', built, '--out', path.join(tmp, 'from-dir.zip')])
    expect(b.status, b.stderr).toBe(0)
    expect(await names(path.join(tmp, 'from-dir.zip'))).toEqual(await names(path.join(tmp, 'normal.zip')))
    expect(fs.readdirSync(built).sort()).toEqual(before)
    expect(fs.existsSync(path.join(built, '.brighttest'))).toBe(false)
  })
  it('a zip gives the same layout as the directory', async () => {
    const z = await mkzip('b.zip')
    const proj = mkdir('b-proj2', { 'brighttest.json': '{}' })
    const r = run(proj, ['--from', z, '--out', path.join(tmp, 'from-zip.zip')])
    expect(r.status, r.stderr).toBe(0)
    expect(await names(path.join(tmp, 'from-zip.zip'))).toEqual(await names(path.join(tmp, 'from-dir.zip')))
  })
  it('exit 1 with a clear message and no package for a bad input', () => {
    const proj = mkdir('b-proj3', { 'brighttest.json': '{}' })
    const bad = mkdir('b-nomanifest', { 'source/main.brs': 'x' })
    const r = run(proj, ['--from', bad, '--out', path.join(tmp, 'never.zip')])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/--from .*no manifest at the top level/)
    expect(r.stderr).toMatch(/instrument build failed: 1 error\(s\), no package written/)
    expect(fs.existsSync(path.join(tmp, 'never.zip'))).toBe(false)
  })
})
