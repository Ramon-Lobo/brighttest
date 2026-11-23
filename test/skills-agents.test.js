import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { run } = require('../lib/skills')
const VERSION = require('../package.json').version

// Test-only agent source: a temp skills root with _agents/<name>.md (the bundled skills/ has no agents in this change).
let cwd, root, out
const p = (...r) => path.join(cwd, ...r)
const AGENT = '---\nname: fixture-helper\ndescription: Fixture agent for the installer tests\ntools: Read, Grep\nskills: [adopting-brighttest]\nhosts: [claude]\n---\n\n# Fixture helper\n\nDoes nothing.\n'
const go = async (action, extra = {}) => {
  out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  try { return await run(null, { skillsAction: action, cwd, agent: 'claude', agentsRoot: root, ...extra }) } finally { spy.mockRestore() }
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-agents-proj-'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-agents-src-'))
  fs.mkdirSync(path.join(root, '_agents'))
  fs.writeFileSync(path.join(root, '_agents', 'fixture-helper.md'), AGENT)
})
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }) })

describe('agents target (ADOPT-08)', () => {
  test('install renders .claude/agents/<name>.md with marker, without hosts', async () => {
    expect(await go('install')).toBe(0)
    const t = fs.readFileSync(p('.claude', 'agents', 'fixture-helper.md'), 'utf8')
    expect(t.startsWith('---\nname: fixture-helper\n')).toBe(true)
    expect(t).not.toMatch(/^hosts:/m)
    expect(t).toContain('tools: Read, Grep')
    expect(t).toContain(`<!-- brighttest agent:fixture-helper v${VERSION} `)
    expect(t).toContain('# Fixture helper')
    expect(out).toContain('agent:fixture-helper')
  })

  test('--no-agents skips the target; other targets never get agents', async () => {
    expect(await go('install', { noAgents: true })).toBe(0)
    expect(fs.existsSync(p('.claude', 'agents'))).toBe(false)
    expect(await go('install', { agent: 'all' })).toBe(0)
    expect(fs.existsSync(p('.claude', 'agents', 'fixture-helper.md'))).toBe(true)
    expect(fs.existsSync(p('.agents', 'agents'))).toBe(false)
    expect(fs.existsSync(p('.github', 'agents'))).toBe(false)
  })

  test('a single-skill run does not touch agents', async () => {
    expect(await go('install', { skill: 'adopting-brighttest' })).toBe(0)
    expect(fs.existsSync(p('.claude', 'agents'))).toBe(false)
  })

  test('re-install is unchanged; user-written file is never overwritten, even with --force', async () => {
    await go('install')
    await go('install')
    expect(out).toContain('unchanged')
    fs.writeFileSync(p('.claude', 'agents', 'fixture-helper.md'), 'my own agent\n')
    expect(await go('install', { force: true })).toBe(0)
    expect(out).toContain('skipped')
    expect(fs.readFileSync(p('.claude', 'agents', 'fixture-helper.md'), 'utf8')).toBe('my own agent\n')
  })

  test('uninstall removes only marked files and the empty dir it filled', async () => {
    await go('install')
    fs.writeFileSync(p('.claude', 'agents', 'mine.md'), 'user agent\n')
    expect(await go('uninstall')).toBe(0)
    expect(fs.existsSync(p('.claude', 'agents', 'fixture-helper.md'))).toBe(false)
    expect(fs.readFileSync(p('.claude', 'agents', 'mine.md'), 'utf8')).toBe('user agent\n')
    fs.rmSync(p('.claude', 'agents', 'mine.md'))
    await go('install')
    await go('uninstall')
    expect(fs.existsSync(p('.claude', 'agents'))).toBe(false)
  })

  test('uninstall leaves a user file at the same path, and --no-agents leaves ours', async () => {
    fs.mkdirSync(p('.claude', 'agents'), { recursive: true })
    fs.writeFileSync(p('.claude', 'agents', 'fixture-helper.md'), 'user file\n')
    await go('uninstall')
    expect(fs.readFileSync(p('.claude', 'agents', 'fixture-helper.md'), 'utf8')).toBe('user file\n')
    fs.rmSync(p('.claude', 'agents'), { recursive: true })
    await go('install')
    await go('uninstall', { noAgents: true })
    expect(fs.existsSync(p('.claude', 'agents', 'fixture-helper.md'))).toBe(true)
  })

  test('bundled install (no override) still works with no agents shipped', async () => {
    expect(await go('install', { agentsRoot: undefined })).toBe(0)
  })
})

