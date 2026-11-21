import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Real processes, no device: lease workers (test/fixtures/lease-worker.js) contend for one key in a temp
// lease dir and log their hold intervals.
const here = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(here, '..', 'fixtures', 'lease-worker.js')
const KEY = '127.0.0.1'
let dir, logFile

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lease-int-'))
  logFile = path.join(dir, 'intervals.log')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function startWorker(id, holdMs, env = {}) {
  const child = spawn(process.execPath, [WORKER, id, logFile, String(holdMs)], {
    env: { ...process.env, BRIGHTTEST_LEASE_DIR: path.join(dir, 'leases'), BRIGHTTEST_LEASE: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.done = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })))
  return child
}
async function waitFor(pred, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (pred()) return true; await sleep(25) }
  return false
}
const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
const has = (re) => () => lines().some((l) => re.test(l))
function intervals() {
  const open = new Map(), out = []
  for (const l of lines()) {
    const [kind, id, ns, ms] = l.split(' ')
    if (kind === 'enter') open.set(id, { id, enter: BigInt(ns), enterMs: Number(ms) })
    if (kind === 'exit' && open.has(id)) out.push({ ...open.get(id), exit: BigInt(ns) })
  }
  return out
}
function overlaps(list) {
  const s = [...list].sort((a, b) => (a.enter < b.enter ? -1 : 1))
  return s.filter((x, i) => i > 0 && x.enter < s[i - 1].exit).length
}
const events = () => {
  const f = path.join(dir, 'leases', KEY, 'events.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

describe('device lease across processes', () => {
  it('8 concurrent workers never overlap and are served in ticket order', async () => {
    // Order is made deterministic by events, not sleeps: w1 takes the lease and holds it; each later worker is
    // started only after the previous one has logged its own 'queued' event (its ticket is then on disk), so
    // ticket order == start order. (The 'queued' event is logged after the worker's first poll, and a head ticket
    // alone in the queue waits a settle first, so the event order of back-to-back starts is not the ticket order.)
    const ws = [startWorker('w1', 1500)]
    expect(await waitFor(has(/^enter w1 /))).toBe(true)
    for (let i = 2; i <= 8; i++) {
      ws.push(startWorker(`w${i}`, 40))
      expect(await waitFor(() => events().some((e) => e.ev === 'queued' && e.agent === `w${i}`), 15000)).toBe(true)
    }
    const res = await Promise.all(ws.map((w) => w.done))
    expect(res.every((r) => r.code === 0)).toBe(true)
    const iv = intervals()
    expect(iv).toHaveLength(8)
    expect(overlaps(iv)).toBe(0)
    const served = [...iv].sort((a, b) => (a.enter < b.enter ? -1 : 1)).map((x) => x.id)
    expect(served).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'])
  })

  it('F2: SIGKILL of the holder frees the device in < 3 s (reclaimed)', async () => {
    const h = startWorker('h', 30000)
    expect(await waitFor(has(/^enter h /))).toBe(true)
    const w = startWorker('w', 50)
    await sleep(300)
    const killedAt = Date.now()
    h.kill('SIGKILL')
    expect((await w.done).code).toBe(0)
    const wEnter = intervals().find((x) => x.id === 'w')
    expect(wEnter.enterMs - killedAt).toBeLessThan(3000)
    expect(events().some((e) => e.ev === 'reclaimed' && e.reason === 'dead')).toBe(true)
  })

  it('a live child of a SIGKILLed holder keeps the lease until the child exits (D8 rule 1)', async () => {
    const h = startWorker('h', 30000, { LEASE_CHILD_MS: '1500' })
    expect(await waitFor(has(/^child h /))).toBe(true)
    const w = startWorker('w', 50)
    await sleep(200)
    const killedAt = Date.now()
    h.kill('SIGKILL')
    expect((await w.done).code).toBe(0)
    const wEnter = intervals().find((x) => x.id === 'w')
    expect(wEnter.enterMs - killedAt).toBeGreaterThan(900)
  })

  it('SIGTERM releases the lease and kills the child group', async () => {
    const h = startWorker('h', 30000, { LEASE_CHILD_MS: '30000' })
    expect(await waitFor(has(/^child h /))).toBe(true)
    const childPid = Number(lines().find((l) => l.startsWith('child h ')).split(' ')[2])
    h.kill('SIGTERM')
    const r = await h.done
    expect(r.signal).toBe('SIGTERM')
    expect(events().some((e) => e.ev === 'released' && e.reason === 'signal')).toBe(true)
    expect(await waitFor(() => { try { process.kill(childPid, 0); return false } catch { return true } }, 3000)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'leases', KEY, 'holder.json'))).toBe(false)
  })

  it('F12: a waiter killed while queued is skipped after the ticket grace', async () => {
    const h = startWorker('h', 1500, { LEASE_GRACE_MS: '500' })
    expect(await waitFor(has(/^enter h /))).toBe(true)
    const dead = startWorker('dead', 50, { LEASE_GRACE_MS: '500' })
    await sleep(300)
    const next = startWorker('next', 50, { LEASE_GRACE_MS: '500' })
    await sleep(200)
    dead.kill('SIGKILL')
    expect(fs.readdirSync(path.join(dir, 'leases', KEY, 'queue')).length).toBe(2) // the dead ticket is still there
    expect((await next.done).code).toBe(0)
    expect(intervals().map((x) => x.id)).toEqual(['h', 'next'])
    expect(fs.readdirSync(path.join(dir, 'leases', KEY, 'queue'))).toEqual([])
  })

  it('F14: a nested acquire with BRIGHTTEST_LEASE is re-entrant (no self-deadlock)', async () => {
    const w = startWorker('outer', 50, { LEASE_NESTED: '1', LEASE_WAIT_MS: '2000' })
    expect((await w.done).code).toBe(0)
    expect(lines().some((l) => /^enter outer-inner .* reentrant$/.test(l))).toBe(true)
    expect(lines()).toContain('nested outer 0')
    expect(events().filter((e) => e.ev === 'acquired')).toHaveLength(1)
  })

  it('wait timeout exits 75; a stale token exits 77', async () => {
    const h = startWorker('h', 3000)
    expect(await waitFor(has(/^enter h /))).toBe(true)
    const t = startWorker('t', 50, { LEASE_WAIT_MS: '500' })
    expect((await t.done).code).toBe(75)
    const s = startWorker('s', 50, { BRIGHTTEST_LEASE: '0'.repeat(24) })
    expect((await s.done).code).toBe(77)
    expect(lines()).toContain('error s LEASE_LOST')
    h.kill('SIGTERM')
    await h.done
  })
})
