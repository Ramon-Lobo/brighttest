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

// STA-S-T8 route cases: /api/state* against a fake in-process hub (state-ops + event log) and a temp lease dir.
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
const publish = (layers, truncated = []) => fake.setAgentText(JSON.stringify({ v: 1, seq: 7, snapshot: { layers }, truncated }))
const until = async (fn, what) => { for (let i = 0; i < 250 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); if (!fn()) throw new Error(`timed out waiting for ${what}`) }

describe('GET /api/state', () => {
  it('serves the agent layers read over ECP (not a hub event), redacted by default and by the configured mask; ?raw=1 returns raw values', async () => {
    publish({ global: { user: { tier: 'free', password: 'pw-secret', nickname: 'Zed' } }, registry: { prefs: { cardlast4: '4242', a: 1 } } })
    const r = await req('GET', '/api/state')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ session: 'sess1', hellos: 1, raw: false, snapshots: [], commands: [] })
    expect(r.json.layers.global.state.user.tier).toBe('free')
    expect(r.json.layers.global.state.user.password).toBe('<redacted:password>') // built-in key regex
    expect(r.json.layers.global.state.user.nickname).toBe('<redacted:nickname>') // configured mask only
    expect(r.json.layers.registry.state.prefs.cardlast4).toBe('<redacted:cardlast4>')
    expect(r.json.layers.registry.state.prefs.a).toBe(1)
    expect(r.text).not.toMatch(/pw-secret|Zed|4242/)
    const raw = await req('GET', '/api/state?raw=1')
    expect(raw.json.layers.global.state.user).toMatchObject({ password: 'pw-secret', nickname: 'Zed' })
  })
  it('keeps hellos, snapshots and history available with no published layers (hub up is enough)', async () => {
    const r = await req('GET', '/api/state')
    expect(r.json.layers).toBeNull()
    expect(r.json.hellos).toBe(1)
  })
  it('reports an unreadable agent document as agentError', async () => {
    fake.setAgentText(JSON.stringify({ v: 1, snapshot: { layers: { global: { s: 'x'.repeat(256 * 1024 + 1) } } } }))
    const r = await req('GET', '/api/state')
    expect(r.json.layers).toBeNull()
    expect(r.json.agentError).toMatch(/256 KB/)
  })
  it('masks command results (result.layers.*) in the list and the ?id= view with the configured mask', async () => {
    await req('POST', '/api/state/snapshots', { action: 'save', name: 'before' })
    hub.stateOps.get('c-1')
    const list = await req('GET', '/api/state')
    expect(list.json.commands[0].result.layers.global.user.nickname).toBe('<redacted:nickname>')
    expect(list.text).not.toMatch(/Zed/)
    const one = await req('GET', '/api/state?id=c-1')
    expect(one.json.command.result.layers.global.user.nickname).toBe('<redacted:nickname>')
    expect(one.text).not.toMatch(/Zed/)
    expect((await req('GET', '/api/state?id=c-1&raw=1')).json.command.result.layers.global.user.nickname).toBe('Zed')
  })
  it('unknown id is 404', async () => {
    expect((await req('GET', '/api/state?id=nope')).status).toBe(404)
  })
})

