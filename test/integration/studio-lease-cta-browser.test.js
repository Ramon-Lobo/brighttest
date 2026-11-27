import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Studio "Take the device back" call to action in headless Chrome (raw CDP, in-repo fake Roku, no device).
// Another lease holder takes the device from Studio. Skips with a message when no Chrome or no Studio build. BT_LEASE_SHOTS=<dir> saves screenshots.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')

if (!chrome) console.warn('studio-lease-cta-browser: skipped, no Chrome found (set CHROME_BIN)')
if (chrome && !built) console.warn('studio-lease-cta-browser: skipped, Studio is not built (npm run studio:build)')

describe.skipIf(!chrome || !built)('Studio lost-lease call to action (headless Chrome, fake Roku)', () => {
  it('shows one Take the device back button in the banner, header and held tiles; queues; clears when acquired', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-leasecta-'))
    process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
    process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
    const lease = require('../../lib/device-lease.js')
    const studio = require('../../lib/studio/server.js')
    const { createFakeRoku } = require('../fixtures/fake-roku/server.js')
    const fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
    const ports = await fake.start()
    process.env.ROKU_ECP_PORT = String(ports.ecpPort)
    const rootDir = path.join(tmp, 'project')
    fs.mkdirSync(path.join(rootDir, 'flows'), { recursive: true })
    const server = await studio.start({
      host: '127.0.0.1', password: 'fake-password', port: 0, rootDir, flowsDir: path.join(rootDir, 'flows'),
      leaseOpts: { acquireOpts: { dir: process.env.BRIGHTTEST_LEASE_DIR, timers: false, identity: {} }, tickMs: 50 },
    })
    const base = `http://localhost:${server.address().port}`
    let ws = null
    let other = null
    const procs = []
    const cleanup = () => { try { ws && ws.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } try { other && other.release && other.release() } catch {} try { server.close() } catch {} try { fake.stop() } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
    const killer = setTimeout(cleanup, 90000)
    try {
      const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=0', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' })
      procs.push(proc)
      const portFile = path.join(tmp, 'chrome', 'DevToolsActivePort')
      for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100)
      const dtPort = fs.readFileSync(portFile, 'utf8').split('\n')[0]
      let page = null
      for (let i = 0; i < 50 && !page; i++) { page = (await getJson(`http://127.0.0.1:${dtPort}/json/list`)).find((t) => t.type === 'page'); if (!page) await sleep(100) }
      ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
      let id = 0
      const waiting = new Map()
      const cdp = (method, params = {}) => new Promise((r, j) => { waiting.set(++id, { r, j }); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.method === 'Fetch.requestPaused') {
          cdp('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }).catch(() => {})
          return
        }
        if (d.id && waiting.has(d.id)) { const { r, j } = waiting.get(d.id); waiting.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result) }
      }
      const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr); return r.result.value }
      const until = async (expr, what, tries = 100) => { for (let i = 0; i < tries; i++) { if (await js(expr)) return; await sleep(100) } throw new Error(`timed out waiting for ${what}`) }
      const q = (tid) => `document.querySelector('[data-testid="${tid}"]')`
      const post = (action) => fetch(`${base}/api/lease`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      const shotDir = process.env.BT_LEASE_SHOTS
      const shot = async (name) => {
        if (!shotDir) return
        await sleep(300)
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'))
      }
      const T = (tid, x, y, w, h, state = 'open') => ({ id: tid, x, y, w, h, state })
      const layout = { v: 1, reg: 1, tiles: [T('state', 0, 0, 6, 16), T('actions', 6, 0, 6, 16), T('monitor', 0, 16, 4, 8), T('flow', 0, 0, 6, 20, 'hidden'), T('remote', 6, 11, 2, 9, 'hidden'), T('node', 8, 11, 4, 9, 'hidden'), T('tree', 0, 20, 4, 9, 'hidden'), T('selector', 4, 20, 4, 9, 'hidden'), T('network', 6, 29, 6, 8, 'hidden')] }
      await cdp('Page.enable')
      await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] })
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
      await cdp('Page.navigate', { url: base })
      await until(q('studio-header'), 'the header')
      await js(`localStorage.setItem('bt.studio.layout.inspect', ${JSON.stringify(JSON.stringify(layout))})`)
      await cdp('Page.reload')
      await until(q('studio-header'), 'Studio to reload')

      // Studio holds the device, then loses it to another session: no banner while it holds.
      await post('acquire')
      await until(`${q('lease-badge')} && ${q('lease-badge')}.textContent.includes('Studio holding')`, 'Studio holding')
      expect(await js(`!!${q('lease-bar')}`)).toBe(false)
      await post('release')
      other = await lease.acquire({ dir: process.env.BRIGHTTEST_LEASE_DIR, key: `127.0.0.1_p${ports.ecpPort}`, agent: 'e2e-run#1', purpose: 'e2e run', pid: process.pid, waitMs: 0, exitOnLost: false, timers: false, identity: {} })

      // The banner is an alert naming the holder, with the one primary button focused; the same control is in the header and the held tiles.
      await until(q('lease-bar'), 'the held banner', 100)
      expect(await js(`${q('lease-bar')}.getAttribute('role')`)).toBe('alert')
      expect(await js(`${q('lease-text')}.textContent`)).toContain('e2e-run#1 has the device (e2e run)')
      expect(await js(`${q('lease-take-over')}.textContent.trim()`)).toContain('Take the device back')
      await until(`document.activeElement === ${q('lease-take-over')}`, 'the banner button to take focus', 20)
      await until(q('lease-take-header'), 'the header button')
      expect(await js(`${q('lease-take-header')}.textContent.trim()`)).toContain('Take the device back')
      await until(`${q('state-held')} && ${q('actionlog-held')}`, 'the held notices in State and Actions')
      expect(await js(`${q('state-held')}.textContent`)).toContain('Use Take the device back above')
      expect(await js(`document.querySelectorAll('[data-testid="lease-take-inline"]').length`)).toBe(2)
      await shot('lease-held.png')

      // A click queues Studio (never preempts): the button turns into the queued state in every place.
      await js(`${q('lease-take-inline')}.click()`)
      await until(`${q('lease-queued')} && /Waiting/.test(${q('lease-queued')}.textContent)`, 'the queued label')
      expect(await js(`${q('lease-take-over')}.disabled`)).toBe(true)
      expect(await js(`${q('lease-queued')}.textContent`)).toMatch(/^Waiting/)
      await shot('lease-queued.png')

      // The holder lets go: Studio acquires and the banner clears.
      await other.release(); other = null
      await until(`!${q('lease-bar')}`, 'the banner to clear', 100)
    } finally { clearTimeout(killer); cleanup() }
  }, 120000)
})
