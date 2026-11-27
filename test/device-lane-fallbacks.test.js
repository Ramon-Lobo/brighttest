import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const device = require('../lib/device.js')
const engines = require('../lib/engines.js')
const { loadConfig } = require('../lib/config.js')

// ENG-T14: device-lane fallbacks with a fake child (no device, no network).
let dir, cfg, log
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fb-'))
  cfg = loadConfig(dir, null)
  log = []
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

// pid is left undefined so killTree can never signal a real process group.
function fakeChild({ out = '', code = 0, delay = 5, hang = false, noClose = false } = {}) {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
  c.kill = () => { log.push('kill'); if (!noClose) setTimeout(() => c.emit('close', null, 'SIGKILL'), 1) }
  if (!hang) setTimeout(() => { if (out) c.stdout.emit('data', Buffer.from(out)); c.emit('close', code) }, delay)
  return c
}
const lease = () => ({ addChild: () => {}, release: () => log.push('release') })
let ef = () => ({ kind: 'rooibos', version: '5.16.4', stamp: null })
const base = (extra = {}) => ({
  engineFor: (...a) => ef(...a),
  acquireForLane: async () => { log.push('acquire'); return { lease: lease() } },
  homeBeforeDeploy: async () => { log.push('home'); return null },
  ...extra,
})
const opts = { host: '127.0.0.1', password: 'pw' }
const RESULT = '[Rooibos Result]\n'
const LCOV = 'TN:\nSF:pkg:/source/a.brs\nDA:1,1\nLF:1\nLH:1\nend_of_record\n'

describe('watchdog', () => {
  it('a hung child is killed and the run fails (never passes)', async () => {
    const code = await device.run(cfg, { ...opts, timeout: 0.05 }, base({ spawn: () => { log.push('spawn'); return fakeChild({ hang: true }) } }))
    expect(code).toBe(1)
    expect(log).toContain('kill')
    expect(log.at(-1)).toBe('release')
    expect(process.stderr.write.mock.calls.join('')).toMatch(/TIMED OUT/)
  })
  it('fails even when the killed child never emits close', async () => {
    const code = await device.run(cfg, { ...opts, timeout: 0.05 },
      base({ killGraceMs: 10, spawn: () => fakeChild({ hang: true, noClose: true }) }))
    expect(code).toBe(1)
    expect(log.at(-1)).toBe('release')
  })
  it('a timeout is a failure even if results streamed before it', async () => {
    const code = await device.run(cfg, { ...opts, timeout: 0.05 }, base({ killGraceMs: 10, spawn: () => {
      const c = fakeChild({ hang: true, noClose: true }); setTimeout(() => c.stdout.emit('data', Buffer.from(RESULT)), 1); return c } }))
    expect(code).toBe(1)
  })
})

describe('idle watchdog', () => {
  const errs = () => process.stderr.write.mock.calls.join('')
  it('kills a child that goes silent before the total timeout, with a typed message', async () => {
    const code = await device.run(cfg, { ...opts, timeout: 30, idleTimeout: 0.05 },
      base({ killGraceMs: 10, spawn: () => fakeChild({ hang: true }) }))
    expect(code).toBe(1)
    expect(log).toContain('kill')
    expect(log.at(-1)).toBe('release')
    expect(errs()).toMatch(/run aborted: no device output for 0\.05s \(idle watchdog\)/)
    expect(errs()).not.toMatch(/TIMED OUT/)
  })
  it('output resets the idle timer, so a chatty run is not killed', async () => {
    const code = await device.run(cfg, { ...opts, timeout: 30, idleTimeout: 0.15 }, base({ spawn: () => {
      const c = fakeChild({ hang: true })
      let n = 0
      const t = setInterval(() => { c.stdout.emit('data', Buffer.from('tick\n')); if (++n === 4) { clearInterval(t); c.stdout.emit('data', Buffer.from(RESULT)); c.emit('close', 0) } }, 60)
      return c } }))
    expect(code).toBe(0)
    expect(log).not.toContain('kill')
  })
  const MEM = 'channel: mem=12345 KB\n'
  const beat = (chunk) => () => {
    const c = fakeChild({ hang: true })
    const t = setInterval(() => c.stdout.emit('data', Buffer.from(chunk)), 40)
    c.on('close', () => clearInterval(t))
    return c
  }
  it('mem-only chunks do not extend the idle timeout', async () => {
    const code = await device.run(cfg, { ...opts, timeout: 30, idleTimeout: 0.15 }, base({ killGraceMs: 10, spawn: beat(MEM) }))
    expect(code).toBe(1)
    expect(log).toContain('kill')
    expect(errs()).toMatch(/idle watchdog/)
  })
  it('a mixed chunk re-arms the idle timer', async () => {
    const c0 = fakeChild({ hang: true })
    const code = await device.run(cfg, { ...opts, timeout: 30, idleTimeout: 0.15 }, base({ spawn: () => {
      let n = 0
      const t = setInterval(() => { c0.stdout.emit('data', Buffer.from(MEM + 'tick\n')); if (++n === 5) { clearInterval(t); c0.stdout.emit('data', Buffer.from(RESULT)); c0.emit('close', 0) } }, 60)
      return c0 } }))
    expect(code).toBe(0)
    expect(log).not.toContain('kill')
  })
  it('a non-mem chunk re-arms the idle timer', async () => {
    const c0 = fakeChild({ hang: true })
    const code = await device.run(cfg, { ...opts, timeout: 30, idleTimeout: 0.15 }, base({ spawn: () => {
      let n = 0
      const t = setInterval(() => { c0.stdout.emit('data', Buffer.from('tick\n')); if (++n === 5) { clearInterval(t); c0.stdout.emit('data', Buffer.from(RESULT)); c0.emit('close', 0) } }, 60)
      return c0 } }))
    expect(code).toBe(0)
    expect(log).not.toContain('kill')
  })
  it('idleTimeout 0 disables it', async () => {
    const code = await device.run(cfg, { ...opts, idleTimeout: 0 }, base({ spawn: () => fakeChild({ out: RESULT, delay: 60 }) }))
    expect(code).toBe(0)
  })
})