describe('POST /api/state/cmd', () => {
  it('queues a set command through the flow-step validator and returns a flow step; the ack chip is readable by id', async () => {
    const r = await req('POST', '/api/state/cmd', { layer: 'global', path: 'user.tier', value: 'premium' })
    expect(r.status).toBe(202)
    expect(r.json).toMatchObject({ id: 'c-1', seq: 1, session: 'sess1' })
    expect(r.json.step).toBe('- setState: { layer: "global", path: "user.tier", value: "premium" }')
    expect(hub.pushed[0]).toMatchObject({ op: 'set', args: { layer: 'global', path: 'user.tier', value: 'premium' } })
    await until(() => hub.stateOps.get('c-1').status === 'done', 'ack')
    const s = await req('GET', '/api/state?id=c-1')
    expect(s.json.command).toMatchObject({ phase: 'applied', status: 'done', ok: true })
  })
  it('maps the registry layer and ops batches like a flow step', async () => {
    await req('POST', '/api/state/cmd', { layer: 'registry', path: 'app.watchlist', value: [1] })
    expect(hub.pushed[0]).toMatchObject({ op: 'registry.write', args: { section: 'app', key: 'watchlist', value: [1] } })
    await req('POST', '/api/state/cmd', { ops: [{ path: 'a.b', value: 1 }, { path: 'c', value: 2 }] })
    expect(hub.pushed[1]).toMatchObject({ op: 'set', args: { layer: 'global', ops: [{ path: 'a.b', value: 1 }, { path: 'c', value: 2 }] } })
  })
  it('honours ack: reflected', async () => {
    const r = await req('POST', '/api/state/cmd', { path: 'x', value: 1, ack: 'reflected' })
    expect(r.status).toBe(202)
    expect(hub.stateOps.get(r.json.id).want).toBe('reflected')
  })
  it('rejects what a flow would reject: bad layer, bad path, unknown key, missing value, bad ack, bad JSON', async () => {
    for (const body of [{ layer: 'bogus', path: 'a', value: 1 }, { path: '..a', value: 1 }, { path: 'a', value: 1, evil: true }, { path: 'a' }, { path: 'a', value: 1, ack: 'maybe' }, { layer: 'node', path: 'a', value: 1 }]) {
      const r = await req('POST', '/api/state/cmd', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.code).toBe('BAD_COMMAND')
    }
    expect((await req('POST', '/api/state/cmd', '{nope')).status).toBe(400)
    expect(hub.pushed).toHaveLength(0)
  })
  it('refuses an oversized value (413) and an app that never said hello (409)', async () => {
    const big = await req('POST', '/api/state/cmd', { path: 'a', value: 'x'.repeat(70000) })
    expect(big.status).toBe(413)
    hub.hellos = 0
    const r = await req('POST', '/api/state/cmd', { path: 'a', value: 1 })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('STATE_NOT_INSTRUMENTED')
  })
  it('405 on GET, 404 on unknown state route', async () => {
    expect((await req('GET', '/api/state/cmd')).status).toBe(405)
    expect((await req('GET', '/api/state/nope')).status).toBe(404)
  })
})

describe('snapshots, diff, export and import', () => {
  it('saves a snapshot from the agent, exports it redacted (raw only on request), and deletes it', async () => {
    const r = await req('POST', '/api/state/snapshots', { action: 'save', name: 'before' })
    expect(r.status).toBe(200)
    expect(r.json.snapshots.map((s) => s.name)).toEqual(['before'])
    const ex = await req('GET', '/api/state/snapshots?name=before')
    expect(ex.json.layers.global.user.tier).toBe('free')
    expect(ex.text).not.toContain('Zed')
    expect((await req('GET', '/api/state/snapshots?name=before&raw=1')).json.layers.global.user.nickname).toBe('Zed')
    expect((await req('DELETE', '/api/state/snapshots?name=before')).status).toBe(200)
    expect((await req('GET', '/api/state/snapshots?name=before')).status).toBe(404)
  })
  it('imports layers, diffs two snapshots, and restores one through the agent', async () => {
    await req('POST', '/api/state/snapshots', { action: 'import', name: 'a', layers: { global: { n: 1, same: true } } })
    const imp = await req('POST', '/api/state/snapshots', { action: 'import', name: 'b', layers: { global: { n: 2, same: true } } })
    expect(imp.status).toBe(200)
    const d = await req('GET', '/api/state/diff?a=a&b=b')
    expect(d.status).toBe(200)
    expect(d.json.diff).toHaveLength(1)
    expect(d.json.diff[0]).toMatchObject({ layer: 'global', path: 'n', value: 2 })
    expect((await req('GET', '/api/state/diff?a=a&b=zzz')).status).toBe(404)
    const rs = await req('POST', '/api/state/snapshots', { action: 'restore', name: 'a' })
    expect(rs.status).toBe(202)
    expect(rs.json.step).toBe('- restore: "a"')
    expect(hub.pushed[0]).toMatchObject({ op: 'restore', args: { name: 'a', layers: { global: { n: 1, same: true } } } })
    expect((await req('POST', '/api/state/snapshots', { action: 'restore', name: 'missing' })).status).toBe(404)
  })
  it('validates names and actions', async () => {
    expect((await req('POST', '/api/state/snapshots', { action: 'save', name: 'bad name!' })).status).toBe(400)
    expect((await req('POST', '/api/state/snapshots', { action: 'wat', name: 'ok' })).status).toBe(400)
    expect((await req('POST', '/api/state/snapshots', { action: 'import', name: 'ok' })).status).toBe(400)
  })
  it('a save the agent never acks fails typed, not hung', async () => {
    auto = false
    hub.stateOps = createStateOps({ session: 'sess1', timeouts: { received: 40 } })
    const r = await req('POST', '/api/state/snapshots', { action: 'save', name: 'x' })
    expect(r.status).toBe(502)
  })
})

