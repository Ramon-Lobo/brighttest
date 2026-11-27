import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `brighttest issue redact|check` through the real CLI, with the network disabled by a preload. The corpus is the
// generic synthetic one in test/fixtures/issue; seeded.json lists every planted value.
const ROOT = path.resolve(__dirname, '..')
const CLI = path.join(ROOT, 'bin', 'cli.js')
const PRELOAD = path.join(__dirname, 'support', 'no-network-preload.js')
const RAW = path.join(__dirname, 'fixtures', 'issue', 'raw')
const seeded = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'seeded.json'), 'utf8'))
const files = fs.readdirSync(RAW).sort()

let proj, home
beforeAll(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-issue-proj-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-issue-home-'))
  fs.mkdirSync(path.join(proj, '.brighttest'))
  fs.writeFileSync(path.join(proj, '.brighttest', 'issue-deny.txt'), '# generic deny terms\nExamplecorp\nSample Channel\n')
})
afterAll(() => { for (const d of [proj, home]) fs.rmSync(d, { recursive: true, force: true }) })

const bt = (args, input) => spawnSync(process.execPath, ['-r', PRELOAD, CLI, 'issue', ...args], {
  cwd: proj,
  input,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, BRIGHTTEST_CACHE: path.join(home, 'devices.json'), ROKU_PASSWORD: 'SEEDED-PASSWORD-0001' },
})
const both = (r) => r.stdout + r.stderr
const rawPaths = files.map((f) => path.join(RAW, f))

describe('issue check', () => {
  test('raw corpus: exit 1 and no seeded value in stdout or stderr', () => {
    const r = bt(['check', ...rawPaths])
    expect(r.status).toBe(1)
    for (const s of seeded) expect(both(r)).not.toContain(s.value)
    expect(r.stderr).toMatch(/ipv4/)
    expect(r.stderr).toMatch(/fingerprint: bt-[0-9a-f]{8}/)
  })
  test('raw corpus --json: leaks have file, line, kind and no value', () => {
    const r = bt(['check', '--json', ...rawPaths])
    expect(r.status).toBe(1)
    const j = JSON.parse(r.stdout)
    expect(j.leaks.length).toBeGreaterThan(0)
    for (const l of j.leaks) expect(Object.keys(l).sort()).toEqual(['file', 'kind', 'line'])
    expect(j.fingerprint).toMatch(/^bt-[0-9a-f]{8}$/)
    for (const s of seeded) expect(both(r)).not.toContain(s.value)
  })
  test('clean text exits 0 (stdin)', () => {
    const r = bt(['check', '-'], 'The build failed with exit code 3 in the verify step.\n')
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/fingerprint: bt-/)
  })
  test('stdin is the default input', () => {
    expect(bt(['check'], 'clean line\n').status).toBe(0)
    expect(bt(['check'], 'host 192.0.2.7 down\n').status).toBe(1)
  })
  test('structure warnings alone do not fail', () => {
    const r = bt(['check', '--json'], '### Summary\nIt broke.\n\n### Severity\nsevere\n\n### Actual behavior\n\n')
    expect(r.status).toBe(0)
    const j = JSON.parse(r.stdout)
    expect(j.warnings.join('\n')).toMatch(/missing required section: Environment/)
    expect(j.warnings.join('\n')).toMatch(/Actual behavior is empty/)
    expect(j.warnings.join('\n')).toMatch(/Severity is not one of/)
    expect(j.sections).toEqual(['Summary', 'Severity', 'Actual behavior'])
  })
  test('usage errors exit 2', () => {
    expect(bt([]).status).toBe(2)
    expect(bt(['bogus']).status).toBe(2)
    expect(bt(['check', '--nope']).status).toBe(2)
    expect(bt(['check', path.join(proj, 'missing.txt')]).status).toBe(2)
    expect(bt(['redact', '-o']).status).toBe(2)
  })
  test('--help exits 0', () => { expect(bt(['--help']).status).toBe(0) })
})

describe('issue redact', () => {
  test('one input: stdout is redacted, exit 0, no seeded value anywhere, and check on it is clean', () => {
    const f = path.join(RAW, 'log-tail.txt')
    const r = bt(['redact', f])
    expect(r.status).toBe(0)
    for (const s of seeded.filter((x) => x.file === 'log-tail.txt')) expect(both(r)).not.toContain(s.value)
    expect(bt(['check', '-'], r.stdout).status).toBe(0)
    expect(bt(['redact', '-'], r.stdout).stdout).toBe(r.stdout)
  })
  test('several inputs need -o; with -o a directory gets every file', () => {
    expect(bt(['redact', ...rawPaths]).status).toBe(2)
    const out = path.join(home, 'out')
    const r = bt(['redact', ...rawPaths, '-o', out])
    expect(r.status).toBe(0)
    expect(fs.readdirSync(out).sort()).toEqual(files)
    const all = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n')
    for (const s of seeded) expect(all + both(r)).not.toContain(s.value)
    expect(bt(['check', ...files.map((f) => path.join(out, f))]).status).toBe(0)
  })
  test('-o file for one input', () => {
    const out = path.join(home, 'one.txt')
    expect(bt(['redact', path.join(RAW, 'error.json'), '-o', out]).status).toBe(0)
    expect(fs.readFileSync(out, 'utf8')).not.toContain('SEEDED-PASSWORD-0001')
  })
})
