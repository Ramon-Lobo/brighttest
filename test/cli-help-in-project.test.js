import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `--help` / `-h` on a subcommand must print that subcommand's help from inside a project dir
// (one with a brighttest config), exactly as it does outside one. Local only: no device, no network.
const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js')
let proj, empty

function run(cwd, args) {
  // Strip lease/device env so a help call can never reach a device.
  const env = { PATH: process.env.PATH, HOME: cwd }
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 })
}

beforeAll(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-help-proj-'))
  fs.mkdirSync(path.join(proj, 'source'))
  fs.writeFileSync(path.join(proj, 'manifest'), 'title=Help\n')
  fs.writeFileSync(path.join(proj, 'brighttest.config.json'), JSON.stringify({ rootDir: '.' }))
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'help-fixture' }))
  empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-help-empty-'))
})
afterAll(() => {
  for (const d of [proj, empty]) if (d) fs.rmSync(d, { recursive: true, force: true })
})

const CASES = [
  { name: 'device', args: ['device'], marker: /^brighttest device /m },
  { name: 'e2e run', args: ['e2e', 'run'], marker: /^brighttest e2e /m },
  { name: 'net', args: ['net'], marker: /^brighttest net convert/m },
]

describe('subcommand help inside a project dir', () => {
  for (const c of CASES) {
    for (const flag of ['--help', '-h']) {
      it(`${c.name} ${flag} prints the subcommand help and exits 0`, () => {
        const r = run(proj, [...c.args, flag])
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(c.marker)
        expect(r.stdout).not.toMatch(/headless lane/)
        expect(r.stdout).not.toMatch(/unified BrightScript test runner/)
        // identical to the output outside a project dir
        expect(r.stdout).toBe(run(empty, [...c.args, flag]).stdout)
      })
    }
  }

  it('top-level --help (no subcommand) prints the main help, not a lane run', () => {
    const r = run(proj, ['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/unified BrightScript test runner/)
    expect(r.stdout).not.toMatch(/headless lane/)
  })
})
