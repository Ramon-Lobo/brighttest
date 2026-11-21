import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const lease = require('../lib/device-lease.js')
const studio = require('../lib/studio/server.js')
const { createEventLog } = require('../lib/instrument/events.js')
const { startHarness, request } = require('./fixtures/net/harness.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// TP-NET-29 route cases: /api/bt/stream and /api/net/* against a fake hub (net proxy + event log) and a temp lease dir.
// Hosts are synthetic (example.test); nothing leaves loopback. Secrets below are fixtures, not credentials.
let dir, fake, server, port, prevPort, harness, log, bus
const key = () => `127.0.0.1_p${process.env.ROKU_ECP_PORT}`
const other = () => lease.acquire({ dir, key: key(), agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, timers: false, identity: {} })

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
    })
    r.on('error', reject)
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body))
    r.end()
  })
}

// Open the SSE stream; resolves with { res, events(), close() } once the ready comment arrived.
function openStream(p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let buf = ''; const events = []
      res.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
          if (data) events.push(JSON.parse(data))
          if (frame === ': ready') resolve({ res, status: res.statusCode, headers: res.headers, events, close: () => r.destroy() })
        }
      })
      if (res.statusCode !== 200) { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ res, status: res.statusCode, text: b, events, close() {} })) }
    })
    r.on('error', reject)
  })
}
const until = async (fn, what) => { for (let i = 0; i < 250 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); if (!fn()) throw new Error(`timed out waiting for ${what}`) }

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-net-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  log = createEventLog({ sessionId: 'sess1' })
  bus = new EventEmitter()
  harness = await startHarness({ emit: (kind, data) => bus.emit('event', log.push({ src: 'hub', kind, data })) })
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, net: { proxy: harness.proxy, events: bus, log },
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
})
afterEach(async () => {
  server.close(); await harness.stop(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

const SECRET_URL = 'https://api.example.test/v1/home?page=1&access_token=abc123secret'
// A mocked exchange carrying secrets in the request and the response.
async function seed() {
  harness.proxy.ruleSet.add({ id: 'home', url: 'https://api.example.test/v1/home*', status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=cookie-secret' }, json: { title: 'Hero', token: 'resp-secret-1' } })
  const r = await request(harness.base + SECRET_URL, { headers: { authorization: 'Bearer auth-secret-1', 'x-trace': 'ok' } })
  expect(r.status).toBe(200)
}

describe('/api/bt/stream', () => {
  it('replays the backlog then pushes live net events, with the documented envelope and redacted headers', async () => {
    await seed()
    const s = await openStream('/api/bt/stream')
    expect(s.status).toBe(200)
    expect(s.headers['content-type']).toMatch(/text\/event-stream/)
    await until(() => s.events.length >= 2, 'backlog')
    expect(s.events.map((e) => e.kind)).toEqual(['net.request', 'net.response'])
    expect(s.events[0]).toMatchObject({ v: 1, seq: 1, session: 'sess1', src: 'hub', kind: 'net.request', data: { id: 'r-1', method: 'GET', rule: 'home' } })
    expect(typeof s.events[0].ts).toBe('number')
    expect(s.events[0].data.headers.authorization).toBe('<redacted:authorization>')
    expect(s.events[0].data.url).not.toContain('abc123secret')
    // live
    await request(harness.base + 'https://api.example.test/v1/live')
    await until(() => s.events.some((e) => e.kind === 'net.error'), 'live event')
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    // ?after skips what the client already has
    const s2 = await openStream('/api/bt/stream?after=3')
    expect(s2.events.map((e) => e.seq)).toEqual([4])
    s.close(); s2.close()
    expect(JSON.stringify([...s.events, ...s2.events])).not.toMatch(/auth-secret-1|abc123secret|cookie-secret/)
  })

  it('refuses with 423 when another process holds the lease, and 405 on a write method', async () => {
    const o = await other()
    const s = await openStream('/api/bt/stream')
    expect(s.status).toBe(423)
    o.release()
    expect((await req('POST', '/api/bt/stream', {})).status).toBe(405)
  })
})

describe('/api/net/requests', () => {
  it('lists redacted entries by default and raw only with raw=1', async () => {
    await seed()
    const red = await req('GET', '/api/net/requests')
    expect(red.status).toBe(200)
    expect(red.json.raw).toBe(false)
    expect(red.json.requests).toHaveLength(1)
    const e = red.json.requests[0]
    expect(e).toMatchObject({ id: 'r-1', method: 'GET', host: 'api.example.test', status: 200, source: 'mock', rule: 'home' })
    expect(e.bytes).toBeGreaterThan(0)
    expect(e.headers.authorization).toBe('<redacted:authorization>')
    expect(e.headers['x-trace']).toBe('ok')
    expect(red.text).not.toMatch(/auth-secret-1|abc123secret/)
    const raw = await req('GET', '/api/net/requests?raw=1')
    expect(raw.json.raw).toBe(true)
    expect(raw.json.requests[0].headers.authorization).toBe('Bearer auth-secret-1')
    expect(raw.json.requests[0].url).toContain('abc123secret')
  })

  it('carries no hello fields as numbers when the hub reports none', async () => {
    const r = await req('GET', '/api/net/requests')
    expect(r.json.hellos).toBeNull()
    expect(r.json.lastHelloAt).toBeNull()
  })

  it('bounds the list with limit', async () => {
    for (let i = 0; i < 3; i++) await request(harness.base + `https://api.example.test/v1/n${i}`)
    const r = await req('GET', '/api/net/requests?limit=2')
    expect(r.json.total).toBe(3)
    expect(r.json.requests.map((x) => x.id)).toEqual(['r-2', 'r-3'])
  })
})

describe('/api/net/mock-this', () => {
  it('turns a captured exchange into a redacted rule and a mockHttp step the runtime accepts', async () => {
    await seed()
    const r = await req('GET', '/api/net/mock-this?id=r-1')
    expect(r.status).toBe(200)
    expect(r.json.rule).toEqual({
      method: 'GET', url: 'https://api.example.test/v1/home?page=1&access_token=*', status: 200,
      headers: { 'content-type': 'application/json' }, json: { title: 'Hero', token: 'resp-secret-1' },
    })
    expect(r.json.step).toBe(`- mockHttp: ${JSON.stringify(r.json.rule)}`)
    expect(r.text).not.toMatch(/abc123secret|cookie-secret|auth-secret-1/)
    // the rule round-trips: POSTing it back as a live rule then matches the same request
    const added = await req('POST', '/api/net/rules', r.json.rule)
    expect(added.status).toBe(200)
    const again = await request(harness.base + 'https://api.example.test/v1/home?page=1&access_token=other')
    expect(again.status).toBe(200)
  })

  it('404 for an unknown id, 413 when the response body is too large to inline', async () => {
    expect((await req('GET', '/api/net/mock-this?id=r-99')).status).toBe(404)
    harness.proxy.ruleSet.add({ url: 'https://api.example.test/big', body: 'x'.repeat(300 * 1024) })
    await request(harness.base + 'https://api.example.test/big')
    const r = await req('GET', '/api/net/mock-this?id=r-1')
    expect(r.status).toBe(413)
    expect(r.json.code).toBe('TOO_LARGE')
  })
})

describe('/api/net/har', () => {
  it('exports a valid HAR 1.2 with secrets redacted', async () => {
    await seed()
    const r = await req('GET', '/api/net/har')
    expect(r.status).toBe(200)
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="brighttest-network\.har"/)
    expect(r.json.log.version).toBe('1.2')
    expect(r.json.log.creator.name).toBe('brighttest')
    expect(r.json.log.entries).toHaveLength(1)
    const en = r.json.log.entries[0]
    expect(en.request.url).not.toContain('abc123secret')
    expect(en.request.headers.find((h) => h.name === 'authorization').value).toBe('<redacted:authorization>')
    expect(en.response.headers.find((h) => h.name === 'set-cookie').value).toBe('<redacted:set-cookie>')
    expect(r.text).not.toMatch(/auth-secret-1|abc123secret|cookie-secret/)
  })
})

describe('/api/net/rules', () => {
  it('lists, adds a mock and a fault, and clears run-time rules', async () => {
    expect((await req('GET', '/api/net/rules')).json).toEqual({ rules: [], recording: false })
    const m = await req('POST', '/api/net/rules', { url: 'https://api.example.test/a', status: 201, body: 'hi' })
    expect(m.status).toBe(200)
    expect(m.json.rules).toHaveLength(1)
    const f = await req('POST', '/api/net/rules', { url: 'https://api.example.test/b', kind: 'status', status: 503 })
    expect(f.status).toBe(200)
    expect(f.json.rules).toHaveLength(2)
    expect((await request(harness.base + 'https://api.example.test/a')).status).toBe(201)
    expect((await request(harness.base + 'https://api.example.test/b')).status).toBe(503)
    const del = await req('DELETE', '/api/net/rules')
    expect(del.status).toBe(200)
    expect(del.json.rules).toEqual([])
  })

  it('rejects a bad rule and bad JSON with 400', async () => {
    expect((await req('POST', '/api/net/rules', { status: 'nope' })).status).toBe(400)
    expect((await req('POST', '/api/net/rules', '{not json')).status).toBe(400)
  })

  it('refuses every write with 423 while another process holds the lease, and changes nothing', async () => {
    const o = await other()
    const post = await req('POST', '/api/net/rules', { url: 'https://api.example.test/a', body: 'x' })
    expect(post.status).toBe(423)
    expect(post.json).toMatchObject({ code: 'LOCKED' })
    expect((await req('DELETE', '/api/net/rules')).status).toBe(423)
    expect((await req('GET', '/api/net/har')).status).toBe(423)
    o.release()
    expect(harness.proxy.ruleSet.list()).toEqual([])
    expect((await req('GET', '/api/net/rules')).json.rules).toEqual([])
  })
})

describe('unknown routes and no hub', () => {
  it('answers 404 JSON for an unknown /api/net or /api/bt route and 405 for a wrong method', async () => {
    const r = await req('GET', '/api/net/nope')
    expect(r.status).toBe(404)
    expect(r.json.code).toBe('NOT_FOUND')
    expect((await req('GET', '/api/bt/other')).status).toBe(404)
    const m = await req('POST', '/api/net/har', {})
    expect(m.status).toBe(405)
    expect(m.headers.allow).toBe('GET')
  })

  it('answers 503 NO_HUB when Studio was started without a hub', async () => {
    const s2 = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
    const p2 = s2.address().port
    const r = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: p2, path: '/api/net/rules' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) })) }))
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('NO_HUB')
    s2.close()
  })
})
