import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const setup = require('../lib/setup.js')
const { upsertEnvLine, writeProjectHost, validHost } = require('../lib/env-writer.js')
const { parseSetupArgs } = require('../bin/cli.js')

const stubs = []
let dir
const saved = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-setup-'))
  for (const k of ['ROKU_HOST', 'ROKU_PASSWORD', 'BRIGHTTEST_CACHE']) saved[k] = process.env[k]
  delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'cache.json')
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await Promise.all(stubs.splice(0).map((s) => s.stop()))
  fs.rmSync(dir, { recursive: true, force: true })
})

function capture() {
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out += s; return true })
  return () => out
}
const okCheck = { host: '10.0.0.5', reachable: true, model: '3941X', softwareVersion: '12.5.0', checks: [{ id: 'reachable', ok: true }, { id: 'developer-mode', ok: true }] }
const badCheck = { ...okCheck, checks: [{ id: 'reachable', ok: true }, { id: 'developer-mode', ok: false, fix: 'Enable developer mode' }] }
const base = { isTTY: false, cwd: undefined, inspectDevice: async () => okCheck, discover: async () => [] }
const deps = (o = {}) => ({ ...base, cwd: dir, ...o })

describe('env writer', () => {
  it('replaces the line in place and keeps every other byte', () => {
    expect(upsertEnvLine('A=1\r\nROKU_HOST=1.1.1.1\r\nROKU_PASSWORD=x\r\n', 'ROKU_HOST', '2.2.2.2')).toBe('A=1\r\nROKU_HOST=2.2.2.2\r\nROKU_PASSWORD=x\r\n')
  })
  it('appends when missing, adding a newline if needed', () => {
    expect(upsertEnvLine('A=1', 'ROKU_HOST', '2.2.2.2')).toBe('A=1\nROKU_HOST=2.2.2.2\n')
    expect(upsertEnvLine('', 'ROKU_HOST', '2.2.2.2')).toBe('ROKU_HOST=2.2.2.2\n')
  })
  it('validates bare hosts only', () => {
    for (const bad of ['1.2.3.4:pw', '1.2.3.4,5.6.7.8', '1.2.3.4:8060', '', '999.1.1.1', 'a b']) expect(validHost(bad)).toBe(false)
    for (const good of ['192.168.0.210', 'roku.local']) expect(validHost(good)).toBe(true)
  })
  it('writes a new file with mode 0600, atomically, and ignores .env in a git work tree', () => {
    fs.mkdirSync(path.join(dir, '.git'))
    const r = writeProjectHost(dir, '10.0.0.5')
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('ROKU_HOST=10.0.0.5\n')
    if (process.platform !== 'win32') expect(fs.statSync(r.wrote).mode & 0o777).toBe(0o600)
    expect(r.gitignore).toBe('added')
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('.env\n')
    expect(writeProjectHost(dir, '10.0.0.6').gitignore).toBe('present')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('skips .gitignore outside a git work tree and refuses ip:pw', () => {
    expect(writeProjectHost(dir, '10.0.0.5').gitignore).toBe('skipped')
    expect(() => writeProjectHost(dir, '10.0.0.5:secret')).toThrow(/invalid host/)
  })
})

describe('setup helpers', () => {
  it('detects the shell', () => {
    expect(setup.detectShell({ SHELL: '/usr/bin/fish' }, 'linux')).toBe('fish')
    expect(setup.detectShell({ SHELL: '/bin/zsh' }, 'darwin')).toBe('zsh')
    expect(setup.detectShell({ PSModulePath: 'x' }, 'win32')).toBe('powershell')
    expect(setup.detectShell({}, 'win32')).toBe('cmd')
  })
  it('parses args', () => {
    expect(parseSetupArgs(['--host=1.2.3.4', '--write', '--shell', 'fish', '--json']))
      .toMatchObject({ host: '1.2.3.4', write: true, shell: 'fish', json: true })
  })
})

describe('setup run', () => {
  it('--host --write --json writes .env and reports no secrets', async () => {
    const get = capture()
    const code = await setup.run({ host: '10.0.0.5', write: true, json: true, shell: 'all' }, deps())
    expect(code).toBe(0)
    const j = JSON.parse(get())
    expect(j).toMatchObject({ host: '10.0.0.5', model: '3941X', passwordKnown: false, gitignore: 'skipped' })
    expect(j.lines).toEqual({ posix: 'export ROKU_HOST=10.0.0.5', fish: 'set -gx ROKU_HOST 10.0.0.5', powershell: '$env:ROKU_HOST = "10.0.0.5"', cmd: 'set ROKU_HOST=10.0.0.5' })
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('ROKU_HOST=10.0.0.5\n')
    expect(get()).not.toMatch(/serial/i)
  })
  it('--print never writes; no TTY without --write never writes', async () => {
    capture()
    expect(await setup.run({ host: '10.0.0.5', print: true }, deps())).toBe(0)
    expect(await setup.run({ host: '10.0.0.5' }, deps())).toBe(0)
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false)
  })
  it('a failing check exits 1 and writes nothing, unless --force', async () => {
    const get = capture()
    expect(await setup.run({ host: '10.0.0.5', write: true }, deps({ inspectDevice: async () => badCheck }))).toBe(1)
    expect(get()).toContain('fix: Enable developer mode')
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false)
    expect(await setup.run({ host: '10.0.0.5', write: true, force: true }, deps({ inspectDevice: async () => badCheck }))).toBe(0)
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(true)
  })
  it('refuses ip:pw, lists and bad flags with exit 2 without echoing the value', async () => {
    const get = capture()
    expect(await setup.run({ host: '10.0.0.5:hunter2' }, deps())).toBe(2)
    expect(get()).not.toContain('hunter2')
    expect(await setup.run({ host: '10.0.0.5', write: true, print: true }, deps())).toBe(2)
    expect(await setup.run({ host: '10.0.0.5', shell: 'tcsh' }, deps())).toBe(2)
  })
  it('discovery: one found is used on a TTY after Enter; several without a TTY exit 2; none exits 2', async () => {
    capture()
    const one = [{ host: '10.0.0.5', name: 'Den', model: '3941X' }]
    expect(await setup.run({ write: true }, deps({ isTTY: true, discover: async () => one, ask: async () => '' }))).toBe(0)
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('ROKU_HOST=10.0.0.5\n')
    const two = [...one, { host: '10.0.0.6', name: 'Bed', model: '4800X' }]
    expect(await setup.run({ write: true }, deps({ discover: async () => two }))).toBe(2)
    expect(await setup.run({ write: true }, deps())).toBe(2)
  })
  it('a TTY prompt declines or accepts the write', async () => {
    capture()
    await setup.run({ host: '10.0.0.5' }, deps({ isTTY: true, ask: async () => 'n' }))
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false)
    await setup.run({ host: '10.0.0.5' }, deps({ isTTY: true, ask: async () => '' }))
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(true)
  })
  it('never asks for the password; reports its source only; warns when the environment overrides', async () => {
    process.env.ROKU_PASSWORD = 'sekrit-value'
    const asked = []
    const get = capture()
    await setup.run({ host: '10.0.0.5', write: true }, deps({ isTTY: true, env: { ...process.env, ROKU_HOST: '10.9.9.9' }, ask: async (q) => { asked.push(q); return '' } }))
    expect(asked.join(' ')).not.toMatch(/password/i)
    expect(get()).not.toContain('sekrit-value')
    expect(get()).toContain('known (from the environment)')
    expect(get()).toContain('overrides .env')
  })
  it('keeps ROKU_PASSWORD and other lines in an existing .env', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ROKU_PASSWORD=abc\nROKU_HOST=1.1.1.1\n')
    capture()
    await setup.run({ host: '10.0.0.5', write: true }, deps())
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('ROKU_PASSWORD=abc\nROKU_HOST=10.0.0.5\n')
  })
  it('checks a fake Roku through doctor.inspectDevice (healthy writes, dev-disabled refuses)', async () => {
    for (const [scenario, want] of [['healthy', 0], ['dev-disabled', 1]]) {
      const stub = createFakeRoku({ scenario })
      const a = await stub.start(); stubs.push(stub)
      const get = capture()
      const code = await setup.run({ host: '127.0.0.1', ecpPort: String(a.ecpPort), write: true, json: true }, { cwd: dir, isTTY: false })
      expect(code).toBe(want)
      expect(JSON.parse(get()).checks.find((k) => k.id === 'developer-mode').ok).toBe(want === 0)
      vi.restoreAllMocks(); vi.spyOn(process, 'cwd').mockReturnValue(dir)
    }
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('ROKU_HOST=127.0.0.1\n')
  })
})
