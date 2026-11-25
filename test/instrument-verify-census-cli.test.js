import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseInstrumentArgs, parseInitArgs } = require('../bin/cli')
const cli = path.resolve(__dirname, '../bin/cli.js')
const legacy = path.resolve(__dirname, '../examples/legacy-app')
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-vc-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const bt = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
function mkdir(name, files) {
  const dir = path.join(tmp, name)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}
const MANIFEST = 'title=t\nmajor_version=1\n'

describe('arg parsing', () => {
  it('verify takes a positional target; census takes --json/--out', () => {
    expect(parseInstrumentArgs(['verify', 'a.zip'])).toMatchObject({ instrumentAction: 'verify', target: 'a.zip', unknown: [] })
    expect(parseInstrumentArgs(['census', '--json', '--out', 'd'])).toMatchObject({ instrumentAction: 'census', json: true, out: 'd' })
    expect(parseInstrumentArgs(['init']).target).toBe(null)
    expect(parseInitArgs(['--brownfield'])).toMatchObject({ brownfield: true, force: false })
  })
})

describe('instrument verify (CLI)', () => {
  it('exit 0 on a clean directory', () => {
    const d = mkdir('clean', { manifest: MANIFEST, 'source/main.brs': 'sub main()\nend sub\n' })
    const r = bt(tmp, ['instrument', 'verify', d])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/clean/)
  })
  it('exit 3 on an instrumented directory, naming markers and paths', () => {
    const d = mkdir('instr', { manifest: MANIFEST + 'bt_instrumented=1\nbs_const=BT_AGENT=true\n', 'source/bt/agent.brs': 'sub x()\nend sub\n' })
    const r = bt(tmp, ['instrument', 'verify', d])
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/INSTRUMENTED/)
    expect(r.stderr).toMatch(/manifest-key: manifest/)
    expect(r.stderr).toMatch(/bs-const: manifest/)
    expect(r.stderr).toMatch(/runtime-file: source\/bt\/agent\.brs/)
  })
  it('exit 0 for BT_AGENT=false, exit 3 for a __bt_boot string alone', () => {
    expect(bt(tmp, ['instrument', 'verify', mkdir('flag', { manifest: MANIFEST + 'bs_const=BT_AGENT=false\n' })]).status).toBe(0)
    expect(bt(tmp, ['instrument', 'verify', mkdir('boot', { manifest: MANIFEST, 'source/x.brs': "' __bt_boot\n" })]).status).toBe(3)
  })
  it('exit 2 on a missing path or no target', () => {
    expect(bt(tmp, ['instrument', 'verify', path.join(tmp, 'nope')]).status).toBe(2)
    expect(bt(tmp, ['instrument', 'verify']).status).toBe(2)
  })
})

