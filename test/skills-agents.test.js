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
