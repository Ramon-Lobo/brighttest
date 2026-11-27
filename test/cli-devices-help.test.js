import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `brighttest devices --help` prints usage and exits 0 without LAN discovery. Discovery is mocked through a
// preload that records any call to a marker file; the marker must stay absent.
const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js')

function runWithMock(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-devhelp-'))
  const marker = path.join(dir, 'discover-called')
  const preload = path.join(dir, 'mock.js')
  fs.writeFileSync(preload, `const d = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib', 'devices.js'))});
d.discover = async () => { require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); return [] };`)
  const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, NODE_OPTIONS: `--require ${preload}` }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 30000 })
  const called = fs.existsSync(marker)
  fs.rmSync(dir, { recursive: true, force: true })
  return { r, called }
}

describe('brighttest devices --help', () => {
  for (const flag of ['--help', '-h']) {
    it(`${flag} prints usage, exits 0, runs no discovery`, () => {
      const { r, called } = runWithMock(['devices', flag])
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/brighttest devices/)
      expect(r.stdout).toMatch(/Usage:/)
      expect(r.stdout).not.toMatch(/discovering/)
      expect(called).toBe(false)
    })
  }
  it('the mock does intercept discovery without --help (sanity)', () => {
    const { called } = runWithMock(['devices'])
    expect(called).toBe(true)
  })
})
