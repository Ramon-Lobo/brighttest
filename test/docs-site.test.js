import { describe, test, expect, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const ds = require('../scripts/docs-site')
const SCRIPT = path.resolve(__dirname, '../scripts/docs-site.js')
const made = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-test-')); made.push(d); return d }
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })

describe('plan', () => {
  const tags = ['v0.3.0', 'v0.6.0', 'v0.7.0', 'v0.7.2', 'v0.7.1', 'v0.8.0-rc.1', 'v0.9.0', 'foo', 'v1.0', 'v0.8.1']

  test('one entry per minor from its highest patch, floor applied, prereleases ignored', () => {
    const p = ds.plan(tags, { floor: '0.7', keep: 4 })
    expect(p.releases.map((r) => r.tag)).toEqual(['v0.9.0', 'v0.8.1', 'v0.7.2'])
    expect(p.latest).toBe('0.9')
  })

  test('latest at root and at its own path; others at vX.Y; next at /next/', () => {
    const p = ds.plan(tags, { floor: '0.7' }, '/brighttest/')
    const key = p.builds.map((b) => `${b.id}:${b.base}`)
    expect(key).toContain('0.9:/brighttest/')
    expect(key).toContain('0.9:/brighttest/v0.9/')
    expect(key).toContain('0.8:/brighttest/v0.8/')
    expect(key).toContain('next:/brighttest/next/')
    expect(p.releases[0]).toMatchObject({ path: '/brighttest/', alias: '/brighttest/v0.9/' })
    expect(p.next).toEqual({ ref: 'main', path: '/brighttest/next/' })
  })

  test('exclude and keep', () => {
    expect(ds.plan(tags, { floor: '0.7', exclude: ['0.9'] }).latest).toBe('0.8')
    expect(ds.plan(tags, { floor: '0.3', keep: 2 }).releases.map((r) => r.id)).toEqual(['0.9', '0.8'])
  })

  test('first slice: only v0.7.0 gives next + root + v0.7', () => {
    const p = ds.plan(['v0.3.0', 'v0.4.0', 'v0.5.0', 'v0.6.0', 'v0.7.0'], { floor: '0.7', exclude: [], keep: 4 })
    expect(p.builds.map((b) => b.base)).toEqual(['/brighttest/', '/brighttest/next/', '/brighttest/v0.7/'])
  })

  test('bad config values throw a named error', () => {
    expect(() => ds.plan(tags, { floor: 'abc' })).toThrow('invalid versions.config.json floor: "abc"')
    expect(() => ds.plan(tags, { exclude: ['0.8', 'zz'] })).toThrow('invalid versions.config.json exclude: "zz"')
    expect(() => ds.plan(tags, { keep: 0 })).toThrow(/invalid versions.config.json keep: 0/)
    expect(() => ds.plan(tags, { keep: 'x' })).toThrow(/invalid versions.config.json keep/)
    expect(() => ds.plan(tags, { keep: 1.5 })).toThrow(/invalid versions.config.json keep/)
  })

  test('no tags: no latest', () => {
    expect(ds.plan([], { floor: '0.7' }).latest).toBeNull()
  })

  test('base prefix is normalised', () => {
    expect(ds.plan(['v0.7.0'], {}, 'docs').basePrefix).toBe('/docs/')
  })
})

