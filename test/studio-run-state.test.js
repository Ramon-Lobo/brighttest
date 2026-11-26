import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const studio = require('../lib/studio/server.js')
const { createEventLog } = require('../lib/instrument/events.js')
const { createStateOps } = require('../lib/instrument/state-ops.js')
const { createNetProxy } = require('../lib/instrument/net-proxy.js')
const hubMod = require('../lib/instrument/hub.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// STUDIO-RUN-STATE-STEPS: Run passes Studio's hub into the step context like `e2e run`. A scripted hub answers the
// state commands; a real loopback hub + proxy serves the network steps. Synthetic hosts, no device, no real network.
const TOKEN = 'tok-run-state'
let dir, fake, server, port, prevPort, hub, realHub, proxy

function req(method, p, body, host = port) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: host, method, path: p, headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, text: b }))
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}
const events = (text) => text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))

function makeHub(acks) {
  const log = createEventLog({ sessionId: 'sess1' })
  const stateOps = createStateOps({ session: 'sess1' })
  let seq = 0
  const h = {
    sessionId: 'sess1', hellos: 1, lastHelloAt: 1000, log, stateOps, pushed: [], events: new EventEmitter(),
    push(cmd, { ack } = {}) {
      const full = { v: 1, id: `c-${++seq}`, ...cmd, seq, session: 'sess1' }
      h.stateOps.track(full, { ack, now: Date.now() })
      h.pushed.push(full)
      setTimeout(() => {
        h.stateOps.onAck({ id: full.id, seq: full.seq, phase: 'received', session: 'sess1' })
        const result = full.op === 'snapshot' ? { layers: { global: { user: { tier: 'free' } } } } : undefined
        h.stateOps.onAck({ id: full.id, seq: full.seq, phase: 'applied', session: 'sess1', result })
      }, 5)
      return full
    },
  }
  return h
}

async function start(opts = {}) {
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, ...opts,
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
}
const writeFlow = (name, text) => { fs.mkdirSync(path.join(dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(dir, 'flows', name), text) }

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-runstate-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  delete process.env.BRIGHTTEST_HUB_TOKEN
})
afterEach(async () => {
  server.close(); await fake.stop()
  if (realHub) await realHub.stop(); if (proxy) proxy.close(); realHub = null; proxy = null
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Run with state steps', () => {
  it('runs waitForAgent, setState, snapshot and restore through the hub', async () => {
    hub = makeHub()
    await start({ net: { proxy: {}, hub, events: hub.events, log: hub.log } })
    writeFlow('s.e2e.yaml', 'appId: dev\nsteps:\n  - waitForAgent\n  - setState: { layer: global, path: user.tier, value: premium }\n  - snapshot: base\n  - restore: base\n')
    const r = await req('GET', '/api/run?file=s.e2e.yaml')
    const ev = events(r.text)
    expect(ev.find((e) => e.type === 'error')).toBeUndefined()
    expect(ev.filter((e) => e.type === 'step' && e.status === 'fail')).toEqual([])
    expect(ev[ev.length - 1]).toMatchObject({ type: 'done', ok: true })
    expect(hub.pushed.map((c) => c.op)).toEqual(['set', 'snapshot', 'restore'])
    expect(hub.pushed[0].args).toMatchObject({ layer: 'global', path: 'user.tier', value: 'premium' })
  })

  it('fails before step 1 when callFunc is not in instrument.state.callable', async () => {
    hub = makeHub()
    await start({ net: { proxy: {}, hub, events: hub.events, log: hub.log } })
    writeFlow('c.e2e.yaml', 'appId: dev\nsteps:\n  - callFunc: { node: { id: home }, fn: bt_reset }\n')
    const ev = events((await req('GET', '/api/run?file=c.e2e.yaml')).text)
    expect(ev.map((e) => e.type)).toEqual(['error'])
    expect(ev[0].error).toMatch(/not in instrument\.state\.callable/)
    expect(hub.pushed).toEqual([])
  })
})

describe('Run with no hub', () => {
  it('fails before the first step with the hub message, never mid-run', async () => {
    await start() // host given, no hub token in the environment: Studio has no hub
    writeFlow('s.e2e.yaml', 'appId: dev\nsteps:\n  - press: Home\n  - setState: { layer: global, path: a, value: 1 }\n')
    const ev = events((await req('GET', '/api/run?file=s.e2e.yaml')).text)
    expect(ev.map((e) => e.type)).toEqual(['error'])
    expect(ev[0].code).toBe('NO_HUB')
    expect(ev[0].error).toMatch(/BRIGHTTEST_HUB_TOKEN/)
    expect(JSON.stringify(ev)).not.toMatch(/STATE_NO_HUB/)
  })

  it('still runs a flow that uses no state or net step', async () => {
    await start()
    writeFlow('p.e2e.yaml', 'appId: dev\nsteps:\n  - press: Home\n')
    const ev = events((await req('GET', '/api/run?file=p.e2e.yaml')).text)
    expect(ev[ev.length - 1]).toMatchObject({ type: 'done', ok: true })
  })
})

describe('Run with network steps', () => {
  it('serves a flow rule through the proxy, removes it and restores the unmatched mode after the run', async () => {
    proxy = createNetProxy({ root: dir })
    realHub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease(), netProxy: proxy })
    await start({ net: { proxy, hub: realHub, events: realHub.events, log: realHub.log } })
    expect(proxy.unmatched).toBeUndefined()
    writeFlow('n.e2e.yaml', 'appId: dev\nconfig:\n  net: { unmatched: fail }\nsteps:\n  - mockHttp: { url: "**/v1/home", status: 200, body: "hi" }\n  - waitForRequest: { url: "**/v1/home", timeout: 8 }\n  - assertRequest: { url: "**/v1/home" }\n')
    const body = []
    let live = true
    const fire = (async () => {
      while (live) {
        const r = await req('GET', `/bt/${TOKEN}/net/;http://example.test/v1/home`, undefined, realHub.port)
        if (r.text === 'hi') body.push(r.text)
        await new Promise((r2) => setTimeout(r2, 40))
      }
    })()
    const sawMode = []
    const poll = setInterval(() => sawMode.push(proxy.unmatched), 10)
    const r = await req('GET', '/api/run?file=n.e2e.yaml')
    live = false; clearInterval(poll); await fire
    const ev = events(r.text)
    expect(ev.find((e) => e.type === 'error')).toBeUndefined()
    expect(ev.filter((e) => e.type === 'step' && e.status === 'fail')).toEqual([])
    expect(ev[ev.length - 1]).toMatchObject({ type: 'done', ok: true })
    expect(body.length).toBeGreaterThan(0)
    expect(sawMode).toContain('fail')                 // the flow's mode applied during the run
    expect(proxy.unmatched).toBeUndefined()           // and the previous one is back
    expect(proxy.ruleSet.list().filter((x) => x.source === 'rule')).toEqual([]) // flow-scoped rules are gone
  })
})
