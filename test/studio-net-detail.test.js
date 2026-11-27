import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const lease = require('../lib/device-lease.js')
const studio = require('../lib/studio/server.js')
const netRules = require('../lib/instrument/net-rules.js')
const detail = require('../lib/studio/net-detail.js')
const { createEventLog } = require('../lib/instrument/events.js')
const { startHarness, request } = require('./fixtures/net/harness.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// STUDIO-NETD-T1: GET /api/net/entry, GET /api/net/body, /api/net/requests?lite=1, the HAR consistency of the shared
// body encoder, and the Studio body spill dir. Fake hub and fake roku on loopback; hosts are example.test.
let dir, fake, server, port, prevPort, harness, log, bus
const key = () => `127.0.0.1_p${process.env.ROKU_ECP_PORT}`
const other = () => lease.acquire({ dir, key: key(), agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, timers: false, identity: {} })

function req(method, p, body, p2 = port) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p2, method, path: p, headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const buf = Buffer.concat(chunks); const text = buf.toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, buf, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }) })
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

const REDACT = { bodyKeys: ['token'] }
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-netd-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  log = createEventLog({ sessionId: 'sess1' })
  bus = new EventEmitter()
  harness = await startHarness({ redact: REDACT, emit: (kind, data) => bus.emit('event', log.push({ src: 'hub', kind, data })) })
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, net: { proxy: harness.proxy, events: bus, log, redact: REDACT },
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
})
afterEach(async () => {
  server.close(); await harness.stop(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

const URL1 = 'https://api.example.test/v1/home?page=1&access_token=abc123secret'
async function seed() {
  harness.proxy.ruleSet.add({ id: 'home', url: 'https://api.example.test/v1/home*', status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=cookie-secret' }, json: { title: 'Hero', token: 'resp-secret-1' } })
  const r = await request(harness.base + URL1, { method: 'POST', headers: { authorization: 'Bearer auth-secret-1', 'content-type': 'application/json' }, body: JSON.stringify({ q: 'x', token: 'req-secret-1' }) })
  expect(r.status).toBe(200)
}

describe('/api/net/entry', () => {
  it('returns redacted request and response with headers, timings and the HAR flag', async () => {
    await seed()
    const r = await req('GET', '/api/net/entry?id=r-1')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ id: 'r-1', method: 'POST', raw: false, redacted: true, inHar: true, synthetic: false, status: 200, source: 'mock', rule: 'home' })
    expect(r.json.url).not.toContain('abc123secret')
    expect(r.json.request.headers.authorization).toBe('<redacted:authorization>')
    expect(r.json.request.body).toMatchObject({ kind: 'json', truncated: false, captureTruncated: false, decodedFrom: null })
    expect(r.json.response.contentType).toBe('application/json')
    expect(r.json.response.body.kind).toBe('json')
    expect(r.json.timings).toEqual({ wait: 0, receive: 0, total: expect.any(Number) })
    expect(r.text).not.toMatch(/auth-secret-1|abc123secret|cookie-secret|resp-secret-1|req-secret-1/)
  })
  it('serves raw values with raw=1 or body=raw', async () => {
    await seed()
    for (const qs of ['raw=1', 'body=raw']) {
      const r = await req('GET', `/api/net/entry?id=r-1&${qs}`)
      expect(r.json).toMatchObject({ raw: true, redacted: false })
      expect(r.json.request.headers.authorization).toBe('Bearer auth-secret-1')
      expect(r.json.response.body.text).toContain('resp-secret-1')
      expect(r.json.url).toContain('abc123secret')
    }
  })
  it('shows brighttest-generated answers as synthetic and not in the HAR', async () => {
    harness.proxy.ruleSet.addConfig([{ url: 'https://only.example.test/**', status: 200 }])
    await request(harness.base + 'https://nowhere.example.test/x')
    const r = await req('GET', '/api/net/entry?id=r-1')
    expect(r.json).toMatchObject({ synthetic: true, inHar: false, status: 599, source: 'unmatched' })
    expect(r.json.response.body.text).toMatch(/no rule matched/)
    const har = await req('GET', '/api/net/har')
    expect(JSON.parse(har.text).log.entries).toHaveLength(0)
  })
  it('over-limit request: kind none / too-large; no response yet: none / no-response', async () => {
    const big = await request(harness.base + 'https://h.example.test/up', { method: 'POST', body: Buffer.alloc(17 * 1024 * 1024, 0x61) })
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(big.status ?? big.error)
    const r = await req('GET', '/api/net/entry?id=r-1')
    expect(r.json).toMatchObject({ status: 413, source: 'refused', synthetic: true })
    expect(r.json.request.body).toEqual({ kind: 'none', reason: 'too-large' })
  })
  it('cuts a body at 1 MB on a character boundary and reports truncation', async () => {
    harness.proxy.ruleSet.add({ url: 'https://h.example.test/big', headers: { 'content-type': 'text/plain' }, body: 'é'.repeat(700 * 1024) }) // 1.4 MB
    await request(harness.base + 'https://h.example.test/big')
    const b = (await req('GET', '/api/net/entry?id=r-1')).json.response.body
    expect(b).toMatchObject({ kind: 'text', bytes: 1400 * 1024, truncated: true })
    expect(b.shownBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(b.shownBytes % 2).toBe(0)
    expect(Buffer.byteLength(b.text)).toBe(b.shownBytes)
  })
  it('decodes a gzip body for display (cap 8 MB) and marks decodedFrom', async () => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ hello: 'world' })))
    harness.proxy.ruleSet.add({ url: 'https://h.example.test/gz', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, bodyBase64: gz.toString('base64') })
    await request(harness.base + 'https://h.example.test/gz')
    const b = (await req('GET', '/api/net/entry?id=r-1')).json.response.body
    expect(b).toMatchObject({ kind: 'json', decodedFrom: 'gzip', bytes: gz.length })
    expect(JSON.parse(b.text)).toEqual({ hello: 'world' })
    const bomb = zlib.gzipSync(Buffer.alloc(9 * 1024 * 1024, 0x20))
    expect(detail.decodeBody(bomb, 'gzip')).toMatchObject({ from: null }) // over the decode cap: stored bytes shown
  })
  it('404 for a missing id and 400 without one; 405 on POST', async () => {
    expect((await req('GET', '/api/net/entry?id=r-99')).status).toBe(404)
    expect((await req('GET', '/api/net/entry')).status).toBe(400)
    expect((await req('POST', '/api/net/entry?id=r-1')).status).toBe(405)
    expect((await req('POST', '/api/net/body?id=r-1&side=res')).status).toBe(405)
  })
  it('423 on both routes when another process holds the lease', async () => {
    const o = await other()
    expect((await req('GET', '/api/net/entry?id=r-1')).status).toBe(423)
    expect((await req('GET', '/api/net/body?id=r-1&side=res')).status).toBe(423)
    o.release()
  })
})

