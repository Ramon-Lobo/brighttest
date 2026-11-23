import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { run } = require('../lib/skills')

// ADOPT-09: --with-hook / --with-mcp merge into the user's JSON files, never overwrite.
let cwd, out
const p = (...r) => path.join(cwd, ...r)
const rd = (f) => JSON.parse(fs.readFileSync(p(f), 'utf8'))
const go = async (action, extra = {}) => {
  out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  try { return await run(null, { skillsAction: action, cwd, agent: 'claude', ...extra }) } finally { spy.mockRestore() }
}
const OTHER_HOOK = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo unrelated' }] }
const seed = () => {
  fs.mkdirSync(p('.claude'), { recursive: true })
  fs.writeFileSync(p('.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { PreToolUse: [OTHER_HOOK], PostToolUse: [{ matcher: 'X', hooks: [] }] } }, null, 4) + '\n')
  fs.writeFileSync(p('.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2) + '\n')
}

beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-merge-')) })
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }) })

describe('hook and MCP merge (ADOPT-09)', () => {
  test('creates both files when absent; flags off writes neither', async () => {
    expect(await go('install')).toBe(0)
    expect(fs.existsSync(p('.mcp.json'))).toBe(false)
    expect(fs.existsSync(p('.claude', 'settings.json'))).toBe(false)
    expect(await go('install', { withHook: true, withMcp: true })).toBe(0)
    expect(rd('.claude/settings.json').hooks.PreToolUse).toHaveLength(1)
    expect(rd('.mcp.json').mcpServers.brighttest.args).toContain('mcp')
  })

  test('keeps existing keys, hooks and servers; idempotent over two runs', async () => {
    seed()
    expect(await go('install', { withHook: true, withMcp: true })).toBe(0)
    const s1 = fs.readFileSync(p('.claude', 'settings.json'), 'utf8'); const m1 = fs.readFileSync(p('.mcp.json'), 'utf8')
    const s = JSON.parse(s1)
    expect(s.permissions).toEqual({ allow: ['Read'] })
    expect(s.hooks.PostToolUse).toHaveLength(1)
    expect(s.hooks.PreToolUse).toHaveLength(2)
    expect(s.hooks.PreToolUse[0]).toEqual(OTHER_HOOK)
    expect(s1).toContain('\n    "permissions"') // 4-space indent kept
    const m = JSON.parse(m1)
    expect(Object.keys(m.mcpServers).sort()).toEqual(['brighttest', 'other'])
    expect(await go('install', { withHook: true, withMcp: true })).toBe(0)
    expect(out).toContain('unchanged')
    expect(fs.readFileSync(p('.claude', 'settings.json'), 'utf8')).toBe(s1)
    expect(fs.readFileSync(p('.mcp.json'), 'utf8')).toBe(m1)
  })

  test('writes no host, password or token', async () => {
    await go('install', { withHook: true, withMcp: true })
    const all = fs.readFileSync(p('.claude', 'settings.json'), 'utf8') + fs.readFileSync(p('.mcp.json'), 'utf8')
    expect(all).not.toMatch(/\d+\.\d+\.\d+\.\d+|password|token|ROKU_/i)
  })

  test('JSONC is refused with a snippet and the file is byte-identical', async () => {
    seed()
    const jsonc = '{\n  // a comment\n  "mcpServers": {}\n}\n'
    fs.writeFileSync(p('.mcp.json'), jsonc)
    const before = fs.readFileSync(p('.claude', 'settings.json'), 'utf8')
    expect(await go('install', { withHook: true, withMcp: true })).toBe(1)
    expect(fs.readFileSync(p('.mcp.json'), 'utf8')).toBe(jsonc)
    expect(out).toContain('not valid JSON')
    expect(out).toContain('"brighttest"')
    expect(fs.readdirSync(cwd).filter((f) => f.includes('bt-tmp'))).toEqual([])
    expect(rd('.claude/settings.json').hooks.PreToolUse).toHaveLength(2) // the hook merge is independent
    expect(fs.readFileSync(p('.claude', 'settings.json'), 'utf8')).not.toBe(before)
  })

  test('a different brighttest server, or wrong-typed keys, are refused untouched', async () => {
    const mcp = JSON.stringify({ mcpServers: { brighttest: { command: 'mine' } } })
    fs.writeFileSync(p('.mcp.json'), mcp)
    fs.mkdirSync(p('.claude'))
    const st = JSON.stringify({ hooks: { PreToolUse: 'nope' } })
    fs.writeFileSync(p('.claude', 'settings.json'), st)
    expect(await go('install', { withHook: true, withMcp: true })).toBe(1)
    expect(fs.readFileSync(p('.mcp.json'), 'utf8')).toBe(mcp)
    expect(fs.readFileSync(p('.claude', 'settings.json'), 'utf8')).toBe(st)
    expect(out).toContain('different "brighttest" server')
    expect(out).toContain('not an array')
  })

  test('uninstall removes only our entries; edited server and other content stay', async () => {
    seed()
    await go('install', { withHook: true, withMcp: true })
    expect(await go('uninstall')).toBe(0)
    const s = rd('.claude/settings.json')
    expect(s.hooks.PreToolUse).toEqual([OTHER_HOOK])
    expect(s.permissions).toEqual({ allow: ['Read'] })
    expect(rd('.mcp.json')).toEqual({ mcpServers: { other: { command: 'other-server' } } })
    // an edited server is left in place
    fs.writeFileSync(p('.mcp.json'), JSON.stringify({ mcpServers: { brighttest: { command: 'node', args: ['x'] } } }))
    await go('install', { withMcp: true }).catch(() => {})
    await go('uninstall')
    expect(rd('.mcp.json').mcpServers.brighttest.args).toEqual(['x'])
  })

  test('uninstall tolerates an unparseable file and --skill leaves config alone', async () => {
    fs.writeFileSync(p('.mcp.json'), '{ // x\n}')
    expect(await go('uninstall')).toBe(0)
    expect(fs.readFileSync(p('.mcp.json'), 'utf8')).toBe('{ // x\n}')
    await go('install', { withHook: true })
    await go('uninstall', { skill: 'writing-rooibos-tests' })
    expect(rd('.claude/settings.json').hooks.PreToolUse).toHaveLength(1)
  })

  test('non-claude target: flags are skipped with a note, no file written', async () => {
    expect(await go('install', { agent: 'cursor', withHook: true, withMcp: true })).toBe(0)
    expect(out).toContain('claude target only')
    expect(fs.existsSync(p('.mcp.json'))).toBe(false)
  })
})
