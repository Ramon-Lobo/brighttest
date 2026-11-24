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

async function boot(env, instrumentExtra = {}, loadedCfg = null) {
  started = []; logs = []
  const log = createEventLog({ sessionId: 'fake' })
  const c = { n: 0 }
  fakeHub = { host: '0.0.0.0', port: 8790, events: new EventEmitter(), log, stop: async () => { c.n++ }, emitLocal(kind, data) { const s = log.push({ src: 'hub', kind, data }); this.events.emit('event', s); return s } }
  stopsOf.set(fakeHub, c)
  const startLanHub = async (o) => { started.push(o); return fakeHub }
  server = await studio.start({
    host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg: loadedCfg || { instrument: { hub: { host: '10.0.0.5', port: 8791 }, ...instrumentExtra }, rootDir: dir },
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

  it('passes instrument.state.redact.paths to the hub so cmd.sent events and the stream are masked', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN }, { state: { redact: { paths: ['global.user.nickname'] } } })
    await get('/api/net/rules')
    expect(started[0].redactPaths).toEqual(['global.user.nickname'])
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

describe('studio hub applies instrument.net.redact from a loaded brighttest.json', () => {
  const { loadConfig } = require('../lib/config.js')
  const { targetFromPath } = require('../lib/instrument/net-proxy.js')
  const cfgWith = (netBlock) => {
    fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ instrument: { hub: { host: '10.0.0.5', port: 8791 }, net: netBlock } }))
    return loadConfig(dir)
  }
  const send = (proxy) => new Promise((resolve) => {
    proxy.ruleSet.add({ id: 'login', url: 'https://api.example.test/login*', status: 200, headers: { 'content-type': 'application/json' }, json: { token: 'SECRET-TEST-VALUE', name: 'keep-me' } })
    const srv = http.createServer((req, res) => { proxy.handle(req, res, targetFromPath('/bt/t/net/;https://api.example.test/login')).catch(() => res.destroy()) })
    srv.listen(0, '127.0.0.1', () => {
      const rq = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => srv.close(resolve)) })
      rq.end(JSON.stringify({ token: 'SECRET-TEST-VALUE', name: 'keep-me' }))
    })
  })

  it('masks a body field in the request list, Mock this and the HAR, but not with ?raw=1', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN }, {}, cfgWith({ redact: { bodyKeys: ['token'] } }))
    await get('/api/net/rules')
    await send(started[0].netProxy)
    const id = (await get('/api/net/requests?raw=1')).json.requests[0].id
    for (const p of ['/api/net/requests', `/api/net/mock-this?id=${id}`, '/api/net/har']) {
      const r = await get(p)
      expect(r.status).toBe(200)
      expect(r.text).not.toContain('SECRET-TEST-VALUE')
      expect(r.text).toContain('keep-me')
    }
    expect((await get('/api/net/requests?raw=1')).text).toContain('SECRET-TEST-VALUE')
  })

  it('reports a bad bodyKeys from the documented key as a net config error (503), not the lease message', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN }, {}, cfgWith({ redact: { bodyKeys: 'token' } }))
    const r = await get('/api/net/rules')
    expect(r.status).toBe(503)
    expect(r.json.error).toMatch(/net config: .*bodyKeys must be an array of strings/)
    expect(r.json.error).not.toMatch(/while Studio holds the device lease/)
    expect(started).toHaveLength(0)
  })
})

describe('studio hub reads instrument.net (NET-STUDIO-CFG)', () => {
  const { loadConfig } = require('../lib/config.js')
  const { targetFromPath } = require('../lib/instrument/net-proxy.js')
  const cfgWith = (netBlock) => {
    fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify({ instrument: { hub: { host: '10.0.0.5', port: 8791 }, net: netBlock } }))
    return loadConfig(dir)
  }
  const sendTo = (proxy, target, method = 'GET') => new Promise((resolve) => {
    const srv = http.createServer((req, res) => { proxy.handle(req, res, targetFromPath(`/bt/t/net/;${target}`)).catch(() => res.destroy()) })
    srv.listen(0, '127.0.0.1', () => {
      http.request({ host: '127.0.0.1', port: srv.address().port, method, path: '/' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => srv.close(() => resolve({ status: res.statusCode, body: b }))) }).end()
    })
  })
  let origin
  afterEach(() => { if (origin) origin.close(); origin = null })
  const startOrigin = () => new Promise((resolve) => {
    origin = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ secret: 'SECRET-TEST-VALUE', ok: 1 })) })
    origin.listen(0, '127.0.0.1', () => resolve(origin.address().port))
  })

  it('passes through to an allow-listed origin, refuses others, masks jsonPaths, and 404s mock-this on a refused id', async () => {
    const op = await startOrigin()
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN }, {}, cfgWith({ upstreamHosts: [`127.0.0.1:${op}`], unmatched: 'passthrough', redact: { bodyKeys: ['secret'] } }))
    await get('/api/net/rules')
    const proxy = started[0].netProxy
    const okRes = await sendTo(proxy, `http://127.0.0.1:${op}/data`)
    expect(okRes.status).toBe(200)
    const bad = await sendTo(proxy, 'http://127.0.0.1:1/nope')
    expect(bad.status).toBe(403)
    const list = (await get('/api/net/requests?raw=1')).json.requests
    const good = list.find((r) => r.source === 'passthrough')
    const refused = list.find((r) => r.source === 'refused')
    expect(good && refused).toBeTruthy()
    expect(refused.bytes).toBeNull()
    for (const p of ['/api/net/requests', `/api/net/mock-this?id=${good.id}`, '/api/net/har']) {
      const r = await get(p)
      expect(r.status).toBe(200)
      expect(r.text).not.toContain('SECRET-TEST-VALUE')
    }
    const m = await get(`/api/net/mock-this?id=${refused.id}`)
    expect(m.status).toBe(404)
    expect(m.json.code).toBe('NOT_FOUND')
  })

  it('refuses passthrough when no upstreamHosts are configured', async () => {
    const op = await startOrigin()
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN }, {}, cfgWith({ unmatched: 'passthrough' }))
    await get('/api/net/rules')
    expect((await sendTo(started[0].netProxy, `http://127.0.0.1:${op}/data`)).status).toBe(403)
  })

  it('fails hub start on an invalid unmatched with the headless error text, shown as the panel message', async () => {
    await boot({ BRIGHTTEST_HUB_TOKEN: TOKEN }, {}, cfgWith({ unmatched: 'bogus' }))
    const r = await get('/api/net/rules')
    expect(r.status).toBe(503)
    expect(r.json.error).toContain('instrument.net.unmatched must be "fail" or "passthrough"')
    expect(started).toHaveLength(0)
  })
})
