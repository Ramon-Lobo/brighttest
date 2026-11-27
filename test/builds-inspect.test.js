import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { inspectPackage } = require('../lib/builds/inspect')
const verifyMod = require('../lib/instrument/verify')
const { makeZip, plainEntries, instrumentedEntries, MANIFEST } = require('./support/zipgen')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-inspect-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const viaVerify = async (buf) => {
  const f = path.join(tmp, crypto.randomBytes(4).toString('hex') + '.zip')
  fs.writeFileSync(f, buf)
  return verifyMod.verify(f)
}
const kindsOf = (markers) => [...new Set(markers.map((m) => m.kind))].sort()

describe('inspectPackage', () => {
  it('reads the manifest facts, size and sha256', async () => {
    const buf = makeZip(plainEntries())
    const info = await inspectPackage(buf)
    expect(info.manifest).toEqual({ title: 'Sample App', major: 1, minor: 4, build: 118, version: '1.4.118' })
    expect(info.size).toBe(buf.length)
    expect(info.sha256).toBe(crypto.createHash('sha256').update(buf).digest('hex'))
    expect(info.kind).toBe('store')
    expect(info.markerCount).toBe(0)
  })
  it('null manifest fields when absent', async () => {
    const info = await inspectPackage(makeZip([{ name: 'manifest', data: 'title=Only\n' }]))
    expect(info.manifest).toEqual({ title: 'Only', major: null, minor: null, build: null, version: null })
    const none = await inspectPackage(makeZip([{ name: 'manifest', data: '# nothing\n' }]))
    expect(none.manifest.title).toBeNull()
  })
})

describe('kind parity with instrument verify', () => {
  it('clean package: store, same as verify clean', async () => {
    const buf = makeZip(plainEntries())
    const [info, v] = [await inspectPackage(buf), await viaVerify(buf)]
    expect(v.result).toBe('clean')
    expect(info.kind).toBe('store')
    expect(info.markerCount).toBe(v.markers.length)
  })
  it('instrumented package: same markers as verify', async () => {
    const buf = makeZip(instrumentedEntries())
    const [info, v] = [await inspectPackage(buf), await viaVerify(buf)]
    expect(v.result).toBe('instrumented')
    expect(info.kind).toBe('instrumented')
    expect(info.markerCount).toBe(v.markers.length)
    expect(info.markerKinds).toEqual(kindsOf(v.markers))
    expect(info.markerKinds).toEqual(['bs-const', 'component-xml', 'manifest-key', 'runtime-file', 'string'])
  })
  for (const [label, entries] of [
    ['manifest key only', [{ name: 'manifest', data: MANIFEST + 'bt_instrumented=1\n' }]],
    ['bs_const BT_AGENT=false is clean', [{ name: 'manifest', data: MANIFEST + 'bs_const=BT_AGENT=false\n' }]],
    ['runtime file only', [{ name: 'manifest', data: MANIFEST }, { name: 'components/bt/X.brs', data: '' }]],
    ['string in a .bs file', [{ name: 'manifest', data: MANIFEST }, { name: 'source/a.bs', data: "x = \"__BT_BOOT\"" }]],
    ['marker text in a non-text file is ignored', [{ name: 'manifest', data: MANIFEST }, { name: 'images/a.png', data: '__bt_agent' }]],
  ]) {
    it(`parity: ${label}`, async () => {
      const buf = makeZip(entries)
      const [info, v] = [await inspectPackage(buf), await viaVerify(buf)]
      expect(info.markerCount).toBe(v.markers.length)
      expect(info.kind).toBe(v.result === 'clean' ? 'store' : 'instrumented')
    })
  }
})

describe('text budget', () => {
  it('over the per-entry cap and no marker found: unknown', async () => {
    const buf = makeZip(plainEntries([{ name: 'source/big.brs', data: 'a\n'.repeat(2000) }]))
    expect((await inspectPackage(buf, { textEntryBytes: 1000 })).kind).toBe('unknown')
  })
  it('over the total budget: unknown, not an error', async () => {
    const buf = makeZip(plainEntries([{ name: 'source/a.brs', data: 'a\n'.repeat(600) }, { name: 'source/b.brs', data: 'b\n'.repeat(600) }]))
    expect((await inspectPackage(buf, { textTotalBytes: 1500 })).kind).toBe('unknown')
  })
  it('a marker found wins over the budget hit', async () => {
    const buf = makeZip(instrumentedEntries().concat([{ name: 'source/z.brs', data: 'a\n'.repeat(2000) }]))
    expect((await inspectPackage(buf, { textEntryBytes: 1000 })).kind).toBe('instrumented')
  })
})

describe('tokenOf', () => {
  it('returns the BT_config token, not serialized', async () => {
    const info = await inspectPackage(makeZip(instrumentedEntries()))
    expect(info.tokenOf()).toBe('0123456789abcdef0123456789abcdef')
    expect(JSON.stringify(info)).not.toContain('0123456789abcdef')
    expect(Object.keys(info)).not.toContain('tokenOf')
  })
  it('null without BT_config', async () => {
    expect((await inspectPackage(makeZip(plainEntries()))).tokenOf()).toBeNull()
  })
})

describe('verify module is unchanged', () => {
  it('exports entryMarkers next to the existing exports', () => {
    for (const k of ['verify', 'EXIT_CLEAN', 'EXIT_INSTRUMENTED', 'RUNTIME_DIRS', 'STRINGS', 'COMPONENT_MARKER']) expect(verifyMod[k]).toBeDefined()
    expect(typeof verifyMod.entryMarkers).toBe('function')
  })
  it('verify output on a known zip is exactly the existing shape', async () => {
    const v = await viaVerify(makeZip(instrumentedEntries()))
    expect(v).toEqual({
      exitCode: 3, result: 'instrumented',
      markers: [
        { kind: 'component-xml', path: 'components/Scene.xml', detail: 'BT_Agent' },
        { kind: 'manifest-key', path: 'manifest', detail: 'bt_instrumented' },
        { kind: 'bs-const', path: 'manifest', detail: 'BT_AGENT=true' },
        { kind: 'runtime-file', path: 'source/bt/BT_config.brs' },
        { kind: 'string', path: 'source/main.brs', detail: '__bt_agent' },
      ],
    })
  })
})
