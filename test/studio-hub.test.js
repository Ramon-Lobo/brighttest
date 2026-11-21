import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-hub-cache-')), 'devices.json')
const studio = require('../lib/studio/server.js')
const { createEventLog } = require('../lib/instrument/events.js')

// STUDIO-HUB-WIRE: Studio starts the instrument hub while it holds the lease. Fake hub, real lease in a temp dir.
const TOKEN = '0123456789abcdef0123456789abcdef' // dummy
let dir, server, port, logs, started, fakeHub
const stopsOf = new WeakMap()
const stopCount = () => stopsOf.get(fakeHub).n

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
    }).on('error', reject)
  })
}

async function boot(env) {
  started = []; logs = []
  const log = createEventLog({ sessionId: 'fake' })
  const c = { n: 0 }
  fakeHub = { host: '0.0.0.0', port: 8790, events: new EventEmitter(), log, stop: async () => { c.n++ }, emitLocal(kind, data) { const s = log.push({ src: 'hub', kind, data }); this.events.emit('event', s); return s } }
  stopsOf.set(fakeHub, c)
  const startLanHub = async (o) => { started.push(o); return fakeHub }
  server = await studio.start({
    host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg: { instrument: { hub: { host: '10.0.0.5', port: 8791 } }, rootDir: dir },
    hubOpts: { startLanHub, env },
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20, log: (s) => logs.push(s) },
  })
  port = server.address().port
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-hub-')) })
afterEach(() => { if (server) server.close(); server = null })

describe('studio hub lifecycle', () => {
  it('starts the hub with the configured port and the env token once the lease is held', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN })
    expect(started).toHaveLength(0) // no lease yet
    const r = await get('/api/net/rules')
    expect(r.status).toBe(200)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ deviceHost: '127.0.0.1', port: 8791, tokens: [TOKEN] })
    expect(typeof started[0].netProxy.handle).toBe('function')
  })

  it('reports hellos and lastHelloAt from the hub in /api/net/requests', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN })
    let r = await get('/api/net/requests')
    expect(r.json).toMatchObject({ total: 0, hellos: 0, lastHelloAt: null })
    fakeHub.hellos = 2; fakeHub.lastHelloAt = 1700000000000
    r = await get('/api/net/requests')
    expect(r.json).toMatchObject({ total: 0, hellos: 2, lastHelloAt: 1700000000000 })
    expect(r.text).not.toContain(TOKEN)
  })

  it('writes proxy traffic into the hub log', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN })
    await get('/api/net/rules')
    const proxy = started[0].netProxy
    expect(proxy).toBeTruthy()
    // the proxy was built with an emit that targets the hub
    const before = fakeHub.log.lastSeq
    fakeHub.emitLocal('net.request', { id: 'r-1' })
    expect(fakeHub.log.lastSeq).toBe(before + 1)
  })

  it('stops the hub when the server stops', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN })
    await get('/api/net/rules')
    server.close(); server = null
    await new Promise((r) => setTimeout(r, 50))
    expect(stopCount()).toBe(1)
  })

  it('stops the hub when the lease is released from the UI', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN })
    await get('/api/net/rules')
    await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/lease', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve) })
      r.on('error', reject); r.end(JSON.stringify({ action: 'release' }))
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(stopCount()).toBe(1)
  })

  it('does not start the hub without a valid token; the message names the env var and no token leaks', async () => {
    for (const env of [{}, { BRIGHTTEST_HUB_TOKEN: 'NOT-HEX-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' }]) {
      await boot(env)
      const r = await get('/api/net/rules')
      expect(r.status).toBe(503)
      expect(r.json.code).toBe('NO_HUB')
      expect(r.json.error).toContain('BRIGHTTEST_HUB_TOKEN')
      expect(started).toHaveLength(0)
      expect(r.text + logs.join('\n')).not.toContain('NOT-HEX')
      server.close(); server = null
    }
  })

  it('never puts a valid token in logs or responses, even when the hub fails to start', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN })
    server.close(); server = null
    logs = []
    server = await studio.start({
      host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg: { rootDir: dir },
      hubOpts: { env: { BRIGHTTEST_HUB_TOKEN: TOKEN }, startLanHub: async () => { throw new Error(`boom ${TOKEN}`) } },
      leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20, log: (s) => logs.push(s) },
    })
    port = server.address().port
    const r = await get('/api/net/rules')
    expect(r.status).toBe(503)
    expect(r.text + logs.join('\n')).not.toContain(TOKEN)
  })
})
