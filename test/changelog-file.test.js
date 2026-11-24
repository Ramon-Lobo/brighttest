import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.join(__dirname, '..')
const file = path.join(root, 'docs', 'changelog.md')

describe('docs/changelog.md', () => {
  // The file ships on this branch; absence means it was removed by mistake, so fail loudly rather than skip.
  it('exists and passes `scripts/changelog.js check`', () => {
    expect(fs.existsSync(file), 'docs/changelog.md is missing').toBe(true)
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'changelog.js'), 'check'], { cwd: root, encoding: 'utf8' })
    expect(r.stdout + r.stderr).toMatch(/ok/)
    expect(r.status).toBe(0)
  })
})