describe('/api/net/body', () => {
  it('downloads the redacted body as an attachment and the raw one with raw=1', async () => {
    await seed()
    const red = await req('GET', '/api/net/body?id=r-1&side=res')
    expect(red.status).toBe(200)
    expect(red.headers['content-disposition']).toMatch(/^attachment; filename="r-1-response\.json"$/)
    expect(red.headers['x-content-type-options']).toBe('nosniff')
    expect(red.text).not.toContain('resp-secret-1')
    expect(JSON.parse(red.text).title).toBe('Hero')
    const raw = await req('GET', '/api/net/body?id=r-1&side=res&raw=1')
    expect(JSON.parse(raw.text)).toEqual({ title: 'Hero', token: 'resp-secret-1' })
    const rq = await req('GET', '/api/net/body?id=r-1&side=req')
    expect(rq.text).not.toContain('req-secret-1')
  })
  it('binary bodies download as the original bytes; empty body 404; bad side 400', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0])
    harness.proxy.ruleSet.add({ url: 'https://h.example.test/bin', headers: { 'content-type': 'application/octet-stream' }, bodyBase64: bytes.toString('base64') })
    await request(harness.base + 'https://h.example.test/bin')
    const r = await req('GET', '/api/net/body?id=r-1&side=res')
    expect(r.buf.equals(bytes)).toBe(true)
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect((await req('GET', '/api/net/body?id=r-1&side=req')).status).toBe(404)
    expect((await req('GET', '/api/net/body?id=r-1&side=x')).status).toBe(400)
    expect((await req('GET', '/api/net/body?id=r-9&side=res')).status).toBe(404)
  })
  it('refuses a body over 32 MB with 413', () => {
    const e = { id: 'r-1', resBody: Buffer.alloc(detail.NET_DOWNLOAD_MAX + 1), resHeaders: {} }
    expect(detail.bodyDownload(e, 'res', netRules.makeRedactor({}), false)).toMatchObject({ status: 413 })
  })
})

describe('/api/net/requests?lite=1', () => {
  it('omits request bodies and reports reqBytes', async () => {
    await seed()
    const full = (await req('GET', '/api/net/requests')).json.requests[0]
    expect(full.body).toContain('q')
    const lite = await req('GET', '/api/net/requests?lite=1')
    const e = lite.json.requests[0]
    expect(e.body).toBeUndefined()
    expect(e.bodyTruncated).toBeUndefined()
    expect(e.reqBytes).toBe(Buffer.byteLength(JSON.stringify({ q: 'x', token: 'req-secret-1' })))
    expect(e).toMatchObject({ id: 'r-1', status: 200, host: 'api.example.test' })
    expect(lite.text).not.toMatch(/auth-secret-1|abc123secret|req-secret-1/)
  })
})

