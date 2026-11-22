import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { vi } from 'vitest'
import lease from '../lib/device-lease.js'

const { acquire, acquirePool } = lease
const DEV = fs.readFileSync(new URL('./fixtures/active-app-dev.xml', import.meta.url), 'utf8')
const OTHER = fs.readFileSync(new URL('./fixtures/active-app-channel.xml', import.meta.url), 'utf8')

let dir, server, port, reqs, body, hang, delayMs, drip, closes
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fg-'))
  reqs = []; body = DEV; hang = false; delayMs = 0; drip = false; closes = []
  server = http.createServer((req, res) => {
    reqs.push(req.url)
    const t0 = Date.now()
    req.socket.on('close', () => closes.push(Date.now() - t0))
    if (hang) return // never answer
    if (drip) { res.write('<active-app>'); const iv = setInterval(() => res.write(' '), 100); res.on('close', () => clearInterval(iv)); return }
    if (delayMs) return void setTimeout(() => { try { res.end(body) } catch { /* closed */ } }, delayMs)
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

const DEV_ID_ONLY = '<active-app><app id="dev" type="appl" ui-location="other">X</app></active-app>'
const DEV_UI_ONLY = '<active-app><app id="999" type="appl" ui-location="dev">X</app></active-app>'
const wait = async (cond, ms = 1500) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))
let alive = true
const seam = { isAlive: () => alive, pidStart: () => null }

const go = async (extra = {}) => {
  const warns = []
  const l = await acquire({
    host: '127.0.0.1', port, dir, env: {}, timers: false, waitMs: 0, pid: 3001, serial: 'SERIAL123',
    identity: { worktree: '/tmp/wt', branch: 'b' }, hostname: 'h', ...seam, onWarn: (m) => warns.push(m), ...extra,
  })
  return { l, warns }
}

