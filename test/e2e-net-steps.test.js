import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'
import { parseFlow } from '../lib/e2e/flow.js'
import ns from '../lib/e2e/net-steps.js'
import hubMod from '../lib/instrument/hub.js'

// Network flow steps (NET-N-T9) against a real loopback hub + proxy (synthetic hosts, no device, no real network).
const TOKEN = 'tok-net-steps'
let dir, cfg, hub, session, ctx
const cleanup = []

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }))
    })
    r.on('error', reject); if (body) r.write(body); r.end()
  })
}
const viaHub = (method, url, body) => req(hub.port, method, `/bt/${TOKEN}/net/;${url}`, body)
const flowOf = (src, name = 'f') => ({ ...parseFlow(src), name })

async function setup(flow) {
  session = ns.planSession([{ file: 'x' }], cfg, () => flow)
  hub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease(), netProxy: session.proxy })
  const begun = ns.beginFlow(flow, session, hub, cfg)
  expect(begun.error).toBeUndefined()
  ctx = { net: begun.net, stepTimeoutMs: 400, opts: { netHandshakeMs: 150 } }
  return ctx
}
const run = (src) => flowOf(src).steps
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-net-steps-'))
  cfg = loadConfig(dir, null)
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'fixtures', 'home.json'), '{"title":"Mock Title"}')
})
afterEach(async () => {
  if (hub) await hub.stop(); if (session) session.close(); hub = null; session = null
  vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true })
  cleanup.length = 0
})

const BASE = 'appId: dev\nsteps:\n'

describe('parsing', () => {
  it('parses all five steps and a bare clearHttp', () => {
    const steps = run(BASE + '  - mockHttp: { method: GET, url: "**/v1/home", status: 200, file: fixtures/home.json }\n  - waitForRequest: { url: "**/v1/home", timeout: 5 }\n  - assertRequest: { method: post, url: "**/track", count: 1, bodyContains: play }\n  - recordHttp: { file: out.har }\n  - recordHttp: stop\n  - clearHttp\n')
    expect(steps.map((s) => s.op)).toEqual(['mockHttp', 'waitForRequest', 'assertRequest', 'recordHttp', 'recordHttp', 'clearHttp'])
    expect(steps[2]).toMatchObject({ count: 1, match: { method: 'POST', url: '**/track', bodyContains: 'play' } })
    expect(steps[4].stop).toBe(true)
  })
  it('gives line-referenced errors', () => {
    expect(() => run(BASE + '  - mockHttp: { status: 200 }\n')).toThrow(/line 3: mockHttp needs url/)
    expect(() => run(BASE + '  - mockHttp: { url: "**/a", status: 99 }\n')).toThrow(/line 3: mockHttp/)
    expect(() => run(BASE + '  - assertRequest: { url: "**/a", count: -1 }\n')).toThrow(/count must be an integer/)
    expect(() => run(BASE + '  - waitForRequest: { method: GET }\n')).toThrow(/waitForRequest needs url/)
    expect(() => run(BASE + '  - recordHttp: { }\n')).toThrow(/recordHttp needs/)
  })
  it('validates config.net', () => {
    const cfgOf = (net) => `appId: dev\nconfig: { net: ${net} }\nsteps:\n  - launch\n`
    expect(parseFlow(cfgOf('{ fixtures: [a.json], unmatched: fail }')).config.net).toEqual({ fixtures: ['a.json'], unmatched: 'fail' })
    expect(() => parseFlow(cfgOf('{ unmatched: maybe }'))).toThrow(/unmatched must be/)
    expect(() => parseFlow(cfgOf('{ bogus: 1 }'))).toThrow(/unknown key "bogus"/)
    expect(() => parseFlow(cfgOf('{ fixtures: a.json }'))).toThrow(/fixtures must be a list/)
    expect(() => parseFlow(cfgOf('{ record: true }'))).toThrow(/requires config.net.upstreamHosts/)
  })
})