describe('HAR consistency (ADR 0051)', () => {
  it('redacted detail text, encoding, headers and url equal the HAR entry for json, text, form and binary', async () => {
    const cases = [
      ['json', { headers: { 'content-type': 'application/json', 'set-cookie': 'sid=c1' }, json: { a: 1, token: 'zz' } }, 'application/json', JSON.stringify({ token: 'rq', n: 1 })],
      ['text', { headers: { 'content-type': 'text/plain' }, body: 'hello é' }, 'text/plain', 'plain request'],
      ['form', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' }, 'application/x-www-form-urlencoded', 'x=1&token=s'],
      ['bin', { headers: { 'content-type': 'application/octet-stream' }, bodyBase64: Buffer.from([0, 9, 200]).toString('base64') }, 'application/octet-stream', 'bin'],
      ['jsonbin', { headers: { 'content-type': 'application/octet-stream' }, body: JSON.stringify({ token: 'hidden' }) }, 'application/octet-stream', ''],
    ]
    for (const [n, rule] of cases) harness.proxy.ruleSet.add({ url: `https://h.example.test/${n}*`, ...rule })
    for (const [n, , ct, body] of cases) await request(`${harness.base}https://h.example.test/${n}?access_token=qq`, { method: body ? 'POST' : 'GET', headers: { 'content-type': ct, authorization: 'Bearer zzz' }, body: body || undefined })
    const har = JSON.parse((await req('GET', '/api/net/har')).text).log.entries
    expect(har).toHaveLength(cases.length)
    for (let i = 0; i < cases.length; i++) {
      const d = (await req('GET', `/api/net/entry?id=r-${i + 1}`)).json
      const h = har[i]
      expect(d.url).toBe(h.request.url)
      expect(d.response.headers).toEqual(Object.fromEntries(h.response.headers.map((x) => [x.name, x.value])))
      expect(d.request.headers).toEqual(Object.fromEntries(h.request.headers.map((x) => [x.name, x.value])))
      expect(d.response.body.text).toBe(h.response.content.text)
      expect(d.response.body.encoding).toBe(h.response.content.encoding)
      if (h.request.postData) expect(d.request.body.text).toBe(h.request.postData.text)
      expect(d.inHar).toBe(true)
    }
  })
  it('harBody matches what buildHar writes, and raw mode skips redaction with the same text/base64 rule', () => {
    const red = netRules.makeRedactor({ bodyKeys: ['token'] })
    const buf = Buffer.from(JSON.stringify({ token: 'zz', ok: 1 }))
    const har = netRules.buildHar([{ startedDateTime: 1, method: 'GET', url: 'https://h.test/x', reqHeaders: {}, reqBody: buf, status: 200, resHeaders: { 'content-type': 'application/json' }, resBody: buf }], { redact: { bodyKeys: ['token'] } })
    const e = har.log.entries[0]
    expect(netRules.harBody(buf, 'application/json', red, 'res')).toEqual({ text: e.response.content.text })
    expect(netRules.harBody(buf, 'application/json', red, 'req')).toEqual({ text: e.request.postData.text })
    expect(netRules.harBody(buf, 'application/json', null, 'res')).toEqual({ text: buf.toString() })
    expect(netRules.harBody(Buffer.from([0, 1]), 'image/png', null, 'res')).toEqual({ text: 'AAE=', encoding: 'base64' })
  })
})

describe('body spill dir', () => {
  it('is created by the Studio hub proxy and removed when the hub stops', async () => {
    const spill = path.join(dir, 'spill', 'net-bodies')
    fs.mkdirSync(spill, { recursive: true }); fs.writeFileSync(path.join(spill, 'marker'), 'x')
    const TOKEN = '0123456789abcdef0123456789abcdef'
    let proxy = null
    const hub = { host: '0.0.0.0', port: 8790, events: new EventEmitter(), log: createEventLog({ sessionId: 'f' }), stop: async () => {}, emitLocal() {} }
    const startLanHub = async (o) => { proxy = o.netProxy; return hub }
    const s2 = await studio.start({
      host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg: { instrument: { hub: { host: '10.0.0.5', port: 8791 } }, rootDir: dir },
      hubOpts: { startLanHub, env: { BRIGHTTEST_HUB_TOKEN: TOKEN }, bodyDir: spill },
      leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 },
    })
    const p2 = s2.address().port
    expect((await req('GET', '/api/net/requests', undefined, p2)).status).toBe(200) // takes the lease, starts the hub
    expect(proxy).not.toBeNull()
    proxy.ruleSet.add({ url: 'https://h.example.test/big', body: 'x'.repeat(1024 * 1024 + 10) })
    const ph = http.createServer((q, r) => { proxy.handle(q, r, 'https://h.example.test/big').catch(() => r.destroy()) })
    await new Promise((r) => ph.listen(0, '127.0.0.1', r))
    await req('GET', '/', undefined, ph.address().port)
    expect(proxy.bodyFiles()).toHaveLength(1)
    expect(proxy.bodyFiles()[0].startsWith(spill)).toBe(true)
    await new Promise((r) => ph.close(r))
    s2.close()
    for (let i = 0; i < 100 && fs.existsSync(spill); i++) await new Promise((r) => setTimeout(r, 20))
    expect(fs.existsSync(spill)).toBe(false)
  })
})
