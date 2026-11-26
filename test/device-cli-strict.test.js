import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.join(__dirname, '..', 'bin', 'cli.js')
const isWin = process.platform === 'win32'

// Strict arguments and exit codes of the read-only device commands (status, log, watch). Real CLI, temp lease dirs only,
// documentation addresses (192.0.2.x) that are never contacted (--no-probe / early exit).
describe('device status/log/watch strict arguments (LMON-CLI-STRICT)', () => {
  let root; let good
  const cleanup = []
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-strict-'))
    good = path.join(root, 'good')
    fs.mkdirSync(good)
  })
  afterAll(() => {
    for (const f of cleanup) { try { f() } catch { /* best effort */ } }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const run = (args, dir = good) => spawnSync(process.execPath, [cli, 'device', ...args], {
    env: { ...process.env, BRIGHTTEST_LEASE_DIR: dir }, encoding: 'utf8', timeout: 20000,
  })

  describe.each([['status', ['--json']], ['log', []], ['watch', ['--once', '--no-probe']]])('%s', (action, extra) => {
    it('exits 2 with a usage line on an unknown flag', () => {
      const r = run([action, ...extra, '--bogus'])
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('unknown option(s)')
      expect(r.stderr).toContain('--bogus')
      expect(r.stderr).toContain(`usage: brighttest device ${action}`)
    })
    it('exits 2 on a stray positional argument', () => {
      expect(run([action, ...extra, 'extra']).status).toBe(2)
    })
  })

  it('watch with --host and an unknown flag exits 2 instead of looping', () => {
    const r = run(['watch', '--host', '192.0.2.1', '--no-probe', '--bogus'])
    expect(r.status).toBe(2)
  })

  it.each([['abc'], ['0'], ['-3'], ['5x'], ['1.5'], ['']])('--tail %j is rejected for log and watch', (v) => {
    for (const a of [['log'], ['watch', '--once', '--no-probe']]) {
      const r = run([...a, '--tail', v])
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('--tail needs a whole number')
    }
  })
  it('--tail has an upper bound (200 for watch, 10000 for log)', () => {
    expect(run(['watch', '--once', '--no-probe', '--tail', '201']).status).toBe(2)
    expect(run(['log', '--tail', '10001']).status).toBe(2)
    expect(run(['watch', '--once', '--no-probe', '--tail', '200']).status).toBe(0)
    expect(run(['log', '--tail', '10000']).status).toBe(0)
  })
  it('--tail with no value exits 2', () => {
    expect(run(['log', '--tail']).status).toBe(2)
  })
  it('status does not take --tail: exit 2 with the usage line', () => {
    for (const v of ['5', 'abc']) {
      const r = run(['status', '--tail', v])
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('unknown option(s)')
      expect(r.stderr).toContain('--tail')
      expect(r.stderr).toContain('usage: brighttest device status')
      expect(r.stderr).not.toContain('undefined')
    }
    expect(run(['status', '--tail=5']).status).toBe(2)
  })
  it.each([['status', ['--json']], ['log', []], ['watch', ['--once', '--no-probe']]])('%s: --host with no value says it needs a value', (action, extra) => {
    const r = run([action, ...extra, '--host'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--host needs a value')
    expect(r.stderr).not.toContain('unknown option')
  })
  it.each([['log'], ['watch', '--once', '--no-probe']])('%s: --tail with no value says it needs a value', (...a) => {
    const r = run([...a, '--tail'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--tail needs a value')
  })
  it('accepts a positive --tail and a missing or empty lease dir', () => {
    expect(run(['log', '--tail', '5']).status).toBe(0)
    expect(run(['status', '--json']).status).toBe(0)
    expect(run(['watch', '--once', '--no-probe']).status).toBe(0)
    expect(run(['status', '--json'], path.join(root, 'does-not-exist')).status).toBe(0)
    expect(run(['watch', '--once', '--no-probe'], path.join(root, 'does-not-exist')).status).toBe(0)
  })

  it('a lease dir that is a file exits 78 for watch, status and log', () => {
    const f = path.join(root, 'a-file')
    fs.writeFileSync(f, 'x')
    for (const a of [['watch', '--once', '--no-probe'], ['watch', '--json', '--no-probe'], ['status'], ['log']]) {
      const r = run(a, f)
      expect(r.status).toBe(78)
      expect(r.stderr).toContain('lease dir is not usable')
    }
  })

  it.skipIf(isWin)('an unreadable lease dir (mode 000) exits 78 for watch, status and log', () => {
    const d = path.join(root, 'locked')
    fs.mkdirSync(d)
    fs.chmodSync(d, 0o000)
    cleanup.push(() => fs.chmodSync(d, 0o700))
    try {
      // root can read anything: skip the assertion when the mode is not enforced
      try { fs.readdirSync(d); return } catch { /* enforced */ }
      for (const a of [['watch', '--once', '--no-probe'], ['status', '--json'], ['log']]) expect(run(a, d).status).toBe(78)
    } finally { fs.chmodSync(d, 0o700) }
  })
})
