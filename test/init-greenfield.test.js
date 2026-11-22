import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'cli.js')

function init(cwd, extra = []) {
  return spawnSync(process.execPath, [cli, 'init', '--greenfield', ...extra], { cwd, encoding: 'utf8', timeout: 60000 })
}
function scratch(manifest) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-gf-'))
  if (manifest !== null) fs.writeFileSync(path.join(d, 'manifest'), manifest)
  return d
}

describe('init --greenfield', () => {
  it('copies version-headed templates and adds BT_AGENT=false', () => {
    const d = scratch('title=X\nbs_const=FOO=true\n')
    try {
      const r = init(d)
      expect(r.status).toBe(0)
      for (const [f, re] of [['BTStore.brs', /^' brighttest-template: BTStore v\d+/], ['BTHttp.brs', /^' brighttest-template: BTHttp v\d+/]]) {
        const body = fs.readFileSync(path.join(d, 'components', 'brighttest', f), 'utf8')
        expect(body.split('\n')[0]).toMatch(re)
      }
      const m = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      expect(m).toContain('bs_const=FOO=true;BT_AGENT=false')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('adds a bs_const line when none exists', () => {
    const d = scratch('title=X\n')
    try {
      init(d)
      const m = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      expect(m.match(/^bs_const=/gm)).toHaveLength(1)
      expect(m).toContain('bs_const=BT_AGENT=false')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('is idempotent on re-run', () => {
    const d = scratch('title=X\nbs_const=FOO=true\n')
    try {
      init(d)
      const before = fs.readFileSync(path.join(d, 'manifest'), 'utf8')
      const tpl = path.join(d, 'components', 'brighttest', 'BTStore.brs')
      fs.appendFileSync(tpl, "' local edit\n")
      const r = init(d)
      expect(r.status).toBe(0)
      expect(fs.readFileSync(path.join(d, 'manifest'), 'utf8')).toBe(before)
      expect(fs.readFileSync(tpl, 'utf8')).toContain("' local edit")
      expect((before.match(/BT_AGENT/g) || [])).toHaveLength(1)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('does not flip an existing BT_AGENT const', () => {
    const d = scratch('title=X\nbs_const=BT_AGENT=true\n')
    try {
      init(d)
      expect(fs.readFileSync(path.join(d, 'manifest'), 'utf8')).toContain('bs_const=BT_AGENT=true')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('without --greenfield nothing is copied', () => {
    const d = scratch('title=X\n')
    try {
      spawnSync(process.execPath, [cli, 'init'], { cwd: d, encoding: 'utf8', timeout: 60000 })
      expect(fs.existsSync(path.join(d, 'components', 'brighttest'))).toBe(false)
      expect(fs.readFileSync(path.join(d, 'manifest'), 'utf8')).not.toContain('BT_AGENT')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
})
