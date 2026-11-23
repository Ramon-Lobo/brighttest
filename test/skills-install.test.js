import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const skills = require('../lib/skills')
const { run, ALL_AGENTS, SAFETY_MAX_BYTES, generateManifest } = skills
const VERSION = require('../package.json').version

let cwd, out
const p = (...r) => path.join(cwd, ...r)
const read = (...r) => fs.readFileSync(p(...r), 'utf8')
const put = (rel, body) => { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), body) }
const go = async (action, extra = {}) => {
  out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  try { return await run(null, { skillsAction: action, cwd, ...extra }) } finally { spy.mockRestore() }
}
const BEGIN = '<!-- BEGIN brighttest -->', END = '<!-- END brighttest -->'

beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-skills-inst-')) })
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('always-on safety block (ADOPT-06)', () => {
  test('size gate: every always-on file gets under 6 KB, with all skills into all targets', async () => {
    expect(await go('install', { agent: 'all' })).toBe(0)
    const files = ['CLAUDE.md', 'AGENTS.md', '.rules', path.join('.github', 'copilot-instructions.md'),
      path.join('.cursor', 'rules', 'brighttest-safety.mdc'), path.join('.windsurf', 'rules', 'brighttest-safety.md'),
      path.join('.clinerules', 'brighttest-safety.md')]
    for (const f of files) {
      expect(fs.existsSync(p(f)), f).toBe(true)
      expect(fs.statSync(p(f)).size, f).toBeLessThan(SAFETY_MAX_BYTES)
      expect(read(f)).toContain('brighttest: rules that always apply')
      expect(read(f)).toContain(`v${VERSION}`)
    }
    // block targets carry the index, never full skill bodies
    expect(read('CLAUDE.md')).toContain('- writing-e2e-flows:')
    expect(read('CLAUDE.md')).not.toContain('## Reference files')
  })

  test('size gate also holds when the file already has content (CRLF)', async () => {
    const user = '# Team notes\r\n\r\nKeep this.\r\n'
    put('CLAUDE.md', user)
    await go('install', { agent: 'claude' })
    const cur = read('CLAUDE.md')
    expect(cur.startsWith(user)).toBe(true)
    expect(Buffer.byteLength(cur) - Buffer.byteLength(user)).toBeLessThan(SAFETY_MAX_BYTES)
    expect(/(^|[^\r])\n/.test(cur)).toBe(false) // all line endings stay CRLF
  })

  test('merge keeps user content, is idempotent, and reports unchanged', async () => {
    put('AGENTS.md', '# Mine\n\nRules here.\n\n## Other\nmore\n')
    await go('install', { agent: 'agents' })
    const first = read('AGENTS.md')
    expect(first.startsWith('# Mine\n\nRules here.\n\n## Other\nmore\n')).toBe(true)
    expect(first.split(BEGIN).length).toBe(2)
    await go('install', { agent: 'agents' })
    expect(read('AGENTS.md')).toBe(first)
    expect(out).toMatch(/unchanged\s+AGENTS\.md · safety/)
  })

  test('edits outside the block survive an update', async () => {
    await go('install', { agent: 'agents' })
    fs.writeFileSync(p('AGENTS.md'), '# Top\n\n' + read('AGENTS.md').replace(/\n$/, '') + '\n\n## Bottom\nkeep\n')
    await go('install', { agent: 'agents' })
    expect(read('AGENTS.md')).toMatch(/^# Top\n\n<!-- BEGIN brighttest -->[\s\S]*<!-- END brighttest -->\n\n## Bottom\nkeep\n$/)
  })

  test('missing and empty target files are created or filled', async () => {
    put('.rules', '')
    await go('install', { agent: 'zed' })
    expect(read('.rules').startsWith(BEGIN)).toBe(true)
    expect(fs.existsSync(p('.github', 'copilot-instructions.md'))).toBe(false)
    await go('install', { agent: 'copilot' })
    expect(read('.github', 'copilot-instructions.md')).toContain(END)
  })

  test('read-only file: reported as failed, content untouched, exit 1', async () => {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return
    put('CLAUDE.md', 'mine\n')
    fs.chmodSync(p('CLAUDE.md'), 0o444)
    expect(await go('install', { agent: 'claude' })).toBe(1)
    expect(out).toMatch(/failed/)
    expect(read('CLAUDE.md')).toBe('mine\n')
  })

  test('--no-safety writes skills but no block or file', async () => {
    expect(await go('install', { agent: 'all', noSafety: true })).toBe(0)
    expect(fs.existsSync(p('CLAUDE.md'))).toBe(false)
    expect(fs.existsSync(p('AGENTS.md'))).toBe(false)
    expect(fs.existsSync(p('.cursor', 'rules', 'brighttest-safety.mdc'))).toBe(false)
    expect(fs.existsSync(p('.claude', 'skills', 'writing-e2e-flows', 'SKILL.md'))).toBe(true)
  })

  test('--skill leaves the safety block alone', async () => {
    await go('install', { agent: 'claude', skill: 'testing-app-state' })
    expect(fs.existsSync(p('CLAUDE.md'))).toBe(false)
    expect(out).toMatch(/safety block was not touched/)
  })

  test.each([
    ['BEGIN without END', `x\n${BEGIN}\nhalf\n`],
    ['END without BEGIN', `x\n${END}\n`],
    ['END before BEGIN', `${END}\nx\n${BEGIN}\n`],
    ['duplicate blocks', `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`],
  ])('malformed block (%s): failed with the file name, file untouched, no TypeError', async (_n, body) => {
    put('CLAUDE.md', body)
    expect(await go('install', { agent: 'claude' })).toBe(1)
    expect(read('CLAUDE.md')).toBe(body)
    expect(out).toMatch(/CLAUDE\.md: managed block .* is malformed/)
    expect(out).not.toMatch(/TypeError/)
    out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    await run(null, { skillsAction: 'uninstall', cwd, agent: 'claude' }); spy.mockRestore()
    expect(read('CLAUDE.md')).toBe(body)
    expect(out).toMatch(/failed/)
  })

  test('markers inside a code fence are not our block', async () => {
    const user = '# Docs\n\n```md\n' + BEGIN + '\nexample\n' + END + '\n```\n'
    put('AGENTS.md', user)
    await go('install', { agent: 'agents' })
    expect(read('AGENTS.md').startsWith(user + '\n' + BEGIN)).toBe(true)
    await go('uninstall', { agent: 'agents' })
    expect(read('AGENTS.md')).toBe(user)
  })

  test('uninstall restores the exact original bytes (no trailing newline, trailing blanks, CRLF)', async () => {
    for (const orig of ['keep', 'keep\n', 'keep\n\n\n', 'a\r\nb', 'a\r\nb\r\n']) {
      put('AGENTS.md', orig)
      await go('install', { agent: 'agents' })
      await go('uninstall', { agent: 'agents' })
      expect(read('AGENTS.md'), JSON.stringify(orig)).toBe(orig)
    }
  })

  test('a symlinked target that resolves outside the project is refused', async () => {
    if (process.platform === 'win32') return
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-skills-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'real.md'), 'outside\n')
      fs.symlinkSync(path.join(outside, 'real.md'), p('CLAUDE.md'))
      expect(await go('install', { agent: 'claude' })).toBe(1)
      expect(out).toMatch(/symlink that resolves outside the project/)
      expect(fs.readFileSync(path.join(outside, 'real.md'), 'utf8')).toBe('outside\n')
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })

  test('writes keep the file mode and leave no temp files', async () => {
    if (process.platform === 'win32') return
    put('AGENTS.md', 'x\n')
    fs.chmodSync(p('AGENTS.md'), 0o640)
    await go('install', { agent: 'agents' })
    expect(fs.statSync(p('AGENTS.md')).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(cwd).filter((f) => f.includes('bt-tmp'))).toEqual([])
  })
})

