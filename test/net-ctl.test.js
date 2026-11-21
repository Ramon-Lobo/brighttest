import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createNetCtl, canonRule } = require('../lib/instrument/net-ctl.js')
const { createNetProxy } = require('../lib/instrument/net-proxy.js')
const { startHub } = require('../lib/instrument/hub.js')
const { request } = require('./fixtures/net/harness.js')
const { runtimeSource, RESERVED_NAMES } = require('../lib/instrument/plugin.js')

const TOKEN = 'tok-ctl-0123456789'
const cleanups = []
let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-netctl-')) })
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); fs.rmSync(tmp, { recursive: true, force: true }) })

function setup() {
  const proxy = createNetProxy({ root: tmp, unmatched: 'fail' })
  cleanups.push(() => proxy.close())
  return { proxy, ctl: createNetCtl({ proxy, root: tmp }) }
}
const call = (ctl, op, body) => ctl.handle(op, body === undefined ? '' : JSON.stringify(body))
describe('canonRule', () => {
  it('restores the canonical spelling of rule keys but leaves json, headers and reqHeaders contents alone', () => {
    const r = canonRule({ URL: 'u', delayms: 5, bodybase64: 'x', reqheaders: { 'X-A': '1' }, json: { Camel: 1 }, headers: { 'X-B': '2' },
      reqbody: { Contains: 'a' }, fault: { Kind: 'status', holdms: 9 }, responses: [{ STATUS: 503, partialbytes: 1 }] })
    expect(r).toEqual({ url: 'u', delayMs: 5, bodyBase64: 'x', reqHeaders: { 'X-A': '1' }, json: { Camel: 1 }, headers: { 'X-B': '2' },
      reqBody: { contains: 'a' }, fault: { kind: 'status', holdMs: 9 }, responses: [{ status: 503, partialBytes: 1 }] })
  })
})

describe('net-ctl ops', () => {
  it('mock adds a run-time rule that wins over config fixtures', () => {
    const { proxy, ctl } = setup()
    proxy.ruleSet.addConfig([{ url: 'https://a.test/x', body: 'config' }])
    expect(call(ctl, 'mock', { url: 'https://a.test/x', body: 'spec' }).status).toBe(200)
    expect(proxy.ruleSet.match({ method: 'GET', url: 'https://a.test/x', headers: {} }).response.body).toBe('spec')
  })

  it('mock accepts lower-cased keys as BrightScript may send them', () => {
    const { proxy, ctl } = setup()
    expect(call(ctl, 'mock', { url: 'https://a.test/d', body: 'x', delayms: 7 }).status).toBe(200)
    expect(proxy.ruleSet.match({ method: 'GET', url: 'https://a.test/d', headers: {} }).response.delayMs).toBe(7)
  })

  it('mock refuses a fault; fault requires kind or fault', () => {
    const { ctl } = setup()
    expect(call(ctl, 'mock', { url: 'https://a.test/x', kind: 'reset' })).toMatchObject({ status: 400 })
    const r = call(ctl, 'fault', { url: 'https://a.test/x' })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('kind')
    expect(call(ctl, 'fault', { url: 'https://a.test/x', kind: 'status', status: 503 }).status).toBe(200)
  })

  it('rule errors are 400 with the message, never a throw', () => {
    const { ctl } = setup()
    const r = call(ctl, 'mock', { url: 'https://a.test/x', status: 42 })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('status')
    expect(call(ctl, 'mock', 'nope')).toMatchObject({ status: 400 })
    expect(ctl.handle('mock', '{not json').json.error).toContain('JSON')
  })

  it('reset drops run-time rules and keeps config fixtures', () => {
    const { proxy, ctl } = setup()
    proxy.ruleSet.addConfig([{ url: 'https://a.test/cfg', body: 'config' }])
    call(ctl, 'mock', { url: 'https://a.test/spec', body: 'spec' })
    expect(call(ctl, 'reset').status).toBe(200)
    expect(proxy.ruleSet.match({ method: 'GET', url: 'https://a.test/spec', headers: {} })).toBeNull()
    expect(proxy.ruleSet.match({ method: 'GET', url: 'https://a.test/cfg', headers: {} }).response.body).toBe('config')
  })

  it('unknown op is 404', () => {
    expect(call(setup().ctl, 'frobnicate', {}).status).toBe(404)
  })

  it('fixture loads a rules file from inside the project and keeps its order', () => {
    const { proxy, ctl } = setup()
    fs.writeFileSync(path.join(tmp, 'r.rules.json'), JSON.stringify({ rules: [{ url: 'https://a.test/**', body: 'first' }, { url: 'https://a.test/x', body: 'second' }] }))
    expect(call(ctl, 'fixture', { path: 'r.rules.json' })).toMatchObject({ status: 200, json: { count: 2 } })
    expect(proxy.ruleSet.match({ method: 'GET', url: 'https://a.test/x', headers: {} }).response.body).toBe('first')
  })

  it('fixture refuses absolute paths, .. escapes, symlink escapes and missing files', () => {
    const { ctl } = setup()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-netctl-out-'))
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }))
    fs.writeFileSync(path.join(outside, 'o.rules.json'), '[]')
    fs.symlinkSync(path.join(outside, 'o.rules.json'), path.join(tmp, 'link.rules.json'))
    for (const p of [path.join(outside, 'o.rules.json'), `../${path.basename(outside)}/o.rules.json`, 'link.rules.json', 'missing.json']) {
      const r = call(ctl, 'fixture', { path: p })
      expect(r.status, p).toBe(400)
    }
  })

  it('requests returns entries since the last reset, filtered by method, url glob and status', async () => {
    const { proxy, ctl } = setup()
    proxy.ruleSet.addConfig([{ url: 'https://a.test/**', body: 'ok' }])
    const hit = async (m, u, b) => {
      const res = { writeHead() {}, end() {}, setHeader() {}, headersSent: false, destroyed: false, on() {}, write() {} }
      const req = Object.assign(require('stream').Readable.from(b ? [Buffer.from(b)] : []), { method: m, headers: {}, socket: { destroy() {} } })
      await proxy.handle(req, res, u)
    }
    await hit('GET', 'https://a.test/before')
    call(ctl, 'reset')
    await hit('GET', 'https://a.test/a')
    await hit('POST', 'https://a.test/track', '{"e":1}')
    const all = call(ctl, 'requests', {}).json.requests
    expect(all.map((e) => e.url)).toEqual(['https://a.test/a', 'https://a.test/track'])
    const posts = call(ctl, 'requests', { METHOD: 'POST', url: '**/track' }).json.requests
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toBe('{"e":1}')
    expect(posts[0].status).toBe(200)
    expect(call(ctl, 'requests', { status: 404 }).json.requests).toEqual([])
  })
})

