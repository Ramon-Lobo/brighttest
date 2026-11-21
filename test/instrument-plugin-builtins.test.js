import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const data = require('brighterscript/dist/roku-types/data.json')
const plugin = require('../lib/instrument/plugin.js')

// Guards the Scene root lists against the Roku node hierarchy that ships with brighterscript.
const ext = {}
for (const [k, v] of Object.entries(data.nodes)) ext[k.toLowerCase()] = v.extends && v.extends.name ? v.extends.name.toLowerCase() : null
const descendsFromScene = (n) => { for (let c = n, i = 0; c && i < 30; c = ext[c], i++) if (c === 'scene') return true; return false }

describe('Scene root lists vs the Roku node hierarchy', () => {
  it('SCENE_BUILTINS is exactly the nodes that descend from Scene', () => {
    const real = Object.keys(ext).filter(descendsFromScene).sort()
    expect([...plugin.SCENE_BUILTINS].sort()).toEqual(real)
  })
  it('no NON_SCENE_BUILTINS entry descends from Scene', () => {
    expect(plugin.NON_SCENE_BUILTINS.filter(descendsFromScene)).toEqual([])
  })
  it('every other documented node is covered (no unknown-scene-subtype for a real built-in)', () => {
    const missing = Object.keys(ext).filter((n) => !n.includes(' ')).filter((n) => plugin.isUnknownSceneRoot(n))
    expect(missing).toEqual([])
  })
  it('an undocumented root is still reported as unknown', () => {
    expect(plugin.isUnknownSceneRoot('someunknownroot')).toBe(true)
  })
})