describe('targets (ADOPT-06)', () => {
  test('moved targets install folders', async () => {
    await go('install', { agent: 'all' })
    for (const d of [['.agents', 'skills'], ['.github', 'skills'], ['.claude', 'skills']]) {
      expect(fs.existsSync(p(...d, 'writing-rooibos-tests', 'SKILL.md')), d.join('/')).toBe(true)
    }
    expect(fs.existsSync(p('.cursor', 'rules', 'writing-rooibos-tests.mdc'))).toBe(false)
  })

  test('windsurf and cline: body-only flat file, references copied and linked, then uninstalled', async () => {
    await go('install', { agent: 'windsurf' })
    const flat = read('.windsurf', 'rules', 'writing-rooibos-tests.md')
    expect(flat).toContain('.agents/skills/writing-rooibos-tests/references/cheatsheet.md')
    expect(flat).not.toContain('## Reference files')
    expect(read('.agents', 'skills', 'writing-rooibos-tests', 'references', 'cheatsheet.md')).toContain('brighttest skills:writing-rooibos-tests')
    await go('uninstall', { agent: 'windsurf' })
    expect(fs.existsSync(p('.windsurf', 'rules', 'writing-rooibos-tests.md'))).toBe(false)
    expect(fs.existsSync(p('.windsurf', 'rules', 'brighttest-safety.md'))).toBe(false)
    expect(fs.existsSync(p('.agents', 'skills', 'writing-rooibos-tests'))).toBe(false)
  })

  test('flat install keeps an identical reference copy from a folder install and uninstall leaves it', async () => {
    await go('install', { agent: 'agentskills' })
    await go('install', { agent: 'cline' })
    await go('uninstall', { agent: 'cline' })
    expect(fs.existsSync(p('.agents', 'skills', 'writing-rooibos-tests', 'references', 'cheatsheet.md'))).toBe(true)
  })
})

