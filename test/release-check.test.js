import { describe, it, expect } from 'vitest'
const rc = require('../scripts/release-check.js')

describe('release-check', () => {
  const good = ['bin/cli.js', 'lib/a.js', 'lib/studio/public/index.html', 'skills/x/SKILL.md', 'package.json', 'README.md']
  it('accepts a clean file list', () => { expect(rc.validatePack(good)).toEqual([]) })
  it('rejects forbidden paths and missing parts (Windows separators too)', () => {
    expect(rc.validatePack([...good, 'test\\a.test.js', 'docs/x.md', 'scripts/y.js']).length).toBe(3)
    expect(rc.validatePack(good.filter((f) => !f.startsWith('lib/studio/public'))).join()).toMatch(/studio\/public\/index.html/)
    expect(rc.validatePack(good.filter((f) => !f.startsWith('skills/'))).join()).toMatch(/skills\//)
  })
  it('parses npm pack json', () => {
    expect(rc.parsePackJson(JSON.stringify([{ files: [{ path: 'a' }] }]))).toEqual(['a'])
    expect(() => rc.parsePackJson('[]')).toThrow()
  })
  it('picks next for prereleases and latest otherwise', () => {
    expect(rc.distTagFor('0.8.0-rc.1')).toBe('next')
    expect(rc.distTagFor('v1.0.0')).toBe('latest')
  })
  it('compares npm versions against 11.15.0', () => {
    expect(rc.npmAtLeast('11.15.0')).toBe(true)
    expect(rc.npmAtLeast('11.21.3')).toBe(true)
    expect(rc.npmAtLeast('12.0.0')).toBe(true)
    expect(rc.npmAtLeast('11.14.9')).toBe(false)
    expect(rc.npmAtLeast('10.9.8')).toBe(false)
    expect(rc.npmAtLeast('garbage')).toBe(false)
  })
  it('flags dependency ranges that do not resolve', () => {
    const view = (s) => (s.startsWith('a@') ? '1.0.0' : '')
    expect(rc.checkDeps({ a: '^1', b: '^2' }, view)).toEqual(['dependency b@^2 does not resolve on npm (publish it first)'])
    expect(rc.checkDeps({ a: '^1' }, view)).toEqual([])
  })
})

describe('changelog tooling on prerelease versions', () => {
  const { spawnSync } = require('node:child_process')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'changelog.js')
  const TEXT = '# Changelog\n\n## Unreleased {#unreleased}\n\n### Features\n- A thing.\n\n## v0.1.0 - 2026-01-01 {#v0-1-0}\n\n### Features\n- First.\n\n[Full diff](https://github.com/o/r/compare/v0.0.0...v0.1.0)\n'
  const run = (args, file) => spawnSync(process.execPath, [SCRIPT, ...args, '--file', file], { encoding: 'utf8' })
  it('stamp leaves the file alone, check needs no section, notes print Unreleased', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pre-'))
    const file = path.join(dir, 'changelog.md')
    fs.writeFileSync(file, TEXT)
    try {
      expect(run(['stamp', '--version', '0.2.0-rc.0'], file).status).toBe(0)
      expect(fs.readFileSync(file, 'utf8')).toBe(TEXT)
      expect(run(['check', '--version', '0.2.0-rc.0'], file).status).toBe(0)
      const n = run(['notes', 'v0.2.0-rc.0'], file)
      expect(n.status).toBe(0)
      expect(n.stdout).toMatch(/A thing/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('docs.yml changelog gate on a prerelease tag', () => {
  it('check --tags ignores prerelease tags (docs.yml stays green on v0.8.0-rc.0)', () => {
    const { check } = require('../scripts/changelog.js')
    const text = '# Changelog\n\n## Unreleased {#unreleased}\n\n## v0.1.0 - 2026-01-01 {#v0-1-0}\n\n### Features\n- First.\n\n[Full diff](https://github.com/o/r/compare/v0.0.0...v0.1.0)\n'
    const findings = check(text, { tags: ['v0.1.0', 'v0.2.0-rc.0'] })
    expect(findings.filter((f) => /rc/.test(f))).toEqual([])
    expect(findings.filter((f) => /tag/.test(f))).toEqual([])
  })
})
