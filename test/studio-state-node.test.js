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
const { createStateOps } = require('../lib/instrument/state-ops.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// STUDIO-NS-T1: GET /api/state/node against a scripted fake hub. `script(cmd)` returns the agent's ack
// ({ result } for success, { error: 'CODE: message' } for a refusal) or null for silence. Values are fixtures.
let dir, fake, server, port, prevPort, hub, script
const stateNode = (q) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: `/api/state/node${q}` }, (res) => {
    let b = ''; res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
  }).on('error', reject)
})
const post = (p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode }))
  })
  r.on('error', reject); r.write(JSON.stringify(body)); r.end()
})

function makeHub(hellos = 1) {
  const log = createEventLog({ sessionId: 'sess1' })
  const stateOps = createStateOps({ session: 'sess1', timeouts: { received: 600, applied: 600 } })
  let seq = 0
  const h = {
    sessionId: 'sess1', hellos, lastHelloAt: 1000, log, stateOps, pushed: [], opts: [], events: new EventEmitter(),
    push(cmd, opts = {}) {
      const full = { v: 1, id: `${opts.quiet ? 'sr' : 'c'}-${++seq}`, ...cmd, seq, session: 'sess1' }
      h.stateOps.track(full, { ack: opts.ack, now: Date.now() })
      h.pushed.push(full); h.opts.push(opts)
      const a = script ? script(full) : null
      if (a) setTimeout(() => {
        h.stateOps.onAck({ id: full.id, seq: full.seq, phase: 'received', session: 'sess1' })
        h.stateOps.onAck({ id: full.id, seq: full.seq, phase: 'applied', session: 'sess1', ...a })
      }, 5)
      return full
    },
  }
  return h
}