const REPORT = (crashed, failed, result) => `> SUITE: S >>>>\n<<<< END It: ok (PASS)\n[START TEST REPORT]\n  Total: 2\n  Passed: 1\n  Crashed: ${crashed}\n  Failed: ${failed}\n  Ignored: 0\n  RESULT: ${result}\n[END TEST REPORT]\n[Rooibos Result]: ${result === 'Fail' ? 'FAIL' : 'PASS'}\n`

describe('crashed test = failure', () => {
  it('Crashed: 1 and RESULT: Fail fails and shows 1 failed', async () => {
    const code = await device.run(cfg, opts, base({ spawn: () => fakeChild({ out: REPORT(1, 0, 'Fail') }) }))
    expect(code).toBe(1)
    expect(process.stdout.write.mock.calls.join('')).toMatch(/1 passed, 1 failed/)
  })
  it('RESULT: Fail with no counted failure still fails', async () => {
    const code = await device.run(cfg, opts, base({ spawn: () => fakeChild({ out: REPORT(0, 0, 'Fail') }) }))
    expect(code).toBe(1)
  })
  it('a clean report still passes', async () => {
    const code = await device.run(cfg, opts, base({ spawn: () => fakeChild({ out: REPORT(0, 0, 'Success').replace('Passed: 1', 'Passed: 2') }) }))
    expect(code).toBe(0)
    expect(process.stdout.write.mock.calls.join('')).toMatch(/2 passed, 0 failed/)
  })
})

describe('no result = failure', () => {
  it('exit 0 with empty output fails with a clear message', async () => {
    const code = await device.run(cfg, opts, base({ spawn: () => fakeChild({ out: '', code: 0 }) }))
    expect(code).toBe(1)
    expect(process.stderr.write.mock.calls.join('')).toMatch(/no results/)
  })
  it('streamed cases without a [Rooibos Result] line fail', async () => {
    const out = '> SUITE: Counter >>>>\n<<<< END It: doubles (PASS)\n'
    const code = await device.run(cfg, opts, base({ spawn: () => fakeChild({ out, code: 0 }) }))
    expect(code).toBe(1)
    expect(process.stderr.write.mock.calls.join('')).toMatch(/no results/)
  })
  it('a result line passes', async () => {
    expect(await device.run(cfg, opts, base({ spawn: () => fakeChild({ out: RESULT }) }))).toBe(0)
  })
  it('--lcov with empty coverage fails with a clear message', async () => {
    const code = await device.run(cfg, { ...opts, lcov: path.join(dir, 'lcov.info') }, base({ spawn: () => fakeChild({ out: RESULT }) }))
    expect(code).toBe(1)
    expect(process.stderr.write.mock.calls.join('')).toMatch(/no coverage was returned/)
  })
})

