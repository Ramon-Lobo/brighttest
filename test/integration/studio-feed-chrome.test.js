import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Studio capture-card feed in headless Chrome (raw CDP, fake media device fed by a y4m generated here, no device).
// Runs against the in-repo fake Roku. Skips with a message when no Chrome or no Studio build. BT_FEED_SHOTS=<dir> saves screenshots.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')


// A 4:3 clip (so the automatic picture rect is a letterbox) of a few frames with a moving luma ramp.
function writeY4m(file, w, h, frames) {
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < frames; f++) {
    const y = Buffer.alloc(w * h)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) y[r * w + c] = (c * 255 / w + f * 20) % 256
    parts.push(Buffer.from('FRAME\n'), y, Buffer.alloc(w * h / 4, 128), Buffer.alloc(w * h / 4, 128))
  }
  fs.writeFileSync(file, Buffer.concat(parts))
}

if (!chrome) console.warn('studio-feed-chrome: skipped, no Chrome found (set CHROME_BIN)')
if (chrome && !built) console.warn('studio-feed-chrome: skipped, Studio is not built (npm run studio:build)')

describe.skipIf(!chrome || !built)('Studio capture-card feed (headless Chrome, fake media device)', () => {
  it('plays a feed, stops screenshots, keeps the overlay, saves calibration and falls back when it ends', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-feedbrowser-'))
    process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
    process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
    const y4m = path.join(tmp, 'clip.y4m')
    writeY4m(y4m, 320, 240, 8)
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
    const killer = setTimeout(cleanup, 90000)
    try {
      const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=0', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' })
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
      let shots = 0
      const cdp = (method, params = {}) => new Promise((r, j) => { waiting.set(++id, { r, j }); ws.send(JSON.stringify({ id, method, params })) })
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.method === 'Fetch.requestPaused') {
          shots++
          cdp('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }).catch(() => {})
          return
        }
        if (d.id && waiting.has(d.id)) { const { r, j } = waiting.get(d.id); waiting.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result) }
      }
      const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + expr); return r.result.value }
      const until = async (expr, what, tries = 100) => { for (let i = 0; i < tries; i++) { if (await js(expr)) return; await sleep(100) } throw new Error(`timed out waiting for ${what}`) }
      const q = (tid) => `document.querySelector('[data-testid="${tid}"]')`
      const shotDir = process.env.BT_FEED_SHOTS
      const shot = async (name) => {
        if (!shotDir) return
        await sleep(300)
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'))
      }
      const pickFeed = async () => {
        if (await js(`!!${q('feed-allow')}`)) await js(`${q('feed-allow')}.click()`)
        await until(`${q('feed-source')} && ${q('feed-source')}.options.length > 1`, 'the fake capture device in the source list')
        await js(`(() => { const s = ${q('feed-source')}; s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
        await until(`${q('monitor-video')} && ${q('monitor-video')}.videoWidth > 0`, 'the video to play')
      }
      await cdp('Page.enable')
      await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] })
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
      await cdp('Page.navigate', { url: base })
      await until(q('monitor-screenshot'), 'the screenshot monitor')
      await shot('01-screenshots-default.png')

      // Select the feed: the video plays at the generated size and the screenshot image is gone.
      await pickFeed()
      expect(await js(`${q('monitor-video')}.videoWidth`)).toBe(320)
      expect(await js(`${q('monitor-video')}.videoHeight`)).toBe(240)
      expect(await js(`!!${q('monitor-screenshot')}`)).toBe(false)
      await until(`${q('feed-status')}.textContent.includes('live')`, 'the feed to settle past the signal wait', 40)
      // A 4:3 frame gets the centered 16:9 picture area.
      expect(await js(`${q('monitor-video')}.style.transform`)).toContain('translate(0%, -12.5%)')
      await shot('02-feed-live-auto-calibration.png')

      // Screenshots are off while the feed is on; the tree loop still draws the overlay and its age.
      await sleep(600)
      const during = shots
      await until(q('monitor-box-age'), 'the box age label')
      expect(await js(`${q('monitor-box-age')}.textContent`)).toMatch(/^boxes \d+\.\d s old$/)
      await sleep(6500) // longer than the 5 s idle timer
      expect(shots).toBe(during)
      expect(await js(`!!${q('monitor-overlay')}`)).toBe(true)

      // A key press dims the boxes (settling) until two reads agree.
      await js(`window.__saw = false; new MutationObserver(() => { if (document.querySelector('[data-testid="monitor-settling"]')) window.__saw = true }).observe(document.body, { childList: true, subtree: true })`)
      await js(`${q('remote-key-down')}.click()`)
      await until('window.__saw', 'the settling state')
      await until(`!${q('monitor-settling')}`, 'the boxes to settle', 60)
      expect(shots).toBe(during)

      // Calibration: nudge, see the alignment aid, and keep it across a reload.
      await js(`${q('feed-calibrate')}.click()`)
      await until(q('feed-aid-frame'), 'the alignment aid')
      const auto = await js(`${q('monitor-video')}.style.transform`)
      await js(`${q('feed-nudge-left')}.click()`)
      await js(`${q('feed-scale-up')}.click()`)
      const manual = await js(`${q('monitor-video')}.style.transform`)
      expect(manual).not.toBe(auto)
      expect(await js(`${q('feed-rect')}.textContent`)).toMatch(/^manual/)
      await shot('03-feed-manual-calibration-aid.png')
      const key = await js(`Object.keys(localStorage).find((k) => k.startsWith('bt.studio.feed.') && k !== 'bt.studio.feedlast')`)
      expect(JSON.parse(await js(`localStorage.getItem(${JSON.stringify(key)})`)).v).toBe(1)
      await cdp('Page.reload')
      await until(q('feed-source'), 'Studio to reload')
      if (!(await js(`!!${q('monitor-video')}`))) { await sleep(1500) }
      if (!(await js(`!!${q('monitor-video')} && ${q('monitor-video')}.videoWidth > 0`))) await pickFeed()
      await until(`${q('monitor-video')}.videoWidth > 0`, 'the feed after reload')
      expect(await js(`${q('monitor-video')}.style.transform`)).toBe(manual)
      await shot('04-feed-calibration-after-reload.png')

      // Unplug: the track ends, Studio says so and screenshots come back.
      const before = shots
      await js(`(() => { const t = ${q('monitor-video')}.srcObject.getVideoTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')) })()`)
      await until(q('monitor-screenshot'), 'the screenshot monitor to return')
      expect(await js(`${q('feed-message')}.textContent`)).toMatch(/unplugged|stopped/i)
      for (let i = 0; i < 40 && shots === before; i++) await sleep(100)
      expect(shots).toBeGreaterThan(before)
      await shot('05-feed-ended-back-to-screenshots.png')
    } finally { clearTimeout(killer); cleanup() }
  }, 120000)
})
