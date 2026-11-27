import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Studio Inspect tile grid in headless Chrome (raw CDP, no device): drag, resize with minimum sizes, minimize, hide and
// restore from the Tiles menu, persistence, Reset, polling that follows the visible tiles, overlay alignment after a
// resize, and the one-column narrow mode. Runs against the in-repo fake Roku. Skips when no Chrome or no Studio build.
// BT_LAYOUT_SHOTS=<dir> saves a screenshot per case.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')
const KEY = 'bt.studio.layout.inspect'

describe.skipIf(!chrome || !built)('Studio Inspect tile grid (headless Chrome)', () => {
  it('drags, resizes, hides, restores, persists, resets and follows the visible tiles', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-layout-'))
    process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
    process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
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
    const procs = []
    const cleanup = () => { try { ws && ws.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } try { server.close() } catch {} try { fake.stop() } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
    try {
      const W = 1440, H = 1700
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
      let shotRequests = 0
      const cdp = (method, params = {}) => new Promise((r, j) => { waiting.set(++id, { r, j }); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.method === 'Fetch.requestPaused') {
          shotRequests++
          cdp('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }).catch(() => {})
          return
        }
        if (d.id && waiting.has(d.id)) { const { r, j } = waiting.get(d.id); waiting.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result) }
      }
      const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr); return r.result.value }
      const until = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await js(expr)) return; await sleep(100) } throw new Error(`timed out waiting for ${what}`) }
      const q = (tid) => `document.querySelector('[data-testid="${tid}"]')`
      const click = (tid) => js(`${q(tid)}.click()`)
      const rect = (tid) => js(`(() => { const r = ${q(tid)}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
      const saved = async () => { await sleep(500); const doc = JSON.parse(await js(`localStorage.getItem('${KEY}')`)); return Object.fromEntries(doc.tiles.map((t) => [t.id, t])) }
      const state = async () => Object.fromEntries(Object.entries(await saved()).map(([k, t]) => [k, t.state]))
      const shotDir = process.env.BT_LAYOUT_SHOTS
      const shot = async (name) => {
        if (!shotDir) return
        await sleep(300)
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'))
      }
      const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
      const drag = async (from, to, mid) => {
        await mouse('mousePressed', from.x, from.y)
        const steps = 8
        for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
        if (mid) await mid()
        await mouse('mouseReleased', to.x, to.y)
      }
      const center = (r) => ({ x: r.x + 30, y: r.y + 15 })

      await cdp('Page.enable')
      await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] })
      await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
      await cdp('Page.navigate', { url: base })
      await until(q('layout-grid'), 'the grid')
      await sleep(1200)

      // Default: every panel is its own tile, no tabs.
      for (const t of ['monitor', 'flow', 'remote', 'node', 'tree', 'selector', 'state', 'actions', 'network']) expect(await js(`!!${q('tile-' + t)}`), t).toBe(true)
      expect(await js(`!!${q('tab-node')}`)).toBe(false)
      expect(await js(`!!${q('live-monitor')} && !!${q('flow-editor')} && !!${q('remote-panel')}`)).toBe(true)
      await shot('01-default.png')

      // Overlay alignment, then again after a resize: image and overlay share one box and the box is 16:9 inside the tile.
      const aligned = async () => {
        const a = await rect('monitor-screenshot'), b = await rect('monitor-overlay')
        for (const k of ['x', 'y', 'w', 'h']) expect(Math.abs(a[k] - b[k]), `${k} ${JSON.stringify([a, b])}`).toBeLessThan(1)
        const bez = await js(`(() => { const r = ${q('monitor-stage')}.querySelector('.bezel').getBoundingClientRect(); return { w: r.width, h: r.height } })()`)
        expect(Math.abs(bez.w / bez.h - 16 / 9)).toBeLessThan(0.02)
        const body = await rect('live-monitor'), st = await rect('monitor-stage')
        expect(st.w).toBeLessThanOrEqual(body.w + 1)
        expect(st.h).toBeLessThanOrEqual(body.h + 1)
      }
      await aligned()

      // Resize: drag the grip; the monitor grows, the picture stays 16:9 and aligned.
      expect(await js(`localStorage.getItem('${KEY}')`)).toBe(null) // nothing is saved until the layout changes
      const before = { monitor: { x: 6, w: 6, h: 11 } }
      let g = await rect('tile-monitor-resize')
      await drag({ x: g.x + 8, y: g.y + 8 }, { x: g.x + 8 - 150, y: g.y + 8 + 150 }, async () => { expect(await js(`!!${q('layout-placeholder')}`)).toBe(false) })
      let now = await saved()
      expect(now.monitor.h).toBeGreaterThan(before.monitor.h)
      expect(now.monitor.w).toBeLessThan(before.monitor.w)
      await aligned()
      await shot('02-resized-monitor.png')

      // Minimum size: shrinking far below the minimum stops at it (monitor 3 x 5).
      g = await rect('tile-monitor-resize')
      await drag({ x: g.x + 8, y: g.y + 8 }, { x: g.x + 8 - 1500, y: g.y + 8 - 1500 })
      now = await saved()
      expect(now.monitor.w).toBe(3)
      expect(now.monitor.h).toBe(5)
      await aligned()
      await shot('03-min-size.png')

      // Drag: the ghost and the placeholder show while moving, and the drop commits a new place.
      const flowBefore = (await saved()).flow
      let sawPlaceholder = false
      const h = await rect('tile-flow-handle')
      await drag(center(h), { x: center(h).x + 560, y: center(h).y + 40 }, async () => {
        sawPlaceholder = await js(`!!${q('layout-placeholder')}`)
      })
      expect(sawPlaceholder).toBe(true)
      expect(await js(`!!${q('layout-placeholder')}`)).toBe(false)
      now = await saved()
      expect(now.flow.x).toBeGreaterThan(flowBefore.x)
      await shot('04-dragged-flow.png')

      // A 3 px wiggle is a click, not a drag.
      const h2 = await rect('tile-remote-handle')
      const rb = (await saved()).remote
      await drag(center(h2), { x: center(h2).x + 2, y: center(h2).y + 1 })
      expect(await saved()).toMatchObject({ remote: { x: rb.x, y: rb.y } })

      // Hide from the tile menu, then restore from the Tiles menu.
      await click('tile-network-menu')
      await click('tile-network-hide')
      expect(await js(`!!${q('tile-network')}`)).toBe(false)
      expect((await state()).network).toBe('hidden')
      await click('tiles-menu')
      expect(await js(`${q('tiles-menu-item-network')}.checked`)).toBe(false)
      await shot('05-hidden-network-menu.png')
      await click('tiles-menu-item-network')
      await until(q('tile-network'), 'the restored tile')
      expect((await state()).network).toBe('open')
      await click('tiles-menu')

      // Minimize unmounts the panel, restore brings it back; the flow editor stays mounted while minimized.
      await click('tile-state-minimize')
      expect(await js(`!!${q('tile-state')} && !document.querySelector('[data-testid="tile-state"] .body')`)).toBe(true)
      expect(await js(`${q('tile-state-minimize')}.getAttribute('aria-expanded')`)).toBe('false')
      await click('tile-flow-minimize')
      expect(await js(`!!${q('flow-editor')}`)).toBe(true)
      expect(await js(`${q('flow-editor')}.offsetParent === null`)).toBe(true)
      await click('tiles-menu')
      expect(await js(`!!${q('tiles-restore-state')}`)).toBe(true)
      await shot('06-minimized.png')
      await click('tiles-restore-state')
      await click('tiles-menu')
      await click('tile-flow-minimize')

      // Reload keeps the layout.
      const keep = await saved()
      await js('location.reload()')
      await until(q('layout-grid'), 'the grid after reload')
      await sleep(600)
      expect(await saved()).toEqual(keep)
      await shot('07-after-reload.png')

      // Polling follows the visible tiles: no /api/screenshot while the monitor is hidden, and again once it is back.
      await sleep(1500)
      expect(shotRequests).toBeGreaterThan(0)
      await click('tile-monitor-menu')
      await click('tile-monitor-hide')
      await sleep(1200)
      shotRequests = 0
      await sleep(3000)
      expect(shotRequests).toBe(0)
      await shot('08-monitor-hidden.png')
      await click('tiles-menu')
      await click('tiles-menu-item-monitor')
      await until(q('monitor-screenshot'), 'the monitor again')
      await sleep(2500)
      expect(shotRequests).toBeGreaterThan(0)
      await click('tiles-menu')

      // Reset asks first; Cancel keeps the layout; Replace restores the default.
      await click('tiles-menu')
      await click('tiles-reset')
      await click('tiles-cancel')
      expect(await saved()).not.toMatchObject({ monitor: { x: 6, w: 6, h: 11 } })
      await click('tiles-reset')
      await click('tiles-confirm')
      const def = await saved()
      expect(def.monitor).toMatchObject({ x: 6, y: 0, w: 6, h: 11, state: 'open' })
      expect(def.flow).toMatchObject({ x: 0, y: 0, w: 6, h: 20 })
      await shot('09-reset.png')

      // Monitor and info preset hides flow and remote.
      await click('tiles-menu')
      await click('tiles-preset-monitor-info')
      await click('tiles-confirm')
      const pre = await state()
      expect(pre).toMatchObject({ monitor: 'open', node: 'open', state: 'open', flow: 'hidden', remote: 'hidden' })
      await shot('10-preset-monitor-info.png')
      await click('tiles-menu')
      await click('tiles-reset')
      await click('tiles-confirm')

      // Narrow: one column, no drag handle.
      await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 1400, deviceScaleFactor: 1, mobile: false })
      await until(`${q('layout-grid')}.classList.contains('narrow')`, 'narrow mode')
      expect(await js(`${q('tile-monitor-handle')}.disabled`)).toBe(true)
      expect(await js(`!!${q('tile-monitor-resize')}`)).toBe(false)
      const colsOf = await js(`getComputedStyle(${q('layout-grid')}).gridTemplateColumns.split(' ').length`)
      expect(colsOf).toBe(1)
      await shot('11-narrow-900.png')
      expect((await saved()).monitor).toMatchObject({ x: 6, w: 6 }) // narrow mode does not change the saved layout
    } finally {
      cleanup()
    }
  }, 180000)
})
