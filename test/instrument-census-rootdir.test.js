import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { census, safeRead } = require('../lib/instrument/census.js')
const { execFileSync } = require('node:child_process')
const fifoIt = process.platform === 'win32' ? it.skip : it
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-census-rd-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const SCENE = '<?xml version="1.0"?>\n<component name="Home" extends="Scene"><script type="text/brightscript" uri="Home.brs"/></component>\n'
const BRS = 'sub init()\nend sub\n'
// app tree under <dir>/<sub>/ with a manifest, as a rootDir project lays out
const app = (dir, sub) => { put(dir, `${sub}/manifest`, 'title=Demo\n'); put(dir, `${sub}/components/Home.xml`, SCENE); put(dir, `${sub}/components/Home.brs`, BRS) }
const mk = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d }

describe('census honours bsconfig rootDir', () => {
  it('follows rootDir set directly (with comments in the bsconfig)', async () => {
    const d = mk('direct'); app(d, 'src'); put(d, 'bsconfig.json', '{\n // app lives in src\n "rootDir": "src",\n}\n')
    const c = await census(d)
    expect(c.counts.components).toBe(1)
    expect(c.scenes.length).toBe(1)
  })
  it('follows rootDir reached through extends', async () => {
    const d = mk('extends'); app(d, 'src')
    put(d, 'bsconfig.base.json', '{"rootDir":"src"}'); put(d, 'bsconfig.json', '{"extends":"./bsconfig.base.json"}')
    expect((await census(d)).counts.components).toBe(1)
  })
  it('resolves an inherited rootDir against the declaring file', async () => {
    const d = mk('extends-nested'); app(d, 'cfg/app'); put(d, 'cfg/base.json', '{"rootDir":"app"}'); put(d, 'bsconfig.json', '{"extends":"cfg/base.json"}')
    expect((await census(d)).counts.components).toBe(1)
  })
  it('ignores a rootDir outside the project root and reads nothing there', async () => {
    const outside = mk('outside-app'); app(outside, '.')
    const d = mk('escape'); put(d, 'bsconfig.json', JSON.stringify({ rootDir: '../outside-app' }))
    expect((await census(d)).counts.components).toBe(0)
  })
  it('ignores a symlinked rootDir that resolves outside the root', async () => {
    const outside = mk('outside-link'); app(outside, '.')
    const d = mk('symlink'); fs.symlinkSync(outside, path.join(d, 'src')); put(d, 'bsconfig.json', '{"rootDir":"src"}')
    expect((await census(d)).counts.components).toBe(0)
  })
  it('ignores an extends that leaves the root', async () => {
    const outside = mk('outside-ext'); put(outside, 'base.json', '{"rootDir":"."}')
    const d = mk('ext-escape'); app(d, '.'); put(d, 'bsconfig.json', '{"extends":"../outside-ext/base.json"}')
    expect((await census(d)).counts.components).toBe(1)
  })
  it('no rootDir keeps the project-root scan unchanged', async () => {
    const d = mk('plain'); app(d, '.'); put(d, 'bsconfig.json', '{"files":["source/**"]}')
    const a = await census(d)
    fs.rmSync(path.join(d, 'bsconfig.json'))
    expect(JSON.stringify(await census(d))).toBe(JSON.stringify(a))
    expect(a.counts.components).toBe(1)
  })
  it('a malformed bsconfig falls back to the root without echoing content', async () => {
    const d = mk('bad'); app(d, '.'); put(d, 'bsconfig.json', '{ SECRET nope')
    expect((await census(d)).counts.components).toBe(1)
  })
  it('brighttest.json rootDir wins over bsconfig rootDir (as build does)', async () => {
    const d = mk('both'); app(d, 'src'); put(d, 'components/Other.xml', SCENE.replace('Home', 'Other').replace('Home.brs', 'Other.brs')); put(d, 'components/Other.brs', BRS); put(d, 'components/Third.xml', SCENE.replace('Home', 'Third').replace('Home.brs', 'Third.brs')); put(d, 'components/Third.brs', BRS)
    put(d, 'manifest', 'title=Demo\n'); put(d, 'bsconfig.json', '{"rootDir":"src"}'); put(d, 'brighttest.json', '{"rootDir":"."}')
    expect((await census(d)).counts.components).toBe(2)
  })
  it('brighttest.json rootDir works without a bsconfig', async () => {
    const d = mk('btonly'); app(d, 'app'); put(d, 'brighttest.json', '{"rootDir":"app"}')
    expect((await census(d)).counts.components).toBe(1)
  })
  it('a brighttest.json rootDir outside the root is ignored', async () => {
    const outside = mk('outside-bt'); app(outside, '.')
    const d = mk('bt-escape'); put(d, 'brighttest.json', '{"rootDir":"../outside-bt"}')
    expect((await census(d)).counts.components).toBe(0)
  })
  it('a symlinked components/ pointing outside is not read and is reported', async () => {
    const outside = mk('outside-comp'); put(outside, 'Home.xml', SCENE); put(outside, 'Home.brs', BRS)
    const d = mk('comp-link'); put(d, 'manifest', 'title=x\n'); fs.symlinkSync(outside, path.join(d, 'components'))
    const c = await census(d)
    expect(c.counts.components).toBe(0)
    expect(c.skipped.some((x) => x.kind === 'path-outside-root' && x.file === 'components')).toBe(true)
  })
  it('handles a BOM and keeps commas inside strings; a malformed bsconfig never echoes content', async () => {
    const d = mk('bom'); app(d, 'sr,}c'); put(d, 'bsconfig.json', '\uFEFF{"rootDir":"sr,}c",}')
    expect((await census(d)).counts.components).toBe(1)
    const e = mk('bad2'); app(e, '.'); put(e, 'bsconfig.json', '{ "rootDir": "SECRET-TOKEN" nope')
    let msg = ''
    let c
    try { c = await census(e) } catch (x) { msg = String(x.message) }
    expect(msg).not.toContain('SECRET')
    expect(JSON.stringify(c || {})).not.toContain('SECRET')
  })
  it('never opens secret-named, certs/ or oversized files (reported as skipped)', async () => {
    const d = mk('guard'); app(d, '.'); put(d, 'source/.env', 'K=v'); put(d, 'source/dev.key', 'k'); put(d, 'components/certs/a.pem', 'p')
    put(d, 'components/Big.brs', 'x'.repeat(2 * 1024 * 1024 + 1))
    const c = await census(d)
    const files = c.skipped.filter((x) => x.kind === 'sensitive-or-oversized-not-read').map((x) => x.file).sort()
    expect(files).toEqual(['components/Big.brs', 'components/certs/', 'source/.env', 'source/dev.key'])
    expect(c.counts.components).toBe(1)
  })
  it('does not follow bsconfig extends to a non-json or secret-named file', async () => {
    const d = mk('ext-env'); app(d, 'src'); put(d, '.env', '{"rootDir":"src"}'); put(d, 'bsconfig.json', '{"extends":".env"}')
    expect((await census(d)).counts.components).toBe(0)
    const e = mk('ext-txt'); app(e, 'src'); put(e, 'base.txt', '{"rootDir":"src"}'); put(e, 'bsconfig.json', '{"extends":"base.txt"}')
    expect((await census(e)).counts.components).toBe(0)
  })
  it('safeRead refuses symlink, dir, secret-named, oversized; reads a regular file', () => {
    const d = mk('sr'); put(d, 'a.json', '{}'); put(d, '.env', 'K=v'); put(d, 'big.json', 'x'.repeat(2 * 1024 * 1024 + 1))
    fs.symlinkSync(path.join(d, 'a.json'), path.join(d, 'link.json')); fs.mkdirSync(path.join(d, 'dir.json'))
    expect(safeRead(path.join(d, 'a.json')).buf.toString()).toBe('{}')
    for (const n of ['link.json', 'dir.json', '.env', 'big.json']) expect(safeRead(path.join(d, n)).refused).toBeTruthy()
    expect(safeRead(path.join(d, 'nope')).refused).toBe('missing')
  })
  it('bsconfig.json symlinked to an in-root .env is not opened', async () => {
    const d = mk('bs-link'); app(d, 'src'); put(d, '.env', '{"rootDir":"src"}'); fs.symlinkSync(path.join(d, '.env'), path.join(d, 'bsconfig.json'))
    const c = await census(d)
    expect(c.counts.components).toBe(0)
    expect(c.skipped.some((x) => x.file === 'bsconfig.json')).toBe(true)
  })
  it('an oversized bsconfig.json is not read', async () => {
    const d = mk('bs-big'); app(d, 'src'); put(d, 'bsconfig.json', '{"rootDir":"src"' + ' '.repeat(2 * 1024 * 1024) + '}')
    expect((await census(d)).counts.components).toBe(0)
  })
  it('a manifest symlinked to .env is not read', async () => {
    const d = mk('man-link'); put(d, '.env', 'bs_const=SECRET=true\n'); put(d, 'components/Home.xml', SCENE); put(d, 'components/Home.brs', BRS)
    fs.symlinkSync(path.join(d, '.env'), path.join(d, 'manifest'))
    const c = await census(d)
    expect(c.skipped.some((x) => x.file === 'manifest')).toBe(true)
  })
  it('a rootDir under a .env-named folder is refused', async () => {
    const d = mk('env-dir'); app(d, '.env/app'); put(d, 'bsconfig.json', '{"rootDir":".env/app"}')
    expect((await census(d)).counts.components).toBe(0)
  })
  fifoIt('a FIFO bsconfig.json or extends target never hangs', async () => {
    const d = mk('fifo'); app(d, 'src'); execFileSync('mkfifo', [path.join(d, 'bsconfig.json')])
    expect((await census(d)).counts.components).toBe(0)
    const e = mk('fifo-ext'); app(e, 'src'); execFileSync('mkfifo', [path.join(e, 'base.json')]); put(e, 'bsconfig.json', '{"extends":"./base.json"}')
    expect((await census(e)).counts.components).toBe(0)
    const f = mk('fifo-man'); put(f, 'components/Home.xml', SCENE); put(f, 'components/Home.brs', BRS); execFileSync('mkfifo', [path.join(f, 'manifest')])
    expect((await census(f)).counts.components).toBe(1)
  }, 10000)
  it('safeRead reports a symlink and a FIFO as their own reasons', () => {
    const d = mk('reasons'); put(d, 'a.json', '{}'); fs.symlinkSync(path.join(d, 'a.json'), path.join(d, 'l.json'))
    expect(safeRead(path.join(d, 'l.json')).refused).toBe('symlink')
    expect(safeRead(path.join(d, 'l.json'), { followLink: true }).buf.toString()).toBe('{}')
    if (process.platform !== 'win32') { execFileSync('mkfifo', [path.join(d, 'f.json')]); expect(safeRead(path.join(d, 'f.json')).refused).toBe('not a regular file') }
  })
  it('a symlinked manifest is reported as a symlink, not as secret-named or oversized', async () => {
    const d = mk('man-reason'); put(d, 'real', 'bs_const=A=true\n'); put(d, 'components/Home.xml', SCENE); put(d, 'components/Home.brs', BRS)
    fs.symlinkSync(path.join(d, 'real'), path.join(d, 'manifest'))
    const s = (await census(d)).skipped.find((x) => x.file === 'manifest')
    expect(s.reason).toBe('manifest is a symlink and was not read')
  })
  it('files under a .env-named folder in source/ are not opened', async () => {
    const d = mk('env-inner'); put(d, 'manifest', 'title=x\n'); put(d, 'components/Home.xml', SCENE); put(d, 'components/Home.brs', BRS)
    put(d, 'source/.env/Leak.brs', BRS)
    const c = await census(d)
    expect(c.skipped.some((x) => x.file === 'source/.env/' && /secret-named/.test(x.reason))).toBe(true)
    expect(c.counts.brsFiles).toBe(1)
  })
  it('a build.pkg folder is walked, only .env* folders are skipped', async () => {
    const d = mk('pkg-dir'); put(d, 'manifest', 'title=x\n'); put(d, 'components/Home.xml', SCENE); put(d, 'components/Home.brs', BRS)
    put(d, 'source/build.pkg/A.brs', BRS)
    expect((await census(d)).counts.brsFiles).toBe(2)
  })
})