describe('versions.json', () => {
  const p = ds.plan(['v0.7.0', 'v0.6.0'], { floor: '0.6' })
  const okAll = p.builds.map((b) => ({ build: b, ok: true }))

  test('schema 1 shape', () => {
    const v = ds.versionsJson(p, okAll, { generated: 'T', nextSha: 'abc1234' })
    expect(v).toEqual({
      schema: 1,
      generated: 'T',
      latest: '0.7',
      versions: [
        { id: 'next', label: 'next (unreleased)', path: '/brighttest/next/', ref: 'main', sha: 'abc1234' },
        { id: '0.7', label: 'v0.7 (latest)', path: '/brighttest/', alias: '/brighttest/v0.7/', tag: 'v0.7.0' },
        { id: '0.6', label: 'v0.6', path: '/brighttest/v0.6/', tag: 'v0.6.0' },
      ],
      skipped: [],
    })
  })

  test('failed tag is skipped and reported; failure policy', () => {
    const res = p.builds.map((b) => (b.id === '0.6' ? { build: b, ok: false, error: 'boom' } : { build: b, ok: true }))
    const v = ds.versionsJson(p, res, { generated: 'T' })
    expect(v.versions.map((x) => x.id)).toEqual(['next', '0.7'])
    expect(v.skipped).toEqual([{ id: '0.6', ref: 'v0.6.0', reason: 'boom' }])
    expect(ds.fatalFailures(p, res)).toHaveLength(0)
    const bad = p.builds.map((b) => (b.id === '0.7' ? { build: b, ok: false, error: 'x' } : { build: b, ok: true }))
    expect(ds.fatalFailures(p, bad).length).toBeGreaterThan(0)
    const noNext = p.builds.map((b) => (b.id === 'next' ? { build: b, ok: false, error: 'x' } : { build: b, ok: true }))
    expect(ds.fatalFailures(p, noNext)).toHaveLength(1)
  })
})

describe('ordering and F1 guard', () => {
  test('root is ordered first', () => {
    const p = ds.plan(['v0.7.0', 'v0.6.0'], { floor: '0.6' })
    expect(ds.orderBuilds(p.builds)[0].rel).toBe('')
  })

  test('builds never target the output dir; each gets its own outDir', () => {
    const args = ds.buildArgs({ base: '/brighttest/' }, '/tmp/x/out-root')
    expect(args).toEqual(['build', 'docs', '--base', '/brighttest/', '--outDir', '/tmp/x/out-root'])
  })

  test('latest builds (root and its alias) get BRIGHTTEST_DOCS_LATEST=1, others do not', () => {
    const p = ds.plan(['v0.6.0', 'v0.7.0'], { floor: '0.6' })
    const env = (b) => ds.buildEnv(b, { BRIGHTTEST_DOCS_LATEST: 'stale', KEEP: 'y' })
    const by = (rel) => p.builds.find((b) => b.rel === rel)
    expect(env(by('')).BRIGHTTEST_DOCS_LATEST).toBe('1')
    expect(env(by('v0.7')).BRIGHTTEST_DOCS_LATEST).toBe('1')
    expect(env(by('v0.6'))).not.toHaveProperty('BRIGHTTEST_DOCS_LATEST')
    expect(env(by('next'))).not.toHaveProperty('BRIGHTTEST_DOCS_LATEST')
    expect(env(by('next')).BRIGHTTEST_DOCS_CHANNEL).toBe('next')
    expect(env(by('v0.6')).BRIGHTTEST_DOCS_CHANNEL).toBe('release')
    expect(env(by('')).KEEP).toBe('y')
  })

  test('assembling root cannot clobber other versions, whatever the input order', () => {
    const mk = (name, rel) => {
      const d = tmp()
      fs.writeFileSync(path.join(d, 'index.html'), name)
      return { build: { rel }, dir: d }
    }
    const items = [mk('next', 'next'), mk('v07', 'v0.7'), mk('root', '')]
    const out = path.join(tmp(), 'site')
    ds.assemble(out, items)
    expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toBe('root')
    expect(fs.readFileSync(path.join(out, 'next', 'index.html'), 'utf8')).toBe('next')
    expect(fs.readFileSync(path.join(out, 'v0.7', 'index.html'), 'utf8')).toBe('v07')
  })

  test('a root build that already contains next/ cannot be silently overwritten', () => {
    const root = tmp(); fs.mkdirSync(path.join(root, 'next')); fs.writeFileSync(path.join(root, 'next', 'index.html'), 'x')
    const nxt = tmp(); fs.writeFileSync(path.join(nxt, 'index.html'), 'n')
    const items = [{ build: { rel: 'next' }, dir: nxt }, { build: { rel: '' }, dir: root }]
    expect(() => ds.assemble(path.join(tmp(), 's'), items)).toThrow(/refusing to overwrite/)
  })

  test('refuses to overwrite a path already placed', () => {
    const d = tmp()
    expect(() => ds.assemble(path.join(tmp(), 's'), [{ build: { rel: 'next' }, dir: d }, { build: { rel: 'next' }, dir: d }])).toThrow(/refusing/)
  })
})

