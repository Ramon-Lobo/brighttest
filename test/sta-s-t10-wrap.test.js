import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// STA-S-T10 (TP-STA-21 headless parts): the plugin wraps the config-named dispatch functions and the entry function of
// opt-in Tasks. Staged output only; the device behavior (observer counts, timing) is DQ-5.
const require = createRequire(import.meta.url)
const { ProgramBuilder } = require('brighterscript')
const createPlugin = require(path.resolve(__dirname, '../lib/instrument/plugin.js'))
const { validateStateConfig } = require(path.resolve(__dirname, '../lib/instrument/build.js'))

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-t10-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const comp = (name, ext, scripts = []) => `<?xml version="1.0" encoding="utf-8" ?>\n<component name="${name}" extends="${ext}">\n${scripts.map((s) => `  <script type="text/brightscript" uri="pkg:/${s}" />\n`).join('')}</component>\n`
const CONFIG = '#if BT_AGENT\nfunction BT_config() as object\n    return { token: "a" }\nend function\n#end if\n'
const APP = {
  manifest: 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n',
  'source/bt/BT_config.brs': CONFIG,
  'components/Scene.xml': comp('Home', 'Scene', ['components/store.brs']),
  'components/store.brs': 'sub init()\n    m.n = 0\nend sub\n\nfunction dispatchAction(action as object, extra = 1 as integer) as object\n    m.n = m.n + 1\n    return action\nend function\n\nsub dispatchSub(action as object)\n    m.n = m.n + 1\nend sub\n',
  'components/Poller.xml': comp('Poller', 'Task', ['components/poller.brs']),
  'components/poller.brs': 'sub init()\n    m.top.functionName = "pollRun"\nend sub\n\nsub pollRun()\n    m.count = 1\nend sub\n',
}

async function build(name, state, files = APP) {
  const dir = path.join(tmp, 'src-' + name)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  const plugin = createPlugin()
  const pb = new ProgramBuilder()
  pb.plugins.add(plugin)
  const staging = path.join(tmp, name, 'staging')
  await pb.run({
    cwd: dir, rootDir: dir, stagingDir: staging, createPackage: false, copyToStaging: true,
    files: ['manifest', 'source/**/*', 'components/**/*'], plugins: [], logLevel: 'error', autoImportComponentScript: false,
    diagnosticFilters: [1107, 1140, 1009], instrument: { state },
  })
  const errors = pb.program.getDiagnostics().filter((d) => d.severity === 1)
  return { errors, plugin, read: (rel) => fs.readFileSync(path.join(staging, rel), 'utf8'), result: plugin.getResult() }
}

describe('dispatch wrap (state.dispatch)', () => {
  it('renames the original on its own line and appends a wrapper with the original signature', async () => {
    const b = await build('d1', { dispatch: ['dispatchAction', 'dispatchSub'] })
    expect(b.errors.map((e) => e.message)).toEqual([])
    const out = b.read('components/store.brs')
    expect(out).toMatch(/function __bt_orig_dispatchAction\(action as object, extra = 1 as integer\) as object/)
    expect(out).toMatch(/function dispatchAction\(p0 as dynamic, p1 = invalid\) as dynamic/)
    expect(out).toMatch(/__bt_r = __bt_orig_dispatchAction\(p0, p1\)/)
    expect(out).toMatch(/BT_dwEmit\(m\.global, "dispatchAction", p0, __bt_h\)/)
    expect(out).toMatch(/\n\s*return __bt_r\nend function/)
    expect(out).toMatch(/sub dispatchSub\(p0 as dynamic\)\n[\s\S]*__bt_orig_dispatchSub\(p0\)\n[\s\S]*end sub/)
    expect(out).not.toMatch(/__bt_r = __bt_orig_dispatchSub/)
    expect(b.result.invalid).toEqual([])
  })
  it('keeps the original definition on its source line (rename only)', async () => {
    const b = await build('d2', { dispatch: ['dispatchAction'] })
    const src = APP['components/store.brs'].split('\n').findIndex((l) => l.includes('function dispatchAction'))
    const out = b.read('components/store.brs').split('\n')
    expect(out.findIndex((l) => l.includes('function __bt_orig_dispatchAction'))).toBe(src)
  })
  it('wraps nothing without the config, and reports a name that matches no function', async () => {
    const none = await build('d3', {})
    expect(none.read('components/store.brs')).not.toMatch(/__bt_orig_/)
    const miss = await build('d4', { dispatch: ['nopeAction'] })
    expect(miss.result.skipped.find((s) => s.kind === 'wrap-target-unknown')).toMatchObject({ kind: 'wrap-target-unknown' })
    expect(miss.read('components/store.brs')).not.toMatch(/__bt_orig_/)
  })
  it('an excluded file is never wrapped', async () => {
    const b = await build('d5', { dispatch: ['vendorAction'] }, { ...APP, 'source/a.spec.brs': 'sub vendorAction(a as object)\nend sub\n' })
    expect(b.errors).toEqual([])
    expect(b.read('source/a.spec.brs')).not.toMatch(/__bt_orig_/)
    expect(b.result.skipped.some((s) => s.kind === 'wrap-target-unknown')).toBe(true)
  })
})

describe('Task snapshots (state.tasks)', () => {
  it('wraps the Task entry function (named by functionName in init) with entry and exit snapshots', async () => {
    const b = await build('t1', { tasks: ['Poller'] })
    expect(b.errors.map((e) => e.message)).toEqual([])
    const out = b.read('components/poller.brs')
    expect(out).toMatch(/sub __bt_orig_pollRun\(\)/)
    expect(out).toMatch(/BT_taskSnap\(m\.global, "Poller", "entry", m\)/)
    expect(out).toMatch(/BT_taskSnap\(m\.global, "Poller", "exit", m\)/)
    expect(out).toMatch(/sub init\(\)\n\s+m\.top\.functionName = "pollRun"/)
    expect(b.result.invalid).toEqual([])
  })
  it('reports a Task whose entry function cannot be found and wraps nothing', async () => {
    const b = await build('t2', { tasks: ['Poller', 'Missing'] }, { ...APP, 'components/poller.brs': 'sub init()\nend sub\n' })
    expect(b.result.skipped.filter((s) => s.kind === 'wrap-target-unknown')).toHaveLength(2)
    expect(b.read('components/poller.brs')).not.toMatch(/__bt_orig_/)
  })
})

describe('state config validation', () => {
  it('accepts identifier lists and refuses anything else', () => {
    expect(() => validateStateConfig({ state: { dispatch: ['a_b'], tasks: ['Poller'] } })).not.toThrow()
    expect(() => validateStateConfig({ state: { dispatch: 'x' } })).toThrow(/instrument\.state\.dispatch must be an array of strings/)
    expect(() => validateStateConfig({ state: { tasks: ['bad name'] } })).toThrow(/instrument\.state\.tasks entries must be identifiers/)
  })
})
