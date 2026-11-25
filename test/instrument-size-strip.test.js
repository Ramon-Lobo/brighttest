import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const plugin = require(path.resolve(__dirname, '../lib/instrument/plugin.js'))
const { build } = require(path.resolve(__dirname, '../lib/instrument/build.js'))
const { loadConfig } = require(path.resolve(__dirname, '../lib/config.js'))
const { runtimeSource, runtimeSourceRaw, stripFullLineComments, stagedAsset, AGENT_ASSETS } = plugin

const isFullLineComment = (l) => /^[ \t]*'/.test(l)
const isBlank = (l) => /^[ \t\r]*$/.test(l)
const kept = (t) => t.split('\n').filter((l) => !isFullLineComment(l) && !isBlank(l))
const lines = (t) => t.replace(/\n$/, '').split('\n')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-inssize-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('staged runtime strip (ADR 0020 D3)', () => {
  it('stripped output has no full-line comment or blank line and keeps every other line byte-identical', () => {
    for (const args of [[true, true, false], [true, true, true], [true, false, false], [false, true, false], [false, false, false]]) {
      const raw = runtimeSourceRaw(...args)
      const out = runtimeSource(...args)
      expect(lines(out).some((l) => isFullLineComment(l) || isBlank(l))).toBe(false)
      expect(lines(out)).toEqual(kept(raw))
    }
    for (const a of AGENT_ASSETS.filter((x) => x.dest.endsWith('.brs'))) {
      const src = fs.readFileSync(a.src, 'utf8')
      expect(lines(stagedAsset(a))).toEqual(kept(src))
    }
  })

  it('does not touch trailing comments or strings, and leaves XML assets verbatim', () => {
    const src = ["x = 1 ' trailing", 's = "a \' b"', '', "   ' indented full-line", "' full", 'y = 2'].join('\n')
    expect(stripFullLineComments(src)).toBe(["x = 1 ' trailing", 's = "a \' b"', 'y = 2'].join('\n') + '\n')
    for (const a of AGENT_ASSETS.filter((x) => !x.dest.endsWith('.brs'))) {
      expect(stagedAsset(a)).toBe(fs.readFileSync(a.src, 'utf8'))
    }
  })

  it('leaves the repo runtime files untouched (they keep their comments)', () => {
    const f = fs.readFileSync(path.resolve(__dirname, '../lib/instrument/runtime/source/bt/BT_core.brs'), 'utf8')
    expect(f.split('\n').some(isFullLineComment)).toBe(true)
  })

  it('TP-INS-16: the real built zip has at most 1500 lines and 60793 bytes under source/bt + components/bt', async () => {
    // Same measure as the test pack: every file (XML and BT_config.brs included), `unzip -p ... | wc -l` for lines.
    const out = path.join(tmp, 'legacy.bt-instrumented.zip')
    const cfg = { ...loadConfig(path.resolve(__dirname, '../examples/legacy-app')), stagingDir: path.join(tmp, 'stage') }
    const r = await build(cfg, { log: () => {}, out })
    expect(r.exitCode).toBe(0)
    const z = await JSZip.loadAsync(fs.readFileSync(out))
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir && /^(source\/bt|components\/bt)\//.test(n))
    let nl = 0
    let bytes = 0
    for (const n of names) {
      const buf = await z.file(n).async('nodebuffer')
      bytes += buf.length
      nl += buf.toString('latin1').split('\n').length - 1
    }
    console.log(`TP-INS-16 built zip: ${names.length} files, ${nl} lines, ${bytes} bytes`)
    // Wiring: the agent assets and the runtime in the zip are the stripped ones (fails if setFile used the raw text).
    for (const a of AGENT_ASSETS.filter((x) => x.dest.endsWith('.brs'))) expect(await z.file(a.dest).async('string')).toBe(stagedAsset(a))
    expect(await z.file('source/bt/BT_runtime.brs').async('string')).toBe(runtimeSource(true, true, false))
    console.log(`TP-INS-16 headroom: ${60793 - bytes} bytes under 60793, ${1500 - nl} lines under 1500`)
    expect(nl).toBeLessThanOrEqual(1500)
    expect(bytes).toBeLessThanOrEqual(60793)
  }, 120000)
})