describe('changelog overlay rule', () => {
  test('v0.7.0 and older, or a tag without its own changelog', () => {
    expect(ds.needsChangelogOverlay('v0.7.0', true)).toBe(true)
    expect(ds.needsChangelogOverlay('v0.3.0', true)).toBe(true)
    expect(ds.needsChangelogOverlay('v0.7.1', true)).toBe(false)
    expect(ds.needsChangelogOverlay('v0.8.0', true)).toBe(false)
    expect(ds.needsChangelogOverlay('v0.8.0', false)).toBe(true)
    expect(ds.needsChangelogOverlay('junk', false)).toBe(false)
  })
})

describe('version switcher and banner', () => {
  const theme = path.resolve(__dirname, '../docs/.vitepress/theme')
  const sw = fs.readFileSync(path.join(theme, 'VersionSwitcher.vue'), 'utf8')
  const bn = fs.readFileSync(path.join(theme, 'VersionBanner.vue'), 'utf8')
  test('every build gets a fixed Changelog item linking its own base', () => {
    expect(sw).toMatch(/<a :href="site\.base \+ 'changelog'">Changelog<\/a>/)
    expect(sw).toContain('data-testid="version-changelog"')
  })
  test('next banner links to its changelog when Unreleased has entries, else the compare', () => {
    expect(bn).toContain('`${current.value.path}changelog#unreleased`')
    expect(bn).toMatch(/cfg\?\.unreleased && current\.value/)
    expect(bn).toContain('return compareUrl.value')
    expect(bn).toContain(':href="changesUrl"')
  })
})

describe('summary and base', () => {
  test('failure text is escaped in the table; skipped reason is one line without temp paths', () => {
    const p = ds.plan(['v0.7.0'], {})
    const err = 'vitepress failed in /tmp/docs-site-abc/wt-v0.7.0 | x\nsecond | line'
    const res = p.builds.map((b) => ({ build: b, ok: false, error: err }))
    const md = ds.summaryMarkdown(p, res)
    for (const l of md.split('\n').filter((x) => x.startsWith('| next'))) {
      expect(l).toContain('\\| x second \\| line')
      expect(l.split(/(?<!\\)\|/)).toHaveLength(6)
    }
    const v = ds.versionsJson(p, res, { generated: 'T' })
    expect(v.skipped[0].reason).not.toMatch(/docs-site-|\n/)
    expect(v.skipped[0].reason).toContain('<tmp>')
  })
  test('markdown lists each build', () => {
    const p = ds.plan(['v0.7.0'], {})
    const md = ds.summaryMarkdown(p)
    expect(md).toContain('| next |')
    expect(md).toContain('`/brighttest/v0.7/`')
  })
  test('base prefix from env wins', () => {
    expect(ds.defaultBase('/nonexistent', { BRIGHTTEST_DOCS_BASE: '/x/' })).toBe('/x/')
    expect(ds.defaultBase('/nonexistent', {})).toBe('/brighttest/')
  })
})

