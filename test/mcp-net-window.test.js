import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { bootStub, startMcp, payload, cleanupMcp } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const { createNetWindow, MAX_IDLE_MS } = require('../lib/mcp/net-window.js')

// NET-N-T15: the net window lease, headless, on a fake clock and an in-memory lease library.
function fakeLeaseLib({ busy = false } = {}) {
  const st = { held: false, leaseId: 'lease-abc', acquires: [], released: [] }
  return {
    st,
    async acquire(o) {
      st.acquires.push(o)
      if (o.token) {
        if (!st.held || o.token !== st.leaseId) throw Object.assign(new Error('lease is not held'), { code: 'LEASE_LOST' })
        return { leaseId: st.leaseId, reentrant: true, release() {} }
      }
      if (busy) throw Object.assign(new Error('busy'), { code: 'BUSY' })
      st.held = true
      return {
        leaseId: st.leaseId,
        release: (why) => { st.held = false; st.released.push(why) },
        assertHeld: () => { if (!st.held) throw Object.assign(new Error('not held'), { code: 'LEASE_LOST' }) },
      }
    },
  }
}

const mk = (lib, extra = {}) => createNetWindow({ leaseLib: lib, acquireOpts: { host: '10.0.0.5', port: 8060 }, idleMs: 60000, maxMs: 600000, checkMs: 5000, ...extra })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('net window lease', () => {
  it('opens one session lease with the idle TTL and the cap', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib).open()
    expect(w.isOpen).toBe(true)
    expect(w.leaseId).toBe('lease-abc')
    expect(lib.st.acquires).toHaveLength(1)
    expect(lib.st.acquires[0]).toMatchObject({ mode: 'session', waitMs: 0, idleMs: 60000, maxHoldMs: 600000 })
    w.release()
  })

  it('caps the idle TTL at sessionIdle (10 min)', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib, { idleMs: 3 * 3600 * 1000 }).open()
    expect(w.idleMs).toBe(MAX_IDLE_MS)
    expect(lib.st.acquires[0].idleMs).toBe(MAX_IDLE_MS)
    w.release()
  })

  it('re-enters the existing lease with its token, no second lease', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib).open()
    const re = await w.reenter({ host: '10.0.0.5', port: 8060 })
    expect(re.reentrant).toBe(true)
    expect(lib.st.acquires).toHaveLength(2)
    expect(lib.st.acquires[1].token).toBe('lease-abc')
    expect(lib.st.acquires[1].mode).toBeUndefined()
    expect(lib.st.held).toBe(true)
    w.release()
  })

  it('releases at the idle TTL, and a device call renews it', async () => {
    const lib = fakeLeaseLib()
    const onRelease = vi.fn()
    const w = await mk(lib, { onRelease }).open()
    await vi.advanceTimersByTimeAsync(50000)
    await w.reenter({ host: 'h' })
    await vi.advanceTimersByTimeAsync(50000)
    expect(w.isOpen).toBe(true)
    await vi.advanceTimersByTimeAsync(11000)
    expect(w.isOpen).toBe(false)
    expect(lib.st.held).toBe(false)
    expect(onRelease).toHaveBeenCalledWith('idle expiry')
  })

  it('does not idle-release under a running call', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib).open()
    const end = w.begin()
    await vi.advanceTimersByTimeAsync(130000)
    expect(w.isOpen).toBe(true)
    end()
    await vi.advanceTimersByTimeAsync(61000)
    expect(w.isOpen).toBe(false)
  })

  it('releases at session end and is idempotent', async () => {
    const lib = fakeLeaseLib()
    const onRelease = vi.fn()
    const w = await mk(lib, { onRelease }).open()
    expect(w.release('mcp session ended')).toBe(true)
    expect(w.release('again')).toBe(false)
    expect(lib.st.released).toEqual(['mcp net window: mcp session ended'])
    expect(onRelease).toHaveBeenCalledTimes(1)
  })

  it('detects a lost lease by the periodic check and tells running calls', async () => {
    const lib = fakeLeaseLib()
    const lost = vi.fn()
    const w = await mk(lib).open()
    w.begin(lost)
    lib.st.held = false // someone removed holder.json
    await vi.advanceTimersByTimeAsync(5000)
    expect(w.isOpen).toBe(false)
    expect(lost).toHaveBeenCalledTimes(1)
    expect(w.lostWhy).toMatch(/lease lost/)
  })

  it('re-entry on a lost lease fails with LEASE_LOST and closes the window', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib).open()
    lib.st.held = false
    await expect(w.reenter({ host: 'h' })).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(w.isOpen).toBe(false)
    await expect(w.reenter({ host: 'h' })).rejects.toMatchObject({ code: 'LEASE_LOST' })
  })

  it('releases at the sessionMax deadline', async () => {
    const lib = fakeLeaseLib()
    const lost = vi.fn()
    const w = await mk(lib, { idleMs: 400000, maxMs: 120000 }).open()
    w.begin(lost)
    await vi.advanceTimersByTimeAsync(121000)
    expect(w.isOpen).toBe(false)
    expect(lost).toHaveBeenCalled()
  })

  it('shows the hub view: held while open, onLost fires on loss', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib).open()
    const v = w.view()
    const cb = vi.fn()
    v.onLost(cb)
    expect(v.held()).toBe(true)
    lib.st.held = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(v.held()).toBe(false)
    expect(cb).toHaveBeenCalled()
  })

  it('refuses with the existing error shape when the device is busy (no new codes)', async () => {
    const w = mk(fakeLeaseLib({ busy: true }))
    await expect(w.open()).rejects.toMatchObject({ code: 'BUSY' })
    expect(w.isOpen).toBe(false)
  })
})