describe('lease gate', () => {
  it('answers 423 LOCKED on every state route while another holder has the device', async () => {
    const l = await other()
    try {
      for (const [m, p, b] of [['GET', '/api/state'], ['POST', '/api/state/cmd', { path: 'a', value: 1 }], ['GET', '/api/state/snapshots'], ['POST', '/api/state/snapshots', { action: 'import', name: 'n', layers: {} }], ['DELETE', '/api/state/snapshots?name=a'], ['GET', '/api/state/diff?a=a&b=b']]) {
        const r = await req(m, p, b)
        expect(r.status, `${m} ${p}`).toBe(423)
        expect(r.json.code).toBe('LOCKED')
      }
      expect(hub.pushed).toHaveLength(0)
    } finally { l.release && l.release() }
  })
})

describe('no hub', () => {
  it('answers 503 NO_HUB when the net has no hub', async () => {
    server.close()
    server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, net: { proxy: {} },
      leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
    port = server.address().port
    const r = await req('GET', '/api/state')
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('NO_HUB')
  })
})

describe('guard and request shape (the UI sends exactly these)', () => {
  it('refuses a foreign Host and a foreign Origin on every new route', async () => {
    for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/state/cmd'], ['GET', '/api/state/snapshots'], ['DELETE', '/api/state/snapshots?name=a'], ['GET', '/api/state/diff?a=a&b=b']]) {
      expect((await req(m, p, m === 'POST' ? {} : undefined, { Host: 'rebind.example:1' })).status, `host ${m} ${p}`).toBe(403)
      expect((await req(m, p, m === 'POST' ? {} : undefined, { Origin: 'http://evil.example' })).status, `origin ${m} ${p}`).toBe(403)
    }
    expect(hub.pushed).toHaveLength(0)
  })
  it('POST and DELETE without a JSON content type are 415 (a UI request must set it)', async () => {
    expect((await req('POST', '/api/state/cmd', '{}', { noCt: true })).status).toBe(415)
    expect((await req('DELETE', '/api/state/snapshots?name=a', undefined, { noCt: true })).status).toBe(415)
  })
  it('DELETE with the UI headers (Content-Type: application/json, no body) removes the snapshot', async () => {
    await req('POST', '/api/state/snapshots', { action: 'import', name: 'gone', layers: { global: {} } })
    const r = await req('DELETE', '/api/state/snapshots?name=gone')
    expect(r.status).toBe(200)
    expect(r.json.snapshots).toEqual([])
  })
  it('an oversized body is a typed 413 and the socket stays usable', async () => {
    const r = await req('POST', '/api/state/cmd', JSON.stringify({ path: 'a', value: 'x'.repeat(300 * 1024) }))
    expect(r.status).toBe(413)
    expect(r.json.code).toBe('STATE_TOO_LARGE')
  })
})

