import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cl = require('../scripts/changelog.js')

const RS = '\x1e', US = '\x1f'
function logOf(commits) {
  return commits.map((c) => `${RS}${c.hash}${US}${c.subject}${US}${c.body || ''}${US}\n\n${(c.files || []).join('\n')}\n`).join('')
}
// Mock runner: log text, set of files that exist at the from ref, package.json at refs, gh behaviour.
function mockRun({ log = '', exists = [], pkgs = {}, gh = 'ok', prs = {}, tags = '', remote = 'https://github.com/o/r.git' } = {}) {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: log }
    if (cmd === 'git' && args[0] === 'cat-file') return { status: exists.includes(args[2].split(':').slice(1).join(':')) ? 0 : 1, stdout: '' }
    if (cmd === 'git' && args[0] === 'show') {
      const p = pkgs[args[1].split(':')[0]]
      return p ? { status: 0, stdout: JSON.stringify(p) } : { status: 1, stdout: '' }
    }
    if (cmd === 'git' && args[0] === 'tag') return { status: 0, stdout: tags }
    if (cmd === 'git' && args[0] === 'remote') return { status: 0, stdout: remote }
    if (cmd === 'gh' && args[0] === 'auth') return { status: gh === 'ok' ? 0 : (gh === 'noauth' ? 1 : null), stdout: '' }
    if (cmd === 'gh' && args[0] === 'api') {
      const sha = args[1].split('/')[4]
      return { status: 0, stdout: prs[sha] ? `${prs[sha]}\n` : '' }
    }
    return { status: 1, stdout: '' }
  }
  run.calls = calls
  return run
}
const draft = (run, opts = {}) => cl.draft(Object.assign({ from: 'v0.1.0', to: 'HEAD' }, opts), run, '.').text

