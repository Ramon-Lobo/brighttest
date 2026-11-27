import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Panel pop-out and dock in headless Chrome (raw CDP, no device): Tiles menu Dock and Pop out, the node context menu's
// Pop out, the old slot restored, Node and State side by side, and a stored v1 layout migrating to v2. Runs against the
// in-repo fake Roku. Skips when no Chrome or no Studio build. BT_LAYOUT_SHOTS=<dir> saves a screenshot per step.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')
const KEY = 'bt.studio.layout.inspect'

describe.skipIf(!chrome || !built)('Studio panel pop-out and dock (headless Chrome)', () => {
  it('docks and pops out inspector panels, shows Node and State side by side, migrates a v1 layout', async () => {
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

      const stored = async () => { await sleep(500); return JSON.parse(await js(`localStorage.getItem('${KEY}')`)) }
      const tileOf = async (id) => (await stored()).tiles.find((t) => t.id === id)
      const shown = (id) => js(`(() => { const e = ${q('tile-' + id)}; return !!e && getComputedStyle(e).display !== 'none' })()`)

      // A stored v1 layout (generic: Node and State side by side, the rest hidden) loads and is re-saved as v2.
      const v1 = ['monitor', 'flow', 'remote', 'node', 'tree', 'selector', 'state', 'actions', 'network'].map((id) => {
        const p = { node: [0, 0, 6, 9], state: [6, 0, 6, 9] }[id]
        return p ? { id, x: p[0], y: p[1], w: p[2], h: p[3], state: 'open' } : { id, x: 0, y: 20, w: 4, h: 9, state: 'hidden' }
      })
      await js(`localStorage.setItem('${KEY}', ${JSON.stringify(JSON.stringify({ v: 1, reg: 1, tiles: v1 }))})`)
      await cdp('Page.navigate', { url: base })
      await until(q('layout-grid'), 'the grid')
      await sleep(1200)
      let doc = await stored()
      expect(doc.v).toBe(2)
      expect(doc.tiles.find((t) => t.id === 'node')).toMatchObject({ x: 0, y: 0, w: 6, state: 'open' })
      expect(doc.tiles.find((t) => t.id === 'state')).toMatchObject({ x: 6, y: 0, w: 6, state: 'open' })
      expect(await shown('tree')).toBe(false)
      const nodeBox = await rect('tile-node'), stateBox = await rect('tile-state')
      expect(Math.abs(nodeBox.y - stateBox.y)).toBeLessThan(2)
      expect(nodeBox.x + nodeBox.w).toBeLessThanOrEqual(stateBox.x + 2)
      await shot('01-v1-migrated-node-state-side-by-side.png')

      // Pop out Tree from the Tiles menu; it appears and the Tiles menu offers Dock.
      await click('tiles-menu')
      expect(await js(`!!${q('tiles-popout-tree')}`)).toBe(true)
      await click('tiles-popout-tree')
      await until(`${q('tile-tree')}.getBoundingClientRect().width > 0`, 'tree tile')
      expect((await tileOf('tree')).state).toBe('open')
      expect(await js(`!!${q('tiles-dock-tree')}`)).toBe(true)
      await shot('02-tree-popped-out.png')

      // Dock State: the tile leaves the grid; the saved slot stays and the panel order is stored.
      const slot = await tileOf('state')
      await click('tiles-dock-state')
      await until(`!${q('tiles-dock-state')}`, 'dock')
      doc = await stored()
      expect(doc.tiles.find((t) => t.id === 'state').state).toBe('hidden')
      expect(doc.panels.order[0]).toBe('state')
      expect(await shown('state')).toBe(false)
      expect(await js(`!!${q('tiles-popout-state')}`)).toBe(true)
      await shot('03-state-docked.png')

      // Pop it out again: back in its previous slot (free), next to Node.
      await click('tiles-popout-state')
      await until(`${q('tile-state')}.getBoundingClientRect().width > 0`, 'state back')
      const back = await tileOf('state')
      expect([back.x, back.y, back.w]).toEqual([slot.x, slot.y, slot.w])
      await shot('04-state-popped-out-again.png')
      await click('tiles-menu')

      // The panel order survives a reload.
      await cdp('Page.navigate', { url: base })
      await until(q('layout-grid'), 'the grid')
      await sleep(1000)
      expect((await stored()).panels.order[0]).toBe('state')

      // Dock Node: Tree (below it) moves up into the slot, so Node comes back to the next free slot.
      await click('tiles-menu')
      await click('tiles-dock-node')
      await click('tiles-menu')
      await sleep(500)
      expect(await tileOf('tree')).toMatchObject({ x: 0, y: 0 })
      await click('tiles-menu')
      await click('tiles-popout-node')
      await until(`${q('tile-node')}.getBoundingClientRect().width > 0`, 'node next free slot')
      const next = await tileOf('node')
      expect(next.state).toBe('open')
      expect(next.x === 0 && next.y === 0).toBe(false)
      expect(await js(`${q('tile-node')}.getBoundingClientRect().height > 30`)).toBe(true)
      await shot('05-node-next-free-slot.png')
    } finally {
      cleanup()
    }
  }, 180000)
})
