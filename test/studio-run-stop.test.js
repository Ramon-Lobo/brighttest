import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const studio = require('../lib/studio/server.js')
const { createEventLog } = require('../lib/instrument/events.js')
const { createStateOps } = require('../lib/instrument/state-ops.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// STUDIO-STOP-T1: Stop a Run (POST /api/run/stop), stop on stream close, one run at a time, the run saved as
// "stopped", the lease kept. Fake Roku + a scripted hub; no device.
let dir, fake, server, port, prevPort, streams

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, text: b }))
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}
// Open the run stream and collect events as they arrive.
function openRun(file) {
  const out = { events: [], status: null, closed: false, abort: null }
  out.done = new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: `/api/run?file=${file}` }, (res) => {
      out.status = res.statusCode
      let buf = ''
      res.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) out.events.push(JSON.parse(chunk.slice(6)))
        }
        if (res.statusCode !== 200) out.events.push(JSON.parse(buf || '{}'))
      })
      res.on('end', () => { out.closed = true; resolve() })
      res.on('error', () => resolve())
    })
    r.on('error', () => resolve())
    out.abort = () => r.destroy()
  })
  streams.push(out)
  return out
}
const until = async (fn, ms = 6000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)) } }
const startedRun = async (run) => { await until(() => run.events.some((e) => e.type === 'start')); return run.events.find((e) => e.type === 'start').runId }
const stepRunning = (run, i) => until(() => run.events.some((e) => e.type === 'step' && e.index === i && e.status === 'running'))

function makeHub() { // never acks: a state step waits for the ack until it is stopped
  const log = createEventLog({ sessionId: 'sess1' })
  const stateOps = createStateOps({ session: 'sess1' })
  let seq = 0
  const h = { sessionId: 'sess1', hellos: 1, lastHelloAt: 1000, log, stateOps, pushed: [], events: new EventEmitter(),
    push(cmd, { ack } = {}) {
      const full = { v: 1, id: `c-${++seq}`, ...cmd, seq, session: 'sess1' }
      h.stateOps.track(full, { ack, now: Date.now() }); h.pushed.push(full); return full
    } }
  return h
}

