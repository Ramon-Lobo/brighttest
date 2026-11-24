import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { startSimulator, createTail, WATCHDOG } = require('../lib/studio/simulator.js')
const engines = require('../lib/engines.js')

let dir, calls, hub, child, spawnArgs, buildArgs, killed
const stockEng = { kind: 'brsNode', name: 'brs-node', dir: path.resolve(__dirname, '..'), version: '2.7.1', flavor: 'stock', bin: 'brs-cli' }
const patchedEng = { ...stockEng, name: '@ramonlobo/brs-node', version: '2.2.0', flavor: 'patched' }

function fakeChild() {
  const c = new EventEmitter()
  c.pid = 424242
  c.stdout = new PassThrough(); c.stderr = new PassThrough()
  c.signals = []
  c.kill = (sig) => { c.signals.push(sig); if (!c.stubborn || sig === 'SIGKILL') setImmediate(() => c.emit('exit', null, sig)); return true }
  return c
}
function seam(over = {}) {
  return {
    resolveEngine: (kind, mode) => { calls.push(`engine:${mode}`); return mode === 'patched' || mode === '@ramonlobo/brs-node' ? patchedEng : stockEng },
    env: {},
    startHub: async (o) => { calls.push('hub'); hub.opts = o; return hub },
    build: async (cfg, o) => { calls.push('build'); buildArgs = o; return { exitCode: 0, out: o.out, lines: [] } },
    spawn: (cmd, args, o) => { calls.push('spawn'); spawnArgs = { cmd, args, o }; child = fakeChild(); return child },
    isAlive: () => true, commandOf: () => 'node /x/node_modules/brs-node/bin/brs.cli.js app.zip',
    kill: (pid, sig) => { killed.push([pid, sig]) },
    settleMs: 40, helloTimeoutMs: 400, pollMs: 5, killGraceMs: 60,
    ...over,
  }
}
const cfgOf = (extra = {}) => ({ stagingDir: dir, instrument: {}, ...extra })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sim-'))
  calls = []; killed = []
  hub = { port: 4321, hellos: 0, lastHelloAt: null, events: new EventEmitter(), log: {}, stop: async () => { calls.push('hub.stop') } }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const hello = () => { hub.hellos++; hub.lastHelloAt = Date.now() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('startSimulator', () => {
  it('starts in order: engine, hub, build, spawn; bakes the hub port and a 32-hex token', async () => {
    const sim = await startSimulator({ cfg: cfgOf(), log: () => {}, seam: seam() })
    expect(calls).toEqual(['engine:stock', 'hub', 'build', 'spawn'])
    expect(hub.opts).toMatchObject({ mode: 'headless', host: '127.0.0.1', port: 0 })
    expect(hub.opts.tokens[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(buildArgs.token).toBe(hub.opts.tokens[0])
    expect(hub.opts.buildToken).toBe(buildArgs.token)
    expect(buildArgs.hub).toEqual({ host: '127.0.0.1', port: 4321 })
    expect(sim.info().state).toBe('starting')
    expect(sim.net.hub).toBe(hub)
    await sim.stop()
  })

  it('spawns node -r sim-watchdog.js <brs-cli> <app.zip> with an ipc slot, and writes child.pid', async () => {
    const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
    expect(spawnArgs.cmd).toBe(process.execPath)
    expect(spawnArgs.args[0]).toBe('-r')
    expect(spawnArgs.args[1]).toBe(WATCHDOG)
    expect(path.basename(WATCHDOG)).toBe('sim-watchdog.js')
    expect(spawnArgs.args[2]).toBe(engines.binOf(stockEng))
    expect(spawnArgs.args[3]).toBe(path.join(dir, 'simulator', 'app.zip'))
    expect(spawnArgs.args).toHaveLength(4)
    expect(spawnArgs.o.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc'])
    expect(fs.readFileSync(path.join(dir, 'simulator', 'child.pid'), 'utf8')).toBe('424242')
    await sim.stop()
  })

  it('a failed build stops the hub and throws with the build lines', async () => {
    const s = seam({ build: async () => ({ exitCode: 1, out: null, lines: ['boom line'] }) })
    await expect(startSimulator({ cfg: cfgOf(), seam: s })).rejects.toThrow(/boom line/)
    expect(calls).toContain('hub.stop')
    expect(calls).not.toContain('spawn')
  })

  describe('engine choice', () => {
    it('default source picks stock', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
      expect(calls[0]).toBe('engine:stock')
      expect(sim.info().engine).toEqual({ name: 'brs-node', version: '2.7.1', flavor: 'stock', source: 'default' })
      await sim.stop()
    })
    it('explicit cfg wins and an explicit patched choice logs the hang warning', async () => {
      const logs = []
      const sim = await startSimulator({ cfg: cfgOf({ engines: { brsNode: 'patched' } }), log: (l) => logs.push(l), seam: seam() })
      expect(calls[0]).toBe('engine:patched')
      expect(logs.join('\n')).toMatch(/known to hang on Tasks/)
      expect(sim.info().engine.source).toBe('config')
      await sim.stop()
    })
    it('explicit env wins over a default', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam({ env: { BRIGHTTEST_ENGINES: 'patched' } }) })
      expect(calls[0]).toBe('engine:patched')
      expect(sim.info().engine.source).toBe('env')
      await sim.stop()
    })
    it('a missing engine throws the resolver error before anything starts', async () => {
      const s = seam({ resolveEngine: () => { throw new engines.EngineError('brs-node engine not found. Install it with: npm i brs-node', 'ENGINE_MISSING') } })
      await expect(startSimulator({ cfg: cfgOf(), seam: s })).rejects.toMatchObject({ code: 'ENGINE_MISSING' })
      expect(calls).toEqual([])
    })
  })

  describe('settle rule', () => {
    it('running after settleMs of quiet; a second hello restarts the window', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam({ settleMs: 120 }) })
      hello()
      await sleep(30)
      expect(sim.info().state).toBe('settling')
      await sleep(60); hello() // inside the window: restarts it
      await sleep(80)
      expect(sim.info().state).toBe('settling')
      await sim.ready()
      expect(sim.info().state).toBe('running')
      expect(Date.now() - hub.lastHelloAt).toBeGreaterThanOrEqual(115)
      await sim.stop()
    })
    it('no hello: no-hello state and ready() rejects SIM_NO_HELLO; the child keeps running until stop', async () => {
      const logs = []
      const sim = await startSimulator({ cfg: cfgOf({ engines: { brsNode: 'patched' } }), log: (l) => logs.push(l), seam: seam({ helloTimeoutMs: 50 }) })
      child.stdout.write('engine said hi\n')
      await expect(sim.ready()).rejects.toMatchObject({ code: 'SIM_NO_HELLO' })
      expect(sim.info().state).toBe('no-hello')
      expect(child.signals).toEqual([])
      expect(logs.join('\n')).toMatch(/engine said hi/)
      expect(logs.join('\n')).toMatch(/set engines.brsNode: stock/)
      await sim.stop()
      expect(child.signals[0]).toBe('SIGTERM')
    })
    it('a crash shows state exited, the exit code and the tail', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
      child.stderr.write('fatal thing\n')
      await sleep(5)
      child.emit('exit', 3, null)
      await expect(sim.ready()).rejects.toMatchObject({ code: 'SIM_EXITED' })
      expect(sim.info()).toMatchObject({ state: 'exited', exitCode: 3 })
      expect(sim.info().tail).toContain('fatal thing')
      await sim.stop()
    })
  })

  describe('stale child.pid', () => {
    const pidFile = () => path.join(dir, 'simulator', 'child.pid')
    beforeEach(() => { fs.mkdirSync(path.join(dir, 'simulator'), { recursive: true }); fs.writeFileSync(pidFile(), '999999') })
    it.skipIf(process.platform === 'win32')('is killed when the command line matches brs.cli.js, then the file is replaced', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
      expect(killed).toEqual([[999999, 'SIGKILL']])
      expect(fs.readFileSync(pidFile(), 'utf8')).toBe('424242')
      await sim.stop()
    })
    it('is not killed when the command line does not match; the file is still deleted', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam({ commandOf: () => 'node some-other.js' }) })
      expect(killed).toEqual([])
      await sim.stop()
    })
    it('is not killed when the pid is dead', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam({ isAlive: () => false }) })
      expect(killed).toEqual([])
      await sim.stop()
    })
  })

  describe('stop', () => {
    it('is idempotent, kills the child, removes the pid file and stops the hub once', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
      const a = sim.stop(); const b = sim.stop()
      expect(a).toBe(b)
      await a
      await sim.stop()
      expect(child.signals).toEqual(['SIGTERM'])
      expect(fs.existsSync(path.join(dir, 'simulator', 'child.pid'))).toBe(false)
      expect(calls.filter((c) => c === 'hub.stop')).toHaveLength(1)
      expect(sim.info().state).toBe('exited')
    })
    it('escalates to SIGKILL when SIGTERM is ignored', async () => {
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
      child.stubborn = true
      await sim.stop()
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    })
    it('removes its process listeners', async () => {
      const before = [process.listenerCount('exit'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
      const sim = await startSimulator({ cfg: cfgOf(), seam: seam() })
      expect(process.listenerCount('exit')).toBe(before[0] + 1)
      await sim.stop()
      expect([process.listenerCount('exit'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before)
    })
  })
})

describe('output ring', () => {
  it('keeps at most the last N lines and joins split chunks', () => {
    const t = createTail(3)
    t.push('ab'); t.push('c\nd\n')
    expect(t.lines()).toEqual(['abc', 'd'])
    const t2 = createTail(3)
    for (let i = 0; i < 10; i++) t2.push(`l${i}\n`)
    expect(t2.lines()).toEqual(['l7', 'l8', 'l9'])
    t2.push('part')
    expect(t2.lines()).toEqual(['l7', 'l8', 'l9', 'part'])
  })
})

describe('binOf', () => {
  it('returns the same path as engineBin', () => {
    const paths = [path.resolve(__dirname, '..')]
    const eng = engines.engineFor('rooibos', {}, { paths })
    expect(engines.binOf(eng)).toBe(engines.engineBin('rooibos', {}, { paths }))
  })
})
