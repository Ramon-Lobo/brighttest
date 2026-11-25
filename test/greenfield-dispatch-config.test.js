import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The unmodified greenfield example declares instrument.state.dispatch ["dispatch"], so its instrument build
// wraps AppStore's dispatch and the wrapper emits state.action with hashBefore and hashAfter. Headless: staged output
// plus the real runtime under the fork engine; nothing here touches a device.
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { build } = require(path.resolve(__dirname, '../lib/instrument/build.js'))
const { loadConfig } = require(path.resolve(__dirname, '../lib/config.js'))
const APP = path.resolve(__dirname, '../examples/greenfield-app')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-greenfield-dispatch-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('greenfield example: action log config', () => {
  it('declares instrument.state.dispatch ["dispatch"] in the shipped brighttest.json', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'brighttest.json'), 'utf8'))
    expect(cfg.instrument.state.dispatch).toEqual(['dispatch'])
    expect(cfg.instrument.state.registrySections).toEqual(['greenfield'])
  })

  it('instrument build of the unmodified example wraps dispatch and emits state.action with hashBefore and hashAfter', async () => {
    const dir = path.join(tmp, 'app')
    fs.cpSync(APP, dir, { recursive: true, filter: (s) => !s.includes('.brighttest') })
    const cfg = { ...loadConfig(dir), stagingDir: path.join(tmp, 'stage') }
    const lines = []
    const out = path.join(tmp, 'out.zip')
    const r = await build(cfg, { log: (l) => lines.push(l), out })
    expect(lines.join('\n')).not.toMatch(/failed/)
    expect(r.exitCode).toBe(0)
    expect(r.result.skipped.filter((s) => s.kind === 'wrap-target-unknown')).toEqual([])
    const z = await JSZip.loadAsync(fs.readFileSync(out))
    const store = await z.file('components/store/AppStore.brs').async('string')
    expect(store).toMatch(/function __bt_orig_dispatch\(action as object\) as object/)
    expect(store).toMatch(/function dispatch\(action as dynamic\) as dynamic/)
    expect(store).toMatch(/BT_dwEmit\(m\.global, "dispatch", action, __bt_h\)/)
    let rt = ''
    for (const f of Object.values(z.files).filter((e) => /\.brs$/.test(e.name))) rt += await f.async('string')
    expect(rt).toMatch(/d = \{ source: "wrap:" \+ fn, hashBefore: hb, hashAfter: BT_dwHash\(g\) \}/)
    expect(rt).toMatch(/g\.setField\("__btEv", FormatJson\(q\)\)/)
  })

  it('without the dispatch list the same build emits no wrapper (opt-in by design)', async () => {
    const dir = path.join(tmp, 'app2')
    fs.cpSync(APP, dir, { recursive: true, filter: (s) => !s.includes('.brighttest') })
    const base = loadConfig(dir)
    const cfg = { ...base, stagingDir: path.join(tmp, 'stage2'), instrument: { ...base.instrument, state: {} } }
    const out = path.join(tmp, 'out2.zip')
    const r = await build(cfg, { log: () => {}, out })
    expect(r.exitCode).toBe(0)
    const z = await JSZip.loadAsync(fs.readFileSync(out))
    expect(await z.file('components/store/AppStore.brs').async('string')).not.toMatch(/__bt_orig_dispatch/)
  })
})
