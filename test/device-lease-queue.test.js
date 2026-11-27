import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const L = require('../lib/device-lease.js')
const identity = require('../lib/device-identity.js')
const { StudioLease } = require('../lib/studio/lease.js')

// One lease queue per device: every taker with a known identity takes the identity key, then the address key.
const lookup = async (h) => ({ address: h })
let dir
const seams = (o = {}) => ({ dir, lookup, timers: false, identity: {}, exitOnLost: false, pollMs: 5, settleMs: 0, ...o })
const ID = L.keyFromIdentity('SERIAL-Q')
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lease-queue-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('one queue per device', () => {
  it('two takers on one identity via different host names queue on one lease', async () => {
    const a = await L.acquire(seams({ host: '192.0.2.10', identityKey: ID, agent: 'dev#1', purpose: 'first', waitMs: 0 }))
    expect(a.keys).toEqual([ID, '192.0.2.10'])
    await expect(L.acquire(seams({ host: 'roku-b.example', identityKey: ID, agent: 'dev#2', purpose: 'second', waitMs: 0 }))).rejects.toMatchObject({ code: 'BUSY' })
    const waiter = L.acquire(seams({ host: '192.0.2.99', identityKey: ID, agent: 'dev#3', purpose: 'third', waitMs: 5000 }))
    await new Promise((r) => setTimeout(r, 100))
    const st = L.status({ dir, key: ID })[0]
    expect(st.queue.map((t) => t.agent)).toEqual(['dev#3'])
    a.release()
    const b = await waiter
    expect(b.keys[0]).toBe(ID)
    b.release()
  })

  it('a taker queued on the address key records waitingOn on its identity key and the wait line names the blocker', async () => {
    // an address-only holder (an old client) keeps the address key
    const old = await L.acquire(seams({ host: '192.0.2.10', agent: 'old#1', purpose: 'legacy run', waitMs: 0 }))
    const lines = []
    const mine = L.acquire(seams({ host: '192.0.2.10', identityKey: ID, agent: 'new#1', purpose: 'queued run', waitMs: 5000 }))
    await new Promise((r) => setTimeout(r, 150))
    const idRec = L.status({ dir, key: ID })[0].holder
    expect(idRec.waitingOn).toBe('192.0.2.10')
    // a third taker waiting on the identity key sees the real blocker
    const store = L.createStore({ dir })
    const third = L.acquire(seams({ host: '192.0.2.10', identityKey: ID, agent: 'new#2', purpose: 'behind', waitMs: 300, onWait: (snap) => lines.push(L.formatWaitLine(snap)) })).catch((e) => e)
    expect((await third).code).toBe('TIMEOUT')
    const text = lines.join('\n')
    expect(text).toMatch(/is held by new#1/)
    expect(text).toMatch(/itself waiting for 192\.0\.2\.10, held by old#1 — "legacy run"/)
    old.release()
    const got = await mine
    // cleared once both keys are held
    expect(L.status({ dir, key: ID })[0].holder.waitingOn).toBeUndefined()
    got.release()
    expect(store.readHolder(ID)).toBeNull()
  })

  it('an old lease file without waitingOn still reads', () => {
    const store = L.createStore({ dir })
    store.ensureKeyDir('192.0.2.50')
    const rec = { schema: L.SCHEMA, leaseId: 'abc', mode: 'command', device: { key: '192.0.2.50', host: '192.0.2.50', port: 8060 }, holder: { agent: 'old#9', purpose: 'p', pid: process.pid, childPids: [] }, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: null, deadline: new Date(Date.now() + 60000).toISOString() }
    fs.writeFileSync(store.holderPath('192.0.2.50'), JSON.stringify(rec))
    const st = L.status({ dir, key: '192.0.2.50' })[0]
    expect(st.holder.holder.agent).toBe('old#9')
    expect(L.formatWaitLine({ ...st, queue: [], position: null })).not.toMatch(/itself waiting/)
  })

  it('pool picks take a remembered identity key first, then the address key', async () => {
    identity.rememberKey(dir, '192.0.2.10', ID)
    const l = await L.acquirePool(seams({ hosts: ['192.0.2.10', '192.0.2.20'], waitMs: 0 }))
    expect(l.poolHost).toBe('192.0.2.10')
    expect(l.keys).toEqual([ID, '192.0.2.10'])
    // the same device through another name is busy: pool moves on to the next member
    const l2 = await L.acquirePool(seams({ hosts: ['192.0.2.10', '192.0.2.20'], waitMs: 0 }))
    expect(l2.poolHost).toBe('192.0.2.20')
    l.release(); l2.release()
  })

  it('identityKeyFor returns the remembered key without a network read, and null when unknown', async () => {
    expect(await identity.identityKeyFor('192.0.2.10', 8060, { dir, read: false })).toBeNull()
    identity.rememberKey(dir, '192.0.2.10', ID)
    expect(await identity.identityKeyFor('192.0.2.10', 8060, { dir, read: false })).toBe(ID)
    const fetchImpl = async () => ({ ok: true, text: async () => '<device-info><serial-number>SERIAL-Z</serial-number></device-info>' })
    const k = await identity.identityKeyFor('192.0.2.30', 8060, { dir, fetchImpl, cache: new Map() })
    expect(k).toBe(L.keyFromIdentity('SERIAL-Z'))
    expect(await identity.identityKeyFor('192.0.2.30', 8060, { dir, read: false })).toBe(k)
  })
})

describe('Studio across both keys', () => {
  const cfg = { deviceLease: { studioIdle: '10s', studioYield: '5s', wait: '30s' } }
  it('takes the identity key then the address key, and yields to a CLI waiter queued on the identity key', async () => {
    identity.rememberKey(dir, '192.0.2.10', ID)
    const clock = { t: Date.now() }
    const s = new StudioLease({ host: '192.0.2.10', cfg, env: { BRIGHTTEST_LEASE_DIR: dir }, now: () => clock.t, log: () => {}, acquireOpts: seams({ now: () => clock.t, sleep: async (ms) => { clock.t += ms; await new Promise((r) => setImmediate(r)) } }) })
    try {
      expect(await s.ensure({ user: true })).toBe(true)
      expect(s.lease.keys).toEqual([ID, '192.0.2.10'])
      const cli = L.acquire(seams({ host: 'roku-b.example', identityKey: ID, agent: 'dev#4', purpose: 'e2e run', waitMs: 600000, now: () => clock.t, sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 5))) } })).catch(() => null)
      for (let i = 0; i < 50 && !s.waiters().length; i++) await new Promise((r) => setTimeout(r, 10))
      expect(s.waiters().map((w) => w.agent)).toEqual(['dev#4'])
      clock.t += 6000
      s.tick()
      expect(s.holding).toBe(false)
      const got = await cli
      if (got) got.release()
    } finally { s.cancel(); s.release('test cleanup') }
  })
})
