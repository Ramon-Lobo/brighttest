import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const { createHubEvents } = require('../lib/e2e/hub-events.js')

// Per-step timing lines, the timing summary and the hub events file, against the fake Roku. Shape and presence only:
// no assertion depends on how long anything took.
const STEP_TIME = /^ {6}step time: \d+ ms\n/gm
const SUMMARY = /^ {2}timing: \d+ step\(s\) \d+ ms · run \d+ ms · runner overhead \d+ ms\n/m
const FIXTURE = path.join(__dirname, 'fixtures', 'e2e-step-timing', 'no-hub-run.txt')

let dir, cfg, out
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-timing-'))
  cfg = loadConfig(dir, null)
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const acquire = async () => ({ lease: { release() {} } })
async function runFlow(steps, deps = {}, extra = {}) {
  const stub = createFakeRoku({ scenario: 'replay-then-live' })
  const a = await stub.start()
  const flow = path.join(dir, 'timing-smoke.e2e.yaml')
  fs.writeFileSync(flow, `appId: dev\nconfig: { timeout: 3 }\nsteps:\n${steps.map((s) => '  - ' + s).join('\n')}\n`)
  try {
    const code = await e2e.run(cfg, {
      e2eAction: 'run', flows: [flow], host: a.host, ecpPort: a.ecpPort, logPort: a.debugPort,
      screenshots: path.join(dir, 'shots'), screenshotsMode: 'off', ...extra,
    }, { acquireForLane: acquire, ...deps })
    return { code, host: a.host }
  } finally { await stub.stop() }
}
const normalize = (s, host) => s.split(dir).join('<dir>').split(host).join('<host>').replace(/\r\n/g, '\n')
const stripTiming = (s) => s.replace(STEP_TIME, '').replace(new RegExp(SUMMARY.source, 'm'), '')

describe('e2e per-step timing', () => {
  it('prints one step time per step and a timing summary with runner overhead', async () => {
    const { code } = await runFlow(['launch', 'assertLog: "FakeApp: live line 3"', 'expectNoLog: "ERROR"'])
    expect(code).toBe(0)
    expect(out.match(STEP_TIME)).toHaveLength(3)
    expect(out).toMatch(SUMMARY)
    expect(out).toMatch(/timing: 3 step\(s\)/)
    // the time line follows its step line
    expect(out).toMatch(/✓ expectNoLog[^\n]*\n {6}step time: \d+ ms\n/)
  }, 15000)

  it('a failing step also prints its time, before the failure text', async () => {
    const { code } = await runFlow(['launch', 'expectNoLog: "live line"'])
    expect(code).toBe(1)
    expect(out).toMatch(/✗ expectNoLog[^\n]*\n {6}step time: \d+ ms\n/)
    expect(out).toMatch(SUMMARY)
  }, 15000)

  it('a no-hub run keeps every existing line byte-identical (fixture captured before the change)', async () => {
    const { code, host } = await runFlow(['launch', 'assertLog: "FakeApp: live line 3"', 'expectNoLog: "ERROR"'])
    expect(code).toBe(0)
    expect(stripTiming(normalize(out, host))).toBe(fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))
  }, 15000)
})

describe('hub events file', () => {
  const eventsFile = () => path.join(dir, 'shots', 'hub-events.ndjson')
  const lines = () => fs.readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

  it('no hub in the run: no events file', async () => {
    await runFlow(['launch'])
    expect(fs.existsSync(eventsFile())).toBe(false)
  }, 15000)

  it('a hub started by the run: one NDJSON line per hub log line and event, with status and bytes', async () => {
    const events = new EventEmitter()
    let stopped = false
    const startLanHub = async ({ log }) => {
      setImmediate(() => { // the hub reports once it is up, as a real one does (the hub is open for events by then)
        log('[brighttest hub] request GET /api/items -> 200 (123 response bytes, source mock)')
        log('[brighttest hub] request POST /api/x -> 403 (7 response bytes, source refused)')
        log('[brighttest hub] refused a request from 10.0.0.9: the hub for h answers only that device (expected 10.0.0.1)')
        events.emit('event', { src: 'hub', kind: 'cmd.sent', data: { id: 'c-1', op: 'setState' } })
      })
      return { events, stop: async () => { stopped = true } }
    }
    const { code } = await runFlow(['launch'], { startLanHub }, { lanHub: true })
    expect(code).toBe(0)
    expect(stopped).toBe(true)
    const rows = lines()
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(Number.isNaN(Date.parse(r.ts))).toBe(false)
    expect(rows[0]).toMatchObject({ kind: 'request', method: 'GET', path: '/api/items', status: 200, bytes: 123, source: 'mock' })
    expect(rows[0].line).toMatch(/^\[brighttest hub\] request GET \/api\/items -> 200 \(123 response bytes/)
    expect(rows[1]).toMatchObject({ kind: 'request', method: 'POST', status: 403, bytes: 7, source: 'refused' })
    expect(rows[2]).toMatchObject({ kind: 'log' })
    expect(rows[3]).toMatchObject({ kind: 'event', src: 'hub', name: 'cmd.sent', data: { id: 'c-1', op: 'setState' } })
    // stdout still carries the hub lines as before
    expect(out).toMatch(/request GET \/api\/items -> 200 \(123 response bytes, source mock\)/)
  }, 15000)

  it('agent-sourced events keep only timing keys; app data and secret-named keys never reach the file', () => {
    const events = new EventEmitter()
    const he = createHubEvents({ dir: path.join(dir, 'agent-events') })
    he.open({ events })
    events.emit('event', { src: 'agent', kind: 'state.snapshot', data: { id: 'c-2', seq: 5, ok: true, user: { authToken: 'SECRET-VALUE' }, authToken: 'SECRET-TOP' } })
    events.emit('event', { src: 'agent', kind: 'custom', data: { op: 'x', nested: { id: 1 } } })
    he.close()
    const raw = fs.readFileSync(he.file, 'utf8')
    expect(raw).not.toMatch(/SECRET|authToken/)
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(rows[0]).toMatchObject({ kind: 'event', src: 'agent', name: 'state.snapshot', data: { id: 'c-2', seq: 5, ok: true } })
    expect(rows[1].data).toEqual({ op: 'x' })
  })

  it('a hub that fails to start leaves no events file', async () => {
    const startLanHub = async () => { throw new Error('boom') }
    await runFlow(['launch'], { startLanHub }, { lanHub: true })
    expect(fs.existsSync(eventsFile())).toBe(false)
  }, 15000)

  it('net proxy events become request lines; a failed write never throws', () => {
    const he = createHubEvents({ dir: path.join(dir, 'net-events') })
    he.net('net.request', { id: 1, method: 'GET', url: 'http://example.test/a/b?q=1' }) // inactive: ignored
    he.open(null)
    he.net('net.request', { id: 2, method: 'GET', url: 'http://example.test/a/b?q=1' })
    he.net('net.response', { id: 2, status: 200, bytes: 42, source: 'mock' })
    he.close()
    he.log('after close') // inactive again
    const rows = fs.readFileSync(he.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'request', method: 'GET', path: '/a/b', status: 200, bytes: 42, source: 'mock' })
    const blocked = createHubEvents({ dir: path.join(dir, 'net-events', 'hub-events.ndjson', 'x') }) // parent is a file
    expect(() => { blocked.open(null); blocked.log('x') }).not.toThrow()
    expect(blocked.active).toBe(false)
  })
})
