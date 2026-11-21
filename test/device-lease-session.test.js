import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import lease from '../lib/device-lease.js'
import hook from '../lib/device-hook.js'
import deviceCommand from '../lib/device-command.js'
import { loadConfig } from '../lib/config.js'
import { parseDeviceArgs } from '../bin/cli.js'

const { acquire, createStore, renew, unlock, tokenValid, exitCodeFor, LeaseError } = lease
const KEY = '127.0.0.1'
const MIN = 60000

// Fake clock: `sleep` advances it, nothing here waits in real time.
let dir, clock
const seams = (extra = {}) => ({
  dir, env: {}, timers: false, identity: { worktree: '/tmp/wt-a', branch: 'feat/x' }, hostname: 'this-host',
  now: () => clock.t, sleep: async (ms) => { clock.t += ms }, isAlive: () => true, pidStart: () => null, random: () => 0.5, ...extra,
})
const lock = (extra = {}) => acquire({ key: KEY, mode: 'session', pid: 2001, waitMs: 0, ...seams(extra), ...extra })
const store = () => createStore(seams())
const events = () => store().readEvents({ key: KEY })
const holder = () => JSON.parse(fs.readFileSync(path.join(dir, KEY, 'holder.json'), 'utf8'))
const iso = (t) => new Date(t).toISOString()

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sess-'))
  clock = { t: Date.now() }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('session lease: lock', () => {
  it('writes a session record with an idle expiry and a hard cap, and no owner pid', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 20000 })
    expect(l.mode).toBe('session')
    expect(l.leaseId).toMatch(/^[0-9a-f]{24}$/)
    const h = holder()
    expect(h.mode).toBe('session')
    expect(h.holder.pid).toBeNull()
    expect(h.expiresAt).toBe(iso(clock.t + 5000))
    expect(h.deadline).toBe(iso(clock.t + 20000))
    expect(events().map((e) => e.ev)).toEqual(['acquired'])
  })

  it('defaults to sessionIdle 10m and sessionMax 45m, and caps idle at the max', async () => {
    await lock()
    const h = holder()
    expect(Date.parse(h.expiresAt) - clock.t).toBe(10 * MIN)
    expect(Date.parse(h.deadline) - clock.t).toBe(45 * MIN)
    fs.rmSync(path.join(dir, KEY, 'holder.json'))
    await lock({ idleMs: 30 * MIN, maxHoldMs: 2 * MIN })
    expect(Date.parse(holder().expiresAt) - clock.t).toBe(2 * MIN)
  })

  it('has no process handlers or timers: it outlives its creator (release is explicit)', async () => {
    const before = lease._held.size
    const l = await lock()
    expect(lease._held.size).toBe(before)
    expect(l.reentrant).toBe(false)
    expect(fs.existsSync(path.join(dir, KEY, 'holder.json'))).toBe(true)
  })

  it('blocks a second lock (--wait 0 gives BUSY, exit 75)', async () => {
    await lock()
    const err = await lock({ pid: 2002 }).catch((e) => e)
    expect(err).toMatchObject({ code: 'BUSY' })
    expect(exitCodeFor(err)).toBe(75)
  })
})