// ---- the session hub in the window (commit 2): real MCP server, stub device, stubbed startLanHub ----
describe('net window hub', () => {
  const realLib = require('../lib/device-lease.js')
  function spyLib() {
    const calls = []
    const lib = { ...realLib, acquire: async (o) => { calls.push({ mode: o.mode, token: o.token }); return realLib.acquire(o) } }
    return { lib, calls }
  }
  function hubStub({ fail } = {}) {
    const starts = []
    const stops = []
    const fn = async (o) => {
      starts.push(o)
      if (fail) throw Object.assign(new Error(fail.message || 'boom'), { code: fail.code })
      return { stop: async () => { stops.push(1) } }
    }
    return { fn, starts, stops }
  }
  async function boot(extra = {}) {
    vi.useRealTimers()
    const { a } = await bootStub('healthy')
    const hub = hubStub(extra.hub)
    const sp = spyLib()
    const c = startMcp({ a, leaseLib: sp.lib, startLanHub: hub.fn })
    await c.initialize()
    return { c, hub, sp }
  }
  afterEach(async () => { await cleanupMcp() })

  it('starts the hub on the first net call with a random token, the session proxy and the hub port', async () => {
    const { c, hub, sp } = await boot()
    const d = payload(await c.tool('net_requests'))
    expect(hub.starts).toHaveLength(1)
    const o = hub.starts[0]
    expect(o.port).toBe(8790)
    expect(o.deviceHost).toBe('127.0.0.1')
    expect(o.tokens).toHaveLength(1)
    expect(o.tokens[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(o.netProxy).toBe(c.server.session.net().proxy)
    expect(o.lease.held()).toBe(true)
    expect(d.hub).toMatchObject({ host: expect.anything(), port: 8790 })
    expect(Object.keys(d.hub).sort()).toEqual(['host', 'leaseId', 'port', 'startedAt'])
    expect(d.hub.leaseId).toBe(o.lease.leaseId)
    expect(JSON.stringify(c.lines)).not.toContain(o.tokens[0])
    expect(c.stderr()).not.toContain(o.tokens[0])
    expect(sp.calls[0]).toMatchObject({ mode: 'session' })
    // a second net call neither restarts the hub nor takes another lease
    await c.tool('net_requests')
    expect(hub.starts).toHaveLength(1)
    expect(sp.calls.filter((x) => x.mode === 'session')).toHaveLength(1)
    expect(sp.calls.slice(1).every((x) => x.token === d.hub.leaseId)).toBe(true)
  })

  it('device tools inside the window re-enter the lease; no command lease is taken', async () => {
    const { c, sp } = await boot()
    await c.tool('net_requests')
    const r = await c.tool('inspect_tree')
    expect(r.result.isError).not.toBe(true)
    expect(sp.calls.filter((x) => x.mode === 'command' && !x.token)).toHaveLength(0)
    expect(sp.calls.at(-1).token).toBeTruthy()
  })

  it('after release: record cleared, hub stopped, mocks kept, next device call takes a command lease', async () => {
    const { c, hub, sp } = await boot()
    await c.tool('net_mock', { match: { url: '**/x' }, respond: { status: 200, body: 'x' } })
    const s = c.server.session
    expect(s.hubInfo).not.toBeNull()
    s.win.release('idle expiry')
    await new Promise((r) => setTimeout(r, 10))
    expect(s.hubInfo).toBeNull()
    expect(s.win).toBeNull()
    expect(hub.stops).toHaveLength(1)
    expect(s.net().rules).toBe(1)
    const n = sp.calls.length
    await c.tool('inspect_tree')
    expect(sp.calls[n]).toMatchObject({ mode: 'command' })
    expect(sp.calls[n].token).toBeUndefined()
  })

  it('a hub start failure releases the window and fails with NET_FAILED', async () => {
    const { c } = await boot({ hub: { fail: { message: 'listen failed', code: 'EADDRINUSE' } } })
    const r = await c.tool('net_requests')
    expect(r.result.isError).toBe(true)
    expect(payload(r).code).toBe('NET_FAILED')
    expect(c.server.session.win).toBeNull()
    expect(c.server.session.hubInfo).toBeNull()
    // the lease is free again: a device call works under a command lease
    expect((await c.tool('inspect_tree')).result.isError).not.toBe(true)
  })

  it('session end stops the hub and releases the window lease', async () => {
    const { c, hub } = await boot()
    await c.tool('net_requests')
    await c.close()
    expect(hub.stops).toHaveLength(1)
    expect(c.server.session.win).toBeNull()
    const st = realLib.status({ dir: c.lease })
    expect(JSON.stringify(st)).not.toContain('brighttest mcp net window')
  })
})
