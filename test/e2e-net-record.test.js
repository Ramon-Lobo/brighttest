import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { loadConfig } from '../lib/config.js'
import { parseFlow } from '../lib/e2e/flow.js'
import ns from '../lib/e2e/net-steps.js'
import hubMod from '../lib/instrument/hub.js'
import { createNetProxy } from '../lib/instrument/net-proxy.js'

// recordHttp on the proxy's real startRecording/stopRecording (NET-REC): loopback upstream, no device.
const TOKEN = 'tok-net-rec'
let dir, cfg, hub, session, ctx, upstream, upPort
const BASE = 'appId: dev\nsteps:\n'
const flowOf = (src) => ({ ...parseFlow(src), name: 'f' })

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }).on('error', reject)
  })
}
const viaHub = (p) => get(hub.port, `/bt/${TOKEN}/net/;http://127.0.0.1:${upPort}${p}`)
const readHar = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
const urls = (har) => har.log.entries.map((e) => new URL(e.request.url).pathname)

async function setup(flow) {
  flow.config.net = { upstreamHosts: [`127.0.0.1:${upPort}`], unmatched: 'passthrough' }
  session = ns.planSession([{ file: 'x' }], cfg, () => flow)
  hub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease(), netProxy: session.proxy })
  const begun = ns.beginFlow(flow, session, hub, cfg)
  expect(begun.error).toBeUndefined()
  ctx = { net: begun.net, stepTimeoutMs: 400, opts: {} }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-net-rec-'))
  cfg = loadConfig(dir, null)
  upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + req.url) })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  upPort = upstream.address().port
})
afterEach(async () => {
  if (hub) await hub.stop(); if (session) session.close(); hub = null; session = null
  await new Promise((r) => upstream.close(r)); upstream.closeAllConnections && upstream.closeAllConnections()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('recordHttp window', () => {
  it('keeps only traffic between start and stop', async () => {
    const flow = flowOf(BASE + '  - recordHttp: { file: out/w.har }\n  - recordHttp: stop\n')
    await setup(flow)
    expect(await viaHub('/before')).toBe(200)
    await ns.execStep(flow.steps[0], ctx)
    expect(session.proxy.recording).toBe(true)
    await viaHub('/during-1'); await viaHub('/during-2')
    const r = await ns.execStep(flow.steps[1], ctx)
    expect(r.detail).toMatch(/^2 request/)
    expect(session.proxy.recording).toBe(false)
    await viaHub('/after')
    expect(urls(readHar('out/w.har'))).toEqual(['/during-1', '/during-2'])
    expect(readHar('out/w.har').log.version).toBe('1.2')
  })

  it('an exchange that began before start is not in the window', async () => {
    const slow = http.createServer((req, res) => setTimeout(() => res.end('slow'), 150))
    await new Promise((r) => slow.listen(0, '127.0.0.1', r))
    const sp = slow.address().port
    const flow = flowOf(BASE + '  - recordHttp: { file: out/s.har }\n  - recordHttp: stop\n')
    flow.config.net = { upstreamHosts: [`127.0.0.1:${sp}`, `127.0.0.1:${upPort}`], unmatched: 'passthrough' }
    session = ns.planSession([{ file: 'x' }], cfg, () => flow)
    hub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease(), netProxy: session.proxy })
    ctx = { net: ns.beginFlow(flow, session, hub, cfg).net, stepTimeoutMs: 400, opts: {} }
    const inflight = get(hub.port, `/bt/${TOKEN}/net/;http://127.0.0.1:${sp}/slow`)
    await new Promise((r) => setTimeout(r, 40))
    await ns.execStep(flow.steps[0], ctx)
    await inflight
    await viaHub('/inside')
    await ns.execStep(flow.steps[1], ctx)
    expect(urls(readHar('out/s.har'))).toEqual(['/inside'])
    await new Promise((r) => slow.close(r))
  })

  it('endFlow closes the window after a failed step and writes what was captured', async () => {
    const flow = flowOf(BASE + '  - recordHttp: { file: out/f.har }\n  - launch\n')
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    await viaHub('/kept')
    const out = []
    ns.endFlow(ctx.net, (m) => out.push(m)) // what run.js does in finally after a step error
    expect(session.proxy.recording).toBe(false)
    expect(out.join('')).toMatch(/1 request\(s\) written/)
    expect(urls(readHar('out/f.har'))).toEqual(['/kept'])
    await viaHub('/later')
    expect(urls(readHar('out/f.har'))).toEqual(['/kept'])
  })

  it('a second recordHttp start while one is open is refused', async () => {
    const flow = flowOf(BASE + '  - recordHttp: { file: a.har }\n')
    await setup(flow)
    await ns.execStep(flow.steps[0], ctx)
    await expect(ns.execStep(flow.steps[0], ctx)).rejects.toThrow(/already active/)
  })

  it('buffer overflow stops the recording with a clear error and discards it', async () => {
    const flow = flowOf(BASE + '  - recordHttp: { file: o.har }\n  - recordHttp: stop\n')
    await setup(flow)
    session.proxy.startRecording({ maxEntries: 2 })
    await viaHub('/1'); await viaHub('/2'); await viaHub('/3')
    expect(() => session.proxy.stopRecording()).toThrow(/recording buffer overflow \(more than 2 exchanges/)
    expect(session.proxy.recording).toBe(false)
    // the stop step surfaces the same error, recording ends, no file is written
    session.proxy.startRecording({ maxEntries: 1 })
    ctx.net.recording = { file: 'o.har' }
    await viaHub('/a'); await viaHub('/b')
    await expect(ns.execStep(flow.steps[1], ctx)).rejects.toThrow(/recording buffer overflow/)
    expect(session.proxy.recording).toBe(false)
    expect(ctx.net.recording).toBe(null)
    expect(fs.existsSync(path.join(dir, 'o.har'))).toBe(false)
  })
})

describe('proxy start/stop', () => {
  it('stop without start throws; start needs record mode', () => {
    const p = createNetProxy({ upstreamHosts: ['a.test'], record: true })
    expect(() => p.stopRecording()).toThrow(/no recording is active/)
    expect(() => createNetProxy({}).startRecording()).toThrow(/needs net.record/)
    p.close()
  })
})
