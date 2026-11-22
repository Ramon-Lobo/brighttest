import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'
import { bootStub, startMcp, payload, cleanupMcp, tmpdir } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const { acquire } = require('../lib/device-lease.js')

// NET-N-T14: MCP net_requests / net_mock. The session owns an in-process net proxy (lib/instrument/net-proxy.js);
// the test drives it through a local http server, the way the hub mounts it. No device traffic beyond the lease.
const servers = []
afterEach(async () => { await cleanupMcp(); for (const s of servers.splice(0)) s.close() })

const isErr = (res) => res.result.isError === true

async function ready() {
  const { stub, a } = await bootStub('healthy')
  const c = startMcp({ a })
  await c.initialize()
  const proxy = c.server.session.net().proxy
  const srv = http.createServer((req, res) => proxy.handle(req, res, 'http://api.example.test' + req.url))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  servers.push(srv)
  const hit = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d }); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    }).on('error', reject)
  })
  return { stub, a, c, hit }
}

describe('MCP net tools', () => {
  it('net_mock answers matching requests and net_requests lists them as mocked with redacted headers', async () => {
    const { c, hit } = await ready()
    const m = payload(await c.tool('net_mock', { match: { method: 'GET', url: '**/catalog' }, respond: { status: 200, json: { items: [1, 2] } } }))
    expect(m).toMatchObject({ ok: true, scope: 'session' })
    const r = await hit('/catalog?token=abc123&page=2', { authorization: 'Bearer SECRET-VALUE', 'x-trace': 't1' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ items: [1, 2] })
    const res = await c.tool('net_requests')
    const d = payload(res)
    expect(d.count).toBe(1)
    expect(d.requests[0]).toMatchObject({ method: 'GET', status: 200, mocked: true, source: 'mock' })
    expect(d.requests[0].url).toContain('page=2')
    expect(d.requests[0].headers.authorization).toBe('<redacted:authorization>')
    expect(d.requests[0].headers['x-trace']).toBe('t1')
    const all = JSON.stringify(res)
    expect(all).not.toContain('SECRET-VALUE')
    expect(all).not.toContain('abc123')
  })

  it('filters by status and url, and caps with limit', async () => {
    const { c, hit } = await ready()
    await c.tool('net_mock', { match: { url: '**/a' }, respond: { status: 200, body: 'a' } })
    await c.tool('net_mock', { match: { url: '**/b' }, respond: { status: 503, body: 'b' } })
    await hit('/a'); await hit('/b'); await hit('/a')
    expect(payload(await c.tool('net_requests', { status: 503 })).count).toBe(1)
    expect(payload(await c.tool('net_requests', { url: '**/a' })).count).toBe(2)
    const l = payload(await c.tool('net_requests', { limit: 1 }))
    expect(l).toMatchObject({ count: 3, returned: 1, truncated: true })
  })

  it('a bad mock rule is a typed error, and a bad argument is rejected before any lease', async () => {
    const { c } = await ready()
    const bad = await c.tool('net_mock', { match: { url: '**/x' }, respond: { status: 200, fault: 'x' } })
    expect(bad.error && bad.error.code).toBe(-32602)
    const rule = await c.tool('net_mock', { match: { url: '' }, respond: { status: 200 } })
    expect(isErr(rule)).toBe(true)
    expect(payload(rule).code).toBe('NET_RULE_INVALID')
  })

  it('refuses without the lease and leaves no rule behind', async () => {
    const { a } = await bootStub('healthy')
    const leaseDir = tmpdir('bt-mcp-lease-')
    const c = startMcp({ a, leaseDir })
    await c.initialize()
    const holder = await acquire({ host: '127.0.0.1', port: a.ecpPort, waitMs: 0, mode: 'command', env: { ...process.env, BRIGHTTEST_LEASE_DIR: leaseDir, BRIGHTTEST_LEASE: '' }, onWait: () => {}, purpose: 'test holder' })
    try {
      for (const [n, args] of [['net_requests', {}], ['net_mock', { match: { url: '**/x' }, respond: { status: 200 } }]]) {
        const r = await c.tool(n, args)
        expect(isErr(r), n).toBe(true)
        expect(payload(r).code, n).toBe('DEVICE_BUSY')
      }
    } finally { holder.release() }
    expect(payload(await c.tool('net_requests')).count).toBe(0)
  })

  it('mocks end with the session', async () => {
    const { c } = await ready()
    await c.tool('net_mock', { match: { url: '**/x' }, respond: { status: 200 } })
    const s = c.server.session
    expect(s.net().proxy.ruleSet).toBeTruthy()
    await c.close()
    expect(s._net).toBeNull()
  })
})