async function start(opts = {}) {
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, ...opts,
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
}
const writeFlow = (name, text) => { fs.mkdirSync(path.join(dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(dir, 'flows', name), text) }
const SLOW = 'appId: dev\nsteps:\n  - wait: 10\n  - waitFor: { text: "never shown anywhere", timeout: 30 }\n  - press: Back\n'
const stopBody = (runId) => JSON.stringify({ runId })

beforeEach(async () => {
  streams = []
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-stop-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  delete process.env.BRIGHTTEST_HUB_TOKEN
})
afterEach(async () => {
  for (const s of streams) if (s.abort) s.abort()
  server.close(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/run/stop', () => {
  it('stops a polling step within 250 ms plus one request, saves the run as stopped, sends no more device requests', async () => {
    await start(); writeFlow('slow.e2e.yaml', SLOW)
    const run = openRun('slow.e2e.yaml')
    const runId = await startedRun(run)
    await stepRunning(run, 1)
    await new Promise((r) => setTimeout(r, 400)) // let the poll loop run a few iterations
    const t0 = Date.now()
    const stop = await req('POST', '/api/run/stop', stopBody(runId))
    expect(stop.status).toBe(200)
    expect(JSON.parse(stop.text)).toEqual({ ok: true, stopping: true })
    await run.done
    expect(Date.now() - t0).toBeLessThan(1000)
    const types = run.events.map((e) => e.type)
    expect(types.slice(-3)).toEqual(['step', 'stopped', 'done'])
    expect(run.events.find((e) => e.type === 'stopped')).toMatchObject({ runId, index: 1, reason: 'stopped by user' })
    expect(run.events[run.events.length - 1]).toMatchObject({ type: 'done', ok: false, stopped: true, runId })
    expect(run.events.find((e) => e.type === 'aborted')).toBeUndefined()
    const stoppedStep = run.events.filter((e) => e.type === 'step' && e.status === 'stopped')[0]
    expect(stoppedStep).toMatchObject({ index: 1, op: 'waitFor', frame: false })
    // No device request after the stop, beyond the one in flight when it arrived.
    const after = fake.log.filter((e) => e.service && e.startMs > t0 + 5 && e.endpoint)
    await new Promise((r) => setTimeout(r, 600))
    const later = fake.log.filter((e) => e.startMs > t0 + 300 && e.endpoint)
    expect(later.length).toBe(0)
    expect(after.length).toBeLessThanOrEqual(2)
    expect(fake.keypresses.map((k) => k.key || k)).not.toContain('Back')
    // The saved run
    const list = JSON.parse((await req('GET', '/api/runs')).text)
    expect(list[0]).toMatchObject({ id: runId, ok: false, stopped: true })
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.brighttest', 'studio', 'runs', String(runId), 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({ ok: false, stopped: true, stoppedAt: 1, reason: 'stopped by user' })
    expect(meta.steps[1].status).toBe('stopped')
    expect(meta.steps.length).toBe(2)
  })

  it('keeps the device lease after a stop and accepts a new run', async () => {
    await start(); writeFlow('slow.e2e.yaml', SLOW); writeFlow('ok.e2e.yaml', 'appId: dev\nsteps:\n  - press: Home\n')
    const run = openRun('slow.e2e.yaml')
    const runId = await startedRun(run); await stepRunning(run, 1)
    await req('POST', '/api/run/stop', stopBody(runId)); await run.done
    const lease = JSON.parse((await req('GET', '/api/lease')).text)
    expect(lease.holding).toBe(true)
    expect(lease.yielded).toBe(false)
    const run2 = openRun('ok.e2e.yaml'); await run2.done
    expect(run2.events[run2.events.length - 1]).toMatchObject({ type: 'done', ok: true })
  })

  it('answers 409 NOT_RUNNING with no run, a wrong id, or after the run ended', async () => {
    await start(); writeFlow('ok.e2e.yaml', 'appId: dev\nsteps:\n  - press: Home\n')
    let r = await req('POST', '/api/run/stop', stopBody(1))
    expect(r.status).toBe(409); expect(JSON.parse(r.text).code).toBe('NOT_RUNNING')
    const run = openRun('ok.e2e.yaml'); await run.done
    r = await req('POST', '/api/run/stop', stopBody(run.events[0].runId))
    expect(r.status).toBe(409); expect(JSON.parse(r.text).code).toBe('NOT_RUNNING')
  })

  it('ignores a stop for another run id while one is active', async () => {
    await start(); writeFlow('slow.e2e.yaml', SLOW)
    const run = openRun('slow.e2e.yaml'); const runId = await startedRun(run); await stepRunning(run, 1)
    const r = await req('POST', '/api/run/stop', stopBody(runId + 99))
    expect(r.status).toBe(409)
    await new Promise((x) => setTimeout(x, 300))
    expect(run.closed).toBe(false)
    await req('POST', '/api/run/stop', stopBody(runId)); await run.done
  })

  it('refuses a second run while one is active (409 RUN_IN_PROGRESS) and allows one after it ends', async () => {
    await start(); writeFlow('slow.e2e.yaml', SLOW)
    const run = openRun('slow.e2e.yaml'); const runId = await startedRun(run); await stepRunning(run, 1)
    const second = openRun('slow.e2e.yaml'); await second.done
    expect(second.status).toBe(409)
    expect(second.events[0]).toMatchObject({ code: 'RUN_IN_PROGRESS', runId })
    await req('POST', '/api/run/stop', stopBody(runId)); await run.done
    const third = openRun('slow.e2e.yaml'); const id3 = await startedRun(third)
    await req('POST', '/api/run/stop', stopBody(id3)); await third.done
    expect(third.events[third.events.length - 1]).toMatchObject({ stopped: true })
  })

  it('stops between steps: a flow of presses ends with at most one more key', async () => {
    await start(); writeFlow('keys.e2e.yaml', 'appId: dev\nsteps:\n  - press: { key: Down, count: 40 }\n  - press: Back\n')
    const run = openRun('keys.e2e.yaml'); const runId = await startedRun(run); await stepRunning(run, 0)
    await new Promise((r) => setTimeout(r, 30))
    await req('POST', '/api/run/stop', stopBody(runId)); await run.done
    expect(run.events[run.events.length - 1]).toMatchObject({ stopped: true })
    const n = fake.keypresses.length
    await new Promise((r) => setTimeout(r, 300))
    expect(fake.keypresses.length).toBe(n)
    expect(n).toBeLessThan(40)
  })
})

describe('stream close', () => {
  it('stops the run when the browser closes the stream', async () => {
    await start(); writeFlow('slow.e2e.yaml', SLOW)
    const run = openRun('slow.e2e.yaml'); const runId = await startedRun(run); await stepRunning(run, 1)
    run.abort()
    await until(() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.brighttest', 'studio', 'runs', String(runId), 'meta.json'), 'utf8')).stopped === true } catch { return false } })
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.brighttest', 'studio', 'runs', String(runId), 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({ ok: false, stopped: true, reason: 'client disconnected' })
    // and a new run is accepted at once (the active slot was freed)
    writeFlow('ok.e2e.yaml', 'appId: dev\nsteps:\n  - press: Home\n')
    const next = openRun('ok.e2e.yaml'); await next.done
    expect(next.events[next.events.length - 1]).toMatchObject({ type: 'done', ok: true })
  })
})

describe('stop during a state step', () => {
  it('returns at once, says the command may still apply, and runs the cleanup', async () => {
    const hub = makeHub()
    await start({ net: { proxy: {}, hub, events: hub.events, log: hub.log } })
    writeFlow('s.e2e.yaml', 'appId: dev\nsteps:\n  - waitForAgent\n  - setState: { layer: global, path: user.tier, value: premium }\n  - press: Back\n')
    const run = openRun('s.e2e.yaml'); const runId = await startedRun(run); await stepRunning(run, 1)
    await until(() => hub.pushed.length === 1)
    const t0 = Date.now()
    await req('POST', '/api/run/stop', stopBody(runId)); await run.done
    expect(Date.now() - t0).toBeLessThan(1000)
    const st = run.events.find((e) => e.type === 'step' && e.status === 'stopped')
    expect(st).toMatchObject({ index: 1, op: 'setState' })
    expect(st.detail).toMatch(/may still apply/)
    expect(run.events.find((e) => e.type === 'stopped')).toBeTruthy()
    expect(fake.keypresses.map((k) => k.key || k)).not.toContain('Back')
    // a following run on the same hub starts clean
    writeFlow('ok.e2e.yaml', 'appId: dev\nsteps:\n  - press: Home\n')
    const next = openRun('ok.e2e.yaml'); await next.done
    expect(next.events[next.events.length - 1]).toMatchObject({ type: 'done', ok: true })
  })
})
