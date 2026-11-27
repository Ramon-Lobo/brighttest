import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Direct links in the Studio shell (headless Chrome, raw CDP): #/builds opens the Builds page, other page ids work, the
// hash follows the nav, and a hash change while open switches page. Fake Roku, no device. Skips when no Chrome or no
// Studio build. BT_ROUTE_SHOTS=<dir> saves screenshots.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')

describe.skipIf(!chrome || !built)('Studio direct links (headless Chrome)', () => {
  it('opens the Builds page from #/builds and keeps the hash in step with the nav', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-route-ui-'))
    const saved = { ecp: process.env.ROKU_ECP_PORT, lease: process.env.BRIGHTTEST_LEASE_DIR, cache: process.env.BRIGHTTEST_CACHE, tok: process.env.BRIGHTTEST_HUB_TOKEN }
    process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
    process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
    process.env.BRIGHTTEST_HUB_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const studio = require('../../lib/studio/server.js')
    const { createFakeRoku } = require('../fixtures/fake-roku/server.js')
    const fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
    const ports = await fake.start()
    process.env.ROKU_ECP_PORT = String(ports.ecpPort)
    const rootDir = path.join(tmp, 'project')
    fs.mkdirSync(path.join(rootDir, 'flows'), { recursive: true })
    const server = await studio.start({
      host: '127.0.0.1', password: 'fake-password', port: 0, rootDir, flowsDir: path.join(rootDir, 'flows'),
      cfg: { builds: { dir: path.join(tmp, 'store'), maxZipMB: 1 } },
      leaseOpts: { acquireOpts: { dir: process.env.BRIGHTTEST_LEASE_DIR, timers: false, identity: {} }, tickMs: 50 },
    })
    const base = `http://localhost:${server.address().port}`
    let ws = null
    const procs = []
    const cleanup = () => {
      try { ws && ws.close() } catch {}
      for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
      try { server.close() } catch {}
      try { fake.stop() } catch {}
      for (const [k, v] of [['ROKU_ECP_PORT', saved.ecp], ['BRIGHTTEST_LEASE_DIR', saved.lease], ['BRIGHTTEST_CACHE', saved.cache], ['BRIGHTTEST_HUB_TOKEN', saved.tok]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    }
    try {
      const W = 1400, H = 900
      const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=0', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' })
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
        if (d.method === 'Fetch.requestPaused') { cdp('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }).catch(() => {}); return }
        if (d.id && waiting.has(d.id)) { const { r, j } = waiting.get(d.id); waiting.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result) }
      }
      const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr); return r.result.value }
      const until = async (expr, what, n = 100) => { for (let i = 0; i < n; i++) { if (await js(expr)) return; await sleep(100) } throw new Error(`timed out waiting for ${what}`) }
      const q = (tid) => `document.querySelector('[data-testid="${tid}"]')`
      const visible = (tid) => `(() => { const e = ${q(tid)}; return !!e && !e.classList.contains('hidden') && e.offsetParent !== null })()`
      const shotDir = process.env.BT_ROUTE_SHOTS
      const shot = async (name) => {
        if (!shotDir) return
        await sleep(300)
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'))
      }
      await cdp('Page.enable')
      await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] })
      await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

      // Direct link on first load.
      await cdp('Page.navigate', { url: `${base}/#/builds` })
      try { await until(visible('page-builds'), 'the Builds page from a direct link') } catch (e) { await shot('builds-direct-link-failed.png'); throw e }
      expect(await js(`${q('nav-builds')}.getAttribute('aria-current')`)).toBe('page')
      expect(await js('location.hash')).toBe('#/builds')
      await shot('builds-direct-link.png')

      // Nav click moves the hash; a hash change while open switches page.
      await js(`${q('nav-devices')}.click()`)
      await until(`location.hash === '#/devices'`, 'hash to follow the nav')
      await js(`location.hash = '#/builds'`)
      await until(visible('page-builds'), 'the Builds page after a hash change')

      // Other direct links and unknown ids.
      await cdp('Page.navigate', { url: `${base}/#/settings` })
      await js('location.reload()')
      await until(`${q('nav-settings')} && ${q('nav-settings')}.getAttribute('aria-current') === 'page'`, 'Settings from a direct link')
      await cdp('Page.navigate', { url: `${base}/#/nope` })
      await js('location.reload()')
      await until(`${q('nav-inspect')} && ${q('nav-inspect')}.getAttribute('aria-current') === 'page'`, 'Inspect for an unknown id')
    } finally { cleanup() }
  }, 90000)
})
