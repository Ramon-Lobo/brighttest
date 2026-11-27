import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `brighttest issue collect` through the real CLI. Generic fixtures only: invented names, 192.0.2.x addresses, a fake
// password. The fake device is test/fixtures/fake-roku.
const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const ROOT = path.resolve(__dirname, '..')
const CLI = path.join(ROOT, 'bin', 'cli.js')
const PRELOAD = path.join(__dirname, 'support', 'no-network-preload.js')
const PASSWORD = 'SEEDED-PASSWORD-0001'
const SECRET_TOKEN = 'tok_0123456789abcdef0123456789abcdef'

let proj, home, leaseDir
beforeEach(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-collect-proj-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-collect-home-'))
  leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-collect-lease-'))
  fs.writeFileSync(path.join(proj, 'brighttest.json'), JSON.stringify({ stagingDir: '.brighttest', specs: [] }))
  fs.writeFileSync(path.join(proj, '.gitignore'), '.brighttest/\n')
  fs.mkdirSync(path.join(proj, 'source'))
  fs.writeFileSync(path.join(proj, 'source', 'main.brs'), 'sub main()\nend sub\n')
  fs.writeFileSync(path.join(proj, 'source', 'main.spec.brs'), 'sub x()\nend sub\n')
})
afterEach(() => { for (const d of [proj, home, leaseDir]) fs.rmSync(d, { recursive: true, force: true }) })

const baseEnv = (extra = {}) => ({
  PATH: process.env.PATH, HOME: home, USERPROFILE: home, BRIGHTTEST_CACHE: path.join(home, 'devices.json'),
  BRIGHTTEST_LEASE_DIR: leaseDir, ROKU_PASSWORD: PASSWORD, ...extra,
})
const bt = (args, { preload = false, env = {} } = {}) => spawnSync(process.execPath, [...(preload ? ['-r', PRELOAD] : []), CLI, 'issue', ...args], {
  cwd: proj, encoding: 'utf8', env: baseEnv(env),
})
// Async variant: the fake device lives in this process, so a sync spawn would deadlock.
const btAsync = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, 'issue', ...args], { cwd: proj, env: baseEnv(env) })
  let stdout = '', stderr = ''
  c.stdout.on('data', (d) => { stdout += d })
  c.stderr.on('data', (d) => { stderr += d })
  c.on('close', (status) => resolve({ status, stdout, stderr }))
})
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const outDir = () => {
  const root = path.join(proj, '.brighttest', 'issue')
  const [stamp] = fs.readdirSync(root)
  expect(stamp).toMatch(/^\d{8}-\d{6}$/)
  return path.join(root, stamp)
}
const allText = (d) => walk(d).map((f) => fs.readFileSync(f, 'utf8')).join('\n')

