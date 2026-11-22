import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { PerfettoCapture } = require('../lib/studio/perfetto.js')
const state = require('../lib/studio/perfetto-state.js')

const ESN = 'TESTESN0001'

// Fake WebSocket: instances register themselves so tests can open or drop them.
class FakeWS {
  static instances = []
  static failOpen = 0
  constructor(url) {
    this.url = url
    this.readyState = 0
    FakeWS.instances.push(this)
    setTimeout(() => {
      if (FakeWS.failOpen > 0) { FakeWS.failOpen--; this.readyState = 3; this.onerror && this.onerror(); return }
      this.readyState = 1
      this.onopen && this.onopen()
    }, 1)
  }
  close() { this.readyState = 3; setTimeout(() => this.onclose && this.onclose(), 1) }
  drop() { this.readyState = 3; this.onclose && this.onclose() }
}
FakeWS.OPEN = 1

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) }
}

describe('Perfetto per-ESN state and auto-restart (PRF-01)', () => {
  let home, dir, srv, port, posts, savedWS, captures, streams, realCreateWriteStream
  beforeEach(async () => {
    captures = []
    streams = []
    // Track every trace file stream a capture opens so teardown can wait for it to close.
    realCreateWriteStream = fs.createWriteStream
    fs.createWriteStream = (...args) => {
      const s = realCreateWriteStream.apply(fs, args)
      streams.push(s)
      return s
    }
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pf-home-'))
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pf-dir-'))
    posts = []
    srv = http.createServer((req, res) => {
      posts.push(req.url)
      res.end('<enabled-channels><channel>dev</channel></enabled-channels>')
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    port = srv.address().port
    FakeWS.instances = []; FakeWS.failOpen = 0
    savedWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS
  })
  afterEach(async () => {
    // Settle every capture the test started BEFORE removing the temp dir: stop restart loops, wait for
    // an in-flight restart to finish, close sockets, then end and await every trace stream.
    for (const pf of captures) pf.stopping = true
    const deadline = Date.now() + 3000
    while (captures.some((pf) => pf.restarting) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    for (const pf of captures) { try { pf.socket && pf.socket.close() } catch { /* already closed */ } }
    await Promise.all(streams.map((s) => new Promise((resolve) => {
      if (s.closed || s.destroyed) return resolve()
      const t = setTimeout(resolve, 3000)
      s.once('close', () => { clearTimeout(t); resolve() })
      s.end()
    })))
    fs.createWriteStream = realCreateWriteStream
    globalThis.WebSocket = savedWS
    await new Promise((r) => srv.close(r))
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const make = (extra = {}) => {
    const pf = new PerfettoCapture({ host: '127.0.0.1', ecpPort: port, channelId: 'dev', dir, esn: ESN, stateDir: home, ...extra })
    captures.push(pf)
    return pf
  }

  it('persists the enable per ESN and survives a new instance (Studio restart)', async () => {
    await make().enable()
    expect(fs.existsSync(path.join(home, 'perfetto-state.json'))).toBe(true)
    const again = make()
    expect(again.persisted.channels).toEqual(['dev'])
    const r = await again.ensureEnabled()
    expect(r.cached).toBe(true)
    expect(posts.length).toBe(1) // no second POST
  })

  it('ignores a stale record and re-sends the enable', async () => {
    state.writeState(ESN, ['dev'], { dir: home, now: Date.now() - 10_000 })
    expect(state.readState(ESN, { dir: home, staleMs: 5000 })).toBeNull()
    const pf = make({ staleMs: 5000 })
    const r = await pf.ensureEnabled()
    expect(r.cached).toBeUndefined()
    expect(posts.length).toBe(1)
  })

  it('state is keyed per ESN', async () => {
    state.writeState(ESN, ['dev'], { dir: home })
    expect(state.readState('OTHERESN', { dir: home })).toBeNull()
  })

  it('re-enables and reopens the stream after a drop', async () => {
    const pf = make({ autoRestart: true, restartDelayMs: 5 })
    await pf.start()
    const restarted = new Promise((r) => pf.once('restarted', r))
    FakeWS.instances[0].drop()
    expect((await restarted).attempt).toBe(1)
    expect(posts.length).toBe(1)
    expect(pf.tracing).toBe(true)
    await pf.stop()
  })

  it('retries are bounded, then reports restart-failed', async () => {
    const pf = make({ autoRestart: true, restartDelayMs: 5, restartAttempts: 3 })
    await pf.start()
    FakeWS.failOpen = 100
    const failed = new Promise((r) => pf.once('restart-failed', r))
    FakeWS.instances[0].drop()
    const ev = await failed
    expect(ev.error).toMatch(/restart failed/)
    expect(FakeWS.instances.length).toBe(1 + 3) // exactly 3 reopen attempts, no more
    expect(pf.error).toMatch(/restart failed/)
    expect(pf.tracing).toBe(false)
  })

  it('deadline caps the restart sequence', async () => {
    const pf = make({ autoRestart: true, restartDelayMs: 50, restartAttempts: 100, restartDeadlineMs: 120 })
    await pf.start()
    FakeWS.failOpen = 1000
    const failed = new Promise((r) => pf.once('restart-failed', r))
    FakeWS.instances[0].drop()
    await failed
    expect(FakeWS.instances.length).toBeLessThan(6)
  })

  it('does not restart after a deliberate stop', async () => {
    const pf = make({ autoRestart: true, restartDelayMs: 5 })
    await pf.start()
    pf.lastMessageAt = 0
    await pf.stop()
    await new Promise((r) => setTimeout(r, 60))
    expect(FakeWS.instances.length).toBe(1)
  })
})

describe('describeState', () => {
  const { describeState } = require('../lib/studio/perfetto-state.js')
  it('no record: says so, never off/disabled', () => {
    for (const r of [null, undefined, {}]) expect(describeState(r)).toBe('no brighttest record; device state not queryable')
  })
  it('record: local HH:MM, no ESN, no state claims', () => {
    const at = new Date(2026, 10, 22, 9, 5).getTime()
    expect(describeState({ channels: ['dev'], enabledAt: at }, { now: at + 1000 })).toBe('enabled by brighttest at 09:05, device state not queryable')
    expect(describeState({ channels: ['dev'], enabledAt: at }, { now: at + 25 * 3600 * 1000 })).toBe('enabled by brighttest at 2026-11-22 09:05, device state not queryable')
    expect(describeState({ channels: ['dev'], enabledAt: at, esn: 'TESTESN0001' })).not.toMatch(/TESTESN|\b(off|disabled|stopped|not running)\b/i)
  })
})
