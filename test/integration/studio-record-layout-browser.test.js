import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Studio Record page on the tile grid in headless Chrome (raw CDP, no device): own layout key, keyboard move and resize,
// announcements, persistence across reload, Inspect key untouched, and the one-column narrow mode. Runs against the
// in-repo fake Roku. Skips when no Chrome or no Studio build. BT_LAYOUT_SHOTS=<dir> saves a screenshot per case.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')
const KEY = 'bt.studio.layout.record'
const INSPECT = 'bt.studio.layout.inspect'

describe.skipIf(!chrome || !built)('Studio Record tile grid (headless Chrome)', () => {
  it('keeps the Record layout under its own key, moves by keyboard, persists and stacks when narrow', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-reclayout-'))
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
      const rq = (tid) => `document.querySelector('[data-testid="page-record"] [data-testid="${tid}"]')`
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
      await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: 1100, deviceScaleFactor: 1, mobile: false })
      await cdp('Page.navigate', { url: base })
      await until(q('nav-record'), 'the nav')
      await click('nav-record')
      await until(`${q('page-record')} && ${q('page-record')}.querySelector('[data-testid="record-layout-grid"]')`, 'the Record grid')
      await sleep(800)
      for (const t of ['rec-monitor', 'rec-remote', 'rec-steps']) expect(await js(`!!${q('tile-' + t)}`), t).toBe(true)
      expect(await js(`!!${q('record-start')} && !!${q('record-doc')}`)).toBe(true)
      expect(await js(`localStorage.getItem('${KEY}')`)).toBe(null) // nothing is saved until the layout changes
      await shot('01-record-grid-default.png')

      // Keyboard: arrows move the focused tile, shift+arrows resize, announced in the live region.
      const key = (k, code, vk, modifiers = 0) => cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers }).then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }))
      await js(`${q('tile-rec-steps-handle')}.focus()`)
      await key('ArrowLeft', 'ArrowLeft', 37, 8) // shift: narrower
      let now = await saved()
      expect(now['rec-steps']).toMatchObject({ x: 7, w: 4 })
      expect(await js(`${rq('record-layout-live')}.textContent`)).toContain('Recording tile, column')
      await key('ArrowRight', 'ArrowRight', 39) // move right one cell
      now = await saved()
      expect(now['rec-steps']).toMatchObject({ x: 8, w: 4 })
      await shot('02-record-keyboard-moved.png')

      // Own key: Inspect's key was never written; reload keeps the Record arrangement.
      expect(await js(`localStorage.getItem('${INSPECT}')`)).toBe(null)
      await cdp('Page.navigate', { url: base })
      await until(q('nav-record'), 'the nav after reload')
      await click('nav-record')
      await until(q('tile-rec-steps'), 'the Record tile after reload')
      const style = await js(`${q('tile-rec-steps')}.getAttribute('style')`)
      expect(style).toContain('1 / 9 / span 24 / span 4')

      // Hide from the strip, bring back, Reset.
      await click('record-tile-toggle-rec-remote')
      await until(`!${q('tile-rec-remote')}`, 'hidden remote').catch(async () => { expect(await js(`${q('tile-rec-remote')}.classList.contains('hidden')`)).toBe(true) })
      await click('record-tile-toggle-rec-remote')
      await click('record-layout-reset')
      now = await saved()
      expect(now['rec-steps']).toMatchObject({ x: 7, y: 0, w: 5, state: 'open' })

      // Narrow: one column, no resize grips, saved layout unchanged.
      await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 1400, deviceScaleFactor: 1, mobile: false })
      await until(`${q('page-record')}.querySelector('[data-testid="record-layout-grid"]').classList.contains('narrow')`, 'narrow mode')
      expect(await js(`${q('tile-rec-monitor-handle')}.disabled`)).toBe(true)
      expect(await js(`getComputedStyle(${q('page-record')}.querySelector('[data-testid="record-layout-grid"]')).gridTemplateColumns.split(' ').length`)).toBe(1)
      await shot('03-record-narrow-900.png')
      expect((await saved())['rec-steps']).toMatchObject({ x: 7, w: 5 })
    } finally {
      cleanup()
    }
  }, 120000)
})