describe('issue collect', () => {
  test('a clean run writes the folder, no network, exit 0', () => {
    const r = bt(['collect'], { preload: true, env: { BRIGHTTEST_AGENT: 'tester' } })
    expect(r.status).toBe(0)
    const d = outDir()
    expect(fs.readdirSync(d).sort()).toEqual(['ISSUE.md', 'attachments', 'environment.json', 'redaction.json'])
    const env = JSON.parse(fs.readFileSync(path.join(d, 'environment.json'), 'utf8'))
    expect(env.brighttest).toMatch(/^\d+\.\d+\.\d+/)
    expect(env.node).toMatch(/^\d+\./)
    expect(env.engines.brsNode).toBeTruthy()
    expect(env.configKeys).toEqual(['specs', 'stagingDir'])
    expect(env.envNames).toEqual(expect.arrayContaining(['BRIGHTTEST_AGENT', 'ROKU_PASSWORD']))
    expect(env.project.brs).toBe(2)
    expect(env.device).toBeUndefined()
    const md = fs.readFileSync(path.join(d, 'ISSUE.md'), 'utf8')
    for (const h of ['Summary', 'Severity', 'Area', 'Environment', 'Steps to reproduce', 'Actual behavior', 'Before filing']) expect(md).toContain(`### ${h}`)
    expect(allText(d)).not.toContain(PASSWORD)
    expect(allText(d)).not.toContain('tester') // value of an env var is never written, only the name
    expect(r.stderr).not.toMatch(/not in \.gitignore/)
  })

  test('warns when .brighttest is not gitignored', () => {
    fs.rmSync(path.join(proj, '.gitignore'))
    const r = bt(['collect'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/\.brighttest\/ is not in \.gitignore/)
  })

  test('seeded secrets in --include files never reach stdout, stderr or files', () => {
    const log = path.join(proj, 'run.log')
    fs.writeFileSync(log, `connecting to 192.0.2.77 failed\nAuthorization: Bearer ${SECRET_TOKEN}\npassword=${PASSWORD}\nExamplecorp build ok\n`)
    fs.mkdirSync(path.join(proj, '.brighttest'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.brighttest', 'issue-deny.txt'), 'Examplecorp\n')
    const r = bt(['collect', '--include', log])
    expect(r.status).toBe(0)
    const d = outDir()
    const text = allText(d) + r.stdout + r.stderr
    for (const v of ['192.0.2.77', SECRET_TOKEN, PASSWORD, 'Examplecorp']) expect(text).not.toContain(v)
    const att = fs.readFileSync(path.join(d, 'attachments', 'run.log'), 'utf8')
    expect(att.split('\n').length).toBe(5)
    const red = JSON.parse(fs.readFileSync(path.join(d, 'redaction.json'), 'utf8'))
    expect(Object.keys(red)).toEqual(['counts', 'skippedDenyTerms', 'files', 'leftOut'])
    expect(red.counts.length).toBeGreaterThan(0)
    for (const c of red.counts) expect(Object.keys(c).sort()).toEqual(['kind', 'lines'])
  })

  test('a failure bundle contributes error.json, log-tail.txt and net-refused.txt only', () => {
    const b = path.join(proj, 'bundle')
    fs.mkdirSync(b)
    fs.writeFileSync(path.join(b, 'error.json'), '{"message":"element not found"}\n')
    fs.writeFileSync(path.join(b, 'log-tail.txt'), '1\tstarted\n')
    fs.writeFileSync(path.join(b, 'net-refused.txt'), '1 request refused\n')
    fs.writeFileSync(path.join(b, 'tree.xml'), '<root/>')
    fs.writeFileSync(path.join(b, 'screenshot.png'), Buffer.from([0x89, 0x50, 0, 1]))
    const r = bt(['collect', '--include', b])
    expect(r.status).toBe(0)
    const d = outDir()
    expect(walk(path.join(d, 'attachments')).map((f) => path.relative(d, f).split(path.sep).join('/')).sort()).toEqual([
      'attachments/failure-bundle-1/error.json', 'attachments/failure-bundle-1/log-tail.txt', 'attachments/failure-bundle-1/net-refused.txt',
    ])
    expect(r.stderr).toMatch(/tree\.xml and screenshots left out on purpose/)
  })

  test('size caps, binaries and plain directories are left out with a reason', () => {
    const big = path.join(proj, 'big.log'); fs.writeFileSync(big, 'a'.repeat(1024 * 1024 + 1)) // never read through the redactor: refused on size
    const bin = path.join(proj, 'blob.bin'); fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]))
    const long = path.join(proj, 'long.log'); fs.writeFileSync(long, 'z'.repeat(70 * 1024))
    const dir = path.join(proj, 'plain'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    const ok = []
    for (let i = 0; i < 6; i++) { const f = path.join(proj, `m${i}.log`); fs.writeFileSync(f, 'build step ok\n'.repeat(Math.floor(1000 * 1000 / 14))); ok.push(f) }
    const r = bt(['collect', '--include', long, '--include', big, '--include', bin, '--include', dir, ...ok.flatMap((f) => ['--include', f])])
    expect(r.status).toBe(0)
    const d = outDir()
    const red = JSON.parse(fs.readFileSync(path.join(d, 'redaction.json'), 'utf8'))
    const reasons = red.leftOut.map((l) => l.reason).join('|')
    expect(reasons).toMatch(/larger than 1 MB/)
    expect(reasons).toMatch(/not a text file/)
    expect(reasons).toMatch(/line longer than 64 KB/)
    expect(reasons).toMatch(/not an e2e failure bundle/)
    expect(reasons).toMatch(/total attachments would pass 5 MB/)
    const kept = fs.readdirSync(path.join(d, 'attachments'))
    expect(kept.length).toBe(5)
    expect(kept).not.toContain('big.log')
  })

  test('--host reads a fake device: model and firmware, no serial, no host, no lease, no cache', async () => {
    const stub = createFakeRoku({ scenario: 'healthy' })
    const a = await stub.start()
    try {
      const r = await btAsync(['collect', '--host', '127.0.0.1'], { ROKU_ECP_PORT: String(a.ecpPort || a.ecp) })
      expect(r.status).toBe(0)
      const d = outDir()
      const env = JSON.parse(fs.readFileSync(path.join(d, 'environment.json'), 'utf8'))
      expect(env.device.reachable).toBe(true)
      expect(env.device.model).toBeTruthy()
      expect(env.device.firmware).toBeTruthy()
      const text = allText(d) + r.stdout + r.stderr
      expect(text).not.toContain('FAKE-SERIAL-0001')
      expect(text).not.toContain('127.0.0.1')
      expect(text).not.toContain(PASSWORD)
      expect(Object.keys(env.device)).not.toContain('serial')
      expect(fs.readdirSync(leaseDir)).toEqual([])
      expect(fs.existsSync(path.join(home, 'devices.json'))).toBe(false)
    } finally { await stub.stop() }
  })

  test('an unreachable --host still writes the folder', () => {
    const r = bt(['collect', '--host', '192.0.2.1'], { env: { ROKU_ECP_PORT: '9' } })
    expect(r.status).toBe(0)
    const env = JSON.parse(fs.readFileSync(path.join(outDir(), 'environment.json'), 'utf8'))
    expect(env.device).toEqual({ reachable: false })
  }, 30000)

  test('usage errors exit 2', () => {
    expect(bt(['collect', '--include', path.join(proj, 'missing.log')]).status).toBe(2)
    expect(bt(['collect', '--include']).status).toBe(2)
    expect(bt(['collect', 'file.txt']).status).toBe(2)
    expect(bt(['collect', '--bogus']).status).toBe(2)
    const out = path.join(proj, 'o'); fs.mkdirSync(out); fs.writeFileSync(path.join(out, 'x'), '1')
    expect(bt(['collect', '--out', out]).status).toBe(2)
  })

  test('--out and --area, --json', () => {
    const out = path.join(proj, 'myissue')
    const r = bt(['collect', '--out', out, '--area', 'Headless', '--json'])
    expect(r.status).toBe(0)
    const j = JSON.parse(r.stdout)
    expect(j.leaks).toEqual([])
    expect(j.files).toContain('ISSUE.md')
    expect(fs.readFileSync(path.join(out, 'ISSUE.md'), 'utf8')).toMatch(/### Area\n\nHeadless/)
  })
})
