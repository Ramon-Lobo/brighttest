import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { readCentralDirectory, inflateEntry } = require('../lib/builds/zipinfo')
const { inspectPackage } = require('../lib/builds/inspect')
const { makeZip, plainEntries, u16, u32 } = require('./support/zipgen')
const zlib = require('node:zlib')

const code = (fn) => { try { fn() } catch (e) { return { code: e.code, reason: e.reason } } return null }
const withEntry = (e, opts) => makeZip(plainEntries([e]), opts)
const unsafe = (buf, re, caps) => { const r = code(() => readCentralDirectory(buf, caps)); expect(r && r.code).toBe('BUILD_UNSAFE_ZIP'); expect(r.reason).toMatch(re) }

describe('zipinfo: accepts', () => {
  it('reads a plain package', () => {
    const { entries } = readCentralDirectory(makeZip(plainEntries([{ name: 'images/', data: '' }, { name: 'a.txt', data: 'x', method: 0 }])))
    expect(entries.map((e) => e.name)).toEqual(['manifest', 'source/main.brs', 'images/', 'a.txt'])
    expect(entries[2].dir).toBe(true)
  })
  it('inflates deflate and stored entries', () => {
    const buf = makeZip(plainEntries([{ name: 'a.txt', data: 'hello', method: 0 }]))
    const { entries } = readCentralDirectory(buf)
    expect(inflateEntry(buf, entries[1], 1000).toString()).toContain('sub main')
    expect(inflateEntry(buf, entries[2], 1000).toString()).toBe('hello')
  })
  it('reads a zip with a comment', () => {
    expect(readCentralDirectory(makeZip(plainEntries(), { comment: 'hi' })).entries).toHaveLength(2)
  })
})

describe('zipinfo: refusals (BUILD_INVALID_ZIP)', () => {
  it('not a zip', () => { expect(code(() => readCentralDirectory(Buffer.from('not a zip at all, just text')))).toMatchObject({ code: 'BUILD_INVALID_ZIP' }) })
  it('too short and empty', () => {
    expect(code(() => readCentralDirectory(Buffer.alloc(0))).code).toBe('BUILD_INVALID_ZIP')
    expect(code(() => readCentralDirectory(Buffer.alloc(10))).code).toBe('BUILD_INVALID_ZIP')
  })
  it('truncated', () => {
    const full = makeZip(plainEntries())
    expect(code(() => readCentralDirectory(full.subarray(0, full.length - 30))).code).toBe('BUILD_INVALID_ZIP')
    expect(code(() => readCentralDirectory(makeZip(plainEntries(), { truncateAt: 40 }))).code).toBe('BUILD_INVALID_ZIP')
  })
  it('bad central directory offset', () => {
    expect(code(() => readCentralDirectory(makeZip(plainEntries(), { eocdCdOffset: 5 }))).code).toBe('BUILD_INVALID_ZIP')
    expect(code(() => readCentralDirectory(makeZip(plainEntries(), { eocdCdOffset: 100000 }))).code).toBe('BUILD_INVALID_ZIP')
  })
  it('entry count that disagrees with the directory', () => {
    expect(code(() => readCentralDirectory(makeZip(plainEntries(), { eocdCount: 5 }))).code).toBe('BUILD_INVALID_ZIP')
  })
})

describe('zipinfo: refusals (BUILD_UNSAFE_ZIP)', () => {
  it('too many entries', () => {
    const many = Array.from({ length: 20001 }, (_, i) => ({ name: `f${i}`, data: '', method: 0 }))
    unsafe(makeZip(many), /more than 20000 entries/)
    expect(readCentralDirectory(makeZip(many.slice(0, 20000))).entries).toHaveLength(20000)
  })
  it('declared total over the cap (lying central sizes)', () => {
    const e = [0, 1, 2].map((i) => ({ name: `f${i}`, data: 'x', method: 0, central: { usize: 200 * 1024 * 1024, csize: 200 * 1024 * 1024 }, local: { usize: 200 * 1024 * 1024, csize: 200 * 1024 * 1024 } }))
    unsafe(makeZip(e), /512 MB/)
  })
  it('bomb by ratio (real data)', () => {
    unsafe(withEntry({ name: 'big.txt', data: Buffer.alloc(3 * 1024 * 1024) }), /ratio over 100:1/)
  })
  it('ratio check ignores small entries', () => {
    expect(readCentralDirectory(withEntry({ name: 'z.txt', data: Buffer.alloc(500 * 1024) })).entries).toHaveLength(3)
  })
  for (const [label, name] of [['absolute', '/etc/passwd'], ['dot-dot', '../evil'], ['nested dot-dot', 'a/../../evil'], ['backslash', 'a\\b.txt'],
    ['drive letter', 'C:/x.txt'], ['drive letter bare', 'c:x'], ['NUL', 'a\u0000b'], ['control char', 'a\u0007b']]) {
    it(`bad name: ${label}`, () => { unsafe(withEntry({ name, data: 'x' }), /entry name|absolute/) })
  }
  it('name over 1024 bytes', () => { unsafe(withEntry({ name: 'a'.repeat(1025), data: 'x' }), /1024 bytes/) })
  it('name of exactly 1024 bytes is fine', () => { expect(readCentralDirectory(withEntry({ name: 'a'.repeat(1024), data: 'x' })).entries).toHaveLength(3) })
  it('duplicate names', () => { unsafe(withEntry({ name: 'source/main.brs', data: 'y' }), /duplicate/) })
  it('encrypted (flag bit 0)', () => { unsafe(withEntry({ name: 'e.bin', data: 'x', flags: 1 }), /encrypted/) })
  it('encrypted (local header only)', () => { unsafe(withEntry({ name: 'e.bin', data: 'x', local: { flags: 1 } }), /encrypted/) })
  it('zip64 locator', () => { unsafe(makeZip(plainEntries(), { zip64Locator: true }), /zip64/) })
  it('zip64 saturated EOCD', () => { unsafe(makeZip(plainEntries(), { eocdCdOffset: 0xffffffff }), /zip64/) })
  it('zip64 extra field', () => {
    unsafe(withEntry({ name: 'x', data: 'x', central: { extra: Buffer.concat([u16(1), u16(8), Buffer.alloc(8)]) } }), /zip64/)
  })
  it('zip64 saturated size', () => { unsafe(withEntry({ name: 'x', data: 'x', central: { usize: 0xffffffff } }), /zip64/) })
  it('compression method 12 (bzip2)', () => { unsafe(withEntry({ name: 'x', data: 'x', method: 12, rawData: Buffer.from('BZh') }), /method 12/) })
  it('central and local headers disagree: method', () => { unsafe(withEntry({ name: 'x', data: 'x', method: 0, central: { method: 8 } }), /disagree/) })
  it('central and local headers disagree: size', () => { unsafe(withEntry({ name: 'x', data: 'xyz', method: 0, central: { usize: 2, csize: 2 } }), /disagree/) })
  it('central and local headers disagree: name', () => { unsafe(withEntry({ name: 'xx', data: 'x', localName: 'yy' }), /disagree/) })
})