describe('foreground advisory (LSE-T15)', () => {
  beforeEach(() => { alive = true })

  it('warns once when the dev channel is in front and the lease is free', async () => {
    const { warns } = await go()
    await wait(() => warns.length > 0)
    await settle()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/dev channel in the foreground but no brighttest lease holder/)
    expect(warns[0]).not.toMatch(/SERIAL123/)
    expect(reqs).toEqual(['/query/active-app'])
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, f)
      if (fs.statSync(p).isFile() && f.endsWith('holder.json')) expect(fs.readFileSync(p, 'utf8')).not.toMatch(/foreground/)
    }
  })

  it('does not delay the acquire', async () => {
    hang = true
    const t = Date.now()
    const { warns } = await go()
    expect(Date.now() - t).toBeLessThan(500)
    await settle(1300)
    expect(warns).toEqual([])
  })

  it('stays silent for another foreground app', async () => {
    body = OTHER
    const { warns } = await go()
    await wait(() => reqs.length > 0); await settle()
    expect(reqs).toHaveLength(1)
    expect(warns).toEqual([])
  })

  it('warns for id=dev alone and for ui-location=dev alone', async () => {
    for (const xml of [DEV_ID_ONLY, DEV_UI_ONLY]) {
      body = xml
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
      const { warns } = await go()
      await wait(() => warns.length > 0)
      expect(warns).toHaveLength(1)
    }
  })

  it('stays silent on HTTP 500 with a dev body', async () => {
    server.removeAllListeners('request')
    server.on('request', (req, res) => { reqs.push(req.url); res.statusCode = 500; res.end(DEV) })
    const { warns } = await go()
    await wait(() => reqs.length > 0); await settle()
    expect(warns).toEqual([])
  })

  it('stays silent on an oversize response', async () => {
    body = DEV + ' '.repeat(70 * 1024)
    const { warns } = await go()
    await wait(() => reqs.length > 0); await settle(300)
    expect(warns).toEqual([])
  })

  it('stays silent on an unreachable host', async () => {
    const dead = port
    await new Promise((r) => server.close(r))
    server = http.createServer()
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const { warns } = await go({ port: dead })
    await settle()
    expect(warns).toEqual([])
  })

  it('makes no ECP call when another holder has the device', async () => {
    await go({ foregroundCheck: false })
    await expect(go({ pid: 3002 })).rejects.toMatchObject({ code: 'BUSY' })
    expect(reqs).toEqual([])
  })

  it('makes no ECP call when the acquire waited in the queue', async () => {
    await go({ foregroundCheck: false })
    setTimeout(() => { alive = false }, 200) // the holder dies: the waiter reclaims
    // Hide the event log from the advisory, so the queued flag is the only possible reason for the skip.
    const store = lease.createStore({ dir, env: {}, ...seam, hostname: 'h' })
    store.readEvents = () => []
    const { l, warns } = await go({ pid: 3002, waitMs: 5000, pollMs: 50, settleMs: 0, store })
    expect(fs.readFileSync(path.join(dir, '127.0.0.1_p' + port, 'events.log'), 'utf8')).toMatch(/"queued":true/)
    await settle(300)
    expect(reqs).toEqual([])
    expect(warns).toEqual([])
    l.release()
  })

  it('makes no ECP call when opted out by env', async () => {
    const { warns } = await go({ env: { BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK: '1' } })
    await settle()
    expect(warns).toEqual([])
    expect(reqs).toEqual([])
  })

  it('makes no ECP call with foregroundCheck false or onWarn null', async () => {
    await (await go({ foregroundCheck: false })).l.release()
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
    await (await go({ onWarn: null })).l.release()
    await settle()
    expect(reqs).toEqual([])
  })

  it('is silent right after a release on the key (any holder), warns on a key with no recent release', async () => {
    const a = await go({ foregroundCheck: false })
    a.l.release()
    const c = await go({ pid: 3003 })
    await settle()
    expect(c.warns).toEqual([])
    expect(reqs).toEqual([])
    c.l.release()
    // an old release (past 10 min) no longer suppresses
    const f = path.join(dir, '127.0.0.1_p' + port, 'events.log')
    const old = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((x) => {
      const e = JSON.parse(x); if (e.ev === 'released') e.t = new Date(Date.now() - 11 * 60000).toISOString(); return JSON.stringify(e)
    })
    fs.writeFileSync(f, old.join('\n') + '\n')
    const d = await go({ pid: 3004 })
    await wait(() => d.warns.length > 0)
    expect(d.warns).toHaveLength(1)
  })

  for (const [label, hangs] of [['hanging', true], ['fast', false]]) {
    for (const delay of [0, 20]) {
      it(`leaves nothing behind when SIGINT arrives ${delay} ms after holder.json appears (${label} fake)`, async () => {
        hang = hangs
        const lz = path.join(dir, 'lz')
        const script = path.join(dir, 'child.cjs')
        fs.writeFileSync(script, `
          process.on('SIGINT', () => process.exit(130)); // exits normally, so only the lease's own exit hook can clean up
          const lease = require(${JSON.stringify(path.resolve('lib/device-lease.js'))});
          lease.acquire({ host: '127.0.0.1', port: ${port}, dir: ${JSON.stringify(lz)}, env: {}, waitMs: 0, onWarn: () => {} })
            .then(() => setInterval(() => {}, 1000));
        `)
        const child = spawn(process.execPath, [script], { stdio: 'ignore' })
        const exited = new Promise((r) => child.on('exit', r))
        const holderAt = () => { try { return fs.readdirSync(lz, { recursive: true }).some((f) => f.endsWith('holder.json')) } catch { return false } }
        const end = Date.now() + 5000
        while (!holderAt() && Date.now() < end) await new Promise((r) => setImmediate(r))
        expect(holderAt()).toBe(true)
        if (delay) await settle(delay)
        child.kill('SIGINT')
        await Promise.race([exited, settle(5000)])
        expect(holderAt()).toBe(false)
      })
    }
  }

  it('never requests the pool gate host; the chosen member gets one request and one warning', async () => {
    const spy = vi.spyOn(http, 'get')
    try {
      const warns = []
      const l = await acquirePool({
        hosts: ['127.0.0.1'], port, dir, env: {}, timers: false, waitMs: 3000, pollMs: 20, pid: 3001,
        identity: { worktree: '/tmp/wt', branch: 'b' }, hostname: 'h', ...seam, onWarn: (m) => warns.push(m),
      })
      await wait(() => warns.length > 0); await settle()
      expect(spy.mock.calls.map((c) => c[0].host)).toEqual(['127.0.0.1'])
      expect(reqs).toHaveLength(1)
      expect(warns).toHaveLength(1)
      l.release()
    } finally { spy.mockRestore() }
  })

  it('prints nothing for a late response once the lease is no longer ours', async () => {
    delayMs = 300
    const { warns } = await go()
    fs.rmSync(path.join(dir, '127.0.0.1_p' + port, 'holder.json')) // reclaimed by someone else
    await wait(() => reqs.length > 0)
    await settle(600)
    expect(reqs).toHaveLength(1)
    expect(warns).toEqual([])
  })

  for (const [label, set] of [['hanging', () => { hang = true }], ['slow-drip', () => { drip = true }]]) {
    it(`the 1 s timeout closes a ${label} request`, async () => {
      set()
      await go()
      await wait(() => closes.length > 0, 3000)
      expect(closes).toHaveLength(1)
      expect(closes[0]).toBeGreaterThan(800)
      expect(closes[0]).toBeLessThan(1700)
    })
  }

  it('release cancels the in-flight request (fake sees the close at once)', async () => {
    hang = true
    const { l } = await go()
    await wait(() => reqs.length > 0)
    l.release()
    await wait(() => closes.length > 0, 600)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toBeLessThan(400)
  })

  for (const [label, host, useFake] of [['a never-answering fake', '127.0.0.1', true], ['a blackhole address', '10.255.255.1', false]]) {
    it(`a script that acquires and releases exits fast against ${label}`, async () => {
      hang = true
      const script = path.join(dir, 'exit.cjs')
      fs.writeFileSync(script, `
        const lease = require(${JSON.stringify(path.resolve('lib/device-lease.js'))});
        lease.acquire({ host: ${JSON.stringify(host)}, port: ${useFake ? port : 8060}, dir: ${JSON.stringify(path.join(dir, 'lx'))}, env: {}, waitMs: 0, timers: false, onWarn: () => {} })
          .then((l) => l.release());
      `)
      const t = Date.now()
      const child = spawn(process.execPath, [script], { stdio: 'ignore' })
      await new Promise((r) => child.on('exit', r))
      expect(Date.now() - t).toBeLessThan(900)
    })
  }

  it('the advisory sockets are unref\'d: a script that never releases still exits fast', async () => {
    hang = true
    const script = path.join(dir, 'noRelease.cjs')
    fs.writeFileSync(script, `
      const lease = require(${JSON.stringify(path.resolve('lib/device-lease.js'))});
      lease.acquire({ host: '127.0.0.1', port: ${port}, dir: ${JSON.stringify(path.join(dir, 'ln'))}, env: {}, waitMs: 0, timers: false, onWarn: () => {} });
    `)
    const t = Date.now()
    const child = spawn(process.execPath, [script], { stdio: 'ignore' })
    await new Promise((r) => child.on('exit', r))
    expect(reqs).toEqual(['/query/active-app']) // the request did go out
    expect(Date.now() - t).toBeLessThan(900)
  })

  it('suppresses for reclaimed, forced and lost events, and ignores a literal null line', async () => {
    for (const ev of ['reclaimed', 'forced', 'lost']) {
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
      const kd = path.join(dir, '127.0.0.1_p' + port)
      fs.mkdirSync(kd, { recursive: true })
      fs.writeFileSync(path.join(kd, 'events.log'), JSON.stringify({ t: new Date().toISOString(), key: 'k', ev }) + '\n')
      const { warns } = await go()
      await settle()
      expect(warns).toEqual([])
      expect(reqs).toEqual([])
    }
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
    const kd = path.join(dir, '127.0.0.1_p' + port)
    fs.mkdirSync(kd, { recursive: true })
    fs.writeFileSync(path.join(kd, 'events.log'), 'null\n')
    const { warns } = await go()
    await wait(() => warns.length > 0)
    expect(warns).toHaveLength(1)
  })
})
