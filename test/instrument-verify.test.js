import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { verify, EXIT_CLEAN, EXIT_INSTRUMENTED } = require('../lib/instrument/verify.js')
const { mergeManifest, RUNTIME_PKG, RUNTIME_SRC } = require('../lib/instrument/plugin.js')

const legacy = path.resolve(__dirname, '../examples/legacy-app')
const greenfield = path.resolve(__dirname, '../examples/greenfield-app')
let tmp

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.brighttest' || e.name === 'tests') continue
    const s = path.join(src, e.name)
    if (e.isDirectory()) copyDir(s, path.join(dest, e.name))
    else fs.copyFileSync(s, path.join(dest, e.name))
  }
}
function walk(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(dir, r, out); else out.push(r)
  }
  return out
}
async function zipDir(dir, out, prefix = '') {
  const z = new JSZip()
  for (const f of walk(dir)) z.file(prefix + f, fs.readFileSync(path.join(dir, f)))
  fs.writeFileSync(out, await z.generateAsync({ type: 'nodebuffer' }))
  return out
}
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const setManifest = (dir, fn) => write(dir, 'manifest', fn(fs.readFileSync(path.join(dir, 'manifest'), 'utf8')))
const kinds = (r) => r.markers.map((m) => m.kind).sort()

// A tree shaped like the plugin's staged output: merged manifest plus the runtime file.
function instrumentedTree(name) {
  const dir = path.join(tmp, name)
  copyDir(legacy, dir)
  setManifest(dir, mergeManifest)
  write(dir, RUNTIME_PKG, RUNTIME_SRC)
  return dir
}

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-verify-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('verify: clean artifacts', () => {
  it('clean legacy-app zip is clean, exit 0', async () => {
    const dir = path.join(tmp, 'clean'); copyDir(legacy, dir)
    const r = await verify(await zipDir(dir, path.join(tmp, 'clean.zip')))
    expect(r).toEqual({ exitCode: EXIT_CLEAN, result: 'clean', markers: [] })
    expect(EXIT_CLEAN).toBe(0)
  })
  it('greenfield-only app (BT_AGENT=false, BTHttp/BTStore libs) passes', async () => {
    const dir = path.join(tmp, 'green'); copyDir(greenfield, dir)
    setManifest(dir, (t) => t.replace(/\r?\n?$/, '\n') + 'bs_const=BT_AGENT=false\n')
    const r = await verify(await zipDir(dir, path.join(tmp, 'green.zip')))
    expect(r.exitCode).toBe(0)
    expect(r.markers).toEqual([])
  })
  it('m-flag: BT_AGENT=false alone is not a marker', async () => {
    const dir = path.join(tmp, 'mflag'); copyDir(legacy, dir)
    setManifest(dir, (t) => t.replace(/^bs_const=.*$/m, 'bs_const=BT_AGENT=false'))
    expect((await verify(dir)).exitCode).toBe(0)
  })
})

describe('verify: instrumented artifacts', () => {
  it('instrumented zip reports every marker kind with paths, exit 3', async () => {
    const dir = instrumentedTree('instr')
    const r = await verify(await zipDir(dir, path.join(tmp, 'instr.bt-instrumented.zip')))
    expect(r.exitCode).toBe(EXIT_INSTRUMENTED)
    expect(r.result).toBe('instrumented')
    expect(r.markers).toContainEqual(expect.objectContaining({ kind: 'manifest-key', path: 'manifest' }))
    expect(r.markers).toContainEqual(expect.objectContaining({ kind: 'bs-const', path: 'manifest' }))
    expect(r.markers).toContainEqual(expect.objectContaining({ kind: 'runtime-file', path: RUNTIME_PKG }))
    expect(r.markers).toContainEqual(expect.objectContaining({ kind: 'string', path: RUNTIME_PKG, detail: '__bt_boot' }))
  })
  it('a renamed zip and the unzipped directory give the same markers', async () => {
    const dir = instrumentedTree('renamed')
    const zipped = await verify(await zipDir(dir, path.join(tmp, 'renamed.zip')))
    const asDir = await verify(dir)
    expect(asDir).toEqual(zipped)
    expect(asDir.exitCode).toBe(3)
  })
  it('tampered: bt_instrumented line deleted, the other markers are still all reported', async () => {
    const dir = instrumentedTree('tamper')
    setManifest(dir, (t) => t.split('\n').filter((l) => !/^bt_instrumented=/.test(l)).join('\n'))
    const r = await verify(await zipDir(dir, path.join(tmp, 'tampered.zip')))
    expect(r.exitCode).toBe(3)
    expect(kinds(r)).not.toContain('manifest-key')
    expect(kinds(r)).toEqual(expect.arrayContaining(['bs-const', 'runtime-file', 'string']))
  })
  it('m-const: BT_AGENT=true in bs_const alone', async () => {
    const dir = path.join(tmp, 'mconst'); copyDir(legacy, dir)
    setManifest(dir, (t) => t.replace(/^bs_const=.*$/m, 'bs_const=STRESS=false;BT_AGENT=true'))
    const r = await verify(await zipDir(dir, path.join(tmp, 'm-const.zip')))
    expect(r.exitCode).toBe(3)
    expect(r.markers).toEqual([{ kind: 'bs-const', path: 'manifest', detail: 'BT_AGENT=true' }])
  })
  it('m-boot: a __bt_boot string in one source file alone', async () => {
    const dir = path.join(tmp, 'mboot'); copyDir(legacy, dir)
    write(dir, 'source/x.brs', "' __bt_boot\n")
    const r = await verify(await zipDir(dir, path.join(tmp, 'm-boot.zip')))
    expect(r.exitCode).toBe(3)
    expect(r.markers).toEqual([{ kind: 'string', path: 'source/x.brs', detail: '__bt_boot' }])
  })
  it('__bt_agent string, components/bt file, and BT_Agent component XML are markers', async () => {
    const dir = path.join(tmp, 'misc'); copyDir(legacy, dir)
    write(dir, 'source/a.brs', "x = m.__bt_agent\n")
    write(dir, 'components/bt/Thing.brs', 'sub a()\nend sub\n')
    write(dir, 'components/Agent.xml', '<component name="BT_Agent" extends="Node"/>\n')
    const r = await verify(dir)
    expect(r.markers).toEqual(expect.arrayContaining([
      { kind: 'string', path: 'source/a.brs', detail: '__bt_agent' },
      { kind: 'runtime-file', path: 'components/bt/Thing.brs' },
      { kind: 'component-xml', path: 'components/Agent.xml', detail: 'BT_Agent' },
    ]))
  })
  it('manifest key without bs_const: marker key alone is enough', async () => {
    const dir = path.join(tmp, 'keyonly'); copyDir(legacy, dir)
    setManifest(dir, (t) => t + '\nbt_instrumented=1\n')
    expect(kinds(await verify(dir))).toEqual(['manifest-key'])
  })
})

describe('verify: bad input', () => {
  it('rejects a missing path', async () => {
    await expect(verify(path.join(tmp, 'nope.zip'))).rejects.toMatchObject({ code: 'BT_VERIFY_MISSING' })
  })
  it('rejects a corrupt zip', async () => {
    const p = path.join(tmp, 'corrupt.zip'); fs.writeFileSync(p, 'nope')
    await expect(verify(p)).rejects.toMatchObject({ code: 'BT_VERIFY_CORRUPT' })
  })
  it('rejects a missing argument', async () => {
    await expect(verify()).rejects.toMatchObject({ code: 'BT_VERIFY_INPUT' })
  })
})