describe('masked placeholders', () => {
  it('always refuses to write a <redacted:...> value, raw or not (the agent set op has no marker guard)', async () => {
    for (const q of ['', '?raw=1']) {
      const r = await req('POST', '/api/state/cmd' + q, { path: 'user.nickname', value: '<redacted:nickname>' })
      expect(r.status, q).toBe(400)
      expect(r.json.code).toBe('REDACTED_VALUE')
    }
    expect((await req('POST', '/api/state/cmd', { ops: [{ path: 'a', value: { b: '<redacted:b>' } }] })).status).toBe(400)
    expect(hub.pushed).toHaveLength(0)
  })
  it('restoring a snapshot with agent markers is allowed and says how many values will be skipped', async () => {
    await req('POST', '/api/state/snapshots', { action: 'import', name: 'red', layers: { global: { user: { token: '<redacted:token>', pw: '<redacted:pw>', tier: 'x' } } } })
    const r = await req('POST', '/api/state/snapshots', { action: 'restore', name: 'red' })
    expect(r.status).toBe(202)
    expect(r.json.note).toMatch(/2 redacted values/)
    await req('POST', '/api/state/snapshots', { action: 'import', name: 'plain', layers: { global: { a: 1 } } })
    expect((await req('POST', '/api/state/snapshots', { action: 'restore', name: 'plain' })).json.note).toBeUndefined()
  })
})

describe('registry edits', () => {
  it('accepts <section>.<key> and rejects a nested path that would write the wrong key', async () => {
    expect((await req('POST', '/api/state/cmd', { layer: 'registry', path: 'prefs.watchlist', value: '["a","b"]' })).status).toBe(202)
    expect(hub.pushed[0]).toMatchObject({ op: 'registry.write', args: { section: 'prefs', key: 'watchlist' } })
    const r = await req('POST', '/api/state/cmd', { layer: 'registry', path: 'prefs.watchlist.0', value: 'a' })
    expect(r.status).toBe(400)
    expect(hub.pushed).toHaveLength(1)
  })
})

describe('device read failures', () => {
  it('returns agentError with readFailed when the ECP read fails, and ?id= needs no tree read', async () => {
    await req('POST', '/api/state/cmd', { path: 'a', value: 1 })
    await until(() => hub.stateOps.get('c-1').status === 'done', 'ack')
    await fake.stop()
    const r = await req('GET', '/api/state')
    expect(r.status).toBe(200)
    expect(r.json.layers).toBeNull()
    expect(r.json.agentReadFailed).toBe(true)
    expect(r.json.agentError).toEqual(expect.any(String))
    expect(r.json.hellos).toBe(1)
    const one = await req('GET', '/api/state?id=c-1')
    expect(one.status).toBe(200)
    expect(one.json.command.status).toBe('done')
    fake = { stop: async () => {} }
  }, 20000)
  it('a healthy read with no layers is not a read failure', async () => {
    expect((await req('GET', '/api/state')).json.agentReadFailed).toBe(false)
  })
})

describe('import and names', () => {
  it('imports only global, scene, node and registry layers', async () => {
    const r = await req('POST', '/api/state/snapshots', { action: 'import', name: 'x', layers: { global: {}, focus: [] } })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/focus/)
    expect((await req('POST', '/api/state/snapshots', { action: 'import', name: 'x', layers: { global: {}, scene: {}, node: {}, registry: {} } })).status).toBe(200)
  })
  it('rejects long, dotted and prototype names', async () => {
    for (const name of ['a'.repeat(65), '.', '..', '__proto__']) {
      const r = await req('POST', '/api/state/snapshots', { action: 'import', name, layers: { global: {} } })
      expect(r.status, name).toBe(400)
    }
    expect((await req('POST', '/api/state/snapshots', { action: 'import', name: 'a'.repeat(64), layers: { global: {} } })).status).toBe(200)
  })
})

describe('diff redaction', () => {
  it('masks configured paths in a diff unless raw', async () => {
    await req('POST', '/api/state/snapshots', { action: 'import', name: 'a', layers: { global: { user: { nickname: 'Zed' }, n: 1 } } })
    await req('POST', '/api/state/snapshots', { action: 'import', name: 'b', layers: { global: { user: { nickname: 'Amy' }, n: 2 } } })
    const d = await req('GET', '/api/state/diff?a=a&b=b')
    expect(d.text).not.toMatch(/Amy|Zed/)
    expect(d.json.diff.map((o) => o.path)).toEqual(['n']) // both sides masked alike: the hidden change is not leaked as a diff
    expect((await req('GET', '/api/state/diff?a=a&b=b&raw=1')).json.diff.find((o) => o.path === 'user.nickname').value).toBe('Amy')
  })
})
