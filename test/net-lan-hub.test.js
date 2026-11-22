import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const hubMod = require('../lib/instrument/hub.js')
const doctor = require('../lib/doctor.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

const TOKEN = 'tok'
const hubs = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(hubs.splice(0).map((h) => h.stop())) })

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    }).on('error', reject)
  })
}
const isDown = (port) => get(port, `/bt/${TOKEN}/hello`).then(() => false, () => true)

// A fake device-lease object shaped like lib/device-lease.js leases.
function fakeLease() {
  const l = { leaseId: 'lease-1', lost: false, expired: false, onLost: null, onExpire: null }
  l.lose = (why = 'reclaimed') => { l.lost = true; if (l.onLost) l.onLost(why, l) }
  return l
}
async function lan(over = {}) {
  const lease = over.lease || fakeLease()
  const h = await hubMod.startLanHub({
    deviceHost: over.deviceHost || '192.168.1.50', lease, tokens: [TOKEN], bindHost: '127.0.0.1',
    peerOf: over.peerOf || (() => '192.168.1.50'), log: over.log, ...over.rest,
  })
  hubs.push(h)
  return { hub: h, lease }
}

describe('LAN hub under the lease', () => {
  it('refuses to listen when the lease is not held', async () => {
    const lease = fakeLease(); lease.lost = true
    await expect(hubMod.startLanHub({ deviceHost: 'h1.example.test', lease, tokens: [TOKEN], bindHost: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'LEASE_LOST' })
  })

  it('masks configured state paths in cmd.sent events (registry.write, restore layers, set)', async () => {
    const { hub } = await lan({ rest: { redactPaths: ['global.user.nickname', 'registry.*.cardlast4'] } })
    hub.push({ op: 'registry.write', args: { section: 'prefs', key: 'cardlast4', value: '4242' } }, { ack: 'applied' })
    hub.push({ op: 'restore', args: { name: 'n', layers: { global: { user: { nickname: 'Zed' } } } } }, { ack: 'applied' })
    hub.push({ op: 'set', args: { layer: 'global', path: 'user.nickname', value: 'Zed' } }, { ack: 'applied' })
    const text = JSON.stringify(hub.log.since(0))
    expect(text).toContain('cmd.sent')
    expect(text).not.toMatch(/4242|Zed/)
  })

  it('serves the leased device peer and stops with stop()', async () => {
    const { hub } = await lan()
    expect((await get(hub.port, `/bt/${TOKEN}/hello`)).status).toBe(200)
    await hub.stop()
    expect(await isDown(hub.port)).toBe(true)
  })

  it('stops itself when the lease is lost, and keeps the previous onLost handler', async () => {
    const lease = fakeLease(); const prev = vi.fn(); lease.onLost = prev
    const { hub } = await lan({ lease })
    lease.lose('tombstoned')
    expect(prev).toHaveBeenCalledWith('tombstoned', lease)
    await new Promise((r) => setTimeout(r, 50))
    expect(await isDown(hub.port)).toBe(true)
  })

  it('stops itself when the lease expires', async () => {
    const lease = fakeLease()
    const { hub } = await lan({ lease })
    lease.expired = true; lease.onExpire()
    await new Promise((r) => setTimeout(r, 50))
    expect(await isDown(hub.port)).toBe(true)
  })

  it('peer lock: a second session for the same device is refused and the first hub is unchanged', async () => {
    const first = await lan()
    await expect(hubMod.startLanHub({ deviceHost: '192.168.1.50', lease: fakeLease(), tokens: [TOKEN], bindHost: '127.0.0.1' }))
      .rejects.toMatchObject({ code: 'PEER_LOCKED', message: expect.stringContaining('refusing a second peer') })
    expect((await get(first.hub.port, `/bt/${TOKEN}/hello`)).status).toBe(200)
    const sess = first.hub.sessionId
    expect(sess).toBeTruthy()
    // after stop the lock is free again
    await first.hub.stop()
    const again = await lan()
    expect(again.hub.port).toBeGreaterThan(0)
  })

  it('peer lock: a request from another LAN peer gets a bare 404, one clear log line, no state change', async () => {
    const lines = []
    let peer = '192.168.1.99'
    const { hub } = await lan({ peerOf: () => peer, log: (s) => lines.push(s) })
    const r1 = await get(hub.port, `/bt/${TOKEN}/hello`)
    const r2 = await get(hub.port, `/bt/${TOKEN}/hello`)
    expect(r1).toEqual({ status: 404, body: '' }); expect(r2.status).toBe(404)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('192.168.1.99')
    expect(lines[0]).toContain('answers only that device')
    peer = '192.168.1.50'
    expect((await get(hub.port, `/bt/${TOKEN}/hello`)).status).toBe(200)
  })

  it('a different device host can run its own hub at the same time', async () => {
    await lan()
    const other = await lan({ deviceHost: '192.168.1.51', peerOf: () => '192.168.1.51' })
    expect((await get(other.hub.port, `/bt/${TOKEN}/hello`)).status).toBe(200)
  })
})

describe('sse()', () => {
  function fakeRes() {
    const out = []; const handlers = {}
    return {
      out, headers: null, writableEnded: false, destroyed: false,
      writeHead(code, h) { this.code = code; this.headers = h },
      write(c) { out.push(c) }, end() { this.writableEnded = true },
      on(ev, cb) { handlers[ev] = cb }, emitClose() { handlers.close && handlers.close() },
    }
  }
  it('sends headers, JSON data, named events and multi-line data', () => {
    const res = fakeRes(); const s = hubMod.sse(res, { retryMs: 1500 })
    expect(res.code).toBe(200); expect(res.headers['content-type']).toBe('text/event-stream')
    s.send({ a: 1 }); s.send('x\ny', 'net'); s.comment('ping')
    expect(res.out.join('')).toBe('retry: 1500\n\ndata: {"a":1}\n\nevent: net\ndata: x\ndata: y\n\n: ping\n\n')
  })
  it('does not write after close or client disconnect', () => {
    const res = fakeRes(); const s = hubMod.sse(res)
    s.close(); s.send('late'); expect(res.out).toEqual([]); expect(res.writableEnded).toBe(true)
    const r2 = fakeRes(); const s2 = hubMod.sse(r2); r2.emitClose(); s2.send('late'); expect(r2.out).toEqual([]); expect(s2.open).toBe(false)
  })
  it('streams over a real loopback server', async () => {
    const srv = http.createServer((req, res) => { const s = hubMod.sse(res); s.send('hi'); s.close() })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const r = await get(srv.address().port, '/')
    await new Promise((r2) => srv.close(r2))
    expect(r.body).toBe('data: hi\n\n')
  })
})

describe('doctor hub bind check', () => {
  it('reports the local bind, says it is not proof, keeps exit 0', async () => {
    const stub = createFakeRoku({ scenario: 'healthy' }); const a = await stub.start()
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    const code = await doctor.run({ host: '127.0.0.1', ecpPort: a.ecpPort })
    await stub.stop()
    expect(code).toBe(0)
    expect(out).toContain('hub-bind')
    expect(out).toContain('device-to-hub path is not proved here')
  })
  it('a failed bind fails the check with its fix text; ECP fix texts are unchanged', async () => {
    const stub = createFakeRoku({ scenario: 'healthy' }); const a = await stub.start()
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    const code = await doctor.run({ host: '127.0.0.1', ecpPort: a.ecpPort }, { probeBind: async () => ({ ok: false, error: 'EADDRINUSE' }) })
    await stub.stop()
    expect(code).toBe(1)
    expect(out).toContain(doctor.FIX_HUB_BIND('EADDRINUSE'))
    expect(doctor.evaluate({ ecpSettingMode: 'limited' }).find((k) => k.id === 'ecp-mode').fix).toBe(doctor.FIX_LIMITED)
  })
  it('probeBind opens and closes a real loopback-capable listener', async () => {
    expect((await doctor.probeBind()).ok).toBe(true)
  })
  it('prints bind, port, advertised address, and that reach is not proven; JSON carries hub', async () => {
    const stub = createFakeRoku({ scenario: 'healthy' }); const a = await stub.start()
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    const deps = { probeBind: async () => ({ ok: true, address: '0.0.0.0', port: 1 }), lanHost: () => '192.0.2.7' }
    await doctor.run({ host: '127.0.0.1', ecpPort: a.ecpPort }, deps)
    expect(out).toContain('bind 0.0.0.0:8790')
    expect(out).toContain('would advertise 192.0.2.7')
    expect(out).toContain(doctor.HUB_REACH_LINE)
    out = ''
    await doctor.run({ host: '127.0.0.1', ecpPort: a.ecpPort, json: true }, deps)
    await stub.stop()
    const j = JSON.parse(out)
    expect(j.hub).toEqual({ bindAddress: '0.0.0.0', port: 8790, advertisedHost: '192.0.2.7', reachProven: false })
  })
  it('an unreachable device skips the bind check', async () => {
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    const probe = vi.fn()
    const code = await doctor.run({ host: '127.0.0.1', ecpPort: 1 }, { probeBind: probe })
    expect(code).toBe(1); expect(probe).not.toHaveBeenCalled()
  })
})
