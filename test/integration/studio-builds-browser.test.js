import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Studio Builds page in headless Chrome (raw CDP): drop and file input, a rejected zip, search/filter/sort, notes and pin
// after reload, install with confirm, token warning, success, 401, EPIPE, cancel, device strip. Fake Roku and a scripted
// installer (the install seam); no device. Skips when no Chrome or no Studio build. BT_BUILDS_SHOTS=<dir> saves screenshots.
const require = createRequire(import.meta.url)
const root = path.join(__dirname, '..', '..')
const { makeZip, plainEntries, instrumentedEntries } = require('../support/zipgen')
const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p))
const built = fs.existsSync(path.join(root, 'lib/studio/public/index.html'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')
const STUDIO_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe.skipIf(!chrome || !built)('Studio Builds page (headless Chrome)', () => {
  it('uploads, lists, edits, installs and reports every outcome', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-builds-ui-'))
    const saved = { ecp: process.env.ROKU_ECP_PORT, lease: process.env.BRIGHTTEST_LEASE_DIR, cache: process.env.BRIGHTTEST_CACHE, tok: process.env.BRIGHTTEST_HUB_TOKEN }
    process.env.BRIGHTTEST_LEASE_DIR = path.join(tmp, 'leases')
    process.env.BRIGHTTEST_CACHE = path.join(tmp, 'devices.json')
    process.env.BRIGHTTEST_HUB_TOKEN = STUDIO_TOKEN
    const studio = require('../../lib/studio/server.js')
    const { createFakeRoku } = require('../fixtures/fake-roku/server.js')
    const fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
    const ports = await fake.start()
    process.env.ROKU_ECP_PORT = String(ports.ecpPort)
    const rootDir = path.join(tmp, 'project')
    fs.mkdirSync(path.join(rootDir, 'flows'), { recursive: true })
    const gw = { mode: 'ok', release: null }
    const installer = (o) => new Promise((resolve) => {
      const res = (code, message, extra = {}) => ({ ok: code === 'OK', code, step: 'upload', message, active: code === 'OK', identical: false, durationMs: 5, retried: false, ...extra })
      o.onStep({ step: 'probe', at: new Date().toISOString() })
      if (gw.mode === '401') return resolve(res('AUTH', 'POST /plugin_install: device rejected the dev password (HTTP 401)'))
      if (gw.mode === 'epipe') { o.onStep({ step: 'upload', at: new Date().toISOString() }); return resolve(res('NETWORK', 'POST /plugin_install (authenticated) failed: EPIPE', { cause: 'EPIPE' })) }
      if (gw.mode === 'hold') {
        const stop = () => resolve(res('CANCELLED', 'cancelled', { step: 'probe' }))
        if (o.signal.aborted) return stop()
        o.signal.addEventListener('abort', stop, { once: true })
        return
      }
      o.onStep({ step: 'upload', at: new Date().toISOString() })
      o.onStep({ step: 'verify-active', at: new Date().toISOString() })
      resolve(res('OK', 'installed; dev channel active', { step: 'verify-active' }))
    })
    const server = await studio.start({
      host: '127.0.0.1', password: 'fake-password', port: 0, rootDir, flowsDir: path.join(rootDir, 'flows'),
      cfg: { builds: { dir: path.join(tmp, 'store'), maxZipMB: 1 } },
      leaseOpts: { acquireOpts: { dir: process.env.BRIGHTTEST_LEASE_DIR, timers: false, identity: {} }, tickMs: 50 },
      buildsOpts: { installPackage: installer, collectFacts: async ({ zipData }) => ({ sha256: crypto.createHash('sha256').update(zipData).digest('hex'), size: zipData.length, manifest: { title: 'Sample App', version: '1.4.118' }, git: {} }), jobKeepMs: 60000 },
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
      const W = 1500, H = 1300
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
      const js = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') + ' ' + expr); return r.result.value }
      const until = async (expr, what, n = 100) => { for (let i = 0; i < n; i++) { if (await js(expr)) return; await sleep(100) } throw new Error(`timed out waiting for ${what}`) }
      const q = (tid) => `document.querySelector('[data-testid="${tid}"]')`
      const text = (tid) => js(`${q(tid)} ? ${q(tid)}.textContent.replace(/\\s+/g, ' ').trim() : null`)
      const has = (tid) => js(`!!${q(tid)}`)
      const click = async (tid) => { await until(`!!${q(tid)}`, tid); await js(`${q(tid)}.click()`); await sleep(80) }
      const setVal = (tid, v, ev) => js(`(() => { const e = ${q(tid)}; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)}, { bubbles: true })) })()`)
      const shotDir = process.env.BT_BUILDS_SHOTS
      const shot = async (name) => {
        if (!shotDir) return
        await sleep(300)
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
        fs.mkdirSync(shotDir, { recursive: true })
        fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, 'base64'))
      }
      const rows = () => js(`[...document.querySelectorAll('[data-testid^="builds-row-"]')].map((r) => r.querySelector('b').textContent)`)
      const dropFiles = (files) => js(`(() => {
        const dt = new DataTransfer()
        for (const f of ${JSON.stringify(files)}) { const bin = atob(f.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); dt.items.add(new File([u], f.name, { type: 'application/zip' })) }
        const el = ${q('page-builds')}
        el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
        el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      })()`)
      const z = (extra) => makeZip(plainEntries(extra))
      const zipA = z([{ name: 'a.txt', data: 'a' }]); const zipB = z([{ name: 'b.txt', data: 'b' }]); const zipC = z([{ name: 'c.txt', data: 'c' }])
      const zipTok = makeZip(instrumentedEntries())

      await cdp('Page.enable')
      await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/screenshot*' }] })
      await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
      await cdp('Page.navigate', { url: base })
      await until(`!!${q('nav-builds')}`, 'the Builds rail button')
      await click('nav-builds')
      await until(`!!${q('page-builds')}`, 'the Builds page')
      await until(`/no builds yet/i.test(document.body.innerText)`, 'the empty list')
      await until(`${q('builds-current')}.textContent.length > 4`, 'the device strip')
      expect(await text('builds-store')).toMatch(/store, 0 builds/)
      expect(await text('builds-lease')).toBeTruthy()
      await shot('01-empty.png')

      // Drop two zips: uploaded one after another; the second ends up selected.
      await dropFiles([{ name: 'alpha.zip', b64: zipA.toString('base64') }, { name: 'beta.zip', b64: zipB.toString('base64') }])
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 2`, 'two rows after the drop')
      expect(await text('builds-upload-1')).toMatch(/alpha\.zip/)
      expect(await text('builds-upload-2')).toMatch(/added/)
      await shot('02-dropped.png')

      // File input path (CDP sets the files like a picker would).
      fs.writeFileSync(path.join(tmp, 'gamma.zip'), zipC)
      const doc = await cdp('DOM.getDocument', { depth: 1 })
      const inp = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-testid="builds-file-input"]' })
      await cdp('DOM.setFileInputFiles', { nodeId: inp.nodeId, files: [path.join(tmp, 'gamma.zip')] })
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 3`, 'three rows after the file input')

      // Same zip again is deduped; a non-zip and a manifest-less zip are rejected with the code's text.
      await dropFiles([{ name: 'alpha-again.zip', b64: zipA.toString('base64') }])
      await until(`/already stored/.test(document.body.innerText)`, 'the dedupe note')
      await dropFiles([{ name: 'broken.zip', b64: Buffer.from('this is not a zip file at all').toString('base64') }, { name: 'nomanifest.zip', b64: makeZip([{ name: 'source/main.brs', data: 'x' }]).toString('base64') }, { name: 'notes.txt', b64: Buffer.from('hi').toString('base64') }])
      await until(`document.querySelectorAll('[data-testid="builds-upload-error"]').length === 3`, 'three upload errors')
      const errs = await js(`[...document.querySelectorAll('[data-testid="builds-upload-error"]')].map((e) => e.textContent)`)
      expect(errs.some((e) => /Not a readable zip/.test(e))).toBe(true)
      expect(errs.some((e) => /No manifest at the top/.test(e))).toBe(true)
      expect(errs.some((e) => /Not a \.zip file/.test(e))).toBe(true)
      expect((await rows()).length).toBe(3)
      await shot('03-rejected.png')

      // Rename the three builds, then search / filter / sort / pin.
      const ids = await js(`[...document.querySelectorAll('[data-testid^="builds-row-"]')].map((r) => r.dataset.testid.slice('builds-row-'.length))`)
      const names = {}
      for (const [i, n] of ['Alpha nightly', 'Beta', 'Gamma'].entries()) {
        const fname = ['gamma.zip', 'beta.zip', 'alpha.zip'][i]
        const rid = await js(`[...document.querySelectorAll('[data-testid^="builds-row-"]')].find((r) => r.textContent.includes(${JSON.stringify(fname)})).dataset.testid`)
        await click(rid)
        await setVal('builds-label', ['Gamma', 'Beta', 'Alpha nightly'][i], 'change')
        names[fname] = rid
        await sleep(200)
      }
      expect((await rows()).sort()).toEqual(['Alpha nightly', 'Beta', 'Gamma'])
      await click(names['alpha.zip'])
      await setVal('builds-tags', 'qa, nightly', 'change')
      await setVal('builds-notes', 'smoke test notes', 'blur')
      await click('builds-pin')
      await until(`/Unpin/.test(${q('builds-pin')}.textContent)`, 'the pin to land')
      await setVal('builds-search', 'smoke', 'input')
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 1`, 'search by notes')
      await setVal('builds-search', '', 'input')
      await setVal('builds-filter-tag', 'qa', 'change')
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 1`, 'filter by tag')
      await setVal('builds-filter-tag', '', 'change')
      await js(`${q('builds-filter-pinned')}.click()`)
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 1`, 'filter pinned')
      await js(`${q('builds-filter-pinned')}.click()`)
      await setVal('builds-sort', 'label', 'change')
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 3`, 'all rows again')
      expect((await rows())[0]).toBe('Alpha nightly') // pinned first
      await shot('04-list-details.png')

      // Reload: notes, tags and pin persist.
      await cdp('Page.navigate', { url: base })
      await until(`!!${q('nav-builds')}`, 'reload')
      await click('nav-builds')
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 3`, 'rows after reload')
      await click(names['alpha.zip'])
      expect(await js(`${q('builds-notes')}.value`)).toBe('smoke test notes')
      expect(await js(`${q('builds-tags')}.value`)).toBe('qa, nightly')
      expect(await text('builds-pin')).toBe('Unpin')
      // pinned build cannot be deleted
      await click('builds-delete'); await click('builds-delete-yes')
      await until(`/Unpin the build/.test(document.body.innerText)`, 'the pinned refusal')

      // Install with the replace confirmation, "don't ask again" off first time.
      await click(names['beta.zip'])
      await click('builds-install')
      await until(`!!${q('builds-confirm')}`, 'the confirm dialog')
      expect(await text('builds-confirm')).toMatch(/replaces the dev channel/)
      await shot('05-confirm.png')
      await click('builds-confirm-ok')
      await until(`!!${q('builds-job-result')}`, 'the result')
      expect(await js(`${q('builds-job-result')}.dataset.ok`)).toBe('true')
      expect(await text('builds-job-result')).toMatch(/Installed; dev channel running/)
      expect(await has('builds-job-step-upload')).toBe(true)
      await shot('06-success.png')
      await until(`/ok/.test(${q(names['beta.zip'])}.textContent)`, 'the install chip')

      // 401 and EPIPE failures show the cause and the hint.
      gw.mode = '401'
      await click('builds-install'); await click('builds-confirm-ok')
      await until(`${q('builds-job-result')} && ${q('builds-job-result')}.dataset.ok === 'false'`, '401 result')
      expect(await text('builds-job-result')).toMatch(/Wrong dev password[\s\S]*401/)
      await shot('07-401.png')
      gw.mode = 'epipe'
      await click('builds-install'); await click('builds-confirm-ok')
      await until(`${q('builds-job-result')} && ${q('builds-job-result')}.dataset.ok === 'false' && /EPIPE/.test(${q('builds-job-result')}.textContent)`, 'EPIPE result')
      expect(await text('builds-job-result')).toMatch(/Connection failed/)
      await shot('08-epipe.png')
      await until(`/EPIPE/.test(${q('builds-history')}.textContent)`, 'the failure in the install history')

      // Token warning: an instrumented zip with another hub token needs a second, explicit confirmation.
      gw.mode = 'ok'
      await dropFiles([{ name: 'tokened.zip', b64: zipTok.toString('base64') }])
      await until(`document.querySelectorAll('[data-testid^="builds-row-"]').length === 4`, 'the instrumented build')
      await click('builds-install'); await click('builds-confirm-ok')
      await until(`!!${q('builds-token-warning')}`, 'the token warning')
      expect(await text('builds-token-warning')).toMatch(/different hub token/)
      expect(await text('builds-token-warning')).not.toContain('0123456789abcdef')
      await shot('09-token-warning.png')
      await click('builds-confirm-ok')
      await until(`${q('builds-job-result')} && ${q('builds-job-result')}.dataset.ok === 'true' && !${q('builds-confirm')}`, 'install anyway result')

      // Cancel while the install waits.
      gw.mode = 'hold'
      await click(names['beta.zip'])
      await click('builds-install'); await click('builds-confirm-skip'); await click('builds-confirm-ok')
      await until(`!!${q('builds-job-cancel')}`, 'the cancel button')
      await shot('10-running.png')
      await click('builds-job-cancel')
      await until(`${q('builds-job-result')} && /cancelled/i.test(${q('builds-job-result')}.textContent)`, 'cancelled result')
      await shot('11-cancelled.png')
      expect(await js(`JSON.parse(localStorage.getItem('bt.studio.builds')).confirm`)).toBe(false)
      // With the preference off a plain install goes straight to progress.
      gw.mode = 'ok'
      await click('builds-install')
      expect(await has('builds-confirm')).toBe(false)
      await until(`${q('builds-job-result')} && ${q('builds-job-result')}.dataset.ok === 'true'`, 'install without a dialog')

      // Device strip from the fake Roku, and the Devices page link.
      expect(await text('builds-current')).toMatch(/^On /)
      await shot('12-device-strip.png')
      await click('nav-devices')
      await click('devices-dev-channel')
      await until(`!!${q('page-builds')}`, 'the link to Builds')
    } finally { cleanup() }
  }, 120000)
})
