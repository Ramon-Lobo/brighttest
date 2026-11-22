import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const script = path.resolve(__dirname, '../scripts/check-denylist.js')
let tmp, repo, list, firstCommit, emptyFile

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const git = (...a) => sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], repo)

function check(args, env = {}, cwd = repo) {
  const e = { ...process.env, HOME: tmp, USERPROFILE: tmp, BRIGHTTEST_DENYLIST: '', ...env }
  if (!e.BRIGHTTEST_DENYLIST) delete e.BRIGHTTEST_DENYLIST
  const r = spawnSync('node', [script, ...args], { cwd, env: e, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-'))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  list = path.join(tmp, 'denylist.txt')
  fs.writeFileSync(list, '# made-up terms\nzzplanted\nqqmarker\n')
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello zzplanted world\nclean line\n')
  fs.writeFileSync(path.join(repo, 'lock.json'), `{"integrity":"sha512-A1/zzplanted/${'B2c3'.repeat(12)}=="}\n`)
  fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('zzplanted')]))
  git('add', '.')
  git('commit', '-q', '-m', 'feat: add zzplanted support')
  firstCommit = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'b.md'), 'QqMarker here\n')
  git('add', 'b.md')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('check-denylist configuration (fails closed)', () => {
  it('exits 2 when no list is configured', () => {
    const r = check([])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/not configured/)
  })
  it('--allow-missing exits 0 with a warning', () => {
    const r = check(['--allow-missing'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/not configured/)
  })
  it('exits 2 when the list is tracked by git', () => {
    fs.writeFileSync(path.join(repo, 'tracked-list.txt'), 'zzplanted\n')
    git('add', 'tracked-list.txt')
    const r = check([], { BRIGHTTEST_DENYLIST: path.join(repo, 'tracked-list.txt') })
    git('rm', '-q', '--cached', 'tracked-list.txt')
    fs.rmSync(path.join(repo, 'tracked-list.txt'))
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/outside the repository/)
  })
  it('exits 2 when the list is empty or only comments', () => {
    const f = path.join(tmp, 'empty.txt')
    fs.writeFileSync(f, '\n# nothing\n')
    const r = check([], { BRIGHTTEST_DENYLIST: f })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/empty/)
  })
  it('exits 2 on an unknown option', () => {
    expect(check(['--bogus'], { BRIGHTTEST_DENYLIST: list }).code).toBe(2)
  })
})

describe('check-denylist scanning', () => {
  const env = () => ({ BRIGHTTEST_DENYLIST: list })

  it('tracked mode: masked file:line, never the term, hash-like ignored, binary skipped', () => {
    const r = check([], env())
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/a\.txt:1 {2}file {2}z{1}\*{7}d/)
    expect(r.all.toLowerCase()).not.toContain('zzplanted')
    expect(r.out).not.toMatch(/lock\.json:\d+ {2}file/)
    expect(r.out).toMatch(/ignored \(hash-like\): 1/)
    expect(r.out).toMatch(/skipped \(binary\/unreadable\): 1/)
  })

  it('--json reports the documented shape', () => {
    const j = JSON.parse(check(['--json'], env()).out)
    expect(j).toMatchObject({ ok: false, mode: 'tracked', termsLoaded: 2 })
    expect(j.hits[0]).toEqual({ kind: 'file', file: 'a.txt', line: 1, commit: null, masked: 'z*******d' })
    expect(j.hits.map((h) => h.file)).toEqual(['a.txt', 'b.md']) // b.md is staged, so tracked
    expect(j.ignored).toEqual([{ file: 'lock.json', line: 1, reason: 'hash-like' }])
    expect(j.skipped).toEqual(['img.bin'])
  })

  it('--staged scans added lines, case-insensitively', () => {
    const r = check(['--staged'], env())
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/b\.md:1 {2}diff {2}q\*{6}r/)
    expect(r.all.toLowerCase()).not.toContain('qqmarker')
  })

  it('--range reports commit-message hits with the short hash, and diff hits', () => {
    git('commit', '-q', '-m', 'docs: add note')
    const r = check(['--range', `${firstCommit}..HEAD`, '--json'], env())
    const j = JSON.parse(r.out)
    expect(j.hits.some((h) => h.kind === 'diff' && h.file === 'b.md')).toBe(true)
    const rootRange = JSON.parse(check(['--range', `${git('rev-list', '--max-parents=0', 'HEAD')}..HEAD`, '--json'], env()).out)
    expect(rootRange.hits.every((h) => h.kind !== 'message')).toBe(true)
    // the first commit message is only in range when the range starts before it
    emptyFile = path.join(tmp, 'empty-input')
    fs.writeFileSync(emptyFile, '')
    const empty = git('hash-object', '-t', 'tree', emptyFile)
    const full = JSON.parse(check(['--range', `${empty}..HEAD`, '--json'], env()).out)
    expect(full.hits.find((h) => h.kind === 'message')).toMatchObject({ commit: firstCommit.slice(0, 10), masked: 'z*******d' })
  })

  it('--path and positional args scan arbitrary directories', () => {
    const d = path.join(tmp, 'scratch')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'r.md'), 'see ZZPlanted.\n')
    const r = check(['--path', d], env())
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/r\.md:1/)
    expect(check([d], env()).code).toBe(1)
    expect(check(['--path', path.join(tmp, 'nope')], env()).code).toBe(2)
  })

  it('does not match a term embedded in a longer word', () => {
    const d = path.join(tmp, 'embedded')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'e.txt'), 'xzzplantedy and zzplanteds\n')
    const r = check([d], env())
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/clean/)
  })

  it('exits 0 with a one-line summary on a clean tree', () => {
    const d = path.join(tmp, 'clean')
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'c.txt'), 'nothing here\n')
    const r = check([d], env())
    expect(r.code).toBe(0)
    expect(r.out.trim().split('\n')).toHaveLength(1)
  })
})