describe('instrument census (CLI)', () => {
  it('--json --out writes census.json/md, prints the module JSON, leaves the app untouched', () => {
    const { census } = require('../lib/instrument/census')
    const out = path.join(tmp, 'census-out')
    const before = fs.readdirSync(legacy).sort()
    const r = bt(legacy, ['instrument', 'census', '--json', '--out', out])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readdirSync(legacy).sort()).toEqual(before)
    const printed = JSON.parse(r.stdout)
    expect(JSON.parse(fs.readFileSync(path.join(out, 'census.json'), 'utf8'))).toEqual(printed)
    expect(fs.readFileSync(path.join(out, 'census.md'), 'utf8')).toMatch(/Could not instrument/)
    return census(legacy).then((c) => expect(printed.counts).toEqual(c.counts))
  })
  it('prints markdown by default and writes nothing without --out', () => {
    const d = mkdir('cen-md', { manifest: MANIFEST, 'source/main.brs': 'sub main()\nend sub\n' })
    const r = bt(d, ['instrument', 'census'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^# Instrumentation census/)
    expect(fs.readdirSync(d).sort()).toEqual(['manifest', 'source'])
  })
})

describe('init --brownfield', () => {
  const setup = (name) => {
    const d = path.join(tmp, name)
    fs.cpSync(legacy, d, { recursive: true })
    // the fixture now declares instrument.state; init only proposes a block when it is exclude-only, so reset that
    const f = path.join(d, 'brighttest.json')
    const c = JSON.parse(fs.readFileSync(f, 'utf8'))
    delete c.instrument.state
    fs.writeFileSync(f, JSON.stringify(c))
    return d
  }
  it('writes the instrument block with proposed registry sections and a .gitignore entry; no example spec', () => {
    const d = setup('bf')
    const r = bt(d, ['init', '--brownfield'])
    expect(r.status, r.stderr).toBe(0)
    const cfg = JSON.parse(fs.readFileSync(path.join(d, 'brighttest.json'), 'utf8'))
    expect(cfg.instrument.strict).toBe(false)
    expect(cfg.instrument.state.registrySections).toEqual(['legacy_prefs', 'legacy_session'])
    expect(cfg.instrument.exclude).toEqual(['source/vendor/**']) // existing settings kept
    expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).toMatch(/^\*\.bt-instrumented\.zip$/m)
    expect(fs.existsSync(path.join(d, 'source/tests/Example.spec.bs'))).toBe(false)
    expect(r.stdout).toMatch(/Proposed registry sections: legacy_prefs, legacy_session/)
  })
  it('keeps an existing instrument block unless --force; is idempotent for .gitignore', () => {
    const d = setup('bf2')
    bt(d, ['init', '--brownfield'])
    const p = path.join(d, 'brighttest.json')
    const c = JSON.parse(fs.readFileSync(p, 'utf8'))
    c.instrument.strict = true
    fs.writeFileSync(p, JSON.stringify(c))
    const gi = fs.readFileSync(path.join(d, '.gitignore'), 'utf8')
    bt(d, ['init', '--brownfield'])
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).instrument.strict).toBe(true)
    expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).toBe(gi)
    bt(d, ['init', '--brownfield', '--force'])
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).instrument.strict).toBe(false)
  })
})

describe('census config handling (ADOPT-28)', () => {
  const app = (name, cfgText) => mkdir(name, { manifest: MANIFEST, 'source/main.brs': 'sub main()\n  x = CreateObject("roUrlTransfer")\nend sub\n', 'source/vendor/V.brs': 'sub v()\n  x = CreateObject("roUrlTransfer")\nend sub\n', ...(cfgText == null ? {} : { 'brighttest.json': cfgText }) })

  it('--config <path> is honoured (a non-default exclude changes the output)', () => {
    const dir = app('cfg-honoured', null)
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ instrument: { exclude: ['source/main.brs'] } }))
    const base = bt(dir, ['instrument', 'census', '--json'])
    const withCfg = bt(dir, ['instrument', 'census', '--json', '--config', 'other.json'])
    expect(base.status).toBe(0)
    expect(withCfg.status).toBe(0)
    const site = (r) => JSON.parse(r.stdout).network.createObjectSites.find((x) => x.file === 'source/main.brs')
    expect(site(base).covered).toBe(true)
    expect(site(withCfg).covered).toBe(false)
    expect(withCfg.stdout).not.toBe(base.stdout)
  })
  it('malformed brighttest.json is an error (exit non-zero, no absolute path)', () => {
    const dir = app('cfg-malformed', '{ not json')
    const r = bt(dir, ['instrument', 'census', '--json'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/could not parse brighttest\.json as JSON/)
    expect(r.stderr).not.toContain(dir)
    expect(r.stderr).not.toContain(os.homedir())
  })
  it('malformed or missing --config file is an error without absolute paths', () => {
    const dir = app('cfg-bad-explicit', null)
    fs.writeFileSync(path.join(dir, 'bad.json'), '[1')
    for (const f of ['bad.json', 'missing.json']) {
      const r = bt(dir, ['instrument', 'census', '--config', f])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(f)
      expect(r.stderr).not.toContain(dir)
    }
  })
  it('never echoes file content, and --config without a value is a usage error', () => {
    const dir = app('cfg-secret', null)
    fs.writeFileSync(path.join(dir, '.env'), 'API_SECRET=hunter2hunter2\n')
    const r = bt(dir, ['instrument', 'census', '--config', '.env'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).not.toMatch(/API_SECRET|hunter2|API_/)
    const m = bt(dir, ['instrument', 'census', '--config'])
    expect(m.status).toBe(2)
    expect(m.stderr).toMatch(/--config \(needs a value\)/)
  })
  it('no brighttest.json still uses defaults', () => {
    expect(bt(app('cfg-none', null), ['instrument', 'census', '--json']).status).toBe(0)
  })
})