// A tiny git repo with a fake vitepress that, like the real one, empties --outDir first.
// POSIX only: shebang scripts, signals and a fake `npm` on PATH.
describe.skipIf(process.platform === 'win32')('real script path on a fixture repo', () => {
  const git = (cwd, ...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout
  }
  const CHANGELOG = [
    '# Changelog', '', 'Intro.', '',
    '## Unreleased {#unreleased}', '', '- new thing [new page](./guide-new.md)', '',
    '## v0.7.0 - 2026-01-02 {#v0-7-0}', '', '- seven [old page](./index.md) and [new page](./guide-new.md)', '',
    '## v0.6.0 - 2026-01-01 {#v0-6-0}', '', '- six', '',
  ].join('\n')
  function fixture({ breakTag } = {}) {
    const repo = tmp()
    git(repo, 'init', '-q', '-b', 'main')
    fs.mkdirSync(path.join(repo, 'docs/.vitepress/theme'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'docs/.vitepress/versions.config.json'), JSON.stringify({ floor: '0.6', keep: 4 }))
    fs.writeFileSync(path.join(repo, 'docs/index.md'), 'v1')
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'one')
    git(repo, 'tag', 'v0.6.0')
    fs.writeFileSync(path.join(repo, 'docs/index.md'), breakTag ? 'BREAK' : 'v2')
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'two')
    git(repo, 'tag', 'v0.7.0')
    fs.writeFileSync(path.join(repo, 'docs/.vitepress/theme/index.ts'), 'export default {}')
    fs.writeFileSync(path.join(repo, 'docs/guide-new.md'), 'x')
    fs.writeFileSync(path.join(repo, 'docs/changelog.md'), CHANGELOG)
    fs.writeFileSync(path.join(repo, 'docs/index.md'), 'main')
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'three')
    const bin = path.join(tmp(), 'vp.js')
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const a = process.argv, base = a[a.indexOf('--base') + 1], out = a[a.indexOf('--outDir') + 1]
const md = fs.readFileSync('docs/index.md', 'utf8')
if (md === 'BREAK') { console.error('boom'); process.exit(1) }
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true })
const theme = fs.existsSync('docs/.vitepress/theme/index.ts')
if (fs.existsSync('docs/changelog.md')) fs.writeFileSync(path.join(out, 'changelog.txt'), fs.readFileSync('docs/changelog.md', 'utf8'))
fs.writeFileSync(path.join(out, 'latest.txt'), String(process.env.BRIGHTTEST_DOCS_LATEST))
fs.writeFileSync(path.join(out, 'index.html'), [md, base, process.env.BRIGHTTEST_DOCS_CHANNEL, 'theme=' + theme].join('|'))
`)
    fs.chmodSync(bin, 0o755)
    return { repo, bin }
  }
  const runScript = (repo, bin, out, extra = []) =>
    spawnSync('node', [SCRIPT, 'build', '--repo', repo, '--out', out, '--no-install', '--vitepress-bin', bin, '--next-ref', 'main', ...extra], { encoding: 'utf8' })
  const read = (...p) => fs.readFileSync(path.join(...p), 'utf8')

  test('builds root, alias, older minor and next without clobbering; versions.json last; worktrees removed', () => {
    const { repo, bin } = fixture()
    const out = path.join(tmp(), 'site')
    const r = runScript(repo, bin, out)
    expect(r.status).toBe(0)
    expect(read(out, 'index.html')).toBe('v2|/brighttest/|release|theme=true')
    expect(read(out, 'v0.7/index.html')).toBe('v2|/brighttest/v0.7/|release|theme=true')
    expect(read(out, 'v0.6/index.html')).toBe('v1|/brighttest/v0.6/|release|theme=true')
    expect(read(out, 'next/index.html')).toBe('main|/brighttest/next/|next|theme=true')
    expect(read(out, 'latest.txt')).toBe('1')
    expect(read(out, 'v0.7/latest.txt')).toBe('1')
    expect(read(out, 'v0.6/latest.txt')).toBe('undefined')
    expect(read(out, 'next/latest.txt')).toBe('undefined')
    const v = JSON.parse(read(out, 'versions.json'))
    expect(v.versions.map((x) => x.id)).toEqual(['next', '0.7', '0.6'])
    expect(v.skipped).toEqual([])
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  test('old tags get a changelog sliced to the tag, dead links become text; main keeps its own', () => {
    const { repo, bin } = fixture()
    const out = path.join(tmp(), 'site')
    const r = runScript(repo, bin, out)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('overlaid changelog on v0.7.0')
    expect(r.stderr).toContain('overlaid changelog on v0.6.0')
    const v07 = read(out, 'v0.7/changelog.txt')
    expect(v07).toContain('## v0.7.0')
    expect(v07).toContain('## v0.6.0')
    expect(v07).not.toContain('Unreleased')
    expect(v07).toContain('[old page](./index.md)')
    expect(v07).toMatch(/and new page(?!\()/)
    expect(v07).not.toContain('guide-new.md')
    const v06 = read(out, 'v0.6/changelog.txt')
    expect(v06).toContain('## v0.6.0')
    expect(v06).not.toContain('## v0.7.0')
    expect(read(out, 'changelog.txt')).toBe(v07)
    expect(read(out, 'next/changelog.txt')).toBe(CHANGELOG)
  })

  test('a broken older tag is skipped, exit 0; a broken latest fails', () => {
    const ok = fixture()
    // break v0.6 only: rewrite its tag content
    git(ok.repo, 'checkout', '-q', 'v0.6.0')
    fs.writeFileSync(path.join(ok.repo, 'docs/index.md'), 'BREAK')
    git(ok.repo, 'commit', '-qam', 'break'); git(ok.repo, 'tag', '-f', 'v0.6.0'); git(ok.repo, 'checkout', '-q', 'main')
    const out = path.join(tmp(), 'site')
    const r = runScript(ok.repo, ok.bin, out)
    expect(r.status).toBe(0)
    const v = JSON.parse(read(out, 'versions.json'))
    expect(v.skipped.map((s) => s.id)).toEqual(['0.6'])
    expect(fs.existsSync(path.join(out, 'v0.6'))).toBe(false)

    const bad = fixture({ breakTag: true })
    const r2 = runScript(bad.repo, bad.bin, path.join(tmp(), 'site'))
    expect(r2.status).toBe(1)
    expect(git(bad.repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  test('--only and --dry-run', () => {
    const { repo, bin } = fixture()
    const out = path.join(tmp(), 'site')
    expect(runScript(repo, bin, out, ['--dry-run']).status).toBe(0)
    expect(fs.existsSync(out)).toBe(false)
    expect(runScript(repo, bin, out, ['--only', 'next']).status).toBe(0)
    expect(fs.readdirSync(out).sort()).toEqual(['next', 'versions.json'])
  })

  test('missing theme overlay only warns', () => {
    const { repo, bin } = fixture()
    git(repo, 'rm', '-rq', 'docs/.vitepress/theme'); git(repo, 'commit', '-qm', 'rm theme')
    const r = runScript(repo, bin, path.join(tmp(), 'site'))
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/no theme overlay/)
  })

  test('without --no-install: tags get ci --ignore-scripts, next gets plain ci', () => {
    const { repo, bin } = fixture()
    const dir = tmp()
    const log = path.join(dir, 'npm.log')
    const npm = path.join(dir, 'npm')
    fs.writeFileSync(npm, `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), wt: path.basename(process.cwd()) }) + '\\n')
