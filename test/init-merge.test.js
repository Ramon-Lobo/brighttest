import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
