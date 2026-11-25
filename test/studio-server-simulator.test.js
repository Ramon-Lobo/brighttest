import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-sim-cache-')), 'devices.json')
const studio = require('../lib/studio/server.js')
const { startHub, localLease } = require('../lib/instrument/hub.js')
const { createEventLog } = require('../lib/instrument/events.js')
const { createStateOps } = require('../lib/instrument/state-ops.js')

let srv, hub, dir, stops
afterEach(async () => {
  if (srv) srv.close()
  if (hub) await hub.stop()
  srv = hub = null
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: urlPath }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }))
    }).on('error', reject)
  })
}

async function boot(over = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sim-'))
  stops = 0
  hub = await startHub({ mode: 'headless', host: '127.0.0.1', port: 0, lease: localLease(), tokens: ['a'.repeat(32)], buildToken: 'a'.repeat(32) })
  const info = { target: 'simulator', engine: { name: 'brs-node', version: '9.9.9', flavor: 'stock', source: 'default' }, pid: 1, state: 'running', exitCode: null, tail: [] }
  const sim = {
    net: { hub, proxy: null, redactPaths: [], events: hub.events, log: hub.log, hello: () => ({ hellos: 0, lastHelloAt: null }), redact: {} },
    info: () => ({ ...info, ...over.info }),
    stop: () => { stops++ },
  }
  let args = null
  srv = await studio.start({ port: 0, rootDir: dir, simulator: true, simStart: async (a) => { args = a; return sim }, ...over.opts })
  return { args: () => args }
}

