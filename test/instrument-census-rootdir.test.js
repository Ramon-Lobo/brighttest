import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { census } = require('../lib/instrument/census.js')
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
})