describe('migration (ADOPT-06)', () => {
  const legacy = (n) => `<!-- BEGIN brighttest:${n} -->\n<!-- brighttest skills:${n} v0.1.0 — managed by \`brighttest skills\`; edits are overwritten on update -->\nold body\n<!-- END brighttest:${n} -->\n`

  test('legacy per-skill blocks are replaced by the single block and reported migrated', async () => {
    put('AGENTS.md', `# Mine\n\n${legacy('writing-rooibos-tests')}\n${legacy('testing-app-state')}\nTail\n`)
    await go('install', { agent: 'agents' })
    const cur = read('AGENTS.md')
    expect(cur).not.toContain('BEGIN brighttest:')
    expect(cur).not.toContain('old body')
    expect(cur).toContain('# Mine')
    expect(cur).toContain('Tail')
    expect(cur).toContain(BEGIN)
    expect((out.match(/migrated/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  test('install --skill X migrates only X; other legacy blocks stay', async () => {
    put('AGENTS.md', `${legacy('writing-rooibos-tests')}\n${legacy('testing-app-state')}`)
    await go('install', { agent: 'agents', skill: 'writing-rooibos-tests' })
    const cur = read('AGENTS.md')
    expect(cur).not.toContain('BEGIN brighttest:writing-rooibos-tests')
    expect(cur).toContain('BEGIN brighttest:testing-app-state')
    expect(cur).toContain('old body')
  })

  test('cursor flattened file with our marker is removed; a user file of the same name is kept', async () => {
    put('.cursor/rules/writing-rooibos-tests.mdc', '---\n---\n<!-- brighttest skills:writing-rooibos-tests v0.1.0 — x -->\nold\n')
    put('.cursor/rules/testing-app-state.mdc', 'my own rule, no marker\n')
    put('AGENTS.md', '<!-- BEGIN brighttest:custom -->\nuser block without our marker\n<!-- END brighttest:custom -->\n')
    await go('install', { agent: 'cursor' })
    expect(fs.existsSync(p('.cursor', 'rules', 'writing-rooibos-tests.mdc'))).toBe(false)
    expect(read('.cursor', 'rules', 'testing-app-state.mdc')).toBe('my own rule, no marker\n')
    expect(out).toMatch(/migrated/)
    await go('install', { agent: 'agents' })
    expect(read('AGENTS.md')).toContain('user block without our marker')
  })

  test('a user-owned brighttest-safety file is skipped without --force', async () => {
    put('.cursor/rules/brighttest-safety.mdc', 'mine\n')
    await go('install', { agent: 'cursor' })
    expect(read('.cursor', 'rules', 'brighttest-safety.mdc')).toBe('mine\n')
    expect(out).toMatch(/skipped/)
  })
})

describe('uninstall (ADOPT-06)', () => {
  test('removes block and index, keeps user content; a file left empty is kept', async () => {
    put('AGENTS.md', '# Mine\n\nkeep\n')
    put('CLAUDE.md', '')
    await go('install', { agent: 'agents' })
    await go('install', { agent: 'claude' })
    await go('uninstall', { agent: 'agents' })
    expect(read('AGENTS.md')).toBe('# Mine\n\nkeep\n')
    await go('uninstall', { agent: 'claude' })
    expect(read('CLAUDE.md')).toBe('')
    expect(fs.existsSync(p('.agents', 'skills', 'writing-e2e-flows'))).toBe(false)
  })

  test('uninstall with --skill leaves the block', async () => {
    await go('install', { agent: 'claude' })
    await go('uninstall', { agent: 'claude', skill: 'testing-app-state' })
    expect(read('CLAUDE.md')).toContain(BEGIN)
    expect(fs.existsSync(p('.claude', 'skills', 'testing-app-state'))).toBe(false)
  })

  test('uninstall of CRLF file keeps CRLF', async () => {
    put('.rules', 'a\r\nb\r\n')
    await go('install', { agent: 'zed' })
    await go('uninstall', { agent: 'zed' })
    expect(read('.rules')).toBe('a\r\nb\r\n')
  })
})

describe('skills list (ADOPT-06)', () => {
  test('shows installed version vs CLI version per target', async () => {
    await go('install', { agent: 'claude' })
    fs.writeFileSync(p('CLAUDE.md'), read('CLAUDE.md').replace(`skills v${VERSION}`, 'skills v0.0.1'))
    await go('list')
    expect(out).toMatch(/Claude Code: v0\.0\.1, CLI is v/)
    fs.writeFileSync(p('CLAUDE.md'), read('CLAUDE.md').replace('skills v0.0.1', `skills v${VERSION}`))
    await go('list')
    expect(out).toMatch(/Claude Code: v.*up to date/)
  })
})

describe('update from an older ref (ADOPT-06)', () => {
  const stubRemote = (manifest, extra = {}) => {
    const files = { 'skills/manifest.json': JSON.stringify(manifest), 'package.json': '{"version":"0.0.9"}',
      'skills/only-skill/SKILL.md': '---\nname: only-skill\ndescription: A skill.\n---\n# Only\n', ...extra }
    vi.stubGlobal('fetch', async (url) => {
      const key = Object.keys(files).find((k) => url.endsWith('/' + k))
      return key ? { ok: true, status: 200, text: async () => files[key] } : { ok: false, status: 404, text: async () => '' }
    })
  }

  test('v1 manifest: installs skills only and says so; existing blocks untouched', async () => {
    stubRemote({ schema: 'brighttest-skills/v1', skills: [{ name: 'only-skill', files: ['SKILL.md'] }] })
    put('CLAUDE.md', 'mine\n')
    expect(await go('update', { agent: 'claude', ref: 'old-tag' })).toBe(0)
    expect(read('.claude', 'skills', 'only-skill', 'SKILL.md')).toContain('only-skill')
    expect(read('CLAUDE.md')).toBe('mine\n')
    expect(out).toMatch(/manifest at this ref is v1: installed skills only/)
  })

  test('v2 manifest: installs the remote safety block', async () => {
    stubRemote({ schema: 'brighttest-skills/v2', skills: [{ name: 'only-skill', files: ['SKILL.md'] }], alwaysOn: { file: '_always-on/safety.md' } },
      { 'skills/_always-on/safety.md': '## remote rules v<version>\nbe safe\n' })
    await go('update', { agent: 'claude', ref: 'new-tag' })
    expect(read('CLAUDE.md')).toContain('## remote rules v0.0.9')
    expect(read('CLAUDE.md')).toContain('- only-skill: A skill.')
  })
})

describe('untrusted --ref manifest (ADOPT-06)', () => {
  const SAFE = '## rules v<version>\nbe safe\n'
  const remote = (skillsEntry, extra = {}, alwaysOn = { file: '_always-on/safety.md' }) => {
    const files = { 'package.json': '{"version":"0.0.9"}', 'skills/_always-on/safety.md': SAFE,
      'skills/ok/SKILL.md': '---\nname: ok\ndescription: d\n---\n# ok\n', ...extra }
    const seen = []
    vi.stubGlobal('fetch', async (url) => {
      seen.push(url)
      const key = Object.keys(files).find((k) => url.endsWith('/' + k))
      if (url.endsWith('/skills/manifest.json')) return { ok: true, status: 200, text: async () => JSON.stringify({ schema: 'brighttest-skills/v2', skills: skillsEntry, alwaysOn }) }
      return key ? { ok: true, status: 200, text: async () => files[key] } : { ok: true, status: 200, text: async () => 'PWNED' }
    })
    return seen
  }
  const okSkill = { name: 'ok', files: ['SKILL.md'] }
  const bad = [
    ['skill name with ..', [{ name: '../../escape', files: ['SKILL.md'] }]],
    ['skill name with slash', [{ name: 'a/b', files: ['SKILL.md'] }]],
    ['file with ..', [{ name: 'ok', files: ['SKILL.md', '../../../pwned.md'] }]],
    ['absolute file', [{ name: 'ok', files: ['/etc/pwned.md'] }]],
    ['backslash file', [{ name: 'ok', files: ['a\\b.md'] }]],
    ['drive letter file', [{ name: 'ok', files: ['C:evil.md'] }]],
    ['NUL file', [{ name: 'ok', files: ['a\u0000b.md'] }]],
  ]
  test.each(bad)('rejects %s before writing anything', async (_n, entries) => {
    remote(entries)
    expect(await go('update', { agent: 'claude', ref: 'x' })).toBe(1)
    expect(fs.existsSync(p('.claude'))).toBe(false)
    expect(fs.existsSync(p('CLAUDE.md'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, '..', 'pwned.md'))).toBe(false)
  })
  test('rejects alwaysOn.file other than _always-on/safety.md', async () => {
    remote([okSkill], {}, { file: '../../other/repo/main/README.md' })
    expect(await go('update', { agent: 'claude', ref: 'x' })).toBe(1)
    expect(fs.existsSync(p('CLAUDE.md'))).toBe(false)
  })
  test.each([
    ['END marker', '## r\n<!-- END brighttest -->\nmore\n'],
    ['BEGIN marker', '<!-- BEGIN brighttest -->\n'],
    ['over 45 lines', Array(46).fill('x').join('\n') + '\n'],
    ['over 6 KB', 'x'.repeat(7000) + '\n'],
  ])('rejects safety text with %s', async (_n, text) => {
    remote([okSkill], { 'skills/_always-on/safety.md': text })
    expect(await go('update', { agent: 'claude', ref: 'x' })).toBe(1)
    expect(fs.existsSync(p('CLAUDE.md'))).toBe(false)
    expect(fs.existsSync(p('.claude'))).toBe(false)
  })
  test('writer refuses a path outside the destination (defense in depth)', () => {
    expect(() => skills.writeFilesTo(path.join(cwd, 'dest'), { '../x.md': 'a' })).toThrow(/outside/)
    expect(() => skills.writeFilesTo(path.join(cwd, 'dest'), { 'sub/../../x.md': 'a' })).toThrow(/outside/)
    expect(fs.existsSync(p('x.md'))).toBe(false)
  })
  test('uninstall rejects a --skill that is a path', async () => {
    expect(await go('uninstall', { agent: 'claude', skill: '../x' })).toBe(1)
  })
  test('a good remote still installs', async () => {
    remote([okSkill])
    expect(await go('update', { agent: 'claude', ref: 'x' })).toBe(0)
    expect(read('CLAUDE.md')).toContain('## rules v0.0.9')
  })
})

describe('manifest v2 generator (ADOPT-06)', () => {
  let root
  const put2 = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body) }
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-skills-gen-')); put2('alpha/SKILL.md', '---\nname: alpha\n---\n# a\n') })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  test('shape: schema, cliVersion, agents, alwaysOn, facts', () => {
    put2('_agents/helper.md', '---\nname: helper\nhosts: [claude]\nskills: [alpha]\n---\nbody\n')
    put2('_always-on/safety.md', 'rule\n')
    expect(generateManifest(root)).toEqual({
      schema: 'brighttest-skills/v2', cliVersion: VERSION, skills: [{ name: 'alpha', files: ['SKILL.md'] }],
      agents: [{ name: 'helper', file: '_agents/helper.md', hosts: ['claude'], skills: ['alpha'] }],
      alwaysOn: { file: '_always-on/safety.md', maxLines: 45 }, facts: 'facts.json',
    })
  })
  test('fails on an unknown skill, an unknown host, and an over-long always-on file', () => {
    put2('_agents/h.md', '---\nhosts: [claude]\nskills: [nope]\n---\n')
    expect(() => generateManifest(root)).toThrow(/unknown skill 'nope'/)
    put2('_agents/h.md', '---\nhosts: [vim]\nskills: [alpha]\n---\n')
    expect(() => generateManifest(root)).toThrow(/unknown host 'vim'/)
    fs.rmSync(path.join(root, '_agents'), { recursive: true })
    put2('_always-on/safety.md', Array(46).fill('x').join('\n') + '\n')
    expect(() => generateManifest(root)).toThrow(/at most 45/)
  })
  test('skills --check reports the generator error as drift', () => {
    put2('_agents/h.md', '---\nskills: [nope]\n---\n')
    fs.writeFileSync(path.join(root, 'manifest.json'), '{}')
    let err = ''
    expect(skills.check(root, { write() {} }, { write: (s) => { err += s } })).toBe(1)
    expect(err).toMatch(/unknown skill/)
  })
  test('the shipped safety block is within 45 lines and names every rule group', () => {
    const t = fs.readFileSync(path.join(__dirname, '..', 'skills', '_always-on', 'safety.md'), 'utf8')
    expect(t.replace(/\n$/, '').split('\n').length).toBeLessThanOrEqual(45)
    for (const k of ['--no-lease', 'device unlock --force', 'Exit 75', 'Secrets:', 'instrument verify', 'not device-verified']) expect(t).toContain(k)
  })
})

test('every target key is covered by the size-gate list', () => { expect(ALL_AGENTS.length).toBe(8) })

describe('installer follow-ups (ADOPT-07)', () => {
  const legacy = (n) => `<!-- BEGIN brighttest:${n} -->\n<!-- brighttest skills:${n} v0.1.0 — managed by \`brighttest skills\`; edits are overwritten on update -->\nold body\n<!-- END brighttest:${n} -->\n`

  test('folder-first: every folder target writes the skill folders, one block, no full bodies, under 6 KB added', async () => {
    for (const [agent, dir, file] of [['agents', '.agents/skills', 'AGENTS.md'], ['opencode', '.agents/skills', 'AGENTS.md'], ['codex', '.agents/skills', 'AGENTS.md'],
      ['copilot', '.github/skills', '.github/copilot-instructions.md'], ['zed', '.agents/skills', '.rules'], ['cursor', '.agents/skills', '.cursor/rules/brighttest-safety.mdc']]) {
      fs.rmSync(cwd, { recursive: true, force: true }); fs.mkdirSync(cwd)
      put(file, 'user line\n')
      expect(await go('install', { agent }), agent).toBe(0)
      expect(fs.existsSync(p(...dir.split('/'), 'writing-e2e-flows', 'SKILL.md')), agent).toBe(true)
      const txt = read(...file.split('/'))
      expect((txt.match(/<!-- BEGIN brighttest -->/g) || []).length, agent).toBeLessThanOrEqual(1)
      expect(txt, agent).not.toContain('## Reference files')
      expect(Buffer.byteLength(txt) - Buffer.byteLength('user line\n'), agent).toBeLessThan(SAFETY_MAX_BYTES)
    }
  })

  test('failed legacy migration: no safety block is written next to the stuck legacy block, uninstall does not throw', async () => {
    const stuck = '<!-- BEGIN brighttest:testing-app-state -->\n<!-- brighttest skills:testing-app-state v0.1.0 — x -->\nbody without end\n'
    put('AGENTS.md', stuck)
    expect(await go('install', { agent: 'agents' })).toBe(1)
    expect(out).toMatch(/legacy migration/)
    expect(read('AGENTS.md')).toBe(stuck)
    expect(await go('uninstall', { agent: 'agents' })).toBe(1)
    expect(out).toMatch(/malformed/)
    expect(read('AGENTS.md')).toBe(stuck)
  })

  test('one bad legacy block does not hide the one that migrated', async () => {
    put('AGENTS.md', legacy('writing-rooibos-tests') + '\n<!-- BEGIN brighttest:testing-app-state -->\n<!-- brighttest skills:testing-app-state v0.1.0 — x -->\nno end\n')
    await go('install', { agent: 'agents' })
    expect(out).toMatch(/migrated/)
    expect(out).toMatch(/failed/)
  })

  test('lone-newline and whitespace-only files round-trip', async () => {
    for (const orig of ['\n', '\n\n', '\r\n', '  \n', ' ']) {
      put('AGENTS.md', orig)
      await go('install', { agent: 'agents' })
      expect(read('AGENTS.md')).toContain(BEGIN)
      await go('uninstall', { agent: 'agents' })
      expect(read('AGENTS.md'), JSON.stringify(orig)).toBe(orig)
    }
  })

  test('uninstall with user text after the block leaves one separator, not two', async () => {
    await go('install', { agent: 'agents' })
    const blk = read('AGENTS.md').replace(/\n$/, '')
    fs.rmSync(p('AGENTS.md'))
    const crlf = (t) => t.replace(/\n/g, '\r\n')
    for (const [pre, post, want, eol] of [
      ['A\n\n', '\n\nB\n', 'A\n\nB\n'],
      ['A\n\n', '\nB\n', 'A\n\nB\n'],
      ['', '\n\nB\n', 'B\n'],
      ['A\n', '\n\nB\n', 'A\n\nB\n'],
      ['A\n\n', '\n\nB\n', 'A\n\nB\n', 'crlf'],
    ]) {
      const t = (x) => (eol ? crlf(x) : x)
      put('AGENTS.md', t(pre + blk + post))
      await go('uninstall', { agent: 'agents' })
      expect(read('AGENTS.md'), JSON.stringify([pre, post, eol])).toBe(t(want))
    }
  })

  test('full install migrates legacy blocks and cursor files of skills no longer in the manifest; --skill does not', async () => {
    put('AGENTS.md', legacy('retired-skill') + '\nTail\n')
    put('.cursor/rules/retired-skill.mdc', '<!-- brighttest skills:retired-skill v0.1.0 — x -->\nold\n')
    await go('install', { agent: 'agents', skill: 'testing-app-state' })
    expect(read('AGENTS.md')).toContain('BEGIN brighttest:retired-skill')
    await go('install', { agent: 'agents' })
    expect(read('AGENTS.md')).not.toContain('retired-skill')
    expect(read('AGENTS.md')).toContain('Tail')
    await go('install', { agent: 'cursor' })
    expect(fs.existsSync(p('.cursor', 'rules', 'retired-skill.mdc'))).toBe(false)
    expect(out).toMatch(/retired-skill/)
  })

  test('uninstall removes a retired skill legacy cursor file but keeps a user file', async () => {
    put('.cursor/rules/retired-skill.mdc', '<!-- brighttest skills:retired-skill v0.1.0 — x -->\nold\n')
    put('.cursor/rules/mine.mdc', 'mine\n')
    await go('uninstall', { agent: 'cursor' })
    expect(fs.existsSync(p('.cursor', 'rules', 'retired-skill.mdc'))).toBe(false)
    expect(read('.cursor', 'rules', 'mine.mdc')).toBe('mine\n')
  })

  test('a dangling symlink is refused, not replaced by a regular file', async () => {
    if (process.platform === 'win32') return
    fs.symlinkSync(p('nowhere.md'), p('CLAUDE.md'))
    expect(await go('install', { agent: 'claude' })).toBe(1)
    expect(out).toMatch(/symlink whose target does not exist/)
    expect(fs.lstatSync(p('CLAUDE.md')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(p('nowhere.md'))).toBe(false)
  })

  test('EBUSY on rename is retried, then reported as transient (not read-only)', async () => {
    put('CLAUDE.md', 'mine\n')
    const real = fs.renameSync
    let calls = 0
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (String(b).endsWith('CLAUDE.md')) { calls++; if (calls <= 2) { const e = new Error('busy'); e.code = 'EBUSY'; throw e } }
      return real(a, b)
    })
    try {
      expect(await go('install', { agent: 'claude' })).toBe(0)
      expect(read('CLAUDE.md')).toContain(BEGIN)
      calls = -100
      put('CLAUDE.md', 'mine\n')
      spy.mockImplementation((a, b) => { if (String(b).endsWith('CLAUDE.md')) { const e = new Error('perm'); e.code = 'EPERM'; throw e } return real(a, b) })
      expect(await go('install', { agent: 'claude' })).toBe(1)
      expect(out).toMatch(/still busy/)
      expect(out).not.toMatch(/read-only/)
      expect(read('CLAUDE.md')).toBe('mine\n')
      expect(fs.readdirSync(cwd).filter((f) => f.includes('bt-tmp'))).toEqual([])
    } finally { spy.mockRestore() }
  })

  test('validRelFile rejects segments ending in a dot or space', () => {
    const { validRelFile } = skills
    for (const bad of ['a.', 'a /b.md', 'references/x.md.', 'references /x.md', 'a/b ', '.. ', '...']) expect(validRelFile(bad), bad).toBe(false)
    for (const good of ['SKILL.md', 'references/a.b.md', 'references/.hidden.md', 'a b/c.md']) expect(validRelFile(good), good).toBe(true)
  })
})