describe('zipinfo: lying sizes fail at inflate, not by expanding', () => {
  const entryOf = (e) => { const buf = withEntry(e); return { buf, entry: readCentralDirectory(buf).entries[2] } }
  it('declared smaller than the real data', () => {
    const data = Buffer.from('a'.repeat(5000) + 'b'.repeat(5000))
    const { buf, entry } = entryOf({ name: 'x', data, central: { usize: 100 }, local: { usize: 100 } })
    const r = code(() => inflateEntry(buf, entry, 1e6))
    expect(r).toMatchObject({ code: 'BUILD_UNSAFE_ZIP', reason: expect.stringMatching(/declared size/) })
  })
  it('declared larger than the real data', () => {
    const { buf, entry } = entryOf({ name: 'x', data: 'short', central: { usize: 5000 }, local: { usize: 5000 } })
    expect(code(() => inflateEntry(buf, entry, 1e6)).code).toBe('BUILD_UNSAFE_ZIP')
  })
  it('stored entry with csize different from usize', () => {
    const { buf, entry } = entryOf({ name: 'x', data: 'abcdef', method: 0, central: { usize: 3 }, local: { usize: 3 } })
    expect(code(() => inflateEntry(buf, entry, 1e6)).code).toBe('BUILD_UNSAFE_ZIP')
  })
  it('corrupt deflate data', () => {
    const { buf, entry } = entryOf({ name: 'x', data: 'x', rawData: Buffer.from([0xff, 0xff, 0xff, 0xff]), central: { usize: 10 }, local: { usize: 10 } })
    expect(code(() => inflateEntry(buf, entry, 1e6)).code).toBe('BUILD_UNSAFE_ZIP')
  })
  it('entry over the per-entry cap', () => {
    const { buf, entry } = entryOf({ name: 'x', data: 'a'.repeat(2000) })
    expect(code(() => inflateEntry(buf, entry, 1000)).code).toBe('BUILD_UNSAFE_ZIP')
  })
  it('uses zlib maxOutputLength (never inflates past the declared size)', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(20 * 1024 * 1024))
    const buf = withEntry({ name: 'x', data: '', rawData: bomb, central: { usize: 10, csize: bomb.length }, local: { usize: 10, csize: bomb.length } })
    const entry = readCentralDirectory(buf).entries[2]
    expect(code(() => inflateEntry(buf, entry, 1e6)).code).toBe('BUILD_UNSAFE_ZIP')
  })
})

describe('intake refusals through inspectPackage', () => {
  it('no manifest at the root (folder zipped instead of its contents)', async () => {
    const buf = makeZip([{ name: 'app/manifest', data: 'title=X\n' }, { name: 'app/source/main.brs', data: '' }])
    await expect(inspectPackage(buf)).rejects.toMatchObject({ code: 'BUILD_NO_MANIFEST' })
  })
  it('manifest over 64 KB', async () => {
    const buf = makeZip([{ name: 'manifest', data: 'title=X\n' + '#'.repeat(70 * 1024) + '\n' }])
    await expect(inspectPackage(buf)).rejects.toMatchObject({ code: 'BUILD_UNSAFE_ZIP' })
  })
  it('a lying manifest header fails instead of expanding', async () => {
    const buf = makeZip([{ name: 'manifest', data: 'title=X\n'.repeat(5000), central: { usize: 30 }, local: { usize: 30 } }])
    await expect(inspectPackage(buf)).rejects.toMatchObject({ code: 'BUILD_UNSAFE_ZIP' })
  })
  it('propagates reader refusals', async () => {
    await expect(inspectPackage(Buffer.from('nope nope nope nope nope nope'))).rejects.toMatchObject({ code: 'BUILD_INVALID_ZIP' })
    await expect(inspectPackage(makeZip(plainEntries([{ name: '../x', data: '' }])))).rejects.toMatchObject({ code: 'BUILD_UNSAFE_ZIP' })
  })
})
