import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Static guard for the legacy fixture's entry point: in Main(), `m` is a plain associative array, so
// `m.global` is invalid there (device error &hf3). The global node must come from the screen.
const main = fs.readFileSync(path.resolve(__dirname, '../examples/legacy-app/source/main.brs'), 'utf8')
const lines = main.split('\n')
const code = (l) => l.replace(/'.*$/, '')

describe('legacy-app Main() global handle', () => {
  it('binds m.global to the screen global node before any other m.global use in Main()', () => {
    const end = lines.findIndex((l) => /^\s*end sub/i.test(l))
    const uses = lines.slice(0, end).map((l, i) => ({ l: code(l), n: i })).filter((x) => /\bm\.global\b/.test(x.l))
    expect(uses.length).toBeGreaterThan(0)
    expect(uses[0].l).toMatch(/m\.global\s*=\s*screen\.getGlobalNode\(\)/)
    const screenAt = lines.findIndex((l) => /screen\s*=\s*CreateObject\("roSGScreen"\)/.test(code(l)))
    expect(screenAt).toBeGreaterThan(-1)
    expect(uses[0].n).toBeGreaterThan(screenAt)
  })

  it('takes the global node from the screen before the first use, in order addFields, CreateScene, show, setFocus', () => {
    const idx = (re) => lines.findIndex((l) => re.test(code(l)))
    const get = idx(/screen\.getGlobalNode\(\)/)
    const add = idx(/m\.global\.addFields\(/)
    const scene = idx(/screen\.CreateScene\(/)
    expect(get).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(get)
    expect(scene).toBeGreaterThan(add)
    const row = code(lines[scene])
    expect(row.indexOf('show()')).toBeGreaterThan(row.indexOf('CreateScene'))
    expect(row.indexOf('setFocus(true)')).toBeGreaterThan(row.indexOf('show()'))
  })
})

describe('legacy-app stress launch params', () => {
  const scene = fs.readFileSync(path.resolve(__dirname, '../examples/legacy-app/components/scenes/LegacyScene.brs'), 'utf8')
  const flows = (n) => fs.readFileSync(path.resolve(__dirname, `../examples/legacy-app/flows/${n}.e2e.yaml`), 'utf8')

  it('main.brs accepts only the documented stressfields and stresstree values, with defaults 500 and both', () => {
    expect(main).toMatch(/stressFields = 500/)
    expect(main).toMatch(/stressTree = "both"/)
    expect(main).toMatch(/nf = 100 or nf = 500 or nf = 1000/)
    expect(main).toMatch(/st = "1500" or st = "6000" or st = "both"/)
    expect(main).toMatch(/stressFields: stressFields/)
    expect(main).toMatch(/stressTree: stressTree/)
  })

  it('main.brs seeds registry legacy_prefs.lastTier when absent', () => {
    expect(main).toMatch(/not reg\.exists\("lastTier"\)/)
  })

  it('runStress passes the params to growGlobal and builds only the chosen tree(s)', () => {
    expect(scene).toMatch(/callFunc\("growGlobal", stressParam\("stressFields", 500\), kb\)/)
    expect(scene).toMatch(/stressParam\("stressTree", "both"\) <> "6000" then sb\.callFunc\("buildTree", 1500\)/)
    expect(scene).toMatch(/stressParam\("stressTree", "both"\) <> "1500" then sb\.callFunc\("buildTree", 6000\)/)
  })

  it('state flows carry the layer assertions and the TP-STA-15 steps', () => {
    expect(flows('state-read')).toMatch(/layer: registry, path: legacy_prefs\.lastTier/)
    expect(flows('state-read')).toMatch(/layer: global, path: user\.tier/)
    for (const k of ['waitForAgent', 'snapshot: fresh', 'setState:', 'restore: fresh', 'assertText: { id: tierLabel, equals: "Tier: premium" }']) expect(flows('state-write')).toContain(k)
  })

  it('brighttest.json declares the registry sections', () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../examples/legacy-app/brighttest.json'), 'utf8'))
    expect(cfg.instrument.state.registrySections).toEqual(['legacy_prefs', 'legacy_session'])
  })
})
