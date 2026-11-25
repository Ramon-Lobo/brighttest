import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'changelog.js')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const EMPTY = `# Changelog

## Unreleased {#unreleased}

## v0.1.0 - 2026-01-01 {#v0-1-0}

### Features

- First release.

[Full diff](https://github.com/o/r/compare/v0.0.0...v0.1.0)
`
const FILLED = EMPTY.replace('## Unreleased {#unreleased}\n', '## Unreleased {#unreleased}\n\n### Features\n\n- A new thing.\n')

let dir, file
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-clrel-')); file = path.join(dir, 'changelog.md') })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// Windows env names are case-insensitive: drop every case variant before setting ours so the outer npm run's value cannot win.
const run = (args, env = {}) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'npm_package_version'))
  return spawnSync(process.execPath, [SCRIPT, ...args, '--file', file], { encoding: 'utf8', env: { ...base, npm_package_version: '', ...env } })
}

describe('changelog release gate', () => {
  it('stamp refuses an empty Unreleased and leaves the file alone', () => {
    fs.writeFileSync(file, EMPTY)
    const r = run(['stamp', '--version', '0.2.0'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no entries/)
    expect(fs.readFileSync(file, 'utf8')).toBe(EMPTY)
  })

  it('stamp writes the version heading and a fresh empty Unreleased', () => {
    fs.writeFileSync(file, FILLED)
    const r = run(['stamp', '--version', '0.2.0', '--date', '2026-02-03', '--no-pages'])
    expect(r.status).toBe(0)
    const t = fs.readFileSync(file, 'utf8')
    expect(t).toMatch(/^## Unreleased \{#unreleased\}\n\n## v0\.2\.0 - 2026-02-03 \{#v0-2-0\}\n/m)
    expect(t).toContain('- A new thing.')
    expect(run(['check', '--version', '0.2.0']).status).toBe(0)
  })

  it('stamp reads npm_package_version when --version is missing (no-shell-variable form)', () => {
    fs.writeFileSync(file, FILLED)
    const r = run(['stamp', '--date', '2026-02-03', '--no-pages'], { npm_package_version: '0.3.0' })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toContain('## v0.3.0 - 2026-02-03 {#v0-3-0}')
  })

  it('check --version passes when the section exists', () => {
    fs.writeFileSync(file, EMPTY)
    expect(run(['check', '--version', '0.1.0']).status).toBe(0)
  })

  it('check --version fails when the section is missing', () => {
    fs.writeFileSync(file, EMPTY)
    const r = run(['check', '--version', '0.9.0'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no section for v0\.9\.0/)
  })

  it('check --version fails when the section has no entries', () => {
    fs.writeFileSync(file, EMPTY.replace('- First release.', ''))
    const r = run(['check', '--version', '0.1.0'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/has no entries/)
  })

  it('check --version-env reads npm_package_version', () => {
    fs.writeFileSync(file, EMPTY)
    expect(run(['check', '--version-env'], { npm_package_version: '0.1.0' }).status).toBe(0)
    const bad = run(['check', '--version-env'], { npm_package_version: '0.9.0' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/no section for v0\.9\.0/)
  })

  it('check --version-env without npm_package_version is a usage error', () => {
    fs.writeFileSync(file, EMPTY)
    expect(run(['check', '--version-env']).status).toBe(2)
  })

  it('package.json carries the two lifecycle scripts', () => {
    expect(pkg.scripts.version).toBe('node scripts/changelog.js stamp && git add docs/changelog.md docs/.vitepress/release-pages.json')
    expect(pkg.scripts.prepublishOnly).toBe('node scripts/changelog.js check --version-env')
  })

  it('the version script uses the no-shell-variable form', () => {
    expect(pkg.scripts.version).not.toMatch(/\$|%/)
  })
})