describe('session lease: fake-clock expiry for every state', () => {
  it('fresh: valid; renewed use keeps it alive past the first idle window', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    expect(tokenValid(l.leaseId, { store: store() })).toBe(true)
    clock.t += 4000
    expect(renew(l.leaseId, seams()).expiresAt).toBe(iso(clock.t + 5000))
    clock.t += 4000 // 8 s after lock, past the original expiry, inside the renewed one
    expect(tokenValid(l.leaseId, { store: store() })).toBe(true)
    expect(store().staleReason(store().readHolder(KEY))).toBeNull()
  })

  it('idle: stale exactly after the idle TTL, token invalid, renew fails 77, unlock fails 77', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    clock.t += 5000 // not yet (strictly greater)
    expect(tokenValid(l.leaseId, { store: store() })).toBe(true)
    clock.t += 1
    expect(store().staleReason(store().readHolder(KEY))).toBe('idle')
    expect(tokenValid(l.leaseId, { store: store() })).toBe(false)
    const r = (() => { try { renew(l.leaseId, seams()) } catch (e) { return e } })()
    expect(r).toMatchObject({ code: 'LEASE_LOST' })
    expect(exitCodeFor(r)).toBe(77)
    expect(r.message).toMatch(/expired \(idle\)/)
    const u = (() => { try { unlock(l.leaseId, seams()) } catch (e) { return e } })()
    expect(exitCodeFor(u)).toBe(77)
  })

  it('cap: renewals never push expiry past the hard cap; then the token dies', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 12000 })
    clock.t += 4000
    renew(l.leaseId, seams())
    clock.t += 4000
    const r = renew(l.leaseId, seams()) // would be +5000 = 13000 > cap 12000
    expect(r.expiresAt).toBe(r.deadline)
    clock.t += 3999
    expect(tokenValid(l.leaseId, { store: store() })).toBe(true)
    clock.t += 2 // 12001 after lock
    expect(store().staleReason(store().readHolder(KEY))).toBe('deadline')
    expect(tokenValid(l.leaseId, { store: store() })).toBe(false)
    expect(() => renew(l.leaseId, seams())).toThrow(/expired \(deadline\)/)
  })

  it('expired: the next acquire reclaims it (idle) and a waiter gets the device', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    clock.t += 7000
    const w = await acquire({ key: KEY, pid: 2002, waitMs: 2000, ...seams() })
    expect(w.mode).toBe('command')
    expect(events().map((e) => e.ev + (e.reason ? ':' + e.reason : ''))).toEqual(expect.arrayContaining(['reclaimed:idle', 'acquired']))
    // the old token is now dead for good
    expect(tokenValid(l.leaseId, { store: store() })).toBe(false)
    w.release()
  })

  it('forgotten session with a queued waiter: waiter acquires when the idle TTL passes', async () => {
    await lock({ idleMs: 5000, maxHoldMs: 20000 })
    const t0 = clock.t
    const w = await acquire({ key: KEY, pid: 2002, waitMs: 30000, ...seams() })
    expect(clock.t - t0).toBeGreaterThanOrEqual(5000)
    expect(clock.t - t0).toBeLessThan(8000)
    w.release()
  })

  it('released: unlock removes it, the token is gone, a second unlock is 77', async () => {
    const l = await lock()
    expect(unlock(l.leaseId, seams())).toEqual({ key: KEY })
    expect(fs.existsSync(path.join(dir, KEY, 'holder.json'))).toBe(false)
    const ev = events().filter((e) => e.ev === 'released')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ reason: 'unlock', leaseId: l.leaseId })
    expect(tokenValid(l.leaseId, { store: store() })).toBe(false)
    expect(() => unlock(l.leaseId, seams())).toThrow(LeaseError)
    expect(exitCodeFor((() => { try { unlock(l.leaseId, seams()) } catch (e) { return e } })())).toBe(77)
  })

  it('forced: unlock --force frees it and the token is invalid', async () => {
    const l = await lock()
    lease.forceRelease({ key: KEY, reason: 'test', ...seams() })
    expect(tokenValid(l.leaseId, { store: store() })).toBe(false)
    expect(() => renew(l.leaseId, seams())).toThrow(/not held/)
  })
})

