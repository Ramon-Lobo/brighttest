import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseInstrumentArgs } = require('../bin/cli')
const cli = path.resolve(__dirname, '../bin/cli.js')
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-icli-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function mkapp(name, files, config) {
  const dir = path.join(tmp, name)
  const all = { manifest: 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n', 'source/main.brs': 'sub main()\nend sub\n', ...files }
  if (config) all['brighttest.json'] = JSON.stringify(config)
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
const run = (cwd, args) => spawnSync(process.execPath, [cli, 'instrument', ...args], { cwd, encoding: 'utf8' })

describe('parseInstrumentArgs', () => {
  it('parses the action and flags', () => {
    expect(parseInstrumentArgs(['build', '--out', 'a.zip', '--strict', '--verbose'])).toMatchObject({ instrumentAction: 'build', out: 'a.zip', strict: true, verbose: true })
    expect(parseInstrumentArgs(['build', '--no-strict', '--out=b.zip'])).toMatchObject({ strict: false, out: 'b.zip' })
    expect(parseInstrumentArgs(['build'])).toMatchObject({ strict: null, out: null, sideload: false })
    expect(parseInstrumentArgs(['build', '--sideload', '--host', '192.0.2.5', '--wait=5m'])).toMatchObject({ sideload: true, host: '192.0.2.5' })
    expect(parseInstrumentArgs(['build', '--bogus']).unknown).toEqual(['--bogus'])
  })
})

describe('brighttest instrument build (CLI)', () => {
  it('exit 0 writes the package and prints the path', () => {
    const app = mkapp('ok', {})
    const r = run(app, ['build', '--out', 'out/app.zip'])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.existsSync(path.join(app, 'out/app.zip'))).toBe(true)
    expect(r.stderr + r.stdout).toMatch(/instrument build: wrote /)
  })
  it('exit 1 on a build error, with the final line and no package', () => {
    const app = mkapp('err', { 'source/bad.brs': 'sub f()\n    x = = 1\nend sub\n' })
    const r = run(app, ['build', '--out', 'out/app.zip'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/instrument build failed: \d+ error\(s\), no package written\n$/)
    expect(fs.existsSync(path.join(app, 'out/app.zip'))).toBe(false)
  })
  it('exit 4 on a strict failure (flag or config), exit 0 with --no-strict', () => {
    const files = { 'source/vendor2/x.brs': 'sub f(x as object)\n    x.setUrl("http://127.0.0.1:1/a")\nend sub\n' }
    const app = mkapp('strict', files, { instrument: { exclude: ['source/vendor2/**'], strict: true } })
    const r = run(app, ['build', '--out', 'out/app.zip'])
    expect(r.status).toBe(4)
    expect(r.stderr).toMatch(/strict: excluded-candidate source\/vendor2\/x\.brs:2 /)
    expect(r.stderr).toMatch(/instrument build failed: 1 error\(s\), no package written/)
    expect(fs.existsSync(path.join(app, 'out/app.zip'))).toBe(false)
    expect(run(app, ['build', '--no-strict', '--out', 'out/app.zip']).status).toBe(0)
    const plain = mkapp('strict2', files, { instrument: { exclude: ['source/vendor2/**'] } })
    expect(run(plain, ['build', '--out', 'o.zip']).status).toBe(0)
    expect(run(plain, ['build', '--strict', '--out', 'o2.zip']).status).toBe(4)
  })
  it('usage errors exit 2; --help documents the exit codes', () => {
    const app = mkapp('usage', {})
    expect(run(app, []).status).toBe(2)
    expect(run(app, ['nope']).status).toBe(2)
    expect(run(app, ['build', '--sideload']).status).toBe(2)
    const h = run(app, ['--help'])
    expect(h.status).toBe(0)
    expect(h.stdout).toMatch(/0 ok, 1 build failure/)
    expect(h.stdout).toMatch(/4 strict-mode failure/)
  })
})
