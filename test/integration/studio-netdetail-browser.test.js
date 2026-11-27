import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Studio Network details split pane in headless Chrome (raw CDP, no device): open and close, splitter by keyboard and
// pointer, selection kept in view, Headers / Payload / Response, Pretty and Raw, search, show secrets, refused and
// not-in-HAR, truncated and binary bodies. Uses the in-repo fake Roku and the fake net proxy harness; hosts are
// example.test. Skips when no Chrome or no Studio build. BT_NETD_SHOTS=<dir> saves a screenshot per case.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')
const KEY = 'bt.studio.net'

describe.skipIf(!chrome || !built)('Studio Network details (headless Chrome)', () => {
  it('opens, resizes, closes and shows headers, payload and response for every call', async () => {
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
    const { EventEmitter } = require('node:events')
    const { createEventLog } = require('../../lib/instrument/events.js')
    const { startHarness, request } = require('../fixtures/net/harness.js')
    const log = createEventLog({ sessionId: 'sessN' })
    const bus = new EventEmitter()
    const REDACT = { bodyKeys: ['token'] }
    const harness = await startHarness({ redact: REDACT, upstreamHosts: ['allowed.example.test'], unmatched: 'passthrough', emit: (kind, data) => bus.emit('event', log.push({ src: 'hub', kind, data })) })
    const server = await studio.start({
      host: '127.0.0.1', password: 'fake-password', port: 0, rootDir, flowsDir: path.join(rootDir, 'flows'),
      net: { proxy: harness.proxy, events: bus, log, redact: REDACT },
      leaseOpts: { acquireOpts: { dir: process.env.BRIGHTTEST_LEASE_DIR, timers: false, identity: {} }, tickMs: 50 },
    })
    const base = `http://localhost:${server.address().port}`
    let ws = null
    const procs = []
    const cleanup = () => { try { ws && ws.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } try { server.close() } catch {} try { harness.stop() } catch {} try { fake.stop() } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
    try {
      const W = 1900, H = 2100
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
        if (d.method === 'Fetch.requestPaused') {
          cdp('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }).catch(() => {})
          return
        }
        if (d.id && waiting.has(d.id)) { const { r, j } = waiting.get(d.id); waiting.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result) }
      }
      const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr); return r.result.value }
      const until = async (expr, what) => { for (let i = 0; i < 100; i++) { if (await js(expr)) return; await sleep(100) } throw new Error(`timed out waiting for ${what}`) }
      const q = (tid) => `document.querySelector('[data-testid="${tid}"]')`
      const text = (tid) => js(`${q(tid)} ? ${q(tid)}.textContent : null`)
      const has = (tid) => js(`!!${q(tid)}`)
      const click = async (tid) => { await js(`${q(tid)}.click()`); await sleep(60) }
      const rect = (el) => js(`(() => { const r = ${el}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
      const shotDir = process.env.BT_NETD_SHOTS
      const shot = async (name) => {
        if (!shotDir) return
        await sleep(300)
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'))
      }
      const KEYS = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, Escape: 27, Enter: 13 }
      const key = async (k) => {
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: KEYS[k] })
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: KEYS[k] })
        await sleep(80)
      }
      const rowSel = (rid) => `[...document.querySelectorAll('[data-testid="net-row"]')].find((r) => r.dataset.id === '${rid}')`
      const pick = async (rid) => { await js(`${rowSel(rid)}.scrollIntoView({ block: 'center' }); ${rowSel(rid)}.click()`); await until(`!!${q('net-detail')}`, 'details'); await sleep(250) }
      const valuenow = () => js(`Number(${q('net-detail-splitter')}.getAttribute('aria-valuenow'))`)
      const inView = async (rid) => js(`(() => { const l = ${q('net-list')}.parentElement.getBoundingClientRect(); const r = ${rowSel(rid)}.getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1 })()`)

      // Traffic: 30 filler rows, then one JSON mock with secrets, a refused host, a binary body and a 1.4 MB text body.
      harness.proxy.ruleSet.add({ id: 'fill', url: 'https://api.example.test/v1/item/*', status: 200, headers: { 'content-type': 'application/json' }, json: { ok: true } })
      for (let i = 0; i < 30; i++) await request(harness.base + `https://api.example.test/v1/item/${i}`)
      harness.proxy.ruleSet.add({ id: 'home', url: 'https://api.example.test/v1/home*', status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=cookie-secret' }, json: { title: 'Hero', rail: ['a', 'b'], token: 'resp-secret-1' } })
      harness.proxy.ruleSet.add({ id: 'bin', url: 'https://api.example.test/v1/blob', status: 200, headers: { 'content-type': 'application/octet-stream' }, bodyBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]).toString('base64') })
      harness.proxy.ruleSet.add({ id: 'big', url: 'https://api.example.test/v1/big', status: 200, headers: { 'content-type': 'text/plain' }, body: 'é'.repeat(700 * 1024) })
      await request(harness.base + 'https://api.example.test/v1/home?page=1&access_token=abc123secret', { method: 'POST', headers: { authorization: 'Bearer auth-secret-1', 'content-type': 'application/json' }, body: JSON.stringify({ q: 'x', token: 'req-secret-1' }) })
      await request(harness.base + 'https://blocked.example.test/v1/nope')
      await request(harness.base + 'https://api.example.test/v1/blob')
      await request(harness.base + 'https://api.example.test/v1/big')
      const ids = { home: 'r-31', refused: 'r-32', bin: 'r-33', big: 'r-34' }

      await cdp('Page.enable')
      await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] })
      await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
      await cdp('Page.navigate', { url: base })
      await until(q('net-panel'), 'the Network panel')
      await until(`document.querySelectorAll('[data-testid="net-row"]').length >= 34`, '34 rows')
      // Make the Network tile taller (drag its grip) so both panes have room.
      {
        const g = await rect(q('tile-network-resize'))
        const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
        await mouse('mousePressed', g.x + 8, g.y + 8)
        for (let i = 1; i <= 8; i++) await mouse('mouseMoved', g.x + 8, g.y + 8 + i * 55)
        await mouse('mouseReleased', g.x + 8, g.y + 8 + 440)
        await sleep(400)
      }
      expect(await has('net-detail')).toBe(false) // closed: the list takes the whole panel
      expect(await js(`${q('net-list')}.getAttribute('role')`)).toBe('grid')
      await shot('01-list-only.png')

      // Open with a click: General block, redaction badge, tabs; focus and selection state on the row.
      await pick(ids.home)
      expect(await js(`${rowSel(ids.home)}.getAttribute('aria-selected')`)).toBe('true')
      await until(`!!${q('net-detail-general')}`, 'General block')
      const gen = await text('net-detail-general')
      expect(gen).toMatch(/POST/)
      expect(gen).toMatch(/Status200/)
      expect(gen).toMatch(/mock/)
      expect(gen).toMatch(/home/)
      expect(gen).not.toContain('abc123secret')
      expect(await text('net-redaction-badge')).toBe('redacted')
      expect(await has('net-not-in-har')).toBe(false)
      expect(await text('net-detail-req-headers')).toContain('<redacted:authorization>')
      expect(await text('net-detail-res-headers')).not.toContain('cookie-secret')
      expect(await has('net-mock-this') && await has('net-copy-rule') && await has('net-block') && await has('net-clear-rules')).toBe(true)
      await shot('02-details-side-by-side.png')

      // Selection stays in view when the pane opens (the list shrank) and when moving with the keyboard.
      expect(await inView(ids.home)).toBe(true)
      await js(`${rowSel(ids.home)}.focus()`)
      await key('ArrowUp')
      expect(await inView('r-30')).toBe(true)
      expect(await js(`${rowSel('r-30')}.getAttribute('aria-selected')`)).toBe('true')
      await until(`!!${q('net-detail-general')} && ${q('net-detail-general')}.textContent.includes('/v1/item/29')`, 'details follow the selection')
      await key('ArrowDown')
      expect(await inView(ids.home)).toBe(true)
      await until(`${q('net-detail-general')}.textContent.includes('v1/home')`, 'details follow back')

      // Payload and Response: Pretty by default for JSON, Raw toggles, search highlights.
      await click('net-detail-tab-payload')
      const req = await text('net-body')
      expect(req).toContain('"q": "x"')
      expect(req).not.toContain('req-secret-1')
      expect(await js(`${q('net-body')}.dataset.side`)).toBe('req')
      expect(await has('net-query')).toBe(true)
      expect(await text('net-query')).not.toContain('abc123secret')
      await click('net-detail-tab-response')
      expect(await js(`${q('net-body')}.dataset.side`)).toBe('res')
      expect((await text('net-body')).includes('\n  "title": "Hero"')).toBe(true)
      expect(await text('net-body')).not.toContain('resp-secret-1')
      await shot('03-response-pretty.png')
      await click('net-body-raw')
      expect((await text('net-body')).includes('"title":"Hero"')).toBe(true)
      expect((await text('net-body')).includes('\n  "title"')).toBe(false)
      await click('net-body-pretty')
      expect((await text('net-body')).includes('\n  "title": "Hero"')).toBe(true)
      await js(`(() => { const i = ${q('net-body-search')}; i.value = 'hero'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await until(`${q('net-body-search-count')}.textContent === '1/1'`, 'one match')
      expect(await js(`${q('net-body')}.querySelectorAll('mark').length`)).toBe(1)
      await js(`(() => { const i = ${q('net-body-search')}; i.value = 'ZZZ'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await until(`${q('net-body-search-count')}.textContent === '0'`, 'no match')
      await click('net-body-search-case')
      await js(`(() => { const i = ${q('net-body-search')}; i.value = 'rail'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await until(`${q('net-body-search-count')}.textContent === '1/1'`, 'case match')
      await js(`(() => { const i = ${q('net-body-search')}; i.value = 'RAIL'; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await until(`${q('net-body-search-count')}.textContent === '0'`, 'case-sensitive miss')
      await shot('04-search.png')
      await click('net-body-search-case')
      await js(`(() => { const i = ${q('net-body-search')}; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)

      // Show secrets applies to the details: the entry is refetched raw, the badge and banner change, and back.
      await click('net-show-secrets')
      await click('net-detail-tab-headers')
      await until(`${q('net-redaction-badge')} && ${q('net-redaction-badge')}.textContent === 'raw: secrets shown'`, 'raw badge')
      expect(await text('net-detail-req-headers')).toContain('auth-secret-1')
      await click('net-detail-tab-response')
      expect(await text('net-body')).toContain('resp-secret-1')
      await shot('05-show-secrets.png')
      await click('net-show-secrets')
      await until(`!${q('net-body')}.textContent.includes('resp-secret-1')`, 'redacted again')

      // Splitter by keyboard: 5 percent a step, Home and End to the limits, double-click resets; limits hold.
      await js(`${q('net-detail-splitter')}.focus()`)
      expect(await js(`${q('net-detail-splitter')}.getAttribute('role')`)).toBe('separator')
      expect(await js(`${q('net-detail-splitter')}.getAttribute('aria-orientation')`)).toBe('vertical')
      const start = await valuenow()
      expect(start).toBe(50)
      await key('ArrowRight')
      expect(await valuenow()).toBe(55)
      await key('ArrowLeft'); await key('ArrowLeft')
      expect(await valuenow()).toBe(45)
      await key('Home')
      expect(await valuenow()).toBeGreaterThanOrEqual(30)
      let l = await rect(q('net-list') + '.parentElement'), dd = await rect(q('net-detail'))
      expect(l.w).toBeGreaterThanOrEqual(160)
      await shot('06-splitter-home.png')
      await key('End')
      l = await rect(q('net-list') + '.parentElement'); dd = await rect(q('net-detail'))
      expect(dd.w).toBeGreaterThanOrEqual(279)
      expect(l.w).toBeGreaterThanOrEqual(160)
      await js(`${q('net-detail-splitter')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
      await sleep(80)
      expect(await valuenow()).toBe(50)
      // Pointer drag on the splitter.
      const sp = await rect(q('net-detail-splitter'))
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x + 3, y: sp.y + 40, button: 'left', buttons: 1, clickCount: 1 })
      for (let i = 1; i <= 6; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sp.x + 3 + i * 25, y: sp.y + 40, button: 'left', buttons: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x + 153, y: sp.y + 40, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(100)
      expect(await valuenow()).toBeGreaterThan(55)
      const saved = JSON.parse(await js(`localStorage.getItem('${KEY}')`))
      expect(saved).toMatchObject({ v: 1 })
      expect(saved.size).toBeGreaterThan(55)

      // Flip to stacked: the separator turns horizontal and Up/Down move it.
      await click('net-detail-orient')
      await until(`${q('net-detail-splitter')}.getAttribute('aria-orientation') === 'horizontal'`, 'stacked')
      await js(`${q('net-detail-splitter')}.focus()`)
      const before = await valuenow()
      await key('ArrowUp')
      expect(await valuenow()).toBe(before - 5)
      await key('ArrowRight')
      expect(await valuenow()).toBe(before - 5) // the other axis is ignored
      expect(await inView(ids.home)).toBe(true)
      expect(JSON.parse(await js(`localStorage.getItem('${KEY}')`)).orient).toBe('stacked')
      await shot('07-stacked.png')
      await click('net-detail-orient')

      // Truncated and binary bodies.
      await pick(ids.big)
      await click('net-detail-tab-response')
      await until(`!!${q('net-body-truncated')}`, 'truncation notice')
      expect(await text('net-body-truncated')).toMatch(/^Showing 1\.0 MB of 1\.4 MB \(download for all\)$/)
      expect(await has('net-body-show-all')).toBe(true)
      expect(await js(`${q('net-body-download')}.getAttribute('href')`)).toBe(`/api/net/body?id=${ids.big}&side=res`)
      const cut = await js(`${q('net-body')}.querySelector('pre').textContent.length`)
      expect(cut).toBeLessThanOrEqual(256 * 1024)
      await click('net-body-show-all')
      expect(await js(`${q('net-body')}.querySelector('pre').textContent.length`)).toBeGreaterThan(cut)
      await shot('08-truncated.png')
      await pick(ids.bin)
      await click('net-detail-tab-response')
      await until(`!!${q('net-body-binary')}`, 'binary view')
      expect(await text('net-body-binary')).toMatch(/Binary body, 10 B, application\/octet-stream/)
      expect(await text('net-body-binary')).toContain('89 50 4e 47')
      expect(await has('net-body-copy')).toBe(false)
      await shot('09-binary.png')

      // Refused: General block carries the hint, Not in HAR, and the body brighttest answered with.
      await pick(ids.refused)
      await click('net-detail-tab-headers')
      await until(`!!${q('net-not-in-har')}`, 'not in HAR')
      expect(await text('net-not-in-har')).toMatch(/^Not in HAR export: brighttest answered this request itself$/)
      expect(await text('net-refused-hint')).toMatch(/Refused by the passthrough allow-list/)
      expect(await text('net-refused-hint')).toContain('blocked.example.test')
      expect(await js(`${q('net-detail-general')}.contains(${q('net-refused-hint')})`)).toBe(true)
      await shot('10-refused.png')
      await click('net-detail-tab-response')
      await until(`${q('net-body')}.textContent.includes('passthrough refused')`, 'refused body')
      const har = await getJson(`${base}/api/net/har`)
      expect(har.log.entries.map((e) => e.request.url).some((u) => u.includes('blocked.example.test'))).toBe(false)

      // Esc closes from inside the details and from the list, and focus returns to the selected row.
      await js(`${q('net-detail-tab-response')}.focus()`)
      await key('Escape')
      expect(await has('net-detail')).toBe(false)
      expect(await js(`document.activeElement === ${rowSel(ids.refused)}`)).toBe(true)
      await key('Enter')
      await until(`!!${q('net-detail')}`, 'Enter opens')
      await js(`${rowSel(ids.refused)}.focus()`)
      await key('Escape')
      expect(await has('net-detail')).toBe(false)
      await shot('11-closed.png')
      await click('net-detail-close').catch(() => {})
    } finally {
      cleanup()
    }
  }, 240000)
})