describe('session lease: using the token', () => {
  it('re-entrant acquire with the token renews the idle TTL and does not queue', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    clock.t += 4000
    const n = await acquire({ key: KEY, pid: 2002, waitMs: 0, ...seams({ env: { BRIGHTTEST_LEASE: l.leaseId } }) })
    expect(n.reentrant).toBe(true)
    expect(n.mode).toBe('session')
    n.release()
    expect(holder().expiresAt).toBe(iso(clock.t + 5000))
    expect(holder().leaseId).toBe(l.leaseId)
    expect(events().filter((e) => e.ev === 'acquired')).toHaveLength(1)
  })

  it('re-entrant acquire with an expired session token is LEASE_LOST (77), even before reclaim', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    clock.t += 6000
    const err = await acquire({ key: KEY, pid: 2002, waitMs: 0, ...seams({ env: { BRIGHTTEST_LEASE: l.leaseId } }) }).catch((e) => e)
    expect(err).toMatchObject({ code: 'LEASE_LOST' })
    expect(exitCodeFor(err)).toBe(77)
    expect(err.message).toMatch(/expired/)
  })

  it('renew refuses a command lease (usage) and an unknown token (77)', async () => {
    const c = await acquire({ key: KEY, pid: 2003, waitMs: 0, ...seams() })
    expect(exitCodeFor((() => { try { renew(c.leaseId, seams()) } catch (e) { return e } })())).toBe(2)
    expect(exitCodeFor((() => { try { unlock(c.leaseId, seams()) } catch (e) { return e } })())).toBe(2)
    expect(exitCodeFor((() => { try { renew('f'.repeat(24), seams()) } catch (e) { return e } })())).toBe(77)
    c.release()
  })

  it('explicit renew logs a renewed event; implicit renewals do not', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    await acquire({ key: KEY, pid: 2002, waitMs: 0, ...seams({ env: { BRIGHTTEST_LEASE: l.leaseId } }) })
    expect(events().filter((e) => e.ev === 'renewed')).toHaveLength(0)
    renew(l.leaseId, seams())
    expect(events().filter((e) => e.ev === 'renewed')).toHaveLength(1)
  })
})

describe('token validity for the hook', () => {
  const HOST = KEY
  const run = async (command, env) => {
    let out = ''
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb() } })
    const payload = { tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: 's' }
    await hook.main({ stdin: Readable.from([JSON.stringify(payload)]), stdout, env })
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'
  }
  const env = () => ({ BRIGHTTEST_LEASE_DIR: dir, ROKU_HOST: HOST, BRIGHTTEST_CACHE: path.join(dir, 'none.json') })
  const raw = (tok) => `BRIGHTTEST_LEASE=${tok} curl -d '' http://${HOST}:8060/keypress/Home`

  it('allows a raw device command with a live token, denies it once the session expired or was unlocked', async () => {
    const l = await acquire({ key: KEY, mode: 'session', pid: 1, waitMs: 0, idleMs: 600000, maxHoldMs: 1200000, env: {}, dir, timers: false, identity: {}, hostname: 'h' })
    expect(await run(raw(l.leaseId), env())).toBe('allow')
    expect(await run(raw('0'.repeat(24)), env())).toBe('deny')
    unlock(l.leaseId, { dir, env: {} })
    expect(await run(raw(l.leaseId), env())).toBe('deny')
  })

  it('a stale token on disk is not valid (real-clock expiry, 1 ms idle)', async () => {
    const l = await acquire({ key: KEY, mode: 'session', pid: 1, waitMs: 0, idleMs: 1, maxHoldMs: 1200000, env: {}, dir, timers: false, identity: {}, hostname: 'h' })
    await new Promise((r) => setTimeout(r, 20))
    expect(await run(raw(l.leaseId), env())).toBe('deny')
  })

  it('every use of a valid token in a hooked command renews its idle TTL', async () => {
    const l = await lock({ idleMs: 5000, maxHoldMs: 60000 })
    const t = store()
    clock.t += 3000
    expect(tokenValid(l.leaseId, { store: t, renew: true })).toBe(true)
    clock.t += 3000 // 6 s after lock: only valid because of the renewal
    expect(tokenValid(l.leaseId, { store: t })).toBe(true)
    clock.t += 3000
    expect(tokenValid(l.leaseId, { store: t })).toBe(false)
  })
})