describe('typed abort messages', () => {
  const errs = () => process.stderr.write.mock.calls.join('')
  it('stall marker from the rooibos CLI names the idle period', async () => {
    const out = '> SUITE: Counter >>>>\n[roku-test] no device output for 90s \u2014 run stalled; finishing with results captured so far.\n'
    expect(await device.run(cfg, opts, base({ spawn: () => fakeChild({ out }) }))).toBe(1)
    expect(errs()).toMatch(/run aborted: no device output for 90s \(idle watchdog\)/)
    expect(errs()).not.toMatch(/deploy or device error/)
  })
  it('debugger prompt is a runtime error and names the suite from the output', async () => {
    const out = '> SUITE: Boom first >>>>\nBrightscript Debugger> \n[roku-test] no device output for 90s \u2014 run stalled\n'
    expect(await device.run(cfg, opts, base({ spawn: () => fakeChild({ out }) }))).toBe(1)
    expect(errs()).toMatch(/run aborted by runtime error in Boom first/)
  })
  it('runtime error with no suite header says the suite is unknown', async () => {
    expect(await device.run(cfg, opts, base({ spawn: () => fakeChild({ out: 'Brightscript Debugger> \n' }) }))).toBe(1)
    expect(errs()).toMatch(/runtime error in unknown suite/)
  })
})

describe('pre-deploy Home', () => {
  it('sends Home after acquiring the lease and before spawning', async () => {
    await device.run(cfg, opts, base({ spawn: () => { log.push('spawn'); return fakeChild({ out: RESULT }) } }))
    expect(log).toEqual(['acquire', 'home', 'spawn', 'release'])
  })
  it('a Home keypress request precedes the deploy (spawn), via the createDevice seam', async () => {
    const createDevice = () => ({ keypress: async (k) => { log.push('keypress:' + k) } })
    const { homeBeforeDeploy: _drop, ...rest } = base({ createDevice, sleep: async () => { log.push('settle') },
      spawn: () => { log.push('spawn'); return fakeChild({ out: RESULT }) } })
    expect(await device.run(cfg, opts, rest)).toBe(0)
    expect(log).toEqual(['acquire', 'keypress:Home', 'settle', 'spawn', 'release'])
  })
  it('a failed Home (returned or thrown) warns and does not fail the run', async () => {
    for (const h of [async () => new Error('ECP down'), async () => { throw new Error('boom') }]) {
      const code = await device.run(cfg, opts, base({ homeBeforeDeploy: h, spawn: () => fakeChild({ out: RESULT }) }))
      expect(code).toBe(0)
    }
    expect(process.stderr.write.mock.calls.join('')).toMatch(/Home before deploy failed/)
  })
  it('homeBeforeDeploy presses Home once through the device key path', async () => {
    const keypress = vi.fn(async () => {})
    const createDevice = vi.fn(() => ({ keypress }))
    expect(await device.homeBeforeDeploy(opts, { createDevice, sleep: async () => {} })).toBeNull()
    expect(keypress.mock.calls).toEqual([['Home']])
    const err = await device.homeBeforeDeploy(opts, { createDevice: () => ({ keypress: async () => { throw new Error('x') } }), sleep: async () => {} })
    expect(err.message).toBe('x')
  })
})