describe('draft: dropping and mapping', () => {
  it('drops by type and internal scope, keeps breaking refactors', () => {
    const log = logOf([
      { hash: 'a1', subject: 'docs(skills): reword', files: ['skills/a.md'] },
      { hash: 'a2', subject: 'chore: bump', files: ['x.js'] },
      { hash: 'a3', subject: 'feat(agents): internal thing', files: ['x.js'] },
      { hash: 'a4', subject: 'feat(deps): dependabot', files: ['package.json'] },
      { hash: 'a5', subject: 'refactor(cli): rework', body: 'BREAKING CHANGE: flag removed', files: ['lib/a.js'] },
      { hash: 'a6', subject: 'feat(cli): add thing', files: ['lib/b.js'] },
    ])
    const t = draft(mockRun({ log }))
    expect(t).not.toMatch(/reword|bump|internal thing|dependabot/)
    expect(t).toMatch(/### Breaking changes\n- \*\*CLI and lanes:\*\* Rework/)
    expect(t).toMatch(/### Features\n- \*\*CLI and lanes:\*\* Add thing/)
  })

  it('maps scopes to areas and unknown scope to Other', () => {
    expect(cl.areaOf('perfetto')).toBe('Studio')
    expect(cl.areaOf('hub')).toBe('Instrumentation and app state')
    expect(cl.areaOf('net')).toBe('Network faults')
    expect(cl.areaOf('ecp')).toBe('E2E')
    expect(cl.areaOf('greenfield')).toBe('Adoption (assess, init, skills)')
    expect(cl.areaOf('mcp')).toBe('Agent surface (MCP)')
    expect(cl.areaOf('doctor')).toBe('Devices and lease')
    expect(cl.areaOf('pkg')).toBe('CLI and lanes')
    expect(cl.areaOf('whatever')).toBe('Other')
    expect(cl.areaOf('')).toBe('Other')
  })

  it('maps type to section: feat, perf, fix, bang', () => {
    const log = logOf([
      { hash: 'b1', subject: 'feat(e2e): new step', files: ['lib/e2e/a.js'] },
      { hash: 'b2', subject: 'perf(studio): faster tree', files: ['lib/studio/a.js'] },
      { hash: 'b3', subject: 'fix(e2e): focus bug', files: ['lib/e2e/a.js'] },
      { hash: 'b4', subject: 'feat(cli)!: drop flag', files: ['lib/c.js'] },
    ])
    const t = draft(mockRun({ log, exists: ['lib/e2e/a.js', 'lib/studio/a.js'] }))
    expect(t).toMatch(/### Breaking changes\n- \*\*CLI and lanes:\*\* Drop flag/)
    expect(t).toMatch(/### Features\n- \*\*E2E:\*\* New step/)
    expect(t).toMatch(/### Improvements\n- \*\*Studio:\*\* Faster tree/)
    expect(t).toMatch(/### Fixes\n- \*\*E2E:\*\* Focus bug/)
  })

  it('drops fixes whose non-test files did not exist at from', () => {
    const log = logOf([
      { hash: 'c1', subject: 'fix(e2e): old bug', files: ['lib/old.js', 'test/old.test.js'] },
      { hash: 'c2', subject: 'fix(e2e): new code bug', files: ['lib/new.js'] },
      { hash: 'c3', subject: 'fix(e2e): only tests', files: ['test/x.test.js'] },
    ])
    const run = mockRun({ log, exists: ['lib/old.js'] })
    const t = draft(run)
    expect(t).toMatch(/- \*\*E2E:\*\* Old bug/)
    expect(t).not.toMatch(/- \*\*E2E:\*\* New code bug/)
    expect(t).toMatch(/internal fixes \(dropped\)[^\n]*2 commits[\s\S]*fix\(e2e\): new code bug/)
    expect(run.calls).toContainEqual(['git', 'cat-file', '-e', 'v0.1.0:lib/old.js'])
  })

  it('pre-sorts security-looking fixes', () => {
    const log = logOf([
      { hash: 'd1', subject: 'fix(studio): mask redacted paths in traces', files: ['lib/s.js'] },
      { hash: 'd2', subject: 'fix(studio): reject cross-origin requests', files: ['lib/s2.js'] },
      { hash: 'd3', subject: 'fix(studio): plain bug', files: ['lib/s3.js'] },
    ])
    const t = draft(mockRun({ log, exists: ['lib/s.js', 'lib/s2.js', 'lib/s3.js'] }))
    const sec = /### Security candidates\n[^\n]*\n([\s\S]*?)\n\n/.exec(t)[1]
    expect(sec).toMatch(/Mask redacted paths/)
    expect(sec).toMatch(/cross-origin/)
    expect(sec).not.toMatch(/Plain bug/)
    expect(t).toMatch(/### Fixes\n- \*\*Studio:\*\* Plain bug/)
  })
})

describe('draft: series, scrub, deps, prs', () => {
  it('folds a series by phrase and by single file, keeping subjects in a comment', () => {
    const log = logOf([
      { hash: 'e1', subject: 'feat(studio): capture reliability part one', files: ['lib/a.js'] },
      { hash: 'e2', subject: 'feat(studio): capture reliability part two', files: ['lib/b.js'] },
      { hash: 'e3', subject: 'feat(studio): unrelated words here', files: ['lib/c.js'] },
      { hash: 'e4', subject: 'feat(studio): another thing', files: ['lib/c.js'] },
      { hash: 'e5', subject: 'feat(studio): lone', files: ['lib/d.js', 'lib/e.js'] },
    ])
    const t = draft(mockRun({ log }))
    expect(t).toMatch(/Capture reliability part one \(2 related changes\)\n  <!-- series: feat\(studio\): capture reliability part one \| feat\(studio\): capture reliability part two -->/)
    expect(t).toMatch(/Unrelated words here \(2 related changes\)/)
    expect(t).toMatch(/- \*\*Studio:\*\* Lone\n/)
  })

  it('scrubs ticket-like tokens and review-fix suffixes', () => {
    expect(cl.scrub('BUG-12: handle focus (review fixes)')).toBe('Handle focus')
    expect(cl.scrub('add steps (T3) for flows')).toBe('Add steps for flows')
    expect(cl.scrub('Phase 3a startup gate')).toBe('Startup gate')
    expect(cl.scrub('support CAP-X12 engine')).toBe('Support engine')
    expect(cl.scrub('plain words')).toBe('Plain words')
  })

  it('writes dependency and engine lines', () => {
    const lines = cl.depLines(
      { dependencies: { a: '^1', '@ramonlobo/brs-node': '^2.1.0', gone: '1' }, engines: { node: '>=20' } },
      { dependencies: { a: '^1', '@ramonlobo/brs-node': '^2.2.0', fresh: '3' }, engines: { node: '>=22' } },
    )
    expect(lines.improvements).toContain('**Dependencies:** Engine fork @ramonlobo/brs-node updated to ^2.2.0 (was ^2.1.0)')
    expect(lines.improvements).toContain('**Dependencies:** fresh added at 3')
    expect(lines.improvements).toContain('**Dependencies:** gone removed')
    expect(lines.breaking[0]).toMatch(/minimum Node\.js is now >=22 \(was >=20\)/)
    const t = draft(mockRun({
      log: logOf([]),
      pkgs: { 'v0.1.0': { engines: { node: '>=20' } }, HEAD: { engines: { node: '>=22' } } },
    }))
    expect(t).toMatch(/### Breaking changes\n- \*\*Dependencies:\*\* \*\*Node:\*\*|### Breaking changes\n- \*\*Node/)
  })

  it('--prs appends PR numbers when gh works', () => {
    const log = logOf([{ hash: 'f1', subject: 'feat(mcp): tool', files: ['lib/m.js'] }])
    const t = draft(mockRun({ log, prs: { f1: 42 } }), { prs: true })
    expect(t).toMatch(/Tool \(#42\)/)
  })

  it.each(['missing', 'noauth'])('--prs continues with a note when gh is %s', (gh) => {
    const log = logOf([{ hash: 'f1', subject: 'feat(mcp): tool', files: ['lib/m.js'] }])
    const r = cl.draft({ from: 'v0.1.0', prs: true }, mockRun({ log, gh }), '.')
    expect(r.notes[0]).toMatch(/gh is not installed or not authenticated/)
    expect(r.text).toMatch(/- \*\*Agent surface \(MCP\):\*\* Tool\n/)
    expect(r.text).not.toMatch(/#\d/)
  })

  it('defaults --from to the latest non-prerelease v* tag', () => {
    const run = mockRun({ log: logOf([]), tags: 'v0.8.0-rc.1\nv0.7.0\nv0.6.0\n' })
    const r = cl.draft({}, run, '.')
    expect(r.text).toMatch(/Draft for v0\.7\.0\.\.HEAD/)
  })
})

const GOOD = `# Changelog

Intro.

## Unreleased {#unreleased}

## v0.2.0 - 2026-02-01 {#v0-2-0}

### Breaking changes
- **CLI:** flag removed. [Upgrade notes](#upgrade-0-2-0)

### Features
- **E2E:** a step with UTF-8 text.

### Upgrade notes {#upgrade-0-2-0}
- Re-run init.

[Full diff](https://github.com/o/r/compare/v0.1.0...v0.2.0)

## v0.1.0 - 2026-01-01 {#v0-1-0}

### Features
- **CLI:** first release, see [guide](./guide/a.md) and [gone](./guide/missing.md#x).

[Full diff](https://github.com/o/r/compare/v0.0.1...v0.1.0)
`

describe('check', () => {
  it('passes a good file', () => {
    expect(cl.check(GOOD, {})).toEqual([])
  })
  it('flags a bad heading', () => {
    const f = cl.check(GOOD.replace('## v0.1.0 - 2026-01-01 {#v0-1-0}', '## 0.1.0 (2026-01-01)'), {})
    expect(f.join('\n')).toMatch(/bad section heading/)
  })
  it('flags a wrong anchor and missing Unreleased first', () => {
    expect(cl.check(GOOD.replace('{#v0-1-0}', '{#v0-1-1}'), {}).join()).toMatch(/anchor should be \{#v0-1-0\}/)
    expect(cl.check(GOOD.replace('## Unreleased {#unreleased}\n\n', ''), {}).join()).toMatch(/first section must be/)
  })
  it('flags wrong section order and unknown sections', () => {
    const swapped = GOOD.replace('### Features\n- **E2E:**', '### Fixes\n- **E2E:**')
      .replace('### Upgrade notes', '### Features\n- **X:** y\n\n### Upgrade notes')
    expect(cl.check(swapped, {}).join()).toMatch(/out of order/)
    expect(cl.check(GOOD.replace('### Features\n- **E2E', '### Added\n- **E2E'), {}).join()).toMatch(/"Added" is not allowed/)
  })
  it('flags ticket IDs, ADR numbers, phases and task IDs but allows UTF-8', () => {
    for (const bad of ['BUG-12', 'CAP-X1', 'ADR 37', 'Phase 3', 'T12']) {
      const f = cl.check(GOOD.replace('first release', `first ${bad} release`), {})
      expect(f.join(), bad).toMatch(/line \d+:/)
    }
    expect(cl.check(GOOD, {})).toEqual([])
  })
  it('flags a missing compare link', () => {
    const f = cl.check(GOOD.replace('[Full diff](https://github.com/o/r/compare/v0.0.1...v0.1.0)', ''), {})
    expect(f.join()).toMatch(/v0\.1\.0: missing compare link/)
  })
  it('flags Breaking changes without Upgrade notes', () => {
    const noUp = GOOD.replace('### Upgrade notes {#upgrade-0-2-0}\n- Re-run init.\n\n', '')
    expect(cl.check(noUp, {}).join()).toMatch(/v0\.2\.0: has Breaking changes but no Upgrade notes/)
  })
  it('--tags: tag without section and section without tag', () => {
    expect(cl.check(GOOD, { tags: ['v0.1.0', 'v0.2.0', 'v0.3.0-rc.1'] })).toEqual([])
    expect(cl.check(GOOD, { tags: ['v0.1.0', 'v0.2.0', 'v0.3.0'] }).join()).toMatch(/tag v0\.3\.0 has no changelog section/)
    expect(cl.check(GOOD, { tags: ['v0.1.0'] }).join()).toMatch(/section v0\.2\.0 has no matching tag/)
  })
  it('--version: exists and non-empty', () => {
    expect(cl.check(GOOD, { version: '0.2.0' })).toEqual([])
    expect(cl.check(GOOD, { version: '0.9.0' }).join()).toMatch(/no section for v0\.9\.0/)
    const empty = GOOD.replace(/### Features\n- \*\*CLI:\*\* first release[^\n]*\n/, '')
    expect(cl.check(empty, { version: '0.1.0' }).join()).toMatch(/v0\.1\.0 has no entries/)
  })
})

describe('stamp', () => {
  const withUnreleased = GOOD.replace('## Unreleased {#unreleased}\n', '## Unreleased {#unreleased}\n\n### Features\n- **CLI:** new thing.\n')
  const base = 'https://github.com/o/r'
  it('refuses an empty Unreleased', () => {
    expect(() => cl.stampText(GOOD, '0.3.0', '2026-03-01', base)).toThrow(/no entries/)
  })
  it('renames, dates, anchors, links and inserts a fresh Unreleased', () => {
    const out = cl.stampText(withUnreleased, '0.3.0', '2026-03-01', base)
    expect(out).toMatch(/^## Unreleased \{#unreleased\}\n\n## v0\.3\.0 - 2026-03-01 \{#v0-3-0\}\n\n### Features\n- \*\*CLI:\*\* new thing\./m)
    expect(out).toContain('[Full diff](https://github.com/o/r/compare/v0.2.0...v0.3.0)')
    expect(cl.check(out, { version: '0.3.0' })).toEqual([])
    expect(cl.splitSections(out).sections[0].lines.join('').trim()).toBe('')
  })
  it('CLI: refuses empty (exit 1), reads npm_package_version, writes the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-stamp-'))
    try {
      const file = path.join(dir, 'changelog.md')
      const errs = []
      const env = { run: mockRun(), cwd: dir, root: dir, stdout() {}, stderr: (s) => errs.push(s), today: () => '2026-04-01', env: { npm_package_version: '0.3.0' } }
      fs.writeFileSync(file, GOOD)
      expect(cl.main(['stamp', '--file', file], env)).toBe(1)
      fs.writeFileSync(file, withUnreleased)
      expect(cl.main(['stamp', '--file', file], env)).toBe(0)
      expect(fs.readFileSync(file, 'utf8')).toContain('## v0.3.0 - 2026-04-01 {#v0-3-0}')
      expect(cl.main(['stamp', '--file', file], Object.assign({}, env, { env: {} }))).toBe(2)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('slice', () => {
  let tree
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-slice-'))
    fs.mkdirSync(path.join(tree, 'docs', 'guide'), { recursive: true })
    fs.writeFileSync(path.join(tree, 'docs', 'guide', 'a.md'), '# a\n')
  })
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }))

  it('cuts to the tag, drops Unreleased, de-links missing pages, keeps anchors', () => {
    const out = cl.sliceText(GOOD, 'v0.1.0', tree)
    expect(out).not.toMatch(/Unreleased/)
    expect(out).not.toMatch(/v0\.2\.0/)
    expect(out).toContain('## v0.1.0 - 2026-01-01 {#v0-1-0}')
    expect(out).toContain('[guide](./guide/a.md)')
    expect(out).toContain('and gone.')
    expect(out).not.toContain('missing.md')
    expect(out).toContain('compare/v0.0.1...v0.1.0')
    expect(out.startsWith('# Changelog')).toBe(true)
  })
  it('keeps newer-than-asked sections out and older in', () => {
    const out = cl.sliceText(GOOD, 'v0.2.0', tree)
    expect(out).toContain('{#v0-2-0}')
    expect(out).toContain('{#v0-1-0}')
    expect(out).toContain('(#upgrade-0-2-0)')
  })
  it('CLI writes --out', () => {
    const file = path.join(tree, 'in.md'), outFile = path.join(tree, 'out', 'c.md')
    fs.writeFileSync(file, GOOD)
    const code = cl.main(['slice', '--upto', 'v0.1.0', '--tree', tree, '--out', outFile, '--file', file], { run: mockRun(), cwd: tree, root: tree, stdout() {}, stderr() {} })
    expect(code).toBe(0)
    expect(fs.readFileSync(outFile, 'utf8')).toContain('{#v0-1-0}')
  })
})

describe('notes and CLI', () => {
  let dir, file, out, errs, env
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-notes-'))
    file = path.join(dir, 'changelog.md')
    fs.writeFileSync(file, GOOD)
    out = []; errs = []
    env = { run: mockRun({ tags: 'v0.1.0\nv0.2.0\n' }), cwd: dir, root: dir, stdout: (s) => out.push(s), stderr: (s) => errs.push(s) }
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('prints one section body', () => {
    expect(cl.main(['notes', 'v0.1.0', '--file', file], env)).toBe(0)
    const body = out.join('')
    expect(body).toMatch(/^### Features/)
    expect(body).not.toMatch(/v0\.2\.0|^## /m)
  })
  it('exit codes: unknown section 1, usage 2, missing file 2', () => {
    expect(cl.main(['notes', 'v9.9.9', '--file', file], env)).toBe(1)
    expect(cl.main(['notes', '--file', file], env)).toBe(2)
    expect(cl.main(['bogus'], env)).toBe(2)
    expect(cl.main(['check', '--nope'], env)).toBe(2)
    expect(cl.main(['check', '--file', path.join(dir, 'none.md')], env)).toBe(2)
    expect(errs.join('')).toMatch(/changelog not found/)
  })
  it('check exit 0 clean and 1 with findings; --tags uses git tags', () => {
    expect(cl.main(['check', '--tags', '--file', file], env)).toBe(0)
    env.run = mockRun({ tags: 'v0.1.0\nv0.2.0\nv0.3.0\n' })
    expect(cl.main(['check', '--tags', '--file', file], env)).toBe(1)
    expect(errs.join('')).toMatch(/tag v0\.3\.0 has no changelog section/)
  })
})
