import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pfs-cache-')), 'devices.json')
const studio = require('../lib/studio/server.js')
const state = require('../lib/studio/perfetto-state.js')

const ESN = 'TESTESN0002'

// Fake WebSocket registry (loopback only; nothing opens a real socket).
class FakeWS {
  static instances = []
  constructor(url) {
    this.url = url; this.readyState = 0
    FakeWS.instances.push(this)
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen() }, 1)
  }
  close() { this.readyState = 3; setTimeout(() => this.onclose && this.onclose(), 1) }
  drop() { this.readyState = 3; this.onclose && this.onclose() }
}
FakeWS.OPEN = 1

const until = async (cond, ms = 4000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) }
}

// PRF-01b: the Studio server builds PerfettoCapture with the device ESN and autoRestart.
describe('Studio server Perfetto wiring (PRF-01b)', () => {
  let ecp, server, port, root, home, posts, savedWS, enableOk
  const call = (action, method = 'POST') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: `/api/perf/perfetto/${action}`, headers: { 'Content-Type': 'application/json' } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) })) })
    r.on('error', reject); r.end(method === 'POST' ? '{}' : undefined)
  })
  const boot = async (perfettoOpts = {}) => {
    server = await studio.start({
      host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: root,
      leaseOpts: { acquireOpts: { dir: path.join(root, 'lease'), timers: false, identity: {} } },
      perfettoOpts: { stateDir: home, restartDelayMs: 5, ...perfettoOpts },
    })
    port = server.address().port
  }
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pfs-root-'))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pfs-home-'))
    posts = []; enableOk = true
    ecp = http.createServer((req, res) => {
      if (req.url === '/query/device-info') return res.end(`<device-info><serial-number>${ESN}</serial-number><software-version>15.2.0</software-version></device-info>`)
      posts.push(req.url)
      res.end(enableOk ? '<enabled-channels><channel>dev</channel></enabled-channels>' : '<enabled-channels></enabled-channels>')
    })
    await new Promise((r) => ecp.listen(0, '127.0.0.1', r))
    process.env.ROKU_ECP_PORT = String(ecp.address().port)
    FakeWS.instances = []
    savedWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS
  })
  afterEach(async () => {
    globalThis.WebSocket = savedWS
    server && server.close()
    server = null
    await new Promise((r) => ecp.close(r))
    delete process.env.ROKU_ECP_PORT
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('restores a stored enable for the device ESN without re-sending it', async () => {
    state.writeState(ESN, ['dev'], { dir: home })
    await boot()
    const r = await call('enable')
    expect(r.status).toBe(200)
    expect(r.json.cached).toBe(true)
    expect(posts).toEqual([])
  })

  it('does not restore a record older than 6 h: sends the enable and rewrites the record', async () => {
    state.writeState(ESN, ['dev'], { dir: home, now: Date.now() - 6 * 60 * 60 * 1000 - 60000 })
    await boot()
    const r = await call('enable')
    expect(r.status).toBe(200)
    expect(r.json.cached).toBeUndefined()
    expect(posts).toEqual(['/perfetto/enable/dev'])
    expect(state.readState(ESN, { dir: home })).not.toBeNull()
  })

  it('restarts a dropped connection at most 3 times, then stops', async () => {
    await boot()
    await call('enable')
    await call('start')
    expect(FakeWS.instances.length).toBe(1)
    const enables = () => posts.length
    const before = enables()
    enableOk = false // every restart attempt now fails at enable
    FakeWS.instances[0].drop()
    await until(() => enables() - before >= 3)
    await new Promise((r) => setTimeout(r, 150)) // room for a (forbidden) 4th attempt
    expect(enables() - before).toBe(3)
    expect(FakeWS.instances.length).toBe(1) // never reopened while enable keeps failing
    const st = await call('status', 'GET')
    expect(st.json.error).toMatch(/restart failed/)
  })

  it('status payload says what brighttest recorded, never the device state or the ESN', async () => {
    await boot()
    let st = await call('status', 'GET')
    expect(st.json.brighttestRecord).toBe('no brighttest record; device state not queryable')
    await call('enable')
    st = await call('status', 'GET')
    expect(st.json.brighttestRecord).toMatch(/^enabled by brighttest at \d\d:\d\d, device state not queryable$/)
    const raw = JSON.stringify(st.json)
    expect(raw).not.toContain(ESN)
    expect(raw).not.toMatch(/\b(off|disabled|stopped|not running)\b/i)
  })
})
