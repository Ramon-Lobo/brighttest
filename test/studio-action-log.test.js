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

// STA-S-T12 route cases: action log, time travel and snapshot fixtures against a fake in-process hub (state-ops + event log) and a temp lease dir.
// Values are fixtures, not credentials.
let dir, fake, server, port, prevPort, hub, auto
const key = () => `127.0.0.1_p${process.env.ROKU_ECP_PORT}`
const other = () => lease.acquire({ dir, key: key(), agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false, timers: false, identity: {} })

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(method !== 'GET' && !(headers && headers.noCt) ? { 'Content-Type': 'application/json' } : {}), ...(headers && !headers.noCt ? headers : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
    })
    r.on('error', reject)
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body))
    r.end()
  })
}

function makeHub() {
  const log = createEventLog({ sessionId: 'sess1' })
  const stateOps = createStateOps({ session: 'sess1' })
  let seq = 0
  const h = {
    sessionId: 'sess1', hellos: 1, lastHelloAt: 1000, log, stateOps, pushed: [], events: new EventEmitter(),
    push(cmd, { ack } = {}) {
      const full = { v: 1, id: `c-${++seq}`, ...cmd, seq, session: 'sess1' }
      h.stateOps.track(full, { ack, now: Date.now() })
      h.pushed.push(full)
      if (auto) setTimeout(() => {
        h.stateOps.onAck({ id: full.id, seq: full.seq, phase: 'received', session: 'sess1' })
        const result = full.op === 'snapshot' ? { layers: { global: { user: { tier: 'free', token: '<redacted:token>', nickname: 'Zed' } } } } : undefined
        h.stateOps.onAck({ id: full.id, seq: full.seq, phase: 'applied', session: 'sess1', result })
      }, 5)
      return full
    },
  }
  return h
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-state-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  auto = true
  hub = makeHub()
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, net: { proxy: {}, hub, events: hub.events, log: hub.log, redactPaths: ['global.user.nickname', 'registry.*.cardlast4'] },
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
})
afterEach(async () => {
  server.close(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

const pushAction = (d) => hub.log.push({ src: 'agent', kind: 'state.action', data: d })

describe('action log', () => {
  it('lists state.action events oldest first with hashes, redacted payloads and a changed flag', async () => {
    pushAction({ source: 'wrap:Dispatch', type: 'login', payload: { user: 'zed', token: 'tok-secret' }, hashBefore: 'aa', hashAfter: 'bb' })
    hub.log.push({ src: 'agent', kind: 'agent.hello', data: {} })
    pushAction({ source: 'wrap:Dispatch', type: 'noop', hashBefore: 'bb', hashAfter: 'bb' })
    const r = await req('GET', '/api/state/actions')
    expect(r.status).toBe(200)
    expect(r.json.actions.map((a) => a.type)).toEqual(['login', 'noop'])
    expect(r.json.actions[0]).toMatchObject({ source: 'wrap:Dispatch', hashBefore: 'aa', hashAfter: 'bb', changed: true, snapshot: null })
    expect(r.json.actions[1].changed).toBe(false)
    expect(r.json.actions[0].entry).toBeLessThan(r.json.actions[1].entry)
    expect(r.text).not.toMatch(/tok-secret/)
    expect((await req('GET', '/api/state/actions?raw=1')).json.actions[0].payload.token).toBe('tok-secret')
  })

  it('records a snapshot on the newest entry and time-travels to it (queues a restore of that snapshot)', async () => {
    pushAction({ source: 'wrap:D', type: 'a', hashBefore: '1', hashAfter: '2' })
    const rec = await req('POST', '/api/state/actions', { action: 'record' })
    expect(rec.status).toBe(200)
    const first = rec.json.entry
    expect(rec.json.snapshot).toBe(`act-${first}`)
    pushAction({ source: 'wrap:D', type: 'b', hashBefore: '2', hashAfter: '3' })
    const list = (await req('GET', '/api/state/actions')).json.actions
    expect(list.map((a) => a.snapshot)).toEqual([`act-${first}`, null])
    hub.pushed.length = 0
    const t = await req('POST', '/api/state/actions', { action: 'travel', entry: first })
    expect(t.status).toBe(202)
    expect(t.json).toMatchObject({ entry: first, hashAfter: '2' })
    expect(hub.pushed).toHaveLength(1)
    expect(hub.pushed[0].op).toBe('restore')
    expect(hub.pushed[0].args.layers.global.user.tier).toBe('free')
  })

  it('refuses an unknown entry, an entry with no snapshot, and recording a stale entry', async () => {
    pushAction({ source: 'wrap:D', type: 'a', hashBefore: '1', hashAfter: '2' })
    pushAction({ source: 'wrap:D', type: 'b', hashBefore: '2', hashAfter: '3' })
    const list = (await req('GET', '/api/state/actions')).json.actions
    hub.pushed.length = 0
    expect((await req('POST', '/api/state/actions', { action: 'travel', entry: 9999 })).status).toBe(404)
    expect((await req('POST', '/api/state/actions', { action: 'travel' })).status).toBe(404)
    const nosnap = await req('POST', '/api/state/actions', { action: 'travel', entry: list[0].entry })
    expect(nosnap.status).toBe(409); expect(nosnap.json.code).toBe('NO_SNAPSHOT')
    const stale = await req('POST', '/api/state/actions', { action: 'record', entry: list[0].entry })
    expect(stale.status).toBe(409); expect(stale.json.code).toBe('STALE_ENTRY')
    expect((await req('POST', '/api/state/actions', { action: 'nope' })).status).toBe(400)
    expect(hub.pushed).toHaveLength(0)
  })

  it('answers 404 when recording on an empty log', async () => {
    expect((await req('POST', '/api/state/actions', { action: 'record' })).status).toBe(404)
  })

  it('answers 423 to a write while another agent holds the lease, and still never queues a command', async () => {
    pushAction({ source: 'wrap:D', type: 'a', hashBefore: '1', hashAfter: '2' })
    const held = await other()
    try {
      const r = await req('POST', '/api/state/actions', { action: 'record' })
      expect(r.status).toBe(423)
      expect(hub.pushed).toHaveLength(0)
    } finally { held.release && held.release() }
  })
})

describe('snapshot fixtures', () => {
  it('round-trips a snapshot through fixtures/state/<name>.json (redacted by default)', async () => {
    expect((await req('POST', '/api/state/snapshots', { action: 'save', name: 'before' })).status).toBe(200)
    const saved = await req('POST', '/api/state/fixtures', { action: 'save', name: 'seed-a', snapshot: 'before' })
    expect(saved.status).toBe(200)
    expect(saved.json.file).toBe('fixtures/state/seed-a.json')
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'state', 'seed-a.json'), 'utf8'))
    expect(onDisk.layers.global.user.tier).toBe('free')
    expect(JSON.stringify(onDisk)).not.toMatch(/Zed/)
    expect((await req('GET', '/api/state/fixtures')).json.fixtures).toEqual(['seed-a'])
    expect((await req('DELETE', '/api/state/snapshots?name=before')).status).toBe(200)
    const loaded = await req('POST', '/api/state/fixtures', { action: 'load', name: 'seed-a' })
    expect(loaded.status).toBe(200)
    const back = await req('GET', '/api/state/snapshots?name=seed-a&raw=1')
    expect(back.json.layers.global.user.tier).toBe('free')
    const rawSave = await req('POST', '/api/state/fixtures', { action: 'save', name: 'seed-raw', snapshot: 'seed-a', raw: true })
    expect(rawSave.json.redacted).toBe(false)
  })

  it('refuses unknown fixtures and snapshots, bad names and unknown layers', async () => {
    expect((await req('POST', '/api/state/fixtures', { action: 'load', name: 'missing' })).status).toBe(404)
    expect((await req('POST', '/api/state/fixtures', { action: 'save', name: 'x', snapshot: 'missing' })).status).toBe(404)
    expect((await req('POST', '/api/state/fixtures', { action: 'save', name: '../evil', snapshot: 'x' })).status).toBe(400)
    expect((await req('POST', '/api/state/fixtures', { action: 'nope', name: 'x' })).status).toBe(400)
    fs.mkdirSync(path.join(dir, 'fixtures', 'state'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'fixtures', 'state', 'bad.json'), JSON.stringify({ layers: { bogus: {} } }))
    expect((await req('POST', '/api/state/fixtures', { action: 'load', name: 'bad' })).status).toBe(400)
  })

  it('answers 423 to a fixture write while another agent holds the lease', async () => {
    const held = await other()
    try { expect((await req('POST', '/api/state/fixtures', { action: 'load', name: 'x' })).status).toBe(423) } finally { held.release && held.release() }
  })
})
