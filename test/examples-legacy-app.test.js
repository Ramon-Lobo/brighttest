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
