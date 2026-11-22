import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { bootStub, startMcp, payload, cleanupMcp, tmpdir } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const { acquire } = require('../lib/device-lease.js')

// NET-N-T14: MCP net_requests / net_mock. The session owns an in-process net proxy (lib/instrument/net-proxy.js);
// the test drives it through a local http server, the way the hub mounts it. No device traffic beyond the lease.
const servers = []
afterEach(async () => { await cleanupMcp(); for (const s of servers.splice(0)) s.close() })

const isErr = (res) => res.result.isError === true

async function ready(opts = {}) {
  const { stub, a } = await bootStub('healthy')
  const c = startMcp({ a, ...opts })
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

  it('both tool descriptions say the tools are not connected to live traffic', async () => {
    const { TOOLS } = require('../lib/mcp/tools.js')
    for (const n of ['net_requests', 'net_mock']) expect(TOOLS.find((t) => t.name === n).description).toContain('no hub mounted')
  })

  it('a URL glob with many wildcards is refused at the boundary, and a hostile pattern is cheap to match', async () => {
    const { c, hit } = await ready()
    const bad = '*a'.repeat(10) + 'b'
    for (const [n, args] of [['net_requests', { url: bad }], ['net_mock', { match: { url: bad }, respond: { status: 200 } }]]) {
      const r = await c.tool(n, args)
      expect(payload(r).code, n).toBe('NET_PATTERN_TOO_COMPLEX')
    }
    const long = await c.tool('net_requests', { url: 'a'.repeat(300) })
    expect(long.error && long.error.code).toBe(-32602)
    const longMock = await c.tool('net_mock', { match: { url: 'a'.repeat(300) }, respond: { status: 200 } })
    expect(longMock.error && longMock.error.code).toBe(-32602)
    // the matcher itself is linear: run in a child with a hard timeout so a regression fails fast instead of hanging
    const code = "const { compileUrlPattern } = require(process.argv[1]); const m = compileUrlPattern('http://x.test/' + '*a'.repeat(10) + 'b'); const t0 = Date.now(); const r = m('http://x.test/' + 'a'.repeat(5000)); console.log(JSON.stringify({ r, ms: Date.now() - t0 }))"
    const child = spawnSync(process.execPath, ['-e', code, path.resolve(__dirname, '../lib/instrument/net-rules.js')], { timeout: 5000, encoding: 'utf8' })
    expect(child.error, 'matcher timed out').toBeUndefined()
    const out = JSON.parse(child.stdout)
    expect(out.r).toBe(false)
    expect(out.ms).toBeLessThan(100)
    await hit('/p')
  })

  it('uses the project instrument.net.redact config and strips userinfo from listed URLs', async () => {
    const cwd = tmpdir('bt-mcp-proj-')
    fs.writeFileSync(path.join(cwd, 'brighttest.json'), JSON.stringify({ instrument: { net: { redact: { query: ['sid'], headers: ['x-device-code'] } } } }))
    const { stub, a } = await bootStub('healthy')
    const c = startMcp({ a, cwd })
    await c.initialize()
    const proxy = c.server.session.net().proxy
    const srv = http.createServer((req, res) => proxy.handle(req, res, 'http://bob:hunter2@api.example.test' + req.url))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r)); servers.push(srv)
    await c.tool('net_mock', { match: { url: '**/x' }, respond: { status: 200 } })
    await new Promise((resolve) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/x?sid=SID-VALUE&p=1', headers: { 'x-device-code': 'DEV-CODE' } }, (r) => { r.resume(); r.on('end', resolve) }))
    const res = await c.tool('net_requests')
    const all = JSON.stringify(res)
    expect(payload(res).count).toBe(1)
    expect(all).not.toContain('SID-VALUE')
    expect(all).not.toContain('DEV-CODE')
    expect(all).not.toContain('hunter2')
    expect(all).not.toContain('bob')
    expect(payload(res).requests[0].url).toContain('api.example.test/x')
  })

  it('caps net_requests output bytes and net_mock rules per session, and checks header values', async () => {
    const { c, hit } = await ready({ limits: { maxNetBytes: 400, maxNetRules: 2 } })
    expect(isErr(await c.tool('net_mock', { match: { url: '**/a' }, respond: { status: 200 } }))).toBe(false)
    expect(isErr(await c.tool('net_mock', { match: { url: '**/b' }, respond: { status: 200 } }))).toBe(false)
    expect(payload(await c.tool('net_mock', { match: { url: '**/c' }, respond: { status: 200 } })).code).toBe('NET_RULE_BUDGET_EXHAUSTED')
    for (let i = 0; i < 6; i++) await hit('/a')
    expect(payload(await c.tool('net_requests')).code).toBe('NET_OUTPUT_TOO_LARGE')
    const bad = await c.tool('net_mock', { match: { url: '**/h' }, respond: { status: 200, headers: { 'x-a': 5 } } })
    expect(bad.error && bad.error.code).toBe(-32602)
  })
})
