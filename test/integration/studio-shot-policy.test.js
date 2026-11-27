import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

// Screenshot policy against Studio's real server, the in-repo fake Roku, and a delay proxy that injects device costs
// (a slow screenshot, a mid-cost tree read, a cheap key press) in front of both the ECP and the installer port.
// A small driver replays the page's loops with the real policy functions (treepolicy.js): tree 300 ms after each read
// (not while a screenshot is in flight), screenshots when shotDecision says so, key presses in bursts.
// Costs are scaled down from a real device (screenshot 1.24 s, tree 44 ms) so the run takes seconds; idleMs is scaled too.
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const p90 = (a) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * 0.9) - 1)]

function delayProxy(target, delayFor) {
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      await sleep(delayFor(req.method, req.url))
      const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      })
      up.on('error', () => { res.writeHead(502); res.end() })
      up.end(Buffer.concat(chunks))
    })
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)))
}

describe('Studio screenshot policy under simulated device costs', () => {
  it('keeps tree and key press fast between screenshots and shoots at least once per idleMs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-shotpolicy-'))
    process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
    process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
    const policy = await import('../../lib/studio/web/src/lib/treepolicy.js')
    const { createFakeRoku } = require('../fixtures/fake-roku/server.js')
    const fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
    const ports = await fake.start()
    const SHOT_MS = 120 // scaled: generate 100 + fetch 20
    const ecpProxy = await delayProxy(ports.ecpPort, (m, u) => (u.startsWith('/query/sgnodes') ? 40 : u.startsWith('/keypress') ? 10 : 0))
    const instProxy = await delayProxy(ports.installerPort, (m, u) => (m === 'POST' ? 100 : u.includes('/pkgs/') ? 20 : 0))
    process.env.ROKU_ECP_PORT = String(ecpProxy.address().port)
    // Studio reaches the installer on port 80 of a real device; point the device handle at the proxy instead.
    const ecp = require('../../lib/e2e/ecp.js')
    const realCreate = ecp.createDevice
    ecp.createDevice = (o) => realCreate({ ...o, installerPort: instProxy.address().port })
    const studio = require('../../lib/studio/server.js')
    const rootDir = path.join(tmp, 'project')
    fs.mkdirSync(path.join(rootDir, 'flows'), { recursive: true })
    const server = await studio.start({
      host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir, flowsDir: path.join(rootDir, 'flows'),
      leaseOpts: { acquireOpts: { dir: process.env.BRIGHTTEST_LEASE_DIR, timers: false, identity: {} }, tickMs: 50 },
    })
    const base = `http://127.0.0.1:${server.address().port}`
    const cleanup = () => { try { server.close() } catch {} try { ecpProxy.close(); instProxy.close() } catch {} try { fake.stop() } catch {} ecp.createDevice = realCreate; try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
    try {
      const IDLE = 1500
      const RUN_MS = 9000
      const t0 = Date.now()
      const treeMs = [], keyMs = [], shotStarts = [], shotEnds = []
      let shotBusy = false, treeSig = '', dirtyAt = null, dirtySince = null, lastShotAt = 0
      const markDirty = () => { dirtyAt = Date.now(); dirtySince ??= dirtyAt }
      let stop = false
      let burstDue = Date.now() + 600

      const treeLoop = (async () => {
        while (!stop) {
          if (!shotBusy) {
            const s = Date.now()
            const d = await (await fetch(`${base}/api/tree`)).json()
            treeMs.push(Date.now() - s)
            const sig = policy.treeSignature(d.nodes)
            if (treeSig && sig !== treeSig) markDirty()
            treeSig = sig
          }
          await sleep(300)
        }
      })()
      const shotLoop = (async () => {
        while (!stop) {
          const d = policy.shotDecision({ now: Date.now(), lastShotAt, dirtyAt, dirtySince, idleMs: IDLE })
          if (d.take) {
            shotBusy = true
            const s = Date.now()
            shotStarts.push(s - t0)
            const r = await fetch(`${base}/api/screenshot`)
            const buf = Buffer.from(await r.arrayBuffer())
            expect(r.status, buf.toString().slice(0, 300)).toBe(200)
            expect(buf.length).toBeGreaterThan(8)
            lastShotAt = Date.now()
            shotEnds.push(lastShotAt - t0)
            if (dirtyAt != null && dirtyAt <= s) { dirtyAt = null; dirtySince = null }
            shotBusy = false
            burstDue = Math.max(burstDue, Date.now() + 200) // a user presses after the picture updated
          }
          await sleep(50)
        }
      })()
      // Key press bursts: three quick presses, then a pause. Each burst starts only when no screenshot is running.
      let bursts = 0
      while (Date.now() - t0 < RUN_MS) {
        if (Date.now() >= burstDue && !shotBusy && bursts < 3) {
          bursts++
          for (let i = 0; i < 3; i++) {
            const s = Date.now()
            await fetch(`${base}/api/keypress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'Down' }) })
            keyMs.push(Date.now() - s)
            markDirty()
            await sleep(120)
          }
          burstDue = Date.now() + 2500
        }
        await sleep(25)
      }
      stop = true
      await Promise.all([treeLoop, shotLoop])

      expect(treeMs.length).toBeGreaterThan(10)
      expect(p90(treeMs), `tree p90 ${p90(treeMs)} of ${JSON.stringify(treeMs)}`).toBeLessThan(250)
      expect(median(treeMs), `tree median of ${JSON.stringify(treeMs)}`).toBeLessThan(100)
      expect(keyMs.length).toBe(9)
      expect(p90(keyMs), `keypress p90 ${p90(keyMs)} of ${JSON.stringify(keyMs)}`).toBeLessThan(200)
      expect(median(keyMs), `keypress median of ${JSON.stringify(keyMs)}`).toBeLessThan(75)
      // At least one screenshot per idleMs: no gap between consecutive screenshots longer than idleMs plus the shot cost and a loop tick.
      expect(shotStarts.length).toBeGreaterThanOrEqual(Math.floor(RUN_MS / (IDLE + SHOT_MS + 400)))
      for (let i = 1; i < shotStarts.length; i++) expect(shotStarts[i] - shotEnds[i - 1], `gap before shot ${i}`).toBeLessThanOrEqual(IDLE + 300)
      // Each burst is followed by a screenshot well before the idle timer (settle 400 ms plus the shot).
      expect(shotStarts.length).toBeGreaterThan(bursts)
    } finally { cleanup() }
  }, 40000)
})