describe('--coverage-dir fallback', () => {
  const covDirOf = (args) => { const a = args.find((x) => x.startsWith('--coverage-dir=')); return a && a.slice(15) }
  const sup = (v) => { ef = () => ({ kind: 'rooibos', version: v, stamp: null }) }

  it('passes --coverage-dir only when the engine supports it', async () => {
    let seen
    sup('5.16.4')
    await device.run(cfg, { ...opts, lcov: path.join(dir, 'l.info') }, base({ spawn: (_n, args) => { seen = args; return fakeChild({ out: RESULT }) } }))
    expect(covDirOf(seen)).toBeUndefined()
    sup('5.17.0')
    await device.run(cfg, { ...opts, lcov: path.join(dir, 'l.info') }, base({ spawn: (_n, args) => { seen = args; return fakeChild({ out: RESULT }) } }))
    expect(covDirOf(seen)).toBeTruthy()
  })
  it('does not pass it without --lcov', async () => {
    let seen; sup('5.17.0')
    await device.run(cfg, opts, base({ spawn: (_n, args) => { seen = args; return fakeChild({ out: RESULT }) } }))
    expect(covDirOf(seen)).toBeUndefined()
  })
  it('prefers the coverage-dir lcov.info (full records); the console LCOV is the line-only fallback', async () => {
    sup('5.17.0')
    const dest = path.join(dir, 'out', 'lcov.info')
    const FULL = 'TN:\nSF:pkg:/source/disk.brs\nFN:1,main\nFNDA:1,main\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nBRDA:1,0,0,1\nBRF:1\nBRH:1\nend_of_record\n'
    const put = (args, text) => { fs.mkdirSync(covDirOf(args), { recursive: true }); fs.writeFileSync(path.join(covDirOf(args), 'lcov.info'), text) }
    // folder wins over the console, function and branch records kept, framework records dropped
    let code = await device.run(cfg, { ...opts, lcov: dest }, base({ spawn: (_n, args) => {
      put(args, FULL + 'TN:\nSF:pkg:/components/rooibos/x.brs\nDA:1,1\nLF:1\nLH:1\nend_of_record\n')
      return fakeChild({ out: RESULT + LCOV }) } }))
    expect(code).toBe(0)
    let text = fs.readFileSync(dest, 'utf8')
    expect(text).toContain('disk.brs')
    expect(text).toContain('FNDA:1,main')
    expect(text).toContain('BRDA:1,0,0,1')
    expect(text).not.toContain('a.brs')
    expect(text).not.toContain('rooibos/')
    // empty folder file: console LCOV, line records only
    fs.rmSync(dest)
    code = await device.run(cfg, { ...opts, lcov: dest }, base({ spawn: (_n, args) => { put(args, ''); return fakeChild({ out: RESULT + LCOV }) } }))
    expect(code).toBe(0)
    text = fs.readFileSync(dest, 'utf8')
    expect(text).toContain('a.brs')
    expect(text).not.toMatch(/^(FN|BRDA)/m)
    // missing folder file: console LCOV
    fs.rmSync(dest)
    code = await device.run(cfg, { ...opts, lcov: dest }, base({ spawn: () => fakeChild({ out: RESULT + LCOV }) }))
    expect(code).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toContain('a.brs')
    // engine without coverage-dir: console LCOV, line records only
    sup('5.16.4')
    fs.rmSync(dest)
    code = await device.run(cfg, { ...opts, lcov: dest }, base({ spawn: () => fakeChild({ out: RESULT + LCOV }) }))
    expect(code).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).not.toMatch(/^(FN|BRDA)/m)
  })
  it('fails when both console and coverage-dir are empty', async () => {
    sup('5.17.0')
    const code = await device.run(cfg, { ...opts, lcov: path.join(dir, 'l.info') }, base({ spawn: () => fakeChild({ out: RESULT }) }))
    expect(code).toBe(1)
    expect(process.stderr.write.mock.calls.join('')).toMatch(/--coverage-dir/)
  })
})

describe('supportsFlag', () => {
  it('uses the stamp flags list when present, else the version table', () => {
    expect(engines.supportsFlag({ kind: 'rooibos', version: '5.17.0-bt.1', stamp: null }, 'coverage-dir')).toBe(true)
    expect(engines.supportsFlag({ kind: 'rooibos', version: '5.16.4', stamp: null }, 'coverage-dir')).toBe(false)
    expect(engines.supportsFlag({ kind: 'rooibos', version: '5.17.0', stamp: { flags: [] } }, 'coverage-dir')).toBe(false)
    expect(engines.supportsFlag({ kind: 'rooibos', version: '5.16.4', stamp: { flags: ['coverage-dir'] } }, 'coverage-dir')).toBe(true)
  })
})

describe('idle timeout route (flag, config, rooibos argv)', () => {
  const run = async (o, c = cfg) => {
    let argv = null
    await device.run(c, { ...opts, ...o }, base({ spawn: (_n, a) => { argv = a; return fakeChild({ out: RESULT }) } }))
    return argv
  }
  const idleArg = (a) => a.filter((x) => x.startsWith('--idle-timeout'))
  it('unset: rooibos argv has no --idle-timeout', async () => {
    expect(idleArg(await run({}))).toEqual([])
  })
  it('flag only: passes --idle-timeout', async () => {
    expect(idleArg(await run({ idleTimeout: 5 }))).toEqual(['--idle-timeout=5'])
  })
  it('config only: passes the configured value', async () => {
    expect(idleArg(await run({}, { ...cfg, deviceIdleTimeout: 7 }))).toEqual(['--idle-timeout=7'])
  })
  it('flag beats config', async () => {
    expect(idleArg(await run({ idleTimeout: 5 }, { ...cfg, deviceIdleTimeout: 7 }))).toEqual(['--idle-timeout=5'])
  })
  it('0 is explicit: passed through and disables the lane watchdog', async () => {
    expect(idleArg(await run({ idleTimeout: 0 }))).toEqual(['--idle-timeout=0'])
  })
  it('config value drives the lane watchdog and its abort line', async () => {
    const code = await device.run({ ...cfg, deviceIdleTimeout: 0.05 }, { ...opts, timeout: 30 },
      base({ killGraceMs: 10, spawn: () => fakeChild({ hang: true }) }))
    expect(code).toBe(1)
    expect(process.stderr.write.mock.calls.join('')).toMatch(/no device output for 0\.05s \(idle watchdog\)/)
  })
})