describe('steps against the hub', () => {
  it('mockHttp answers the app, waitForRequest and assertRequest see it', async () => {
    const flow = flowOf(BASE + '  - mockHttp: { url: "**/v1/home", status: 200, file: fixtures/home.json }\n  - launch\n')
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    expect((await viaHub('GET', 'http://example.test/v1/home')).text).toBe('{"title":"Mock Title"}')
    await viaHub('POST', 'http://example.test/v1/track', '{"event":"play"}')
    const [w] = run(BASE + '  - waitForRequest: { method: GET, url: "**/v1/home", timeout: 1 }\n')
    await expect(ns.execStep(w, ctx)).resolves.toBeTruthy()
    const [a] = run(BASE + '  - assertRequest: { method: POST, url: "**/track", count: 1, bodyContains: play }\n')
    await expect(ns.execStep(a, ctx)).resolves.toBeTruthy()
    const [none] = run(BASE + '  - assertRequest: { url: "**/ads/**", count: 0 }\n')
    await expect(ns.execStep(none, ctx)).resolves.toBeTruthy()
  })

  it('waitForRequest times out with the log summary', async () => {
    const flow = flowOf(BASE + '  - launch\n')
    flow.config.net = {}
    await setup(flow)
    await viaHub('GET', 'http://example.test/other')
    const [w] = run(BASE + '  - waitForRequest: { method: GET, url: "**/v1/home", timeout: 0.2 }\n')
    await expect(ns.execStep(w, ctx)).rejects.toThrow(/waitForRequest: no request matching GET \*\*\/v1\/home within 0.2s \(1 request\(s\) in the log: GET \/other\)/)
  })

  it('assertRequest mismatch names expected, seen and the log', async () => {
    const flow = flowOf(BASE + '  - mockHttp: { url: "**/track", status: 204 }\n  - launch\n')
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    await viaHub('POST', 'http://example.test/track', 'pause')
    const [a] = run(BASE + '  - assertRequest: { method: POST, url: "**/track", count: 1, bodyContains: play }\n')
    await expect(ns.execStep(a, ctx)).rejects.toThrow(/assertRequest: expected 1 request\(s\) matching POST \*\*\/track with body containing "play", saw 0 \(1 request\(s\) in the log: POST \/track\)/)
    await viaHub('POST', 'http://example.test/track', 'x')
    const [two] = run(BASE + '  - assertRequest: { url: "**/track", count: 1 }\n')
    await expect(ns.execStep(two, ctx)).rejects.toThrow(/expected 1 request\(s\).*saw 2/)
  })

  it('clearHttp drops flow rules and hides the log; a 503 mock works', async () => {
    const flow = flowOf(BASE + '  - mockHttp: { url: "**/search*", status: 503 }\n  - launch\n')
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    expect((await viaHub('GET', 'http://example.test/search?q=a')).status).toBe(503)
    await ns.execStep(run(BASE + '  - clearHttp\n')[0], ctx)
    expect(session.proxy.ruleSet.list()).toEqual([])
    const [a] = run(BASE + '  - assertRequest: { url: "**/search*", count: 0 }\n')
    await expect(ns.execStep(a, ctx)).resolves.toBeTruthy()
  })

  it('endFlow drops the flow scoped rules; a second flow does not see the first flow log', async () => {
    const flow = flowOf(BASE + '  - mockHttp: { url: "**/a", status: 200 }\n  - launch\n')
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    await viaHub('GET', 'http://example.test/a')
    ns.endFlow(ctx.net)
    expect(session.proxy.ruleSet.list()).toEqual([])
    const second = ns.beginFlow(flow, session, hub, cfg)
    const [a] = run(BASE + '  - assertRequest: { url: "**/a", count: 0 }\n')
    await expect(ns.execStep(a, { ...ctx, net: second.net })).resolves.toBeTruthy()
  })

  it('config.net.fixtures load flow-scoped and make unmatched fail', async () => {
    fs.writeFileSync(path.join(dir, 'fixtures', 'rules.json'), JSON.stringify([{ url: '**/fx', status: 201, body: 'fx' }]))
    const flow = flowOf(BASE + '  - launch\n')
    flow.config.net = { fixtures: ['fixtures/rules.json'] }
    await setup(flow)
    expect((await viaHub('GET', 'http://example.test/fx')).text).toBe('fx')
    expect((await viaHub('GET', 'http://example.test/nope')).status).toBe(599)
    ns.endFlow(ctx.net)
    expect(session.proxy.ruleSet.list()).toEqual([])
  })

  it('recordHttp refuses without upstreamHosts and stop without a start', async () => {
    const flow = flowOf(BASE + '  - recordHttp: { file: out.har }\n  - launch\n')
    await setup(flow)
    await expect(ns.execStep(flow.steps[0], ctx)).rejects.toThrow(/refuses to start without config.net.upstreamHosts/)
    await expect(ns.execStep({ op: 'recordHttp', stop: true }, ctx)).rejects.toThrow(/without an active recording/)
  })

  it('recordHttp with upstreamHosts writes a HAR window (empty here: nothing passed through)', async () => {
    const flow = flowOf(BASE + '  - recordHttp: { file: out/s.har }\n  - recordHttp: stop\n')
    flow.config.net = { upstreamHosts: ['example.test'] }
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    await ns.execStep(flow.steps[1], ctx)
    const har = JSON.parse(fs.readFileSync(path.join(dir, 'out', 's.har'), 'utf8'))
    expect(har.log.entries).toEqual([])
  })
})

describe('fail fast', () => {
  it('a build that never dials the hub fails right after launch, well before step timeouts', async () => {
    const flow = flowOf(BASE + '  - mockHttp: { url: "**/a", status: 200 }\n  - launch\n')
    await setup(flow)
    const t0 = Date.now()
    await expect(ns.awaitHandshake(ctx)).rejects.toThrow('no agent.hello/BT_url handshake seen: build with `brighttest instrument build --net`')
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('passes once the app has said hello', async () => {
    const flow = flowOf(BASE + '  - launch\n')
    flow.config.net = {}
    await setup(flow)
    await req(hub.port, 'GET', `/bt/${TOKEN}/hello`)
    await expect(ns.awaitHandshake(ctx)).resolves.toBeUndefined()
  })
  it('a flow with net steps and no hub fails before the device is touched (e2e.run)', async () => {
    const calls = []
    const createDevice = () => ({ deviceInfo: async () => { calls.push('info'); return { model: 'Stub', developerEnabled: true } }, launch: async () => calls.push('launch'), keypress: async () => calls.push('key') })
    const flowFile = path.join(dir, 'n.e2e.yaml')
    fs.writeFileSync(flowFile, BASE + '  - mockHttp: { url: "**/a", status: 200 }\n  - launch\n')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const out = []
    process.stdout.write.mockImplementation((s) => { out.push(String(s)); return true })
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flowFile], host: '10.0.0.1', logs: false }, { createDevice, acquireForLane: async () => ({ lease: null }) })
    expect(code).toBe(1)
    expect(calls).toEqual(['info'])
    expect(out.join('')).toMatch(/network steps need the instrument hub/)
  })
  it('a net step with no ctx.net reports the missing instrumented build', async () => {
    await expect(ns.execStep({ op: 'clearHttp' }, {})).rejects.toThrow(/instrument build --net/)
  })
})
