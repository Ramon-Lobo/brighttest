import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { loadConfig } from '../lib/config.js'
import { parseFlow } from '../lib/e2e/flow.js'
import ns from '../lib/e2e/net-steps.js'
import lint from '../lib/e2e/lint.js'
import proxyMod from '../lib/instrument/net-proxy.js'
import headless from '../lib/instrument/net-headless.js'
import studio from '../lib/studio/server.js'
import logs from '../lib/e2e/logs.js'

// FR-NET-PASSTHROUGH-EMPTY / FR-NET-CONFIG-UNIFY / FR-STUDIO-HUB-NOTICE: generic hosts only, no device, no network.
let dir
const write = (cfgObj) => { fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify(cfgObj)); return loadConfig(dir, null) }
const flowOf = (net, extra = '') => ({ ...parseFlow(`appId: dev\nconfig: { net: ${net} }\nsteps:\n  - launch\n${extra}`), name: 'f', file: path.join(dir, 'f.e2e.yaml') })
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-netcfg-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('passthrough needs upstreamHosts', () => {
  it('assertPassthroughHosts refuses an empty allow-list with the documented sentence', () => {
    expect(() => proxyMod.assertPassthroughHosts('passthrough', [], 'config.net'))
      .toThrow('config.net: passthrough needs config.net.upstreamHosts; with an empty list every request is refused (403)')
    expect(() => proxyMod.assertPassthroughHosts('passthrough', undefined)).toThrow(/passthrough needs config.net.upstreamHosts/)
    expect(() => proxyMod.assertPassthroughHosts('passthrough', ['api.example.test'])).not.toThrow()
    expect(() => proxyMod.assertPassthroughHosts('fail', [])).not.toThrow()
    expect(() => proxyMod.assertPassthroughHosts(undefined, [])).not.toThrow()
  })

  it('e2e preflight (lint and run) flags an explicit passthrough with no hosts anywhere', () => {
    const cfg = write({})
    const f = path.join(dir, 'f.e2e.yaml')
    fs.writeFileSync(f, 'appId: dev\nconfig: { net: { unmatched: passthrough } }\nsteps:\n  - launch\n')
    const bad = ns.preflight([f], cfg, (x) => ({ ...parseFlow(fs.readFileSync(x, 'utf8')), file: x, name: 'f' }))
    expect(bad).toHaveLength(1)
    expect(bad[0].message).toMatch(/passthrough needs config.net.upstreamHosts/)
  })

  it('instrument.net.upstreamHosts satisfies a flow that only sets unmatched: passthrough', () => {
    const cfg = write({ instrument: { net: { upstreamHosts: ['api.example.test'] } } })
    const flow = flowOf('{ unmatched: passthrough }')
    expect(ns.effectiveNet(flow, cfg)).toEqual({ upstreamHosts: ['api.example.test'], unmatched: 'passthrough' })
  })

  it('e2e lint exits 1 with the message', () => {
    const cfg = write({})
    const f = path.join(dir, 'f.e2e.yaml')
    fs.writeFileSync(f, 'appId: dev\nconfig: { net: { unmatched: passthrough } }\nsteps:\n  - launch\n')
    const errs = []
    const orig = console.error; console.error = (m) => errs.push(m)
    let code
    try { code = lint.lint([f], () => {}, cfg) } finally { console.error = orig }
    expect(code).toBe(1)
    expect(errs.join('\n')).toMatch(/passthrough needs config.net.upstreamHosts/)
  })
})

describe('headless lane', () => {
  it('prepare refuses --net-unmatched passthrough without upstreamHosts', () => {
    const cfg = write({ instrument: { net: { fixtures: [] } } })
    expect(() => headless.prepare(cfg, { netUnmatched: 'passthrough' }, { log() {}, warn() {} })).toThrow(/passthrough needs config.net.upstreamHosts/)
  })
})

describe('config unify', () => {
  it('a flow inherits instrument.net and its own config.net wins per key', () => {
    const cfg = write({ instrument: { net: { upstreamHosts: ['a.example.test'], unmatched: 'passthrough', redact: { query: ['sid'] }, record: true } } })
    const flow = flowOf('{ upstreamHosts: [b.example.test] }')
    expect(ns.effectiveNet(flow, cfg)).toEqual({ upstreamHosts: ['b.example.test'], unmatched: 'passthrough', redact: { query: ['sid'] } })
    expect(ns.effectiveNet(flowOf('{ unmatched: fail }'), cfg).upstreamHosts).toEqual(['a.example.test'])
  })

  it('planSession and beginFlow use the merged allow-list (inherited host reaches the proxy)', () => {
    const cfg = write({ instrument: { net: { upstreamHosts: ['a.example.test'] } } })
    const flow = flowOf('{ unmatched: passthrough, upstreamHosts: [b.example.test] }')
    const session = ns.planSession([{ file: 'x' }], cfg, () => flow)
    try { expect(session.proxy.allowedHosts()).toEqual(['b.example.test']) } finally { session.close() }
  })

  it('Studio: beginFlow widens the hub proxy allow-list and fails an empty passthrough', () => {
    const cfg = write({ instrument: { net: { upstreamHosts: ['a.example.test'] } } })
    const proxy = proxyMod.createNetProxy({ upstreamHosts: ['a.example.test'], warn: () => {} })
    const begun = ns.beginFlow(flowOf('{ upstreamHosts: [b.example.test], unmatched: passthrough }'), { proxy }, {}, cfg)
    expect(begun.error).toBeUndefined()
    expect(proxy.allowedHosts().sort()).toEqual(['a.example.test', 'b.example.test'])
    const cfg2 = write({})
    const bad = ns.beginFlow(flowOf('{ unmatched: passthrough }'), { proxy }, {}, cfg2)
    expect(bad.error).toMatch(/^config\.net: passthrough needs config\.net\.upstreamHosts/)
    proxy.close()
  })
})