describe('studio server simulator branch', () => {
  it('/api/device reports the simulator target with the sim state', async () => {
    const b = await boot({ info: { state: 'settling' } })
    const r = await get('/api/device')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ connected: true, target: 'simulator', state: 'settling', engine: { name: 'brs-node', flavor: 'stock' } })
    expect(b.args().rootDir).toBe(dir)
  })
  it('/api/state answers 200 with no device and no layers reader', async () => {
    await boot()
    const r = await get('/api/state?layer=global')
    expect(r.status).toBe(200)
    expect(r.json.layers).toBeNull()
    expect(r.json.agentReadFailed).toBe(false)
  })
  it('/api/bt/stream streams in simulator mode', async () => {
    await boot()
    const head = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: srv.address().port, path: '/api/bt/stream' }, (res) => {
        let b = ''
        res.on('data', (c) => { b += c; if (b.includes(': ready')) { req.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'] }) } })
      })
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)))
    })
    expect(head.status).toBe(200)
    expect(head.type).toMatch(/text\/event-stream/)
  })
  it.each(['/api/tree', '/api/screenshot', '/api/keypress', '/api/run', '/api/connect', '/api/launch', '/api/perf/session', '/api/perf/console'])('%s answers 409 SIMULATOR_TARGET', async (p) => {
    await boot()
    const r = await get(p)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('SIMULATOR_TARGET')
    expect(r.json.error).toMatch(/--host/)
  })
  it('/api/net/requests answers 503 NO_HUB with the simulator message', async () => {
    await boot()
    const r = await get('/api/net/requests')
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('NO_HUB')
    expect(r.json.error).toMatch(/simulator/)
  })
  it('close stops the simulator once', async () => {
    await boot()
    srv.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(stops).toBe(1)
  })
  it('refuses --host and a failed simulator start rejects', async () => {
    expect(() => studio.start({ port: 0, simulator: true, host: '10.0.0.1' })).toThrow(/--host/)
    let err
    try { await studio.start({ port: 0, simulator: true, simStart: async () => { throw Object.assign(new Error('nope'), { code: 'ENGINE_MISSING' }) } }) } catch (e) { err = e }
    expect(err.code).toBe('ENGINE_MISSING')
  })
  it('a synchronous throw in the inner start awaits the simulator stop before start() rejects', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sim-'))
    stops = 0
    let stopped = false
    // The inner start throws synchronously (reading net off the started simulator throws); stop is async.
    const sim = { get net() { throw new Error('boom') }, info: () => ({}), stop: () => { stops++; return new Promise((r) => setTimeout(() => { stopped = true; r() }, 30)) } }
    let err
    try { await studio.start({ port: 0, rootDir: dir, simulator: true, simStart: async () => sim }) } catch (e) { err = e }
    expect(err && err.message).toBe('boom')
    expect(stopped).toBe(true)
    expect(stops).toBe(1)
  })
  it('a rejecting simulator stop still rejects start() with the original error, with no unhandled rejection', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sim-'))
    stops = 0
    const unhandled = []
    const onUnhandled = (r) => unhandled.push(r)
    process.on('unhandledRejection', onUnhandled)
    try {
      const sim = { get net() { throw new Error('boom') }, info: () => ({}), stop: () => { stops++; return Promise.reject(new Error('stop failed')) } }
      let err
      try { await studio.start({ port: 0, rootDir: dir, simulator: true, simStart: async () => sim }) } catch (e) { err = e }
      await new Promise((r) => setTimeout(r, 20))
      expect(err && err.message).toBe('boom')
      expect(stops).toBe(1)
      expect(unhandled).toEqual([])
    } finally { process.off('unhandledRejection', onUnhandled) }
  })
  it('a malformed deviceLease.pool with --simulator is a USAGE error, not a crash', () => {
    let err
    try { studio.start({ port: 0, simulator: true, cfg: { deviceLease: { pool: 'not-a-list' } } }) } catch (e) { err = e }
    expect(err && err.code).toBe('USAGE')
    expect(err.message).toMatch(/--simulator/)
  })
  describe('/api/state layers from the hub', () => {
    // A fake hub: state-ops + log, and an auto-acking app that answers `snapshot` with fixed layers.
    function fakeHub({ hellos = 1, answer = true } = {}) {
      const log = createEventLog({ sessionId: 's1' })
      const stateOps = createStateOps({ session: 's1' })
      let seq = 0
      const h = {
        sessionId: 's1', hellos, lastHelloAt: hellos ? 1 : null, log, stateOps, pushed: [], events: log,
        push(cmd, { ack } = {}) {
          const full = { v: 1, id: `c-${++seq}`, ...cmd, seq, session: 's1' }
          stateOps.track(full, { ack, now: Date.now() })
          h.pushed.push(full)
          if (answer) setTimeout(() => {
            stateOps.onAck({ id: full.id, seq, phase: 'received', session: 's1' })
            const result = full.op === 'snapshot' ? { layers: { global: { user: { tier: 'free', password: 'pw' } }, registry: {} } } : undefined
            stateOps.onAck({ id: full.id, seq, phase: 'applied', session: 's1', result })
          }, 5)
          return full
        },
      }
      return h
    }
    async function bootFake(opts) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sim-'))
      const fh = fakeHub(opts)
      const sim = { net: { hub: fh, proxy: null, redactPaths: [], events: fh.events, log: fh.log }, info: () => ({ target: 'simulator' }), stop: () => {} }
      srv = await studio.start({ port: 0, rootDir: dir, simulator: true, simStart: async () => sim })
      return fh
    }
    it('returns the live layers in the device-mode shape (object keyed by layer, masked) when the hub is up', async () => {
      const fh = await bootFake()
      const r = await get('/api/state')
      expect(r.status).toBe(200)
      expect(r.json.layers.global.state.user.tier).toBe('free')
      expect(r.json.layers.global.truncated).toEqual([])
      expect(r.json.layers.global.state.user.password).not.toBe('pw')
      expect(r.json.agentError).toBeNull()
      expect(r.json.agentReadFailed).toBe(false)
      expect(fh.pushed.map((c) => c.op)).toEqual(['snapshot'])
      expect(r.json.commands).toEqual([]) // poll commands stay out of the list
    })
    it('raw=1 returns unmasked layers', async () => {
      await bootFake()
      const r = await get('/api/state?raw=1')
      expect(r.json.layers.global.state.user.password).toBe('pw')
    })
    it('layers is null with a clear message before the app says hello, and nothing is queued', async () => {
      const fh = await bootFake({ hellos: 0 })
      const r = await get('/api/state')
      expect(r.status).toBe(200)
      expect(r.json.layers).toBeNull()
      expect(r.json.agentError).toMatch(/hello/)
      expect(r.json.agentReadFailed).toBe(false)
      expect(fh.pushed).toEqual([])
    })
    it('layers is null with agentReadFailed when the app never acks', async () => {
      await bootFake({ answer: false })
      const r = await get('/api/state')
      expect(r.status).toBe(200)
      expect(r.json.layers).toBeNull()
      expect(r.json.agentReadFailed).toBe(true)
      expect(r.json.agentCode).toBe('ACK_TIMEOUT')
    }, 15000)
  })
})
