import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import lease from '../lib/device-lease.js'

const {
  acquire, createStore, parseDuration, formatDuration, redactArgv, stripHostPasswords, keyFromAddress,
  normalizeKey, exitCodeFor, LeaseError, formatWaitLine, hashSerial,
} = lease

// Test seams: a temp lease dir, a fake clock that `sleep` advances, injected liveness and identity.
let dir, clock, liveSet, starts
const KEY = '127.0.0.1'
const ident = { worktree: '/tmp/wt-a', branch: 'feat/x' }

function seams(extra = {}) {
  return {
    dir, env: {}, timers: false, identity: ident, hostname: 'this-host',
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms },
    isAlive: (pid) => liveSet.has(pid),
    pidStart: (pid) => starts.get(pid) || null,
    random: () => 0.5,
    ...extra,
  }
}
const opts = (extra = {}) => ({ key: KEY, pid: 1001, pidStartValue: 'start-1001', waitMs: 60000, ...seams(extra), ...extra })
const events = () => createStore({ dir }).readEvents({ key: KEY })
const holderFile = () => path.join(dir, KEY, 'holder.json')
const readHolder = () => JSON.parse(fs.readFileSync(holderFile(), 'utf8'))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-lease-'))
  clock = { t: Date.now() }
  liveSet = new Set([1001, 1002, 1003, 1004])
  starts = new Map([[1001, 'start-1001'], [1002, 'start-1002'], [1003, 'start-1003'], [1004, 'start-1004']])
})
afterEach(() => {
  try { fs.chmodSync(dir, 0o700) } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('durations, redaction, keys', () => {
  it('parses durations', () => {
    expect(parseDuration('90s')).toBe(90000)
    expect(parseDuration('10m')).toBe(600000)
    expect(parseDuration('1h')).toBe(3600000)
    expect(parseDuration('250')).toBe(250)
    expect(parseDuration('0')).toBe(0)
    expect(parseDuration(1500)).toBe(1500)
    expect(() => parseDuration('soon')).toThrow(LeaseError)
    expect(formatDuration(252000)).toBe('4m12s')
  })

  it('redacts passwords from argv and ip:pw hosts', () => {
    const r = redactArgv(['e2e', 'run', '--password', 'hunter2', '--host', '10.0.0.5:S3CRET,10.0.0.6', '--pass=abc'])
    expect(r).not.toMatch(/hunter2|S3CRET|abc/)
    expect(r).toContain('--host 10.0.0.5,10.0.0.6')
    expect(redactArgv(['--host=1.2.3.4:pw123'])).toBe('--host=1.2.3.4')
    expect(redactArgv(['echo', 'xSECRETx'], ['SECRET'])).toBe('echo x***x')
    expect(stripHostPasswords('::1')).toBe('::1')
    expect(redactArgv(['device', 'with', '--host', '1.2.3.4:pw', '--', '/usr/bin/curl', '-u', 'me:hunter2'])).toBe('device with --host 1.2.3.4 -- curl …')
  })

  it('normalizes keys: resolved IP, IPv6 safe, port only when not 8060', async () => {
    expect(keyFromAddress('192.168.1.50')).toBe('192.168.1.50')
    expect(keyFromAddress('192.168.1.50', 8060)).toBe('192.168.1.50')
    expect(keyFromAddress('127.0.0.1', 18060)).toBe('127.0.0.1_p18060')
    expect(keyFromAddress('FE80::1')).toBe('fe80__1')
    const lookup = async (h) => ({ address: h === 'roku.local' ? '192.168.1.50' : h })
    expect(await normalizeKey('roku.local', { lookup })).toBe('192.168.1.50')
    expect(await normalizeKey('192.168.1.50:pw', { lookup })).toBe('192.168.1.50')
    expect(await normalizeKey('nope.invalid', { lookup: async () => { throw new Error('ENOTFOUND') } })).toBe('nope.invalid')
  })

  it('I4: warns when the key falls back to an unresolved hostname, not for IPs or resolved names', async () => {
    const calls = []
    const fail = async () => { throw new Error('ENOTFOUND') }
    await normalizeKey('roku.local', { lookup: fail, onFallback: (h) => calls.push(h) })
    await normalizeKey('10.0.0.9', { lookup: fail, onFallback: (h) => calls.push(h) })
    await normalizeKey('roku.local', { lookup: async () => ({ address: '10.0.0.9' }), onFallback: (h) => calls.push(h) })
    expect(calls).toEqual(['roku.local'])
    const warns = []
    const l = await acquire({ ...seams(), host: 'roku.local', lookup: fail, onWarn: (m) => warns.push(m), pid: 1001, pidStartValue: 'start-1001', waitMs: 0 })
    expect(l.key).toBe('roku.local')
    expect(warns[0]).toMatch(/could not resolve "roku\.local".*different lease key/)
    l.release()
  })

  it('writes events.log notes for a DNS fallback and for a non-default ECP port', async () => {
    const fail = async () => { throw new Error('ENOTFOUND') }
    const l = await acquire({ ...seams(), host: 'roku.local', lookup: fail, onWarn: () => {}, pid: 1001, pidStartValue: 'start-1001', waitMs: 0 })
    const ev = createStore({ dir }).readEvents({ key: 'roku.local' }).filter((e) => e.ev === 'note')
    expect(ev.map((e) => e.note).join('|')).toMatch(/key fallback.*roku\.local/)
    l.release()
    const warns = []
    const p = await acquire({ ...seams(), host: '10.0.0.9', port: 9060, lookup: async () => ({ address: '10.0.0.9' }), onWarn: (m) => warns.push(m), pid: 1001, pidStartValue: 'start-1001', waitMs: 0 })
    const ev2 = createStore({ dir }).readEvents({ key: p.key }).filter((e) => e.ev === 'note')
    expect(p.key).toBe('10.0.0.9_p9060')
    expect(ev2[0].note).toMatch(/ECP port.*9060.*not the default 8060/i)
    expect(warns).toEqual([]) // events.log only, no stderr warning
    p.release()
    // the default port, or an explicit key, writes no note
    const d = await acquire({ ...seams(), host: '10.0.0.8', port: 8060, lookup: async () => ({ address: '10.0.0.8' }), pid: 1001, pidStartValue: 'start-1001', waitMs: 0 })
    expect(createStore({ dir }).readEvents({ key: d.key }).filter((e) => e.ev === 'note')).toEqual([])
    d.release()
  })

  it('rejects a --max beyond the timer limit (about 24.8 days) with a clear error', () => {
    expect(lease.resolveSettings({ flags: { max: '590h' } }).maxHoldMs).toBe(590 * 3600000)
    expect(() => lease.resolveSettings({ flags: { max: '600h' } })).toThrow(/--max.*24\.8 days/)
    expect(() => lease.resolveSettings({ flags: { max: '1000h' } })).toThrow(LeaseError)
    expect(() => lease.resolveSettings({ cfg: { deviceLease: { maxHold: '9999h' } } })).toThrow(/max/)
  })

  it('a start-time mismatch is re-read without the cache before the holder is called a reused PID', async () => {
    liveSet.add(1001); starts.set(1001, 'start-1001')
    const a = await acquire(opts())
    const reads = []
    // The cached read is stale (an old value); the live read is right.
    const store = createStore({ dir, ...seams({ pidStart: (pid, o) => { reads.push(!!(o && o.fresh)); return o && o.fresh ? 'start-1001' : 'stale-value' } }) })
    expect(store.staleReason(store.readHolder(KEY))).toBeNull()
    expect(reads).toEqual([false, true])
    // A genuine mismatch (the live read differs too) is still reuse.
    const store2 = createStore({ dir, ...seams({ pidStart: () => 'someone-else' }) })
    expect(store2.staleReason(store2.readHolder(KEY))).toBe('pid-reuse')
    a.release()
  })

  it('hashes serials and maps errors to exit codes', () => {
    expect(hashSerial('X01234567890')).toMatch(/^[0-9a-f]{12}$/)
    expect(hashSerial(null)).toBeNull()
    expect(exitCodeFor(new LeaseError('BUSY', ''))).toBe(75)
    expect(exitCodeFor(new LeaseError('TIMEOUT', ''))).toBe(75)
    expect(exitCodeFor(new LeaseError('LEASE_LOST', ''))).toBe(77)
    expect(exitCodeFor(new LeaseError('IO', ''))).toBe(78)
  })
})

describe('acquire / release', () => {
  it('writes the v1 schema with holder identity and no raw serial', async () => {
    const l = await acquire(opts({ host: '127.0.0.1', agent: 'dev#1', purpose: 'LSE-T1 check', serial: 'X01234567890', command: ['e2e', 'run', '--password', 'pw9'] }))
    const h = readHolder()
    expect(h).toMatchObject({ schema: 'brighttest-lease/v1', leaseId: l.leaseId, mode: 'command' })
    expect(h.leaseId).toMatch(/^[0-9a-f]{24}$/)
    expect(h.holder).toMatchObject({ agent: 'dev#1', purpose: 'LSE-T1 check', pid: 1001, worktree: '/tmp/wt-a', branch: 'feat/x', childPids: [] })
    expect(Date.parse(h.deadline) - Date.parse(h.acquiredAt)).toBe(60 * 60000)
    expect(JSON.stringify(h)).not.toContain('X01234567890')
    expect(JSON.stringify(h)).not.toContain('pw9')
    if (process.platform !== 'win32') expect(fs.statSync(holderFile()).mode & 0o777).toBe(0o600)
    expect(l.release()).toBe(true)
    expect(fs.existsSync(holderFile())).toBe(false)
    expect(l.release()).toBe(false) // idempotent
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'released'])
  })

  it('records hostname, mode, queuedAhead on acquired and the exit code on released', async () => {
    const a = await acquire(opts({ agent: 'a' }))
    let b = null
    const pb = acquire(opts({ pid: 1002, pidStartValue: 'start-1002', agent: 'b', sleep: async (ms) => { clock.t += ms; if (clock.t > clock.release && a) a.release('done', { exitCode: 7 }) } }))
      .then((l) => { b = l })
    clock.release = clock.t + 3000
    await pb
    b.release()
    const ev = events()
    expect(ev[0]).toMatchObject({ ev: 'acquired', hostname: 'this-host', mode: 'command', queuedAhead: 0 })
    expect(ev.find((e) => e.ev === 'queued')).toMatchObject({ hostname: 'this-host', mode: 'command', queuedAhead: 0 })
    const rel = ev.filter((e) => e.ev === 'released')
    expect(rel[0]).toMatchObject({ reason: 'done', exitCode: 7 })
    expect(rel[1]).not.toHaveProperty('exitCode') // no code given: the field is absent
  })

  it('three acquirers: the second waiter records queuedAhead 1', async () => {
    const a = await acquire(opts({ agent: 'a' }))
    const nap = async (ms) => { clock.t += ms; await new Promise((r) => setTimeout(r, 2)) }
    const evs = () => events().filter((e) => e.ev === 'queued')
    const until = async (n) => { const end = Date.now() + 5000; while (evs().length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 5)) }
    let b = null; let c = null
    const pb = acquire(opts({ pid: 1002, pidStartValue: 'start-1002', agent: 'b', sleep: nap })).then((l) => { b = l })
    await until(1)
    clock.t += 50
    const pc = acquire(opts({ pid: 1003, pidStartValue: 'start-1003', agent: 'c', sleep: nap })).then((l) => { c = l })
    await until(2)
    a.release()
    await pb
    b.release()
    await pc
    c.release()
    const q = events().filter((e) => e.ev === 'queued')
    expect(q.map((e) => [e.agent, e.queuedAhead])).toEqual([['b', 0], ['c', 1]])
    const acq = events().filter((e) => e.ev === 'acquired')
    expect(acq.map((e) => [e.agent, e.queuedAhead])).toEqual([['a', 0], ['b', 0], ['c', 1]])
  })

  it('F1: two acquirers on a free device — one links, the other queues then gets it', async () => {
    const a = await acquire(opts({ agent: 'a' }))
    let b = null
    const pb = acquire(opts({ pid: 1002, pidStartValue: 'start-1002', agent: 'b', sleep: async (ms) => { clock.t += ms; if (clock.t > clock.release && a) a.release() } }))
      .then((l) => { b = l })
    clock.release = clock.t + 3000
    await pb
    expect(b.leaseId).not.toBe(a.leaseId)
    expect(readHolder().holder.agent).toBe('b')
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'queued', 'released', 'acquired'])
    b.release()
  })

  it('--wait 0 fails BUSY when held or anyone is queued (no barging)', async () => {
    const a = await acquire(opts())
    await expect(acquire(opts({ pid: 1002, waitMs: 0 }))).rejects.toMatchObject({ code: 'BUSY' })
    a.release()
    // a live ticket ahead also blocks a non-waiting acquire
    const q = path.join(dir, KEY, 'queue', `${String(clock.t).padStart(15, '0')}-aaaaaaaaaaaaaaaaaaaaaaaa.json`)
    fs.writeFileSync(q, JSON.stringify({ leaseId: 'aaaaaaaaaaaaaaaaaaaaaaaa', pid: 1003, hostname: 'this-host', waitUntil: new Date(clock.t + 60000).toISOString() }))
    await expect(acquire(opts({ pid: 1002, waitMs: 0 }))).rejects.toMatchObject({ code: 'BUSY' })
    fs.unlinkSync(q)
    const c = await acquire(opts({ pid: 1002, waitMs: 0 }))
    c.release()
  })

  it('times out after waitMs with a timeout event and removes its ticket', async () => {
    const a = await acquire(opts())
    await expect(acquire(opts({ pid: 1002, waitMs: 2000 }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(fs.readdirSync(path.join(dir, KEY, 'queue'))).toEqual([])
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'queued', 'timeout'])
    a.release()
  })

  it('serves waiters FIFO: only the head ticket may acquire', async () => {
    const a = await acquire(opts({ agent: 'a' }))
    const order = []
    const sleepy = async (ms) => { clock.t += ms; await new Promise((r) => setImmediate(r)) }
    const queueLen = () => fs.readdirSync(path.join(dir, KEY, 'queue')).filter((n) => n.endsWith('.json')).length
    const ws = []
    // Enqueue strictly one after the other: wait until each ticket is visible before starting the next waiter,
    // so the expected order does not depend on scheduling or timing.
    for (const [i, pid] of [[1, 1002], [2, 1003], [3, 1004]]) {
      ws.push(acquire(opts({ pid, pidStartValue: `start-${pid}`, agent: `w${i}`, sleep: sleepy })).then((l) => { order.push(`w${i}`); l.release() }))
      while (queueLen() < i) await new Promise((r) => setImmediate(r))
      clock.t += 5 // distinct ticket timestamps
    }
    a.release()
    await Promise.all(ws)
    expect(order).toEqual(['w1', 'w2', 'w3'])
  })

  it('emits a wait snapshot and formats a waiting line without secrets', async () => {
    const a = await acquire(opts({ agent: 'device-qa#1', purpose: 'e2e run flows/home.e2e.yaml', secrets: ['S3CRET'], command: ['e2e', '--host', '1.2.3.4:S3CRET'] }))
    const snaps = []
    await expect(acquire(opts({ pid: 1002, waitMs: 1500, onWait: (s) => snaps.push(s) }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(snaps.length).toBeGreaterThan(0)
    const line = formatWaitLine(snaps[0], { waitUntil: snaps[0].waitUntil })
    expect(line).toContain('held by device-qa#1')
    expect(line).toContain('You are #2 in queue')
    expect(line).toContain('worktree /tmp/wt-a (feat/x)')
    expect(line).not.toContain('S3CRET')
    a.release()
  })
})

describe('interactive holder marker (D5)', () => {
  const rec = () => JSON.parse(fs.readFileSync(holderFile(), 'utf8'))

  it('a command holder has no interactive fields and its wait line is unchanged', async () => {
    const a = await acquire(opts({ agent: 'dev#1', purpose: 'e2e run' }))
    const h = rec().holder
    for (const k of ['kind', 'yieldAfterMs', 'idleReleaseMs', 'activityAt', 'busy']) expect(h).not.toHaveProperty(k)
    const snaps = []
    await expect(acquire(opts({ pid: 1002, waitMs: 300, onWait: (s) => snaps.push(s) }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(formatWaitLine(snaps[0])).not.toMatch(/interactive|yields to waiters/)
    expect(lease.describeInteractive(h)).toBeNull()
    a.release()
  })

  it('records kind and timings, and the wait line says it yields to waiters after its last action', async () => {
    const a = await acquire(opts({ agent: 'dev#2', purpose: 'studio :8711', kind: 'interactive', yieldAfterMs: 60000, idleReleaseMs: 300000 }))
    expect(rec().holder).toMatchObject({ kind: 'interactive', yieldAfterMs: 60000, idleReleaseMs: 300000, busy: false })
    expect(typeof rec().holder.activityAt).toBe('string')
    const snaps = []
    await expect(acquire(opts({ pid: 1002, waitMs: 300, onWait: (s) => snaps.push(s) }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(formatWaitLine(snaps[0])).toContain('interactive: yields to waiters 60s after its last action')
    a.release()
  })

  it('annotate merges fields, writes at once then throttles to 5 s, and never changes id or deadline', async () => {
    const a = await acquire(opts({ kind: 'interactive', yieldAfterMs: 60000 }))
    const before = rec()
    clock.t += 6000
    a.annotate({ busy: true, activityAt: 'x1', leaseId: 'evil', deadline: 'evil', pid: 1 })
    expect(rec().holder).toMatchObject({ busy: true, activityAt: 'x1' })
    expect(rec().holder.pid).toBe(before.holder.pid)
    expect(rec().leaseId).toBe(before.leaseId)
    expect(rec().deadline).toBe(before.deadline)
    clock.t += 1000
    a.annotate({ busy: false })
    expect(rec().holder.busy).toBe(true) // throttled: in memory only
    expect(a.record.holder.busy).toBe(false)
    a.heartbeat()
    expect(rec().holder.busy).toBe(false) // the next heartbeat writes it
    a.release()
  })
})

describe('staleness and reclaim (D8, D9)', () => {
  it('F2/F3: dead holder is reclaimed once under the mutex; a second reclaimer is a no-op', async () => {
    const a = await acquire(opts())
    liveSet.delete(1001)
    const s1 = createStore(seams())
    const observed = s1.readHolder(KEY)
    expect(s1.staleReason(observed)).toBe('dead')
    expect(s1.reclaimIfStale(KEY, observed, 'r1')).toBe(true)
    // A second reclaimer that observed the old lease: a fresh holder now owns the key → nothing is deleted.
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002' }))
    expect(s1.reclaimIfStale(KEY, observed, 'r2')).toBe(false)
    expect(readHolder().leaseId).toBe(b.leaseId)
    expect(events().filter((e) => e.ev === 'reclaimed')).toHaveLength(1)
    expect(a.release()).toBe(false) // the dead holder no longer owns it
    b.release()
  })

  it('F3: the mutex serializes reclaimers (held mutex → the other backs off)', async () => {
    await acquire(opts())
    liveSet.delete(1001)
    const s = createStore(seams())
    const observed = s.readHolder(KEY)
    fs.mkdirSync(path.join(dir, KEY, 'reclaim.lock'))
    expect(s.reclaimIfStale(KEY, observed)).toBe(false)
    expect(fs.existsSync(holderFile())).toBe(true)
    fs.rmdirSync(path.join(dir, KEY, 'reclaim.lock'))
    expect(s.reclaimIfStale(KEY, observed)).toBe(true)
  })

  it('a waiter reclaims a dead holder and acquires', async () => {
    await acquire(opts())
    liveSet.delete(1001)
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002' }))
    expect(readHolder().leaseId).toBe(b.leaseId)
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'reclaimed', 'acquired'])
    b.release()
  })

  it('a live child process keeps a dead holder alive (D8 rule 1)', async () => {
    const a = await acquire(opts())
    a.addChild(1003)
    expect(readHolder().holder.childPids).toEqual([1003])
    liveSet.delete(1001)
    const s = createStore(seams())
    expect(s.staleReason(s.readHolder(KEY))).toBeNull()
    liveSet.delete(1003)
    expect(s.staleReason(s.readHolder(KEY))).toBe('dead')
  })

  it('F4: hung holder is held until the deadline and self-expires 5 s before it', async () => {
    let expired = false
    const a = await acquire(opts({ maxHoldMs: 20000, onExpire: () => { expired = true } }))
    const s = createStore(seams())
    clock.t += 14000
    a.heartbeat()
    expect(expired).toBe(false)
    expect(s.staleReason(s.readHolder(KEY))).toBeNull()
    clock.t += 1500 // within 5 s of the deadline
    a.heartbeat()
    expect(expired).toBe(true)
    expect(fs.existsSync(holderFile())).toBe(false)
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'lost', 'released'])
  })

  it('F4: past the deadline a lease is stale even with a live PID', async () => {
    await acquire(opts({ maxHoldMs: 1000 }))
    const s = createStore(seams())
    clock.t += 1001
    expect(s.staleReason(s.readHolder(KEY))).toBe('deadline')
  })

  it('F5: PID reuse (start time differs) is stale', async () => {
    await acquire(opts())
    starts.set(1001, 'a-different-start')
    const s = createStore(seams())
    expect(s.staleReason(s.readHolder(KEY))).toBe('pid-reuse')
  })

  it('F6: a lease from another hostname is alive until its deadline', async () => {
    await acquire(opts({ maxHoldMs: 5000 }))
    liveSet.delete(1001)
    const other = createStore(seams({ hostname: 'another-host' }))
    expect(other.staleReason(other.readHolder(KEY))).toBeNull()
    clock.t += 6000
    expect(other.staleReason(other.readHolder(KEY))).toBe('deadline')
  })

  it('F7/F8: a clock jump lets another reclaim; the holder detects LOST on its heartbeat', async () => {
    let lost = null
    const a = await acquire(opts({ maxHoldMs: 10000, onLost: (r) => { lost = r } }))
    const jumped = { t: clock.t + 20000 }
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002', now: () => jumped.t }))
    a.heartbeat() // the holder's own clock has not jumped
    expect(lost).toBe('held by another lease')
    expect(a.lost).toBe(true)
    expect(readHolder().leaseId).toBe(b.leaseId)
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'reclaimed', 'acquired', 'lost'])
  })

  it('F9: lease dir deleted mid-hold → heartbeat re-asserts; if someone else took it → LOST', async () => {
    let lost = null
    const a = await acquire(opts({ onLost: (r) => { lost = r } }))
    fs.rmSync(path.join(dir, KEY), { recursive: true, force: true })
    a.heartbeat()
    expect(readHolder().leaseId).toBe(a.leaseId)
    expect(lost).toBeNull()
    fs.rmSync(path.join(dir, KEY), { recursive: true, force: true })
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002' }))
    a.heartbeat()
    expect(lost).toBe('held by another lease')
    expect(readHolder().leaseId).toBe(b.leaseId)
  })

  it('F10: an unusable lease dir throws IO (exit 78), never proceeds unlocked', async () => {
    if (process.platform === 'win32') return // chmod does not deny writes on Windows
    if (process.getuid && process.getuid() === 0) return // root ignores modes
    fs.chmodSync(dir, 0o500)
    const err = await acquire(opts()).catch((e) => e)
    expect(err).toMatchObject({ code: 'IO' })
    expect(exitCodeFor(err)).toBe(78)
    expect(err.message).toContain(dir)
    fs.chmodSync(dir, 0o700)
    const file = path.join(dir, 'afile')
    fs.writeFileSync(file, '')
    await expect(acquire(opts({ dir: file }))).rejects.toMatchObject({ code: 'IO' })
  })

  it('F10: injected disk-full on write → IO', async () => {
    const shim = { ...fs, openSync: (p, ...rest) => { if (String(p).endsWith('.tmp')) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e } return fs.openSync(p, ...rest) } }
    await expect(acquire(opts({ fs: shim }))).rejects.toMatchObject({ code: 'IO' })
  })

  it('F11: corrupt holder.json — younger than 5 s waits, older is reclaimed', async () => {
    fs.mkdirSync(path.join(dir, KEY, 'queue'), { recursive: true })
    fs.writeFileSync(holderFile(), '{"schema":')
    const s = createStore(seams())
    expect(s.staleReason(s.readHolder(KEY))).toBeNull()
    await expect(acquire(opts({ waitMs: 2000, sleep: async (ms) => { clock.t += Math.min(ms, 100) } }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    const old = (clock.t - 10000) / 1000
    fs.utimesSync(holderFile(), old, old)
    const l = await acquire(opts())
    expect(readHolder().leaseId).toBe(l.leaseId)
    expect(events().some((e) => e.ev === 'reclaimed' && e.reason === 'corrupt')).toBe(true)
  })

  it('F11: link unsupported → falls back to open(wx)', async () => {
    const shim = { ...fs, linkSync: () => { const e = new Error('nope'); e.code = 'ENOTSUP'; throw e } }
    const a = await acquire(opts({ fs: shim }))
    expect(readHolder().leaseId).toBe(a.leaseId)
    await expect(acquire(opts({ fs: shim, pid: 1002, waitMs: 0 }))).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('F16: an orphaned reclaim.lock older than 30 s is removed', async () => {
    await acquire(opts())
    liveSet.delete(1001)
    const m = path.join(dir, KEY, 'reclaim.lock')
    fs.mkdirSync(m)
    const s = createStore(seams())
    expect(s.reclaimIfStale(KEY, s.readHolder(KEY))).toBe(false) // fresh mutex: someone is reclaiming
    const old = (clock.t - 60000) / 1000
    fs.utimesSync(m, old, old)
    expect(s.reclaimIfStale(KEY, s.readHolder(KEY))).toBe(true)
    expect(fs.existsSync(m)).toBe(false)
  })

  it('F17: a session lease past its idle TTL (or cap) is stale', () => {
    const s = createStore(seams())
    fs.mkdirSync(path.join(dir, KEY), { recursive: true })
    const base = { schema: 'brighttest-lease/v1', leaseId: 'b'.repeat(24), mode: 'session', holder: { pid: null, hostname: 'this-host' } }
    fs.writeFileSync(holderFile(), JSON.stringify({ ...base, expiresAt: new Date(clock.t + 1000).toISOString(), deadline: new Date(clock.t + 9000).toISOString() }))
    expect(s.staleReason(s.readHolder(KEY))).toBeNull()
    clock.t += 1500
    expect(s.staleReason(s.readHolder(KEY))).toBe('idle')
  })

  it('dead tickets are swept after the grace; expired tickets at once', async () => {
    const s = createStore(seams())
    const q = path.join(dir, KEY, 'queue')
    fs.mkdirSync(q, { recursive: true })
    const mk = (name, t) => fs.writeFileSync(path.join(q, name), JSON.stringify(t))
    mk('000000000000001-dead.json', { leaseId: 'dead', pid: 9999, hostname: 'this-host', waitUntil: new Date(clock.t + 600000).toISOString() })
    mk('000000000000002-expired.json', { leaseId: 'expired', pid: 1002, hostname: 'this-host', waitUntil: new Date(clock.t - 1).toISOString() })
    mk('000000000000003-live.json', { leaseId: 'live', pid: 1003, hostname: 'this-host', waitUntil: new Date(clock.t + 600000).toISOString() })
    expect(s.liveTickets(KEY).map((t) => t.leaseId)).toEqual(['dead', 'live'])
    clock.t += lease.TICKET_GRACE_MS - 1000 // inside the grace: still queued
    expect(s.liveTickets(KEY).map((t) => t.leaseId)).toEqual(['dead', 'live'])
    clock.t += 2000
    expect(s.liveTickets(KEY).map((t) => t.leaseId)).toEqual(['live'])
    expect(lease.TICKET_GRACE_MS).toBe(60000) // F12 / TP-LSE-23, 42: adoption window
  })
})

describe('re-entrancy (BRIGHTTEST_LEASE)', () => {
  it('F15: a token that holds nothing is LEASE_LOST, never a silent unlocked run', async () => {
    const err = await acquire(opts({ env: { BRIGHTTEST_LEASE: '000000000000000000000000' } })).catch((e) => e)
    expect(err).toMatchObject({ code: 'LEASE_LOST' })
    expect(exitCodeFor(err)).toBe(77)
    expect(err.message).toMatch(/no longer held/)
  })

  it('a token that holds this key → a no-op re-entrant lease', async () => {
    const a = await acquire(opts())
    const n = await acquire(opts({ pid: 1002, waitMs: 0, env: { BRIGHTTEST_LEASE: a.leaseId } }))
    expect(n.reentrant).toBe(true)
    n.release()
    expect(readHolder().leaseId).toBe(a.leaseId)
    expect(events().filter((e) => e.ev === 'acquired')).toHaveLength(1)
    a.release()
  })

  it('a token for another key → normal acquire of this key', async () => {
    const a = await acquire(opts({ key: '127.0.0.2' }))
    const b = await acquire(opts({ pid: 1002, env: { BRIGHTTEST_LEASE: a.leaseId } }))
    expect(b.reentrant).toBe(false)
    expect(readHolder().leaseId).toBe(b.leaseId)
    b.release(); a.release()
  })
})

describe('status and events', () => {
  it('status lists holder, queue and stale flag per key', async () => {
    const a = await acquire(opts({ agent: 'dev#1', expectMs: 300000 }))
    const p = acquire(opts({ pid: 1002, waitMs: 1500, agent: 'dev#2' })).catch(() => null)
    await p
    const [st] = lease.status({ dir, key: KEY })
    expect(st.holder.leaseId).toBe(a.leaseId)
    expect(st.stale).toBe(false)
    expect(st.etaMs).toBeGreaterThan(0)
    expect(lease.status({ dir }).map((s) => s.key)).toEqual([KEY])
    expect(lease.readEvents({ dir, tail: 1 })[0].ev).toBe('timeout')
    a.release()
  })

  it('rotates events.log past 1 MB', async () => {
    fs.mkdirSync(path.join(dir, KEY), { recursive: true })
    fs.writeFileSync(path.join(dir, KEY, 'events.log'), 'x'.repeat(1024 * 1024 + 1))
    const a = await acquire(opts())
    a.release()
    expect(fs.existsSync(path.join(dir, KEY, 'events.log.1'))).toBe(true)
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'released'])
  })
})

describe('B1: process start time is environment independent', () => {
  const saved = { TZ: process.env.TZ, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    lease.clearPidStartCache()
  })
  const inEnv = (tz, lang, fn) => {
    process.env.TZ = tz; process.env.LANG = lang; process.env.LC_ALL = lang
    lease.clearPidStartCache()
    return fn()
  }

  it('reads the same start time under different TZ and LANG', () => {
    const a = inEnv('Asia/Tokyo', 'ja_JP.UTF-8', () => lease.pidStart(process.pid))
    const b = inEnv('America/Los_Angeles', 'de_DE.UTF-8', () => lease.pidStart(process.pid))
    if (process.platform !== 'win32') expect(a).toBeTruthy()
    expect(b).toBe(a)
  })

  it('does not reclaim a live holder seen by a waiter in a different TZ/LANG', async () => {
    const real = { dir, env: {}, timers: false, identity: ident, hostname: 'this-host' }
    const rec = inEnv('Asia/Tokyo', 'ja_JP.UTF-8', () => ({ pid: process.pid, start: lease.pidStart(process.pid) }))
    const h = await acquire({ ...real, key: KEY, pid: rec.pid, pidStartValue: rec.start, waitMs: 0 })
    const waiter = inEnv('America/Los_Angeles', 'de_DE.UTF-8', () => createStore(real))
    const cur = waiter.readHolder(KEY)
    expect(waiter.staleReason(cur)).toBeNull()
    expect(waiter.reclaimIfStale(KEY, cur, 'w')).toBe(false)
    expect(readHolder().leaseId).toBe(h.leaseId)
    h.release()
  })
})

describe('B2: force, reclaim and heartbeat do not get undone by the old holder', () => {
  it('unlock --force frees the device and the old holder goes LOST instead of re-asserting', async () => {
    let lost = null
    const a = await acquire(opts({ agent: 'a', onLost: (r) => { lost = r } }))
    const r = lease.forceRelease({ ...seams(), key: KEY, reason: 'stuck' })
    expect(r.released).toBe(true)
    expect(fs.existsSync(holderFile())).toBe(false)
    a.heartbeat()
    expect(lost).toBe('released by force or reclaim')
    expect(fs.existsSync(holderFile())).toBe(false) // not re-created
    // the device is really free for the next acquirer
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002', waitMs: 0 }))
    expect(readHolder().leaseId).toBe(b.leaseId)
    b.release()
  })

  it('a reclaim is not undone: the dead-looking holder goes LOST even after the new holder released', async () => {
    let lost = null
    const a = await acquire(opts({ onLost: (r) => { lost = r } }))
    liveSet.delete(1001)
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002', waitMs: 0 }))
    b.release() // holder.json is now missing while the lease directory is intact
    liveSet.add(1001)
    a.heartbeat()
    expect(lost).toBe('released by force or reclaim')
    expect(fs.existsSync(holderFile())).toBe(false)
  })

  it('holder.json missing alone (directory intact, no tombstone) is LOST, not re-asserted', async () => {
    let lost = null
    const a = await acquire(opts({ onLost: (r) => { lost = r } }))
    fs.unlinkSync(holderFile())
    a.heartbeat()
    expect(lost).toBe('lease file gone')
    expect(fs.existsSync(holderFile())).toBe(false)
  })

  it('holder.json missing then back (same dir.id) within the re-check is not LOST', async () => {
    let lost = null
    let calls = 0
    let saved = null
    const a = await acquire(opts({ onLost: (r) => { lost = r }, recheckSleep: () => { if (++calls === 2) fs.writeFileSync(holderFile(), JSON.stringify(saved)) } }))
    saved = readHolder()
    fs.unlinkSync(holderFile())
    a.heartbeat()
    expect(calls).toBe(2)
    expect(lost).toBe(null)
    expect(readHolder().leaseId).toBe(a.leaseId)
    a.release()
  })

  it('holder.json that stays missing (same dir.id) is LOST after the bounded re-check', async () => {
    let lost = null
    let calls = 0
    const a = await acquire(opts({ onLost: (r) => { lost = r }, recheckSleep: () => { calls++ } }))
    fs.unlinkSync(holderFile())
    a.heartbeat()
    expect(calls).toBe(5)
    expect(lost).toBe('lease file gone')
  })

  it('a changed dir.id skips the re-check and re-asserts', async () => {
    let lost = null
    let calls = 0
    const a = await acquire(opts({ onLost: (r) => { lost = r }, recheckSleep: () => { calls++ } }))
    fs.unlinkSync(holderFile())
    fs.writeFileSync(path.join(path.dirname(holderFile()), 'dir.id'), 'otherid')
    a.heartbeat()
    expect(calls).toBe(0)
    expect(lost).toBe(null)
    expect(readHolder().leaseId).toBe(a.leaseId)
    a.release()
  })

  it('heartbeat and addChild never overwrite a newer lease', async () => {
    let lost = null
    const a = await acquire(opts({ maxHoldMs: 10000, onLost: (r) => { lost = r } }))
    const jumped = { t: clock.t + 20000 }
    const b = await acquire(opts({ pid: 1002, pidStartValue: 'start-1002', now: () => jumped.t }))
    a.addChild(5555) // before a has noticed
    expect(readHolder().leaseId).toBe(b.leaseId)
    expect(readHolder().holder.childPids).toEqual([])
    a.heartbeat()
    expect(lost).toBe('held by another lease')
    expect(readHolder().leaseId).toBe(b.leaseId)
    expect(readHolder().heartbeatAt).toBe(new Date(jumped.t).toISOString())
  })
})

describe('ticket adoption, ETA and --expect (LSE-T11, TP-LSE-23)', () => {
  const q = () => path.join(dir, KEY, 'queue')
  const iso = (t) => new Date(t).toISOString()
  const writeTicket = (name, t) => {
    fs.mkdirSync(q(), { recursive: true })
    const p = path.join(q(), name)
    fs.writeFileSync(p, JSON.stringify({ hostname: 'this-host', waitUntil: iso(clock.t + 600000), queuedAt: iso(clock.t), ...t }))
    const s = clock.t / 1000
    fs.utimesSync(p, s, s)
    return p
  }
  const heldBy = async (pid, extra = {}) => acquire(opts({ pid, pidStartValue: `start-${pid}`, ...extra }))
  const logReleased = (verb, heldMs) => createStore(seams()).logEvent(KEY, { ev: 'released', leaseId: 'x', agent: 'a', purpose: `${verb} job`, verb, heldMs })

  it('adopts a dead same-agent/purpose ticket inside the 60 s window and keeps its place', async () => {
    const holder = await heldBy(1001, { agent: 'h', purpose: 'hold' })
    const dead = writeTicket('000000000000100-deadwaiter.json', { leaseId: 'deadwaiter', agent: 'qa#1', purpose: 'p1', pid: 9999, queuedAt: iso(1e8) })
    writeTicket('000000000000200-other.json', { leaseId: 'other', agent: 'qa#2', purpose: 'p2', pid: 1003 })
    clock.t += 59000 // inside the 60 s window
    let adopted
    const p = acquire(opts({ pid: 1002, pidStartValue: 'start-1002', agent: 'qa#1', purpose: 'p1', waitMs: 600000,
      sleep: async (ms) => { clock.t += ms; if (!adopted) { adopted = fs.readdirSync(q()); holder.release() } } }))
    const l = await p
    expect(adopted[0]).toMatch(/^000000000000100-[0-9a-f]+\.json$/) // the dead ticket's slot, new leaseId
    expect(adopted[0]).not.toContain('deadwaiter')
    expect(adopted).toHaveLength(2)
    expect(events().some((e) => e.ev === 'adopted' && e.agent === 'qa#1')).toBe(true)
    expect(fs.existsSync(dead)).toBe(false)
    expect(l.record.holder.agent).toBe('qa#1')
    l.release()
  })

  it('does not adopt after the window, for another agent/purpose, or from a live waiter', async () => {
    await heldBy(1001, { agent: 'h', purpose: 'hold' })
    writeTicket('000000000000100-late.json', { leaseId: 'late', agent: 'qa#1', purpose: 'p1', pid: 9999 })
    clock.t += lease.TICKET_GRACE_MS + 1
    const s = createStore(seams())
    const mk = (agent, purpose, pid) => ({ leaseId: 'new' + pid, agent, purpose, pid, hostname: 'this-host', waitUntil: iso(clock.t + 1e6) })
    expect(s.adoptTicket(KEY, mk('qa#1', 'p1', 1002))).toBeNull() // past the grace
    clock.t -= lease.TICKET_GRACE_MS + 1
    const s2 = createStore(seams())
    expect(s2.adoptTicket(KEY, mk('qa#9', 'p1', 1002))).toBeNull() // other agent
    expect(s2.adoptTicket(KEY, mk('qa#1', 'p2', 1002))).toBeNull() // other purpose
    writeTicket('000000000000300-live.json', { leaseId: 'live', agent: 'qa#3', purpose: 'p3', pid: 1003 })
    expect(s2.adoptTicket(KEY, mk('qa#3', 'p3', 1004))).toBeNull() // owner alive
    expect(s2.adoptTicket(KEY, mk('qa#1', 'p1', 1002))).toMatch(/000000000000100-new1002\.json$/)
  })

  it('only one of two adopters gets a ticket', () => {
    writeTicket('000000000000100-deadwaiter.json', { leaseId: 'deadwaiter', agent: 'qa#1', purpose: 'p1', pid: 9999 })
    const s = createStore(seams())
    const mk = (id) => ({ leaseId: id, agent: 'qa#1', purpose: 'p1', pid: 1002, hostname: 'this-host', waitUntil: iso(clock.t + 1e6) })
    expect(s.adoptTicket(KEY, mk('aaaa'))).not.toBeNull()
    expect(s.adoptTicket(KEY, mk('bbbb'))).toBeNull()
  })

  it('ETA: median heldMs of the last 10 released events with the same purpose verb', () => {
    for (const ms of [999999, 1000, 3000, 2000]) logReleased('e2e', ms) // 999999 is the 11th-oldest below
    for (let i = 0; i < 9; i++) logReleased('e2e', 2000)
    logReleased('with', 77)
    const s = createStore(seams())
    // last 10 of "e2e run": 1000,3000,2000 + nine 2000 -> drop the oldest outlier(s); median 2000
    const hold = { acquiredAt: iso(clock.t - 500), holder: { purpose: 'e2e run --suite z', verb: 'e2e' }, leaseId: 'h' }
    fs.mkdirSync(path.join(dir, KEY), { recursive: true })
    fs.writeFileSync(holderFile(), JSON.stringify({ ...hold, schema: 'brighttest-lease/v1', mode: 'command', deadline: iso(clock.t + 9e6), holder: { ...hold.holder, pid: 1001, pidStart: 'start-1001', hostname: 'this-host' } }))
    expect(s.statusOf(KEY).etaMs).toBe(1500) // median 2000 - 500 elapsed
  })

  it('ETA adds the expected hold of each ticket ahead; a waiter sees its own wait; unknown history gives null', async () => {
    for (const ms of [2000, 4000, 6000]) logReleased('e2e', ms) // median 4000
    const h = await heldBy(1001, { agent: 'h', purpose: 'e2e run', verb: 'e2e', expectMs: 10000 })
    writeTicket('000000000000100-a.json', { leaseId: 'a', agent: 'a', purpose: 'e2e run', verb: 'e2e', pid: 1003 })
    writeTicket('000000000000200-b.json', { leaseId: 'b', agent: 'b', purpose: 'mystery job', pid: 1004 })
    clock.t += 3000
    const st = createStore(seams()).statusOf(KEY)
    expect(st.queue.map((t) => t.etaMs)).toEqual([7000, 11000]) // holder remaining 7 s; + a's 4 s
    expect(st.etaMs).toBeNull() // b has no history
    h.release()
  })

  it('an overdue holder and a holder with no data get honest ETA notes; the verb is recorded and an old holder file still reads', async () => {
    const h = await heldBy(1001, { agent: 'h', purpose: 'p', verb: 'Sideload', expectMs: 2000 })
    expect(readHolder().holder.verb).toBe('sideload')
    writeTicket('000000000000100-a.json', { leaseId: 'a', agent: 'a', purpose: 'p', pid: 1003 })
    clock.t += 5000
    let st = createStore(seams()).statusOf(KEY)
    expect(st.etaMs).toBeNull()
    expect(st.etaNote).toBe('past expected hold by 3s; ETA unknown')
    expect(st.queue[0].etaNote).toBe('past expected hold by 3s; ETA unknown')
    h.release()
    // a holder file written before the verb field existed, and no --expect: no data
    const old = { acquiredAt: iso(clock.t - 500), holder: { purpose: 'old text', pid: 1001, pidStart: 'start-1001', hostname: 'this-host' }, leaseId: 'h2' }
    fs.writeFileSync(holderFile(), JSON.stringify({ ...old, schema: 'brighttest-lease/v1', mode: 'command', deadline: iso(clock.t + 9e6) }))
    st = createStore(seams()).statusOf(KEY)
    expect(st.holder.holder.purpose).toBe('old text')
    expect(st.etaMs).toBeNull()
    expect(st.etaNote).toBe('ETA unknown (no --expect)')
  })

  it('--expect: the holder expectMs drives the ETA over history, and the wait line shows it; ETA never blocks', async () => {
    for (const ms of [2000, 2000, 2000]) logReleased('with', ms)
    const h = await heldBy(1001, { agent: 'h', purpose: 'device with', verb: 'with', expectMs: 30000 })
    expect(readHolder().expectMs).toBe(30000)
    clock.t += 5000
    const waits = []
    let n = 0
    const p = acquire(opts({ pid: 1002, pidStartValue: 'start-1002', agent: 'w', purpose: 'device with', verb: 'with', waitMs: 600000,
      onWait: (snap) => waits.push(snap),
      sleep: async (ms) => { clock.t += ms; if (++n === 3) h.release() } }))
    const l = await p
    expect(Math.abs(waits[0].etaMs - 25000)).toBeLessThan(500) // fake clock moved a poll or two
    expect(formatWaitLine(waits[0])).toMatch(/You are #2 in queue; est\. wait ~2[45]s/)
    expect(l.record.holder.agent).toBe('w')
    l.release()
    // a wedged events log cannot break status
    fs.writeFileSync(path.join(dir, KEY, 'events.log'), 'not json\n')
    expect(() => createStore(seams()).statusOf(KEY)).not.toThrow()
  })

  it('--expect parses through the CLI settings (units, invalid)', () => {
    expect(lease.resolveSettings({ flags: { expect: '30s' }, env: {} }).expectMs).toBe(30000)
    expect(lease.resolveSettings({ env: {} }).expectMs).toBeNull()
    expect(() => lease.resolveSettings({ flags: { expect: 'soon' }, env: {} })).toThrow(LeaseError)
  })
})