describe('CLI: lock, with --lease, unlock (fake lease store, no device)', () => {
  let out, errs, saved
  beforeEach(() => {
    saved = { BRIGHTTEST_LEASE_DIR: process.env.BRIGHTTEST_LEASE_DIR, BRIGHTTEST_LEASE: process.env.BRIGHTTEST_LEASE }
    process.env.BRIGHTTEST_LEASE_DIR = dir
    delete process.env.BRIGHTTEST_LEASE
    out = []; errs = []
    vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)))
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { errs.push(String(s)); return true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  const cfg = () => loadConfig(dir, null)
  const dev = (args) => deviceCommand.run(parseDeviceArgs(args), cfg())
  const base = ['--host', KEY, '--no-hygiene', '--as', 'dev#t']

  it('parses --idle and --lease', () => {
    expect(parseDeviceArgs(['lock', '--idle', '5s', '--max=20s', '--json'])).toMatchObject({ deviceAction: 'lock', idle: '5s', max: '20s', json: true })
    expect(parseDeviceArgs(['renew', '--lease', 'abc'])).toMatchObject({ deviceAction: 'renew', lease: 'abc' })
  })

  it('lock --json, with --lease, renew, unlock, second unlock 77', async () => {
    expect(await dev(['lock', ...base, '--idle', '60s', '--max', '120s', '--json'])).toBe(0)
    const j = JSON.parse(out[0])
    expect(Object.keys(j).sort()).toEqual(['deadline', 'expiresAt', 'leaseId'])
    const tok = j.leaseId

    // with --lease runs under the session: no queue (--wait 0 would fail otherwise), child sees the token
    const code = await dev(['with', ...base, '--wait', '0', '--lease', tok, '--', process.execPath, '-e', 'process.exit(process.env.BRIGHTTEST_LEASE ? 0 : 9)'])
    expect(code).toBe(0)
    // and without the token the device is busy
    expect(await dev(['with', ...base, '--wait', '0', '--', process.execPath, '-e', '0'])).toBe(75)

    out.length = 0
    expect(await dev(['renew', '--lease', tok])).toBe(0)
    expect(out[0]).toMatch(/^renewed 127\.0\.0\.1/)
    expect(await dev(['unlock', '--lease', tok])).toBe(0)
    expect(out[1]).toBe('unlocked 127.0.0.1')
    expect(await dev(['unlock', '--lease', tok])).toBe(77)
    expect(await dev(['renew', '--lease', tok])).toBe(77)
    // the device is free again
    expect(await dev(['with', ...base, '--wait', '0', '--', process.execPath, '-e', '0'])).toBe(0)
    const evs = createStore({ dir }).readEvents({ key: KEY }).map((e) => e.ev)
    expect(evs).toEqual(expect.arrayContaining(['acquired', 'renewed', 'released']))
  })

  it('lock prints the bare token on stdout and the hint on stderr; token from BRIGHTTEST_LEASE for unlock', async () => {
    expect(await dev(['lock', ...base])).toBe(0)
    expect(out[0]).toMatch(/^[0-9a-f]{24}$/)
    expect(errs.join('')).toMatch(/locked 127\.0\.0\.1/)
    process.env.BRIGHTTEST_LEASE = out[0]
    expect(await dev(['lock', ...base])).toBe(2) // already holding this device
    expect(await dev(['unlock'])).toBe(0)
  })

  it('a second lock with --wait 0 is busy (75); a stale env token does not block a new lock', async () => {
    expect(await dev(['lock', ...base])).toBe(0)
    const first = out[0]
    expect(await dev(['lock', ...base, '--wait', '0'])).toBe(75)
    expect(await dev(['unlock', '--lease', first])).toBe(0)
    process.env.BRIGHTTEST_LEASE = first // now stale: holds nothing
    out.length = 0
    expect(await dev(['lock', ...base, '--wait', '0'])).toBe(0)
    expect(out[0]).toMatch(/^[0-9a-f]{24}$/)
    expect(out[0]).not.toBe(first)
  })

  it('with --lease on an expired session is 77, never a silent unlocked run', async () => {
    expect(await dev(['lock', ...base, '--idle', '1ms', '--max', '60s'])).toBe(0)
    const tok = out[0]
    await new Promise((r) => setTimeout(r, 15))
    expect(await dev(['with', ...base, '--wait', '0', '--lease', tok, '--', process.execPath, '-e', '0'])).toBe(77)
  })

  it('unlock without a token is a usage error (2); on a command lease it is refused (2)', async () => {
    expect(await dev(['unlock'])).toBe(2)
    expect(await dev(['renew'])).toBe(2)
  })

  it('status shows a session lock without a pid', async () => {
    expect(await dev(['lock', ...base])).toBe(0)
    out.length = 0
    expect(await dev(['status'])).toBe(0)
    const text = out.join('\n')
    expect(text).toMatch(/mode session/)
    expect(text).toMatch(/session, no owner process/)
    expect(text).toMatch(/idle expiry/)
    expect(text).not.toMatch(/pid null/)
  })
})
