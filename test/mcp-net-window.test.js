import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootStub, startMcp, payload, cleanupMcp } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const { createNetWindow, MAX_IDLE_MS } = require('../lib/mcp/net-window.js')

// NET-N-T15: the net window lease, headless, on a fake clock and an in-memory lease library.
function fakeLeaseLib({ busy = false, command = false } = {}) {
  // Models the lease FILE: expiresAt moves only on acquire, a token re-entry or a renew (as the real session lease does).
  const st = { held: false, leaseId: 'lease-abc', idleMs: 0, expiresAt: 0, acquires: [], released: [], renews: 0 }
  const live = () => st.held && Date.now() < st.expiresAt
  const touch = () => { st.expiresAt = Date.now() + st.idleMs }
  const lost = () => Object.assign(new Error('lease is not held'), { code: 'LEASE_LOST' })
  return {
    st,
    async acquire(o) {
      st.acquires.push(o)
      if (o.token) {
        if (!live() || o.token !== st.leaseId) throw lost()
        touch()
        return { leaseId: st.leaseId, reentrant: true, release() {} }
      }
      if (busy) throw Object.assign(new Error('busy'), { code: 'BUSY' })
      if (command) {
        // nested in `device with`: a re-entrant view of the outer command lease; renew on it is refused
        st.held = true; st.idleMs = 1e12; touch()
        return { leaseId: st.leaseId, mode: 'command', reentrant: true, release() { st.released.push('noop') }, assertHeld: () => { if (!st.held) throw lost() } }
      }
      st.held = true; st.idleMs = o.idleMs; touch()
      return {
        leaseId: st.leaseId,
        release: (why) => { st.validAtRelease = live(); st.held = false; st.released.push(why) },
        assertHeld: () => { if (!st.held) throw lost() },
      }
    },
    renew(token) { if (command) { st.renewRefused = (st.renewRefused || 0) + 1; throw Object.assign(new Error('only session leases are renewed'), { code: 'USAGE' }) } if (token !== st.leaseId || !live()) throw lost(); st.renews++; touch() },
    tokenValid(token) { return token === st.leaseId && live() },
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

  it('releases before the lease record expires: tokenValid is still true at the idle release', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib, { idleMs: 60000 }).open()
    await vi.advanceTimersByTimeAsync(30000)
    const end = w.begin()
    await vi.advanceTimersByTimeAsync(5000)
    end() // arms idle, then renews the record
    await vi.advanceTimersByTimeAsync(70000)
    expect(w.isOpen).toBe(false)
    expect(lib.st.validAtRelease).toBe(true) // the record was still live when the window let go
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

  it('keeps the lease file alive across a short call followed by idle time (I1)', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib, { idleMs: 60000 }).open()
    await vi.advanceTimersByTimeAsync(50000)
    const re = await w.reenter({ host: 'h' })
    const end = w.begin()
    await vi.advanceTimersByTimeAsync(600) // a 600 ms call
    end()
    await vi.advanceTimersByTimeAsync(55000) // idle, but inside the window's TTL measured from the call's end
    expect(re.reentrant).toBe(true)
    expect(w.isOpen).toBe(true)
    expect(lib.st.held).toBe(true)
    expect(lib.st.renews).toBeGreaterThan(0)
    w.release()
  })

  it('keeps the lease file alive for a call longer than the TTL (I1)', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib, { idleMs: 60000 }).open()
    const end = w.begin()
    await vi.advanceTimersByTimeAsync(200000)
    expect(w.isOpen).toBe(true)
    expect(lib.tokenValid('lease-abc')).toBe(true)
    end()
    expect(w.isOpen).toBe(true)
    w.release()
  })

  it('treats an expired lease record as lost while idle (I1)', async () => {
    const lib = fakeLeaseLib()
    const w = await mk(lib, { idleMs: 60000 }).open()
    lib.st.expiresAt = Date.now() + 1000 // the file expires early: another agent may take the device
    await vi.advanceTimersByTimeAsync(20000)
    expect(w.isOpen).toBe(false)
    expect(w.lostWhy).toMatch(/lease lost/)
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
    expect(d.hub.leaseId).toBe(o.lease.leaseId.slice(0, 8))
    expect(d.hub.leaseId).toHaveLength(8)
    expect(JSON.stringify(c.lines)).not.toContain(o.lease.leaseId)
    expect(c.server.session.hubInfo.leaseId).toBe(o.lease.leaseId)
    expect(JSON.stringify(c.lines)).not.toContain(o.tokens[0])
    expect(c.stderr()).not.toContain(o.tokens[0])
    expect(sp.calls[0]).toMatchObject({ mode: 'session' })
    // a second net call neither restarts the hub nor takes another lease
    await c.tool('net_requests')
    expect(hub.starts).toHaveLength(1)
    expect(sp.calls.filter((x) => x.mode === 'session')).toHaveLength(1)
    expect(sp.calls.slice(1).every((x) => x.token === o.lease.leaseId)).toBe(true)
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

  it('writes the hub log through the hub sink: start, each request (no bodies, no query), stop', async () => {
    const { c, hub } = await boot()
    await c.tool('net_mock', { match: { url: '**/x' }, respond: { status: 200, body: 'SECRET-BODY-TEXT' } })
    expect(hub.starts[0].log).toEqual(expect.any(Function))
    expect(c.stderr()).toMatch(/\[brighttest hub\] session hub started on port 8790 for 127\.0\.0\.1\n/)
    const { Readable, Writable } = require('stream')
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} })
    const res = Object.assign(new Writable({ write(ch, e, cb) { cb() } }), { writeHead() { this.headersSent = true; return this } })
    await hub.starts[0].netProxy.handle(req, res, 'http://example.test/x?token=QUERYSECRET')
    const err = c.stderr()
    expect(err).toMatch(/\[brighttest hub\] request GET \/x -> 200 \(16 response bytes, source mock\)\n/)
    expect(err).not.toContain('SECRET-BODY-TEXT')
    expect(err).not.toContain('QUERYSECRET')
    c.server.session.win.release('idle expiry')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.stderr()).toContain('[brighttest hub] session hub stopped\n')
  })

  it('logs a refused (403) hub request with method, path, status, bytes; no query, no body', async () => {
    const { c, hub } = await boot()
    await c.tool('net_requests')
    const { Readable, Writable } = require('stream')
    const req = Object.assign(Readable.from([]), { method: 'POST', headers: {} })
    const res = Object.assign(new Writable({ write(ch, e, cb) { cb() } }), { writeHead() { this.headersSent = true; return this } })
    await hub.starts[0].netProxy.handle(req, res, 'http://127.0.0.1:9/private/x?token=QUERYSECRET')
    const err = c.stderr()
    const m = err.match(/\[brighttest hub\] request POST \/private\/x -> 403 \((\d+) response bytes, source refused\)\n/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBeGreaterThan(0)
    expect(err).not.toContain('QUERYSECRET')
    expect(err).not.toMatch(/request POST \/private\/x failed/)
  })

  it('hub net.error uses the status and bytes of the event; falls back when absent', async () => {
    const { c } = await boot()
    await c.tool('net_requests')
    const sess = c.server.session
    const ev = (id, method, url, err) => { sess.hubNetEvent('net.request', { id, method, url }); sess.hubNetEvent('net.error', { id, kind: 'upstream', ...err }) }
    ev(901, 'GET', 'http://h.test/a?q=1', { detail: 'refused: host not allowed', refused: true, status: 403, bytes: 77 })
    ev(902, 'GET', 'http://h.test/b', { detail: 'bad target url', status: 400, bytes: 12 })
    ev(903, 'POST', 'http://h.test/c', { detail: 'refused: host not allowed', refused: true })
    const err = c.stderr()
    expect(err).toContain('[brighttest hub] request GET /a -> 403 (77 response bytes, source refused)\n')
    expect(err).toContain('[brighttest hub] request GET /b -> 400 (12 response bytes, source error)\n')
    expect(err).toMatch(/\[brighttest hub\] request POST \/c -> 403 \(\d+ response bytes, source refused\)\n/)
  })

  it('start and stop hub lines keep their exact format', async () => {
    const { c } = await boot()
    await c.tool('net_requests')
    expect(c.stderr()).toMatch(/^\[brighttest hub\] session hub started on port 8790 for 127\.0\.0\.1\n/m)
    c.server.session.win.release('idle expiry')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.stderr()).toMatch(/^\[brighttest hub\] session hub stopped\n/m)
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

// ---- signals and onFatal release the window's lease (I2) ----
describe('net window lease on process stop', () => {
  const child = path.join(__dirname, 'fixtures', 'mcp-signal-child.js')
  const holders = (dir) => fs.readdirSync(dir).filter((k) => fs.existsSync(path.join(dir, k, 'holder.json')))

  async function openWindowIn() {
    vi.useRealTimers()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mcp-sig-'))
    const env = { ...process.env, BRIGHTTEST_LEASE_DIR: dir, BRIGHTTEST_AGENT: 'mcp-test' }
    delete env.BRIGHTTEST_LEASE; delete env.BRIGHTTEST_NO_LEASE
    const p = spawn(process.execPath, [child], { env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    const exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })))
    const waitFor = async (pred) => { for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 25)); }
    const send = (o) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ id: 2, method: 'tools/call', params: { name: 'net_requests', arguments: {} } })
    await waitFor(() => out.includes('"id":2'))
    expect(out).toContain('"id":2')
    expect(holders(dir)).toHaveLength(1) // the window holds the session lease
    return { p, dir, exited, waitFor, holders: () => holders(dir) }
  }

  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT', 'SIGHUP'])('%s releases the lease before the process ends', async (sig) => {
    const x = await openWindowIn()
    try {
      x.p.kill(sig)
      const r = await x.exited
      expect(r.sig).toBe(sig) // default signal semantics kept
      expect(x.holders()).toHaveLength(0)
    } finally { x.p.kill('SIGKILL'); fs.rmSync(x.dir, { recursive: true, force: true }) }
  }, 20000)

  it.skipIf(process.platform === 'win32')('an uncaught error (onFatal) releases the window lease and exits 1', async () => {
    const x = await openWindowIn()
    try {
      x.p.kill('SIGUSR2')
      const r = await x.exited
      expect(r.code).toBe(1)
      expect(x.holders()).toHaveLength(0)
    } finally { x.p.kill('SIGKILL'); fs.rmSync(x.dir, { recursive: true, force: true }) }
  }, 20000)
})

describe('net window inside device with (ADR 0058)', () => {
  it('stays open across checks with a command lease, never calling renew', async () => {
    const lib = fakeLeaseLib({ command: true })
    const w = await mk(lib, { idleMs: 60000 }).open()
    const end = w.begin()
    await vi.advanceTimersByTimeAsync(20000) // several checks while a call runs
    end()
    await vi.advanceTimersByTimeAsync(20000) // and while idle
    expect(w.isOpen).toBe(true)
    expect(w.lostWhy).toBe(null)
    expect(lib.st.renewRefused || 0).toBe(0)
    w.release()
  })

  it('reports LEASE_LOST when the outer command lease ends', async () => {
    const lib = fakeLeaseLib({ command: true })
    const w = await mk(lib, { idleMs: 60000 }).open()
    const end = w.begin()
    lib.st.held = false
    await vi.advanceTimersByTimeAsync(6000)
    expect(w.isOpen).toBe(false)
    expect(w.lostWhy).toMatch(/lease lost/)
    end()
  })
})
