import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// TP-LSE-27 (a)-(e), headless: `device with --device any` on two fake hosts (127.0.0.1 and 127.0.0.2, never
// contacted: --no-hygiene) in a temp lease dir. The worker logs enter/exit with the ROKU_HOST the child got.
const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, '..', '..', 'bin', 'cli.js')
const A = '127.0.0.1'
const B = '127.0.0.2'
let dir, proj, logFile, children
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pool-int-'))
  proj = path.join(dir, 'proj'); fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, 'brighttest.json'), JSON.stringify({ deviceLease: { pool: [A, B] } }))
  fs.writeFileSync(path.join(dir, 'worker.js'), `const fs=require('fs');const [id,log,ms='120']=process.argv.slice(2);
const t=()=>process.hrtime.bigint()+' '+Date.now();
fs.appendFileSync(log,'enter '+id+' '+t()+' '+(process.env.BRIGHTTEST_LEASE?'tok':'notok')+' '+(process.env.ROKU_HOST||'-')+'\\n');
setTimeout(()=>{fs.appendFileSync(log,'exit '+id+' '+t()+'\\n');process.exit(0)},Number(ms));`)
  logFile = path.join(dir, 'log'); children = []
})
afterEach(() => { for (const c of children) try { c.kill('SIGKILL') } catch {} fs.rmSync(dir, { recursive: true, force: true }) })

function bt(args, ms, id) {
  const c = spawn(process.execPath, [CLI, 'device', 'with', '--no-hygiene', '--as', id, ...args, '--', process.execPath, path.join(dir, 'worker.js'), id, logFile, String(ms)], {
    cwd: proj, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BRIGHTTEST_LEASE_DIR: path.join(dir, 'leases'), BRIGHTTEST_CACHE: path.join(dir, 'cache.json'), BRIGHTTEST_LEASE: '', ROKU_HOST: '', ROKU_PASSWORD: '' },
  })
  c.err = ''; c.stderr.on('data', (d) => { c.err += d })
  c.done = new Promise((r) => c.on('close', (code) => r(code)))
  children.push(c)
  return c
}
const any = (id, ms, extra = []) => bt(['--device', 'any', ...extra], ms, id)
const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
const rec = (kind, id) => { const l = lines().find((x) => x.startsWith(`${kind} ${id} `)); return l ? l.split(' ') : null }
const hostOf = (id) => (rec('enter', id) || [])[5]
const tokOf = (id) => (rec('enter', id) || [])[4]
const enterMs = (id) => Number(rec('enter', id)[3])
const exitMs = (id) => Number(rec('exit', id)[3])
async function waitFor(pred, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (pred()) return true; await sleep(25) }
  return false
}
const entered = (id) => () => !!rec('enter', id)
function gateAcquired() { // the pool gate's events.log: how many 'acquired' so far
  const d = path.join(dir, 'leases')
  const g = fs.existsSync(d) ? fs.readdirSync(d).find((n) => n.startsWith('pool-')) : null
  const f = g && path.join(d, g, 'events.log')
  return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"acquired"')).length : 0
}

describe('TP-LSE-27 device pool of two (headless)', () => {
  it('(a) both free: two parallel runs land on different keys and overlap in time', async () => {
    const p1 = any('p1', 1500); const p2 = any('p2', 1500)
    expect(await waitFor(() => rec('enter', 'p1') && rec('enter', 'p2'))).toBe(true)
    expect(new Set([hostOf('p1'), hostOf('p2')])).toEqual(new Set([A, B]))
    expect(tokOf('p1')).toBe('tok')
    expect(await Promise.all([p1.done, p2.done])).toEqual([0, 0])
    expect(enterMs('p1') < exitMs('p2') && enterMs('p2') < exitMs('p1')).toBe(true)
  }, 30000)

  it('(a) --wait 0 with free devices does not fail on the pool gate (two concurrent runs)', async () => {
    const p1 = any('p1', 3000, ['--wait', '0']); const p2 = any('p2', 3000, ['--wait', '0'])
    expect(await Promise.all([p1.done, p2.done])).toEqual([0, 0])
    expect(new Set([hostOf('p1'), hostOf('p2')])).toEqual(new Set([A, B]))
  }, 30000)

  it('(b) .1 held: --device any picks .2 at once', async () => {
    bt(['--host', A], 4000, 'h1')
    expect(await waitFor(entered('h1'))).toBe(true)
    const t = Date.now()
    const c = any('b', 200)
    expect(await waitFor(entered('b'))).toBe(true)
    expect(hostOf('b')).toBe(B)
    expect(enterMs('b') - t).toBeLessThan(3000)
    await c.done
  }, 30000)

  it('(c) both held: waits and takes the device that frees first (.2)', async () => {
    bt(['--host', A], 4000, 'h1')
    expect(await waitFor(entered('h1'))).toBe(true)
    bt(['--host', B], 1000, 'h2')
    expect(await waitFor(entered('h2'))).toBe(true)
    const c = any('c', 200, ['--wait', '10s'])
    expect(await waitFor(entered('c'))).toBe(true)
    expect(hostOf('c')).toBe(B)
    expect(enterMs('c') >= exitMs('h2')).toBe(true)
    expect(await c.done).toBe(0)
  }, 30000)

  it('(d) explicit host wins: queues for .1 while .2 is free', async () => {
    bt(['--host', A], 2000, 'h1')
    expect(await waitFor(entered('h1'))).toBe(true)
    const c = bt(['--host', A, '--device', 'any', '--wait', '10s'], 200, 'd')
    expect(await waitFor(entered('d'))).toBe(true)
    expect(hostOf('d')).toBe(A)
    expect(enterMs('d') >= exitMs('h1')).toBe(true)
    expect(await c.done).toBe(0)
  }, 30000)

  it('(e) FIFO across the pool: f1 gets the first freed device, f2 the next', async () => {
    bt(['--host', A], 2000, 'h1')
    bt(['--host', B], 4000, 'h2')
    expect(await waitFor(() => rec('enter', 'h1') && rec('enter', 'h2'))).toBe(true)
    const f1 = any('f1', 6000, ['--wait', '30s'])
    expect(await waitFor(() => gateAcquired() >= 1)).toBe(true)
    await sleep(50)
    const f2 = any('f2', 200, ['--wait', '30s'])
    expect(await Promise.all([f1.done, f2.done])).toEqual([0, 0])
    expect(hostOf('f1')).toBe(A) // h1 frees first
    expect(hostOf('f2')).toBe(B)
    expect(enterMs('f1')).toBeLessThan(enterMs('f2'))
  }, 40000)

  it('no pool configured: exit 2 with a clear message and no lease taken', async () => {
    fs.writeFileSync(path.join(proj, 'brighttest.json'), '{}')
    const c = any('n', 100)
    expect(await c.done).toBe(2)
    expect(c.err).toMatch(/needs a device pool/)
    expect(fs.existsSync(path.join(dir, 'leases'))).toBe(false)
  }, 20000)
})