fs.mkdirSync('node_modules/.bin', { recursive: true })
fs.copyFileSync(${JSON.stringify(bin)}, 'node_modules/.bin/vitepress'); fs.chmodSync('node_modules/.bin/vitepress', 0o755)
`)
    fs.chmodSync(npm, 0o755)
    const out = path.join(tmp(), 'site')
    const r = spawnSync('node', [SCRIPT, 'build', '--repo', repo, '--out', out, '--next-ref', 'main'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    })
    expect(r.status).toBe(0)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const by = Object.fromEntries(calls.map((c) => [c.wt, c.argv]))
    expect(by['wt-v0.7.0']).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    expect(by['wt-v0.6.0']).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    expect(by['wt-next']).toEqual(['ci', '--no-audit', '--no-fund'])
    expect(r.stderr).toContain('next: building main')
  })

  test('rejects a --next-ref that looks like an option', () => {
    const { repo, bin } = fixture()
    const r = runScript(repo, bin, path.join(tmp(), 'site'), ['--next-ref', '--evil'])
    expect(r.status).not.toBe(0)
  })

  test('SIGTERM kills the running build child and removes the temp root', async () => {
    const { repo } = fixture()
    const work = tmp()
    const pidFile = path.join(work, 'pid')
    const bin = path.join(work, 'sleepy.js')
    fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
setTimeout(() => {}, 60000)
`)
    fs.chmodSync(bin, 0o755)
    const tmpdir = tmp()
    const child = spawn('node', [SCRIPT, 'build', '--repo', repo, '--out', path.join(work, 'site'), '--no-install', '--vitepress-bin', bin, '--next-ref', 'main'], {
      env: { ...process.env, TMPDIR: tmpdir }, stdio: 'ignore',
    })
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
    const deadline = Date.now() + 15000
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(pidFile)).toBe(true)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    child.kill('SIGTERM')
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))])
    if (code === 'timeout') child.kill('SIGKILL')
    expect(code).toBe(143)
    expect(fs.readdirSync(tmpdir).filter((n) => n.startsWith('docs-site-'))).toEqual([])
    expect(() => process.kill(pid, 0)).toThrow()
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
  }, 30000)

  test('plan subcommand prints JSON and writes the step summary', () => {
    const { repo } = fixture()
    const sum = path.join(tmp(), 'sum.md')
    const r = spawnSync('node', [SCRIPT, 'plan', '--repo', repo], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: sum } })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).latest).toBe('0.7')
    expect(fs.readFileSync(sum, 'utf8')).toContain('Docs site build plan')
  })
})