describe('refused summary', () => {
  let up, proxy
  afterEach(() => { if (proxy) proxy.close(); if (up) up.close() })
  it('counts refused passthrough requests by host and words the line', async () => {
    proxy = proxyMod.createNetProxy({ upstreamHosts: ['ok.example.test'], unmatched: 'passthrough', lookup: async () => ['93.184.216.34'], warn: () => {} })
    const srv = http.createServer((req, res) => proxy.handle(req, res, `http://${req.headers['x-t']}${req.url}`))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r)); up = srv
    const hit = (host) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/x', headers: { 'x-t': host } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)) }))
    for (const h of ['cdn.example.test', 'cdn.example.test', 'api.other.test']) expect(await hit(h)).toBe(403)
    const list = proxy.refusedHosts()
    expect(list).toEqual([{ host: 'cdn.example.test', count: 2 }, { host: 'api.other.test', count: 1 }])
    expect(proxyMod.refusedSummary(list)).toBe('3 requests refused by the passthrough allow-list: cdn.example.test (2), api.other.test (1). Add them to config.net.upstreamHosts.')
    expect(proxyMod.refusedSummary([{ host: 'h.example.test', count: 1 }])).toBe('1 request refused by the passthrough allow-list: h.example.test (1). Add it to config.net.upstreamHosts.')
    expect(proxyMod.refusedSummary([])).toBeNull()
    const net = { proxy, hidden: new Set() }
    expect(ns.refusedLine(net)).toMatch(/^3 requests refused/)
    net.hidden = new Set(proxy.requests().map((e) => e.id))
    expect(ns.refusedLine(net)).toBeNull()
  })

  it('the failure bundle carries net-refused.txt and error.json netRefused', async () => {
    const out = path.join(dir, 'bundle')
    await logs.writeFailureBundle(out, { flow: 'f', step: { op: 'assertRequest', line: 4 }, error: new Error('boom'), logs: null, shot: { error: 'none' }, netRefused: '2 requests refused by the passthrough allow-list: h.example.test (2). Add it to config.net.upstreamHosts.' })
    expect(fs.readFileSync(path.join(out, 'net-refused.txt'), 'utf8')).toMatch(/h\.example\.test \(2\)/)
    expect(JSON.parse(fs.readFileSync(path.join(out, 'error.json'), 'utf8')).netRefused).toMatch(/refused by the passthrough allow-list/)
    const out2 = path.join(dir, 'bundle2')
    await logs.writeFailureBundle(out2, { flow: 'f', step: null, error: new Error('x'), logs: null, shot: null })
    expect(fs.existsSync(path.join(out2, 'net-refused.txt'))).toBe(false)
  })
})

describe('Studio hub notice', () => {
  const TOKEN = 'a'.repeat(32)
  const cfgOf = (net) => write({ instrument: { net } })
  it('on, with the port and host count', () => {
    const n = studio.hubNotice({ host: '192.0.2.10', cfg: cfgOf({ upstreamHosts: ['a.example.test', 'b.example.test'] }), env: { BRIGHTTEST_HUB_TOKEN: TOKEN } })
    expect(n.line).toBe('hub: on (port 8790, passthrough to 2 hosts)')
    expect(n.warn).toBeNull()
  })
  it('warns on an empty allow-list unless unmatched is fail', () => {
    expect(studio.hubNotice({ host: '192.0.2.10', cfg: cfgOf({}), env: { BRIGHTTEST_HUB_TOKEN: TOKEN } }).warn).toMatch(/allow-list is empty/)
    expect(studio.hubNotice({ host: '192.0.2.10', cfg: cfgOf({ unmatched: 'fail' }), env: { BRIGHTTEST_HUB_TOKEN: TOKEN } }).warn).toBeNull()
  })
  it('off, with the reason', () => {
    const cfg = cfgOf({})
    expect(studio.hubNotice({ host: '192.0.2.10', cfg, env: {} }).line).toBe('hub: off (BRIGHTTEST_HUB_TOKEN not set)')
    expect(studio.hubNotice({ host: '192.0.2.10', cfg, env: { BRIGHTTEST_HUB_TOKEN: 'nope' } }).line).toMatch(/hub: off \(BRIGHTTEST_HUB_TOKEN is malformed/)
    expect(studio.hubNotice({ host: null, cfg, env: { BRIGHTTEST_HUB_TOKEN: TOKEN } }).line).toBe('hub: off (no device)')
    expect(studio.hubNotice({ host: '192.0.2.10', cfg, env: {}, pool: true }).line).toMatch(/hub: off \(device pool/)
    expect(JSON.stringify(studio.hubNotice({ host: '192.0.2.10', cfg, env: { BRIGHTTEST_HUB_TOKEN: 'secret-ish' } }))).not.toContain('secret-ish')
  })
})

describe('Network panel refused state', () => {
  it('recognizes a refused row and words the hint with the bare host', async () => {
    const m = await import('../lib/studio/web/src/lib/net-state.js')
    const row = { id: 1, host: 'cdn.example.test:443', source: 'refused', status: 403, bytes: 80 }
    expect(m.isRefused(row)).toBe(true)
    expect(m.isRefused({ refused: true })).toBe(true)
    expect(m.isRefused({ source: 'passthrough' })).toBe(false)
    expect(m.refusedHost(row)).toBe('cdn.example.test')
    expect(m.refusedHint(row)).toMatch(/Add "cdn\.example\.test" to instrument\.net\.upstreamHosts/)
    expect(m.canMock(row)).toBe(false)
    expect(m.canMock({ bytes: 5, source: 'mock' })).toBe(true)
  })
})