async function boot(h, extra = {}) {
  hub = h
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, net: { proxy: {}, hub, events: hub.events, log: hub.log, redactPaths: ['node.title', 'm.profile.nickname'], ...extra },
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-node-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  script = (c) => ({ result: { found: true, value: { visible: true, title: 'Home', password: '<redacted:password>' }, truncated: ['node.items:items'] } })
  await boot(makeHub())
})
afterEach(async () => {
  server.close(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/state/node', () => {
  it('reads node fields through a quiet get op and masks configured paths rooted at node.', async () => {
    const r = await stateNode('?id=hero&layer=node')
    expect(r.status).toBe(200)
    expect(hub.pushed[0]).toMatchObject({ op: 'get', args: { layer: 'node', node: { id: 'hero' } } })
    expect(hub.pushed[0].args).not.toHaveProperty('path')
    expect(hub.opts[0]).toMatchObject({ quiet: true, ack: 'applied' })
    expect(r.json).toMatchObject({ id: 'hero', layer: 'node', path: '', found: true, depth: null, redacted: true, truncated: ['node.items:items'] })
    expect(r.json.value.visible).toBe(true)
    expect(r.json.value.title).toBe('<redacted:title>') // configured mask
    expect(r.json.value.password).toBe('<redacted:password>')
    expect(r.text).not.toMatch(/Home/)
    expect(hub.stateOps.get('sr-1')).toBeNull() // record dropped
  })
  it('?raw=1 returns the agent value unmasked by Studio', async () => {
    const r = await stateNode('?id=hero&layer=node&raw=1')
    expect(r.json.value.title).toBe('Home')
  })
  it('reads m with a path and depth; the mask is rooted at m.<path>', async () => {
    script = () => ({ result: { found: true, value: { nickname: 'Zed', n: 1 }, truncated: [], depth: 2 } })
    const r = await stateNode('?id=row&layer=m&path=profile&depth=2')
    expect(hub.pushed[0].args).toEqual({ layer: 'm', node: { id: 'row' }, path: 'profile', depth: 2 })
    expect(r.json).toMatchObject({ layer: 'm', path: 'profile', depth: 2, found: true })
    expect(r.json.value).toEqual({ nickname: '<redacted:nickname>', n: 1 })
  })
  it('a path mask applies to a scalar read at that exact path', async () => {
    script = () => ({ result: { found: true, value: 'Zed', truncated: [] } })
    const r = await stateNode('?id=row&layer=m&path=profile.nickname')
    expect(r.json.value).toBe('<redacted:nickname>')
  })
  it('found:false is a 200 with a null value', async () => {
    script = () => ({ result: { found: false } })
    const r = await stateNode('?id=hero&layer=node&path=nope')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ found: false, value: null, redacted: false, truncated: [] })
  })
  it('does not list the quiet read in the state command list', async () => {
    await stateNode('?id=hero&layer=node')
    const list = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/state' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))) }))
    expect(list.commands).toEqual([])
  })

  it.each([
    ['NODE_NOT_FOUND', 404], ['M_NOT_AVAILABLE', 409], ['M_PATH_FORBIDDEN', 409], ['PATH_UNDER_NODE', 400], ['STATE_TOO_LARGE', 413], ['MYSTERY', 502],
  ])('passes the agent refusal %s through as %i', async (code, status) => {
    script = () => ({ ok: false, error: `${code}: because reasons` })
    const r = await stateNode('?id=hero&layer=m')
    expect(r.status).toBe(status)
    expect(r.json).toMatchObject({ code, error: 'because reasons' })
  })
  it('an unparseable refusal is CMD_FAILED (502)', async () => {
    script = () => ({ ok: false, error: 'boom' })
    const r = await stateNode('?id=hero&layer=node')
    expect(r.status).toBe(502)
    expect(r.json.code).toBe('CMD_FAILED')
  })
  it('no answer from the app is 504 ACK_TIMEOUT and the record is dropped', async () => {
    script = null
    const t0 = Date.now()
    const r = await stateNode('?id=hero&layer=node')
    expect(r.status).toBe(504)
    expect(r.json.code).toBe('ACK_TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(4500)
    expect(hub.stateOps.get('sr-1')).toBeNull()
  })

  it('validates input (400 BAD_COMMAND) without queuing a command', async () => {
    for (const q of ['?layer=node', '?id=x', '?id=x&layer=global', `?id=${'a'.repeat(257)}&layer=node`, '?id=x&layer=m&path=a..b', '?id=x&layer=m&path=.a',
      `?id=x&layer=m&path=${'a'.repeat(1025)}`, '?id=x&layer=m&depth=0', '?id=x&layer=m&depth=abc', '?id=x&layer=m&depth=1.5']) {
      const r = await stateNode(q)
      expect(r.status, q.slice(0, 40)).toBe(400)
      expect(r.json.code).toBe('BAD_COMMAND')
    }
    expect(hub.pushed).toEqual([])
  })
  it('accepts the 256-character id and 1 KB path limits', async () => {
    const r = await stateNode(`?id=${'a'.repeat(256)}&layer=m&path=${'p'.repeat(1024)}`)
    expect(r.status).toBe(200)
  })
  it('409 STATE_NOT_INSTRUMENTED when no agent.hello was seen', async () => {
    server.close(); await boot(makeHub(0))
    const r = await stateNode('?id=hero&layer=node')
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('STATE_NOT_INSTRUMENTED')
    expect(hub.pushed).toEqual([])
  })
  it('503 NO_HUB when Studio has no hub', async () => {
    server.close(); server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, net: { proxy: {} },
      leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
    port = server.address().port
    const r = await stateNode('?id=hero&layer=node')
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('NO_HUB')
  })
  it('423 LOCKED when another agent holds the device lease', async () => {
    lease.acquire({ dir, key: `127.0.0.1_p${process.env.ROKU_ECP_PORT}`, agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, timers: false, identity: {} })
    const r = await stateNode('?id=hero&layer=node')
    expect(r.status).toBe(423)
    expect(hub.pushed).toEqual([])
  })
  it('only GET is allowed', async () => {
    const r = await post('/api/state/node', {})
    expect(r.status).toBe(405)
  })
})
