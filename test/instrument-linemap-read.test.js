import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const lm = require('../lib/instrument/linemap.js')
const { writeFailureBundle } = require('../lib/e2e/logs.js')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lmread-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const MAP = { schema: 1, files: { 'source/net.brs': [[10, 7], [11, 8], [12, 8]] } }
const bt = () => ({
  message: 'Type Mismatch', code: '&hf4', file: 'pkg:/source/net.brs', line: 11, location: 'pkg:/source/net.brs(11)',
  frames: [
    { index: 0, fn: 'a', file: 'pkg:/source/net.brs', line: 11 },
    { index: 1, fn: 'b', file: 'pkg:/source/plain.brs', line: 3 },
    { index: 2, fn: 'c', file: 'pkg:/source/net.brs', line: 99 },
  ],
  summary: 'Type Mismatch (runtime error &hf4) at pkg:/source/net.brs(11)',
})
const norm = (m) => lm.loadLineMap((() => { const f = path.join(tmp, `m${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(m)); return f })()).map

describe('linemap reader', () => {
  it('translates mapped frames, keeps package lines, leaves unmapped and partially mapped frames alone', () => {
    const { backtrace, mapped } = lm.translateBacktrace(bt(), norm(MAP))
    expect(mapped).toBe(1)
    expect(backtrace.frames[0]).toMatchObject({ line: 11, sourceLine: 8 })
    expect(backtrace.frames[1]).toEqual(bt().frames[1]) // file not in the map
    expect(backtrace.frames[2]).toEqual(bt().frames[2]) // line not in the map
    expect(backtrace.sourceLine).toBe(8)
    expect(backtrace.summary).toBe('Type Mismatch (runtime error &hf4) at pkg:/source/net.brs(11) (source line 8)')
    expect(backtrace.sourceLocation).toBe('pkg:/source/net.brs(8)')
  })
  it('matches file names case-insensitively', () => {
    const b = bt(); b.frames[0].file = 'pkg:/Source/NET.brs'
    expect(lm.translateBacktrace(b, norm(MAP)).backtrace.frames[0].sourceLine).toBe(8)
  })
  it('missing map: a one-line note, no throw', () => {
    const r = lm.loadLineMap(path.join(tmp, 'nope.json'))
    expect(r.map).toBeUndefined()
    expect(r.note).toMatch(/^source lines not mapped: no line map at /)
    expect(r.note).not.toMatch(/\n/)
    expect(lm.loadLineMap(null).note).toMatch(/instrument.lineMap is off/)
  })
  it('malformed map: ignored with a note', () => {
    for (const body of ['{not json', '{"schema":2,"files":{}}', '{"schema":1,"files":{"a":[["x",1]]}}', '[]']) {
      const f = path.join(tmp, 'bad.json'); fs.writeFileSync(f, body)
      const r = lm.loadLineMap(f)
      expect(r.map).toBeUndefined()
      expect(r.note).toMatch(/is unreadable/)
    }
  })
  it('a directory (or other non-file) at the map path is refused', () => {
    expect(lm.loadLineMap(tmp).note).toMatch(/no line map at/)
  })
  it('resolves the path: string against rootDir, true beside the default instrument package, else null', () => {
    const root = path.join(tmp, 'proj')
    expect(lm.resolveLineMapPath({ rootDir: root, instrument: { lineMap: '../m/x.json' } })).toBe(path.join(tmp, 'm/x.json'))
    expect(lm.resolveLineMapPath({ rootDir: root, stagingDir: path.join(root, '.brighttest'), instrument: { lineMap: true } })).toBe(path.join(root, '.brighttest/instrument/bt-linemap.json'))
    expect(lm.resolveLineMapPath({ rootDir: root, instrument: {} })).toBeNull()
    expect(lm.resolveLineMapPath({ rootDir: root, instrument: { lineMap: false } })).toBeNull()
  })
})

describe('failure bundle crash lines', () => {
  const logs = () => ({ crash: () => ({ summary: bt().summary, backtrace: bt() }), tail: () => [], error: null })
  const run = async (name, cfg) => {
    const dir = path.join(tmp, name)
    await writeFailureBundle(dir, { flow: 'f', step: null, error: new Error('x'), logs: logs(), shot: null, device: null, cfg })
    return JSON.parse(fs.readFileSync(path.join(dir, 'error.json'), 'utf8'))
  }
  it('no cfg: unchanged (no note, no sourceLine)', async () => {
    const e = await run('nocfg', null)
    expect(e.lineMapNote).toBeUndefined()
    expect(e.crash.backtrace.frames[0].sourceLine).toBeUndefined()
  })
  it('lineMap off or no file: bundle says so in one line', async () => {
    const e = await run('off', { rootDir: tmp, instrument: {} })
    expect(e.lineMapNote).toMatch(/instrument.lineMap is off/)
    expect(e.crash.summary).toBe(bt().summary)
    const e2 = await run('nofile', { rootDir: tmp, instrument: { lineMap: 'absent.json' } })
    expect(e2.lineMapNote).toMatch(/no line map at/)
  })
  it('map present: source line in frames and the summary', async () => {
    fs.writeFileSync(path.join(tmp, 'good.json'), JSON.stringify(MAP))
    const e = await run('good', { rootDir: tmp, instrument: { lineMap: 'good.json' } })
    expect(e.lineMapNote).toBeUndefined()
    expect(e.crash.backtrace.frames[0]).toMatchObject({ line: 11, sourceLine: 8 })
    expect(e.crash.summary).toMatch(/\(source line 8\)$/)
  })
  it('map present but no frame in a rewritten file: says so', async () => {
    fs.writeFileSync(path.join(tmp, 'other.json'), JSON.stringify({ schema: 1, files: { 'source/other.brs': [[1, 1]] } }))
    const e = await run('other', { rootDir: tmp, instrument: { lineMap: 'other.json' } })
    expect(e.lineMapNote).toMatch(/no frame is in a rewritten file/)
  })
})