describe('hub ctl/net route', () => {
  async function hubWith(proxy) {
    const hub = await startHub({ lease: { held: () => true, onLost() {}, leaseId: 'l1' }, tokens: [TOKEN], ...(proxy ? { netProxy: proxy } : {}) })
    cleanups.push(() => hub.stop())
    return `http://127.0.0.1:${hub.port}/bt/${TOKEN}/ctl/net`
  }
  const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) })

  it('serves mock / requests / reset over POST on loopback', async () => {
    const { proxy } = setup()
    const base = await hubWith(proxy)
    expect((await post(`${base}/mock`, { url: 'https://a.test/x', body: 'hi' })).status).toBe(200)
    expect(proxy.ruleSet.list().filter((r) => r.source === 'rule')).toHaveLength(1)
    const bad = await post(`${base}/mock`, { url: 'https://a.test/x', status: 1 })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).error).toContain('status')
    expect(JSON.parse((await post(`${base}/requests`, {})).body)).toEqual({ requests: [] })
    expect((await post(`${base}/reset`, {})).status).toBe(200)
    expect(proxy.ruleSet.list()).toHaveLength(0)
  })

  it('wrong token, GET, unknown op shape and a hub without a proxy are bare 404s', async () => {
    const { proxy } = setup()
    const base = await hubWith(proxy)
    expect((await post(base.replace(TOKEN, 'nope'), {})).status).toBe(404)
    expect((await request(`${base}/reset`)).status).toBe(404)
    expect((await request(`${base}/reset`)).body).toBe('')
    expect((await post(`${base}/mock/extra`, {})).status).toBe(404)
    const bare = await hubWith(null)
    expect((await post(`${bare}/reset`, {})).status).toBe(404)
  })

  it('a lost lease answers 423', async () => {
    const { proxy } = setup()
    let held = true
    const hub = await startHub({ lease: { held: () => held, onLost() {}, leaseId: 'l2' }, tokens: [TOKEN], netProxy: proxy })
    cleanups.push(() => hub.stop())
    held = false
    expect((await post(`http://127.0.0.1:${hub.port}/bt/${TOKEN}/ctl/net/reset`, {})).status).toBe(423)
  })
})

describe('BTNet_spec runtime asset', () => {
  it('is added to the runtime only when netSpec is requested with the real net runtime', () => {
    expect(runtimeSource(true, false, true)).toContain('sub BTNet_mock(')
    expect(runtimeSource(true, false, false)).not.toContain('BTNet_')
    expect(runtimeSource(false, false, true)).not.toContain('BTNet_')
  })
  it('every function the asset defines is a reserved runtime name', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'instrument', 'runtime', 'source', 'bt', 'BTNet_spec.brs'), 'utf8')
    const defined = [...src.matchAll(/^\s*(?:function|sub)\s+(BTNet_\w+)/gim)].map((m) => m[1].toLowerCase())
    expect(defined.length).toBeGreaterThanOrEqual(6)
    const reserved = RESERVED_NAMES.map((n) => n.toLowerCase())
    for (const d of defined) expect(reserved).toContain(d)
  })
})
