import { describe, test, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { parseFrontmatter, collisionCheck } = require('../lib/skills')

const SKILLS = path.join(__dirname, '..', 'skills')
const names = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS, d.name, 'SKILL.md'))).map((d) => d.name).sort()
const real = names.map((n) => ({ name: n, fm: parseFrontmatter(fs.readFileSync(path.join(SKILLS, n, 'SKILL.md'), 'utf8')).fm }))

describe('skill triggers (AGT-04)', () => {
  test('shipped skills have no trigger collisions or missing fields', () => {
    expect(collisionCheck(real)).toEqual([])
  })
  test('each skill has triggers and a when-not-to-use naming a neighbour', () => {
    for (const s of real) {
      expect(s.fm.triggers, s.name).toBeTruthy()
      expect(s.fm['when-not-to-use'], s.name).toMatch(/\(use [a-z-]+\)/)
    }
  })
  test('detects a shared trigger phrase (case/space-insensitive)', () => {
    const p = collisionCheck([
      { name: 'a', fm: { triggers: 'Run Tests; foo', 'when-not-to-use': '(use b)' } },
      { name: 'b', fm: { triggers: 'bar;  run  tests', 'when-not-to-use': '(use a)' } },
    ])
    expect(p.some((m) => /run tests/.test(m) && /a/.test(m) && /b/.test(m))).toBe(true)
  })
  test('detects a missing when-not-to-use, missing triggers, and unknown neighbour', () => {
    const p = collisionCheck([
      { name: 'a', fm: { triggers: 'x' } },
      { name: 'b', fm: { 'when-not-to-use': '(use a)' } },
      { name: 'c', fm: { triggers: 'y', 'when-not-to-use': '(use ghost)' } },
    ])
    expect(p.join('\n')).toMatch(/a: missing when-not-to-use/)
    expect(p.join('\n')).toMatch(/b: missing triggers/)
    expect(p.join('\n')).toMatch(/c: .*ghost/)
  })
})