describe('bundled agent definitions (ADOPT-18)', () => {
  const NAMES = ['adoption-assessor', 'ci-integrator', 'device-debugger', 'test-author']
  const dir = path.join(__dirname, '..', 'skills', '_agents')
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'manifest.json'), 'utf8'))

  test('manifest lists exactly the four agents, claude host, no Agent tool', () => {
    expect(manifest.agents.map((a) => a.name).sort()).toEqual(NAMES)
    for (const n of NAMES) {
      const t = fs.readFileSync(path.join(dir, `${n}.md`), 'utf8')
      const tools = /^tools:\s*(.*)$/m.exec(t)[1].split(',').map((x) => x.trim())
      expect(tools).not.toContain('Agent')
      expect(t).toMatch(/^hosts: \[claude\]$/m)
      expect(t).toMatch(/## Must not/)
      expect(t).toMatch(/## Hand back to the user when/)
    }
  })

  test('install from the bundled skills renders all four agents', async () => {
    out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    try { expect(await run(null, { skillsAction: 'install', cwd, agent: 'claude' })).toBe(0) } finally { spy.mockRestore() }
    for (const n of NAMES) expect(fs.existsSync(p('.claude', 'agents', `${n}.md`))).toBe(true)
  })
})

describe('copilot agents target (ADOPT-24)', () => {
  const BOTH = AGENT.replace('hosts: [claude]', 'hosts: [claude, copilot]').replace('tools: Read, Grep', 'tools: Read, Grep, Bash')
  const bodyOf = (t) => t.replace(/\r\n/g, '\n').match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)[1]
  beforeEach(() => { fs.writeFileSync(path.join(root, '_agents', 'fixture-helper.md'), BOTH) })

  test('renders .github/agents/<name>.agent.md: name, description, mapped tools, marker, unchanged body', async () => {
    expect(await go('install', { agent: 'all' })).toBe(0)
    const t = fs.readFileSync(p('.github', 'agents', 'fixture-helper.agent.md'), 'utf8')
    const keys = t.match(/^---\n([\s\S]*?)\n---/)[1].split('\n').map((l) => l.split(':')[0])
    expect(keys).toEqual(['name', 'description', 'tools'])
    expect(t).toContain('tools: [read, search, execute]')
    expect(t).toContain(`<!-- brighttest agent:fixture-helper v${VERSION} `)
    const neutralBody = BOTH.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)[1].trim()
    expect(bodyOf(t).replace(/^<!--.*-->\n/, '').trim()).toBe(neutralBody)
    expect(fs.existsSync(p('.claude', 'agents', 'fixture-helper.md'))).toBe(true)
  })

  test('only agents that list copilot render for it; claude-only stays out', async () => {
    fs.writeFileSync(path.join(root, '_agents', 'fixture-helper.md'), AGENT)
    expect(await go('install', { agent: 'all' })).toBe(0)
    expect(fs.existsSync(p('.github', 'agents'))).toBe(false)
    expect(fs.existsSync(p('.claude', 'agents', 'fixture-helper.md'))).toBe(true)
  })

  test('second run is unchanged, --no-agents skips, user file is never overwritten', async () => {
    await go('install', { agent: 'copilot' })
    await go('install', { agent: 'copilot' })
    expect(out).toContain('unchanged')
    fs.rmSync(p('.github', 'agents'), { recursive: true })
    await go('install', { agent: 'copilot', noAgents: true })
    expect(fs.existsSync(p('.github', 'agents'))).toBe(false)
    fs.mkdirSync(p('.github', 'agents'), { recursive: true })
    fs.writeFileSync(p('.github', 'agents', 'fixture-helper.agent.md'), 'mine\n')
    await go('install', { agent: 'copilot', force: true })
    expect(out).toContain('skipped')
    expect(fs.readFileSync(p('.github', 'agents', 'fixture-helper.agent.md'), 'utf8')).toBe('mine\n')
  })

  test('uninstall removes only our copilot agent files', async () => {
    await go('install', { agent: 'copilot' })
    fs.writeFileSync(p('.github', 'agents', 'mine.agent.md'), 'user agent\n')
    fs.writeFileSync(p('.github', 'agents', 'plain.md'), 'user plain\n')
    expect(await go('uninstall', { agent: 'copilot' })).toBe(0)
    expect(fs.existsSync(p('.github', 'agents', 'fixture-helper.agent.md'))).toBe(false)
    expect(fs.readFileSync(p('.github', 'agents', 'mine.agent.md'), 'utf8')).toBe('user agent\n')
    expect(fs.readFileSync(p('.github', 'agents', 'plain.md'), 'utf8')).toBe('user plain\n')
    fs.rmSync(p('.github', 'agents'), { recursive: true })
    await go('install', { agent: 'copilot' })
    await go('uninstall', { agent: 'copilot' })
    expect(fs.existsSync(p('.github', 'agents'))).toBe(false)
  })
})