// Two-tier docs (ADR 0061): the pure helpers behind the version switcher, 404 body, badge lookup and tier link.
describe('two-tier version mapping', async () => {
  const vc = await import('../docs/.vitepress/theme/versionContext.ts')

  test('a full/ page tries itself, then the plain page (versions without a full tier)', () => {
    expect(vc.switchCandidates('full/guide/studio')).toEqual(['full/guide/studio', 'guide/studio'])
    expect(vc.switchCandidates('full/')).toEqual(['full/', ''])
    expect(vc.switchCandidates('/full/guide/studio')).toEqual(['full/guide/studio', 'guide/studio'])
  })

  test('a plain or look-alike page has one candidate', () => {
    expect(vc.switchCandidates('guide/studio')).toEqual(['guide/studio'])
    expect(vc.switchCandidates('fullness/guide')).toEqual(['fullness/guide'])
    expect(vc.switchCandidates('')).toEqual([''])
  })

  test('stripFull', () => {
    expect(vc.stripFull('full/guide/mcp.md')).toBe('guide/mcp.md')
    expect(vc.stripFull('guide/mcp.md')).toBe('guide/mcp.md')
  })

  test('tierLink: lite page -> full, full page -> lite, nothing when untiered or no tiers', () => {
    const tiered = ['guide/studio.md', 'index.md', 'e2e/index.md']
    expect(vc.tierLink('guide/studio.md', tiered)).toEqual({ kind: 'to-full', path: 'full/guide/studio' })
    expect(vc.tierLink('full/guide/studio.md', tiered)).toEqual({ kind: 'to-lite', path: 'guide/studio' })
    expect(vc.tierLink('index.md', tiered)).toEqual({ kind: 'to-full', path: 'full/' })
    expect(vc.tierLink('full/e2e/index.md', tiered)).toEqual({ kind: 'to-lite', path: 'e2e/' })
    expect(vc.tierLink('changelog.md', tiered)).toBeNull()
    expect(vc.tierLink('guide/studio.md', undefined)).toBeNull()
    expect(vc.tierLink('guide/studio.md', [])).toBeNull()
  })
})
