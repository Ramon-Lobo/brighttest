import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { writeBsConfig, loadConfig } = require('../lib/config.js')
const headless = require('../lib/headless.js')

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-inswire-'))
  fs.mkdirSync(path.join(tmp, 'source'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'manifest'), 'title=x\n')
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }) })

const writeCfg = (instrument) => {
  fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify({ rootDir: '.', ...(instrument === undefined ? {} : { instrument }) }))
  return loadConfig(tmp)
}
const gen = (cfg, lane, extra) => {
  const r = writeBsConfig(cfg, lane, extra)
  const btc = path.join(tmp, '.brighttest', lane, 'BT_config.brs')
  return { bs: fs.readFileSync(r.bsconfigPath, 'utf8'), btc: fs.existsSync(btc) ? fs.readFileSync(btc, 'utf8') : null }
}
const fakeHubDeps = (seen) => ({
  startHub: async (o) => { seen.o = o; return { host: '127.0.0.1', port: 4321, stop: async () => {} } },
  localLease: () => ({}),
})

describe('writeBsConfig instrument generalization', () => {
  it('no instrument context: no plugin and no BT_config, with or without an enabled block', () => {
    const a = gen(writeCfg(undefined), 'headless')
    expect(a.btc).toBeNull()
    expect(JSON.parse(a.bs).plugins.length).toBe(1)
    const b = gen(writeCfg({ enabled: true }), 'headless')
    expect(b.btc).toBeNull()
    expect(b.bs).toBe(a.bs)
  })

  it('net-only: extra.net and the equivalent extra.instrument are byte-identical', () => {
    const cfg = writeCfg({ net: true })
    const viaNet = gen(cfg, 'headless', { net: { token: 't0k', port: 4000 } })
    const viaInst = gen(cfg, 'headless', { instrument: { token: 't0k', host: '127.0.0.1', port: 4000, net: true, state: false } })
    expect(viaInst.bs).toBe(viaNet.bs)
    expect(viaInst.btc).toBe(viaNet.btc)
    expect(viaNet.btc).toContain('features: { net: true, state: false, op: false }')
    const inst = JSON.parse(viaNet.bs).instrument
    expect(inst).toMatchObject({ net: true, scene: false, op: false, netSpec: true })
    expect(inst.state).toBeUndefined()
  })

  it('state on: the agent is baked and the plugin gets scene/op/state', () => {
    const cfg = writeCfg({ enabled: true, state: { publish: { maxBytes: 2048 } } })
    const r = gen(cfg, 'headless-scene', { instrument: { token: 't0k', host: '127.0.0.1', port: 4000, net: false, state: { publish: { maxBytes: 2048 } } } })
    expect(r.btc).toContain('features: { net: false, state: true, op: true }')
    expect(r.btc).toContain('maxBytes: 2048')
    const inst = JSON.parse(r.bs).instrument
    expect(inst).toMatchObject({ net: false, scene: true, op: true, netSpec: false, state: { publish: { maxBytes: 2048 } } })
    expect(JSON.parse(r.bs).plugins.length).toBe(2)
  })

  it('state and net together', () => {
    const cfg = writeCfg({ enabled: true, net: true })
    const r = gen(cfg, 'headless-scene', { instrument: { token: 't0k', port: 4000, net: true, state: {} } })
    expect(r.btc).toContain('features: { net: true, state: true, op: true }')
  })

  it('the device lane never gets the instrument', () => {
    const r = gen(writeCfg({ enabled: true }), 'device', { instrument: { token: 't0k', port: 1, net: true, state: {} } })
    expect(r.btc).toBeNull()
    expect(JSON.parse(r.bs).instrument).toBeUndefined()
  })
})

describe('headless.runWithNet instrument context', () => {
  it('not enabled and no net: inner gets undefined (unchanged)', async () => {
    const seen = {}
    let got = 'unset'
    const code = await headless.runWithNet(writeCfg(undefined), {}, fakeHubDeps(seen), async (c) => { got = c; return 0 })
    expect(code).toBe(0)
    expect(got).toBeUndefined()
  })

  it('enabled: ctx carries a fresh token shared with the hub, net false, state object', async () => {
    const seen = {}
    let got
    await headless.runWithNet(writeCfg({ enabled: true }), {}, fakeHubDeps(seen), async (c) => { got = c; return 0 })
    expect(got).toMatchObject({ host: '127.0.0.1', port: 4321, net: false, state: {} })
    expect(got.token).toMatch(/^[0-9a-f]{32}$/)
    expect(seen.o.tokens).toEqual([got.token])
    expect(seen.o.netProxy).toBeUndefined()
  })

  it('opts.instrument forces it on; _noInstrument ignores it', async () => {
    let got = 'unset'
    await headless.runWithNet(writeCfg(undefined), { instrument: true }, fakeHubDeps({}), async (c) => { got = c; return 0 })
    expect(got.state).toEqual({})
    got = 'unset'
    await headless.runWithNet(writeCfg({ enabled: true }), { _noInstrument: true }, fakeHubDeps({}), async (c) => { got = c; return 0 })
    expect(got).toBeUndefined()
  })

  it('a bad block exits 2 with the message and never runs inner', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let ran = false
    const code = await headless.runWithNet(writeCfg({ enabled: 'yes' }), {}, fakeHubDeps({}), async () => { ran = true; return 0 })
    expect(code).toBe(2)
    expect(ran).toBe(false)
    expect(err.mock.calls.join('\n')).toContain('instrument.enabled must be true or false')
  })

  it('a hub that cannot start fails an instrumented run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = { startHub: async () => { throw new Error('nope') }, localLease: () => ({}) }
    expect(await headless.runWithNet(writeCfg({ enabled: true }), {}, deps, async () => 0)).toBe(1)
  })
})

describe('headless.runSuite with state', () => {
  it('--no-sgnode with the state agent exits 2 with the design message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await headless.runSuite(writeCfg({ enabled: true }), { noSgnode: true }, { token: 't', port: 1, net: false, state: {} })
    expect(code).toBe(2)
    expect(err.mock.calls.join('\n')).toContain('--no-sgnode runs no SceneGraph; the instrument state agent needs a scene lane')
  })

  it('state on routes to the scene lane with the context', async () => {
    const cov = require('../lib/coverage-headless.js')
    const spy = vi.spyOn(cov, 'run').mockResolvedValue(0)
    const ctx = { token: 't', port: 1, net: false, state: {} }
    expect(await headless.runSuite(writeCfg({ enabled: true }), {}, ctx)).toBe(0)
    expect(spy.mock.calls[0][1]).toMatchObject({ coverage: false, _instrument: ctx })
  })
})

describe('instrumentWanted', () => {
  it('is false by default and true when enabled, forced, or the block is bad', () => {
    expect(headless.instrumentWanted(writeCfg(undefined), {})).toBe(false)
    expect(headless.instrumentWanted(writeCfg({ enabled: false }), {})).toBe(false)
    expect(headless.instrumentWanted(writeCfg({ enabled: true }), {})).toBe(true)
    expect(headless.instrumentWanted(writeCfg(undefined), { instrument: true })).toBe(true)
    expect(headless.instrumentWanted(writeCfg({ enabled: 1 }), {})).toBe(true)
    expect(headless.instrumentWanted(writeCfg({ enabled: true }), { _noInstrument: true })).toBe(false)
  })
})
