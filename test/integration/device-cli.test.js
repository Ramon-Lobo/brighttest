import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `brighttest device …` end to end: real processes, a temp lease dir, no device (--no-hygiene).
const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(here, '..', '..', 'bin', 'cli.js')
let dir, log

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dev-cli-')); log = path.join(dir, 'w.log') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A worker command for `device with`: logs enter/exit with a monotonic clock and whether it got a token.
const worker = (id, ms) => [process.execPath, '-e',
  `const fs=require('fs');const t=()=>process.hrtime.bigint();fs.appendFileSync(${JSON.stringify(log)},'enter ${id} '+t()+' '+(process.env.BRIGHTTEST_LEASE?'tok':'notok')+' '+process.env.ROKU_HOST+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'exit ${id} '+t()+'\\n');process.exit(Number(process.env.EXIT_CODE||0))},${ms})`]
function bt(args, env = {}) {
  const env2 = { ...process.env, BRIGHTTEST_LEASE_DIR: path.join(dir, 'leases'), BRIGHTTEST_CACHE: path.join(dir, 'devices.json'), ...env }
  delete env2.BRIGHTTEST_LEASE; delete env2.ROKU_HOST; delete env2.ROKU_PASSWORD
  Object.assign(env2, env)
  const c = spawn(process.execPath, [CLI, ...args], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
  c.done = new Promise((r) => c.on('close', (code) => r({ code, out, err })))
  return c
}
const withArgs = (id, ms, extra = []) => ['device', 'with', '--host', '127.0.0.1', '--no-hygiene', '--as', id, ...extra, '--', ...worker(id, ms)]
const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
async function waitFor(pred, ms = 10000) { const u = Date.now() + ms; while (Date.now() < u) { if (pred()) return true; await sleep(25) } return false }
function order() {
  const open = new Map(), iv = []
  for (const l of lines()) { const [k, id, ns] = l.split(' '); if (k === 'enter') open.set(id, BigInt(ns)); if (k === 'exit') iv.push({ id, en: open.get(id), ex: BigInt(ns) }) }
  iv.sort((a, b) => (a.en < b.en ? -1 : 1))
  return { ids: iv.map((x) => x.id), overlaps: iv.filter((x, i) => i > 0 && x.en < iv[i - 1].ex).length }
}
const events = () => {
  const f = path.join(dir, 'leases', '127.0.0.1', 'events.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

describe('brighttest device', () => {
  it('with: passes the child exit code through and gives it the lease env', async () => {
    const r = await bt(withArgs('a', 10), { EXIT_CODE: '3' }).done
    expect(r.code).toBe(3)
    expect(lines()[0]).toMatch(/^enter a \d+ tok 127\.0\.0\.1$/)
    expect(events().map((e) => e.ev)).toEqual(['acquired', 'released'])
  })

  it('8 concurrent `device with` never overlap and are served FIFO', async () => {
    const ps = []
    for (let i = 1; i <= 8; i++) { ps.push(bt(withArgs(`w${i}`, 100))); await sleep(60) }
    const rs = await Promise.all(ps.map((p) => p.done))
    expect(rs.map((r) => r.code)).toEqual(Array(8).fill(0))
    const o = order()
    expect(o.overlaps).toBe(0)
    const queued = events().filter((e) => e.ev === 'queued').map((e) => e.agent)
    expect(o.ids.filter((id) => queued.includes(id))).toEqual(queued)
  })

  it('wait timeout → 75 with the waiting line; --wait 0 → 75 at once', async () => {
    const h = bt(withArgs('h', 5000, ['--purpose', 'long hold']))
    expect(await waitFor(() => lines().length > 0)).toBe(true)
    const t = await bt(['device', 'with', '--host', '127.0.0.1', '--no-hygiene', '--wait', '1s', '--', 'true']).done
    expect(t.code).toBe(75)
    expect(t.err).toContain('held by h — "long hold"')
    const t0 = Date.now()
    const b = await bt(['device', 'with', '--host', '127.0.0.1', '--no-hygiene', '--wait', '0', '--', 'true']).done
    expect(b.code).toBe(75)
    expect(Date.now() - t0).toBeLessThan(3000)
    const st = await bt(['device', 'status', '--json']).done
    expect(JSON.parse(st.out)[0].holder.holder.agent).toBe('h')
    h.kill('SIGTERM'); await h.done
  })

  it('nested `device with` is re-entrant; a stale token exits 77', async () => {
    const r = await bt(['device', 'with', '--host', '127.0.0.1', '--no-hygiene', '--', process.execPath, CLI, ...withArgs('n', 10)]).done
    expect(r.code).toBe(0)
    expect(events().filter((e) => e.ev === 'acquired')).toHaveLength(1)
    const s = await bt(withArgs('s', 10), { BRIGHTTEST_LEASE: '0'.repeat(24) }).done
    expect(s.code).toBe(77)
    expect(s.err).toMatch(/no longer held/)
    expect(lines().some((l) => l.startsWith('enter s'))).toBe(false)
  })

  it('unlock --force needs a reason for a live lease, then releases it (audited)', async () => {
    const h = bt(withArgs('h', 20000))
    expect(await waitFor(() => lines().length > 0)).toBe(true)
    const no = await bt(['device', 'unlock', '--force', '--host', '127.0.0.1']).done
    expect(no.code).toBe(2)
    const yes = await bt(['device', 'unlock', '--force', '--host', '127.0.0.1', '--reason', 'test', '--kill']).done
    expect(yes.code).toBe(0)
    await h.done
    expect(events().some((e) => e.ev === 'forced' && e.reason === 'test')).toBe(true)
    const lg = await bt(['device', 'log', '--json']).done
    expect(JSON.parse(lg.out).map((e) => e.ev)).toContain('forced')
  })

  it('F9: lease dir deleted mid-hold → the holder re-asserts at once; the next caller queues (no overlap)', async () => {
    const h = bt(withArgs('h', 2500))
    expect(await waitFor(() => lines().length > 0)).toBe(true)
    await sleep(500)
    fs.rmSync(path.join(dir, 'leases', '127.0.0.1'), { recursive: true, force: true })
    await sleep(150)
    const w = bt(withArgs('w', 50))
    const [rh, rw] = await Promise.all([h.done, w.done])
    expect([rh.code, rw.code]).toEqual([0, 0])
    expect(order()).toEqual({ ids: ['h', 'w'], overlaps: 0 })
  })
})
