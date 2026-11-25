import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseArgs } = require('../bin/cli')
const cli = path.resolve(__dirname, '../bin/cli.js')
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-insflag-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const bt = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000 })
function project(name, config) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest'), 'title=t\nmajor_version=1\n')
  fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify(config))
  return dir
}

describe('--instrument flag', () => {
  it('parses to opts.instrument and is absent by default', () => {
    expect(parseArgs(['--instrument']).instrument).toBe(true)
    expect(parseArgs(['--instrument', '--coverage'])).toMatchObject({ instrument: true, coverage: true })
    expect(parseArgs([]).instrument).toBeUndefined()
  })

  it('is listed in --help', () => {
    const r = bt(tmp, ['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--instrument')
  })

  it.each([['--device'], ['--cross-check']])('exits 2 with %s before any build', (flag) => {
    const dir = project('guard' + flag, {})
    const r = bt(dir, ['--instrument', flag, '--host', '127.0.0.1'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--instrument applies to the headless lanes only')
    expect(r.stderr).toContain('instrument build --sideload')
  })

  it('does not trip the guard on a headless run without the flag', () => {
    const dir = project('noguard', {})
    const r = bt(dir, ['--no-sgnode', '--junit'])
    expect(r.stderr).not.toContain('--instrument applies')
    expect(r.stderr).not.toContain('--instrument takes no value')
  })

  it('a bad instrument block with --instrument exits 2 with the typed message', () => {
    const dir = project('bad', { instrument: { state: 'yes' } })
    const r = bt(dir, ['--instrument'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('[brighttest] instrument: instrument.state must be true, false or an object')
  })

  it('state:false with --instrument and no net exits 2 (nothing to instrument)', () => {
    const dir = project('nothing', { instrument: { state: false } })
    const r = bt(dir, ['--instrument'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('nothing to instrument')
  })

  it('without the flag the same bad block only warns and does not exit 2 on validation', () => {
    const dir = project('warn', { instrument: { state: 'yes' } })
    const r = bt(dir, [])
    expect(r.status).not.toBe(2)
    expect(r.stderr).toContain('ignored: instrument is not enabled for this run')
  })

  it('--instrument=<value> exits 2 (takes no value)', () => {
    const dir = project('withvalue', {})
    for (const v of ['--instrument=true', '--instrument=']) {
      const r = bt(dir, [v])
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('--instrument takes no value')
    }
  })
})
