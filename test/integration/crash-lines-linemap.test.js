import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Build a drifting file with instrument.lineMap, feed a synthetic crash transcript through the real parser, and expect
// the failure bundle to carry the source line. No device.
const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const createPlugin = require(path.resolve(__dirname, '../../lib/instrument/plugin.js'))
const { parseBacktrace, writeFailureBundle } = require(path.resolve(__dirname, '../../lib/e2e/logs.js'))
const lineshift = path.resolve(__dirname, '../fixtures/instrument-plugin/lineshift')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-crashlines-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1

describe('crash lines through the line map', () => {
  it('maps a staged crash line back to the source line in the failure bundle', async () => {
    const plugin = createPlugin()
    const pb = new ProgramBuilder()
    pb.plugins.add(plugin)
    const dir = path.join(tmp, 'build')
    fs.mkdirSync(dir, { recursive: true })
    await pb.run({
      cwd: dir, rootDir: lineshift, stagingDir: path.join(dir, 'staging'), createPackage: false, copyToStaging: true,
      files: ['manifest', 'source/**/*'], plugins: [], logLevel: 'error', autoImportComponentScript: false,
      diagnosticFilters: [1107, 1140, 1009], instrument: { lineMap: true },
    })
    const staged = fs.readFileSync(path.join(dir, 'staging/source/net.brs'), 'utf8')
    const stagedLine = lineOf(staged, 'a.nope.deep')
    const srcLine = lineOf(fs.readFileSync(path.join(lineshift, 'source/net.brs'), 'utf8'), 'a.nope.deep')
    expect(stagedLine).not.toBe(srcLine)

    const bt = parseBacktrace([
      `Runtime Error. (runtime error &h02) in pkg:/source/net.brs(${stagedLine})`,
      'Backtrace:',
      '#0  Function go() As Void',
      `   file/line: pkg:/source/net.brs(${stagedLine})`,
    ])
    const out = path.join(tmp, 'bundle')
    await writeFailureBundle(out, {
      flow: 'f', step: null, error: new Error('boom'), shot: null, device: null,
      logs: { crash: () => ({ summary: bt.summary, backtrace: bt }), tail: () => [], error: null },
      // the lane build wrote bt-linemap.json to <dir>/out
      cfg: { rootDir: dir, instrument: { lineMap: path.join(dir, 'out', 'bt-linemap.json') } },
    })
    const e = JSON.parse(fs.readFileSync(path.join(out, 'error.json'), 'utf8'))
    expect(e.crash.backtrace.frames[0]).toMatchObject({ line: stagedLine, sourceLine: srcLine })
    expect(e.crash.summary).toContain(`(source line ${srcLine})`)
  })
})
