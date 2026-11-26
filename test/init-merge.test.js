import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'cli.js')
const legacy = path.join(root, 'examples', 'legacy-app')

function scratch(cfgText) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-im-'))
  fs.cpSync(legacy, d, { recursive: true, filter: (s) => !/EXPECTED-CENSUS|node_modules/.test(s) })
  if (cfgText === null) fs.rmSync(path.join(d, 'brighttest.json'))
  else fs.writeFileSync(path.join(d, 'brighttest.json'), cfgText)
  return d
}
const run = (cwd, extra = []) => spawnSync(process.execPath, [cli, 'init', '--brownfield', ...extra], { cwd, encoding: 'utf8', timeout: 120000 })
const file = (d) => path.join(d, 'brighttest.json')
const VALID = JSON.stringify({ rootDir: '.', sourceGlobs: ['manifest', 'source/**/*'], testsFilePattern: '**/*.spec.bs', stagingDir: '.brighttest', custom: { a: 1 }, instrument: { strict: false, exclude: ['x/**'], state: { registrySections: ['mine'] } } }, null, 4) + '\n'

describe('init --brownfield merges into an existing brighttest.json', () => {
  it('a valid file is untouched (bytes and mtime) and reported unchanged', () => {
    const d = scratch(VALID)
    try {
      const old = new Date(Date.now() - 86400000)
      fs.utimesSync(file(d), old, old)
      const before = fs.statSync(file(d)).mtimeMs
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('brighttest.json')
      expect(r.stdout).toContain('unchanged (valid)')
      expect(fs.readFileSync(file(d), 'utf8')).toBe(VALID)
      expect(fs.statSync(file(d)).mtimeMs).toBe(before)
      expect(fs.existsSync(file(d) + '.bak')).toBe(false)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('adds missing keys, keeps existing keys, order and indentation, and is idempotent', () => {
    const d = scratch(JSON.stringify({ sourceGlobs: ['manifest', 'source/**/*'], custom: 1, instrument: { exclude: ['v/**'] } }, null, 4) + '\n')
    try {
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/added rootDir: \(absent\) -> "\."/)
      expect(r.stdout).toMatch(/added instrument\.strict: \(absent\) -> false/)
      expect(r.stdout).toMatch(/added instrument\.state:/)
      const text = fs.readFileSync(file(d), 'utf8')
      const cfg = JSON.parse(text)
      expect(Object.keys(cfg).slice(0, 3)).toEqual(['sourceGlobs', 'custom', 'instrument'])
      expect(cfg.sourceGlobs).toEqual(['manifest', 'source/**/*'])
      expect(cfg.instrument.exclude).toEqual(['v/**'])
      expect(cfg.instrument.state.registrySections).toEqual(['legacy_prefs', 'legacy_session'])
      expect(text).toMatch(/\n {4}"custom"/)
      expect(fs.existsSync(file(d) + '.bak')).toBe(true)
      const r2 = run(d)
      expect(r2.stdout).toContain('unchanged (valid)')
      expect(fs.readFileSync(file(d), 'utf8')).toBe(text)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('fixes an invalid value, reports old -> new, keeps unknown keys', () => {
    const d = scratch(JSON.stringify({ rootDir: 5, sourceGlobs: ['manifest', 7], testsFilePattern: '**/*.spec.bs', stagingDir: '.brighttest', keep: { z: [1] }, instrument: { strict: 'yes', exclude: ['a'], state: true } }, null, 2) + '\n')
    try {
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/changed rootDir: 5 -> "\."/)
      expect(r.stdout).toMatch(/changed sourceGlobs: \["manifest",7\] -> \["manifest"\]/)
      expect(r.stdout).toMatch(/changed instrument\.strict: "yes" -> false/)
      expect(r.stdout).not.toMatch(/instrument\.state/)
      const cfg = JSON.parse(fs.readFileSync(file(d), 'utf8'))
      expect(cfg.keep).toEqual({ z: [1] })
      expect(cfg.instrument.state).toBe(true)
      expect(cfg.instrument.exclude).toEqual(['a'])
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('corrupt JSON or a non-object exits 1 and writes nothing', () => {
    for (const bad of ['{ "rootDir": ', '[1,2]']) {
      const d = scratch(bad)
      try {
        const r = run(d)
        expect(r.status).toBe(1)
        expect(r.stderr).toMatch(/brighttest\.json/)
        expect(fs.readFileSync(file(d), 'utf8')).toBe(bad)
        expect(fs.existsSync(file(d) + '.bak')).toBe(false)
        expect(fs.readFileSync(path.join(d, '.gitignore'), 'utf8')).not.toContain('bt-instrumented')
      } finally { fs.rmSync(d, { recursive: true, force: true }) }
    }
  })

  it('--dry-run prints the plan and writes nothing, not even .gitignore', () => {
    const text = JSON.stringify({ rootDir: '.' }) + '\n'
    const d = scratch(text)
    try {
      const gi = fs.existsSync(path.join(d, '.gitignore')) ? fs.readFileSync(path.join(d, '.gitignore'), 'utf8') : null
      const r = run(d, ['--dry-run'])
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/added sourceGlobs/)
      expect(r.stdout).toContain('dry run')
      expect(fs.readFileSync(file(d), 'utf8')).toBe(text)
      expect(fs.existsSync(file(d) + '.bak')).toBe(false)
      expect(fs.existsSync(path.join(d, '.gitignore')) ? fs.readFileSync(path.join(d, '.gitignore'), 'utf8') : null).toBe(gi)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('the legacy-app fixture config: only the missing strict key is added', () => {
    const d = scratch(fs.readFileSync(path.join(legacy, 'brighttest.json'), 'utf8'))
    try {
      const r = run(d)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/added instrument\.strict/)
      expect(r.stdout.match(/\b(?:added|changed) /g)).toHaveLength(1)
      const orig = JSON.parse(fs.readFileSync(path.join(legacy, 'brighttest.json'), 'utf8'))
      const cfg = JSON.parse(fs.readFileSync(file(d), 'utf8'))
      expect(cfg.sourceGlobs).toEqual(orig.sourceGlobs)
      expect(cfg.instrument.state).toEqual(orig.instrument.state)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('creates the file when absent (unchanged behaviour)', () => {
    const d = scratch(null)
    try {
      const r = run(d)
      expect(r.status).toBe(0)
      const cfg = JSON.parse(fs.readFileSync(file(d), 'utf8'))
      expect(cfg.instrument.strict).toBe(false)
      expect(cfg.instrument.state.registrySections).toEqual(['legacy_prefs', 'legacy_session'])
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
})

describe('init --brownfield hardening', () => {
  const merged = (cfg, extra = []) => {
    const d = scratch(typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2) + '\n')
    try {
      const r = run(d, extra)
      return { r, text: fs.readFileSync(file(d), 'utf8'), d, gi: fs.existsSync(path.join(d, '.gitignore')) ? fs.readFileSync(path.join(d, '.gitignore'), 'utf8') : null, bak: fs.existsSync(file(d) + '.bak') }
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  }
  const base = { rootDir: '.', sourceGlobs: ['manifest'], testsFilePattern: '**/*.spec.bs', stagingDir: '.brighttest' }

  it('one semantically bad state sub-key keeps its siblings, is reported and not rewritten', () => {
    const state = { registrySections: ['auth'], redact: { paths: ['user.token'] }, callable: ['a', 'A'] }
    const m = merged({ ...base, instrument: { strict: false, state } })
    expect(m.r.status).toBe(0)
    expect(JSON.parse(m.text).instrument.state).toEqual(state)
    expect(m.r.stdout).toMatch(/needs attention: instrument\.state\.callable: .*duplicate/)
    const { validateBrownfield } = require('../lib/init-merge')
    expect(validateBrownfield(JSON.parse(m.text), { rootDir: '.', sourceGlobs: [], testsFilePattern: 'x', stagingDir: 's' }).map((c) => c.key)).toContain('instrument.state.callable')
  })

  it('a wrong-typed state sub-key is repaired alone', () => {
    const m = merged({ ...base, instrument: { strict: false, state: { registrySections: ['auth'], redact: { paths: ['u'] }, callable: 'x', tasks: ['T', 5] } } })
    const st = JSON.parse(m.text).instrument.state
    expect(st).toEqual({ registrySections: ['auth'], redact: { paths: ['u'] }, callable: [], tasks: ['T'] })
  })

  it('keeps {src, dest} sourceGlobs entries and their key order', () => {
    const globs = ['manifest', { dest: 'x/', src: 'lib/**/*' }, 7]
    const m = merged({ ...base, sourceGlobs: globs, instrument: { strict: false, state: { registrySections: [] } } })
    expect(m.text).toContain('"dest": "x/",\n      "src": "lib/**/*"')
    expect(JSON.parse(m.text).sourceGlobs).toEqual(['manifest', { dest: 'x/', src: 'lib/**/*' }])
    const ok = merged({ ...base, sourceGlobs: globs.slice(0, 2), instrument: { strict: false, state: { registrySections: [] } } })
    expect(ok.r.stdout).toContain('brighttest.json: unchanged (valid)')
  })

  it('--dry-run without --brownfield exits 2 and writes nothing', () => {
    for (const args of [['init', '--dry-run'], ['init', '--greenfield', '--dry-run']]) {
      const d = scratch(null)
      try {
        const r = spawnSync(process.execPath, [cli, ...args], { cwd: d, encoding: 'utf8', timeout: 60000 })
        expect(r.status).toBe(2)
        expect(r.stderr).toContain('Usage: brighttest init --brownfield')
        expect(fs.existsSync(file(d))).toBe(false)
      } finally { fs.rmSync(d, { recursive: true, force: true }) }
    }
  })

  it('--brownfield --dry-run with no file says would create and writes nothing', () => {
    const d = scratch(null)
    try {
      const gi = fs.existsSync(path.join(d, '.gitignore')) ? fs.readFileSync(path.join(d, '.gitignore'), 'utf8') : null
      const r = run(d, ['--dry-run'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('would-create')
      expect(r.stdout).not.toMatch(/\bcreated\b/)
      expect(fs.existsSync(file(d))).toBe(false)
      expect(fs.existsSync(file(d) + '.bak')).toBe(false)
      expect(fs.existsSync(path.join(d, '.gitignore')) ? fs.readFileSync(path.join(d, '.gitignore'), 'utf8') : null).toBe(gi)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('gitignores brighttest.json.bak, idempotently', () => {
    const d = scratch(JSON.stringify({ rootDir: '.' }) + '\n')
    try {
      run(d)
      run(d)
      const lines = fs.readFileSync(path.join(d, '.gitignore'), 'utf8').split('\n')
      expect(lines.filter((l) => l === 'brighttest.json.bak')).toHaveLength(1)
      expect(lines).toContain('*.bt-instrumented.zip')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  it('keeps CRLF line endings and tab indentation', () => {
    const crlf = merged(JSON.stringify({ rootDir: '.' }, null, 4).replace(/\n/g, '\r\n') + '\r\n')
    expect(crlf.text).toMatch(/\r\n/)
    expect(crlf.text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(crlf.text.endsWith('}\r\n')).toBe(true)
    const tab = merged(JSON.stringify({ rootDir: '.' }, null, '\t') + '\n')
    expect(tab.text).toMatch(/\n\t"sourceGlobs"/)
    expect(tab.text).not.toContain('\r')
  })

  it('strict "true" becomes true and is listed', () => {
    const m = merged({ ...base, instrument: { strict: 'true', state: { registrySections: [] } } })
    expect(JSON.parse(m.text).instrument.strict).toBe(true)
    expect(m.r.stdout).toMatch(/changed instrument\.strict: "true" -> true/)
    expect(merged({ ...base, instrument: { strict: 'false', state: { registrySections: [] } } }).text).toContain('"strict": false')
  })

  it('prints the stable status lines', () => {
    const m = merged({ rootDir: '.' })
    expect(m.r.stdout).toMatch(/brighttest\.json: updated \(\d+ changes\)/)
    expect(m.r.stdout).toContain('brighttest.json.bak')
  })
})
