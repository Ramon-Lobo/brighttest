import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const { createFakeRoku, SCENARIOS, parseArgs } = require('./fixtures/fake-roku/server.js')
const { buildDigestHeader, parseChallenge, createDevice } = require('../lib/e2e/ecp.js')

const stubs = []
async function boot(scenario, extra = {}) {
  const stub = createFakeRoku({ scenario, ...extra })
  const a = await stub.start()
  stubs.push(stub)
  return { stub, a }
}
afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.stop())) })

const ecp = (a, p, init) => fetch(a.ecpUrl + p, init)
const post = (a, p) => ecp(a, p, { method: 'POST' })

async function digest(a, method, uri, body, headers = {}, pw = 'rokudev-test') {
  const first = await fetch(a.installerUrl + uri, { method, body, headers })
  if (first.status !== 401) return first
  const challenge = parseChallenge(first.headers.get('www-authenticate'))
  const auth = buildDigestHeader({ user: 'rokudev', password: pw, method, uri, challenge })
  return fetch(a.installerUrl + uri, { method, body, headers: { ...headers, Authorization: auth } })
}
const form = (action) => {
  const boundary = 'XBOUNDARY'
  return { body: `--${boundary}\r\nContent-Disposition: form-data; name="mysubmit"\r\n\r\n${action}\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
}
const install = (a, action = 'Install') => { const f = form(action); return digest(a, 'POST', '/plugin_install', f.body, f.headers) }

function tcp(port, { send, until, timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    let data = ''
    const s = net.connect(port, '127.0.0.1')
    const t = setTimeout(() => { s.destroy(); resolve(data) }, timeout)
    s.on('data', (d) => {
      data += d.toString()
      if (until && until.test(data)) { clearTimeout(t); s.destroy(); resolve(data) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
    s.on('connect', () => { if (send) s.write(send) })
  })
}

const SCENARIO_NAMES = ['healthy', 'latency-200ms', '5xx-once', '5xx-always', 'reset-once', 'stall', '401', '403', '404',
  'crash-mid-flow', 'limited', 'dev-disabled', 'unreachable', 'cold-stall', 'home-bounce', 'osd-facade', 'system-dialog-root',
  'launch-404-after-sideload', 'sgnodes-fails', 'halted-app', 'installer-page', 'never-leaves-home', 'replay-then-live',
  'debugger-crash', 'large-tree-3k', 'large-tree-6k']

describe('fake-roku scenarios (one smoke test each)', () => {
  it('defines exactly the documented scenarios', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...SCENARIO_NAMES].sort())
    expect(() => createFakeRoku({ scenario: 'nope' })).toThrow(/unknown scenario/)
  })

  it('healthy: device-info, active-app, sgnodes, keypress, launch', async () => {
    const { a } = await boot('healthy')
    expect(a.host).toBe('127.0.0.1')
    const di = await (await ecp(a, '/query/device-info')).text()
    expect(di).toContain('<ecp-setting-mode>permissive</ecp-setting-mode>')
    expect(di).toContain('FAKE-SERIAL-0001')
    expect(await (await ecp(a, '/query/active-app')).text()).toContain('id="dev"')
    const nodes = await (await ecp(a, '/query/sgnodes/all')).text()
    expect(nodes).toContain('name="__bt_agent"')
    expect(await (await ecp(a, '/query/app-ui')).text()).toContain('<status>OK</status>')
    expect((await post(a, '/keypress/Select')).status).toBe(200)
    expect((await post(a, '/launch/dev?contentId=x')).status).toBe(200)
    expect((await post(a, '/input?foo=bar')).status).toBe(200)
    expect((await ecp(a, '/query/nope')).status).toBe(404)
  })

  it('lib/e2e/ecp.js createDevice can talk to the stub on host:port-free URL pieces', async () => {
    const { a } = await boot('healthy')
    expect(typeof createDevice).toBe('function')
    expect((await fetch(`http://${a.host}:${a.ecpPort}/query/device-info`)).status).toBe(200)
  })

  it('latency-200ms', async () => {
    const { a } = await boot('latency-200ms')
    const t = Date.now()
    await ecp(a, '/query/device-info')
    expect(Date.now() - t).toBeGreaterThanOrEqual(190)
  })

  it('5xx-once: first request per endpoint 503, then ok; attempt numbers logged', async () => {
    const { stub, a } = await boot('5xx-once')
    expect((await ecp(a, '/query/device-info')).status).toBe(503)
    expect((await ecp(a, '/query/device-info')).status).toBe(200)
    expect((await ecp(a, '/query/active-app')).status).toBe(503)
    const e = stub.log.filter((l) => l.endpoint === '/query/device-info')
    expect(e.map((x) => x.attempt)).toEqual([1, 2])
    expect(e.map((x) => x.status)).toEqual([503, 200])
  })

  it('5xx-always', async () => {
    const { a } = await boot('5xx-always')
    for (let i = 0; i < 3; i++) expect((await ecp(a, '/query/device-info')).status).toBe(503)
  })

  it('reset-once', async () => {
    const { a } = await boot('reset-once')
    await expect(ecp(a, '/query/device-info')).rejects.toThrow()
    expect((await ecp(a, '/query/device-info')).status).toBe(200)
  })

  it('stall: ECP never answers', async () => {
    const { a } = await boot('stall')
    await expect(ecp(a, '/query/device-info', { signal: AbortSignal.timeout(250) })).rejects.toThrow()
  })

  it.each([401, 403, 404])('%i on every ECP request', async (code) => {
    const { a } = await boot(String(code))
    expect((await ecp(a, '/query/device-info')).status).toBe(code)
  })

  it('crash-mid-flow: third key press crashes the app and prints a debugger transcript', async () => {
    const { stub, a } = await boot('crash-mid-flow')
    const dbg = tcp(a.debugPort, { until: /Runtime Error/, timeout: 2000 })
    await new Promise((r) => setTimeout(r, 100))
    for (const k of ['Down', 'Down', 'Select']) await post(a, `/keypress/${k}`)
    expect(await (await ecp(a, '/query/active-app')).text()).toContain('<app>Roku</app>')
    expect(await (await ecp(a, '/query/sgnodes/all')).text()).toContain('FAILED')
    expect(await dbg).toContain('Brightscript Debugger>')
    expect(stub.keypresses).toHaveLength(3)
  })

  it('limited: only device-info/apps/active-app answer', async () => {
    const { a } = await boot('limited')
    expect(await (await ecp(a, '/query/device-info')).text()).toContain('<ecp-setting-mode>limited</ecp-setting-mode>')
    expect((await ecp(a, '/query/active-app')).status).toBe(200)
    expect((await post(a, '/keypress/Home')).status).toBe(403)
    expect((await ecp(a, '/query/sgnodes/all')).status).toBe(403)
  })

  it('dev-disabled: developer-enabled false, installer 404, launch 404, console closed', async () => {
    const { a } = await boot('dev-disabled')
    expect(await (await ecp(a, '/query/device-info')).text()).toContain('<developer-enabled>false</developer-enabled>')
    expect((await post(a, '/launch/dev')).status).toBe(404)
    expect((await fetch(a.installerUrl + '/plugin_install')).status).toBe(404)
    await expect(tcp(a.consolePort)).rejects.toThrow()
  })

  it('unreachable: nothing listens', async () => {
    const { a } = await boot('unreachable')
    await expect(ecp(a, '/query/device-info')).rejects.toThrow()
    await expect(tcp(a.debugPort)).rejects.toThrow()
  })

  it('cold-stall: sgnodes/all waits after launch (coldStallMs overridable)', async () => {
    const { a } = await boot('cold-stall', { coldStallMs: 400 })
    await post(a, '/launch/dev')
    const t = Date.now()
    await ecp(a, '/query/sgnodes/all')
    expect(Date.now() - t).toBeGreaterThanOrEqual(350)
    const t2 = Date.now()
    await ecp(a, '/query/sgnodes/all')
    expect(Date.now() - t2).toBeLessThan(300)
  })

  it('cold-stall default is about 7 s', async () => {
    const { stub } = await boot('cold-stall')
    expect(stub.config.coldStallMs).toBe(7000)
  })

  it('home-bounce: Roku reported for two queries after launch, then dev', async () => {
    const { a } = await boot('home-bounce')
    await post(a, '/launch/dev')
    const seen = []
    for (let i = 0; i < 3; i++) seen.push((await (await ecp(a, '/query/active-app')).text()).includes('id="dev"'))
    expect(seen).toEqual([false, false, true])
  })

  it('osd-facade: active app is dev but the tree is only an overlay', async () => {
    const { a } = await boot('osd-facade')
    const x = await (await ecp(a, '/query/sgnodes/all')).text()
    expect(x).toContain('node-count="1"')
    expect(x).toContain('OsdOverlay')
  })

  it('system-dialog-root', async () => {
    const { a } = await boot('system-dialog-root')
    expect(await (await ecp(a, '/query/sgnodes/roots')).text()).toContain('SystemDialog')
    expect(await (await ecp(a, '/query/app-ui')).text()).toContain('type="SGDialog"')
  })

  it('launch-404-after-sideload: 404 twice right after install, then 200', async () => {
    const { a } = await boot('launch-404-after-sideload')
    expect((await post(a, '/launch/dev')).status).toBe(200) // nothing sideloaded yet
    expect(await (await install(a)).text()).toContain('Install Success')
    expect((await post(a, '/launch/dev')).status).toBe(404)
    expect((await post(a, '/launch/dev')).status).toBe(404)
    expect((await post(a, '/launch/dev')).status).toBe(200)
  })

  it('sgnodes-fails', async () => {
    const { a } = await boot('sgnodes-fails')
    expect(await (await ecp(a, '/query/sgnodes/all')).text()).toContain('<status>FAILED</status>')
  })

  it('halted-app: tree queries hang and 8085 shows the debugger prompt', async () => {
    const { a } = await boot('halted-app')
    await expect(ecp(a, '/query/sgnodes/all', { signal: AbortSignal.timeout(250) })).rejects.toThrow()
    expect(await tcp(a.debugPort, { until: /Brightscript Debugger>/ })).toContain('Brightscript Debugger>')
  })

  it('installer-page: 200 page with neither Success nor Failure text', async () => {
    const { a } = await boot('installer-page')
    const t = await (await install(a)).text()
    expect(t).toContain('Development Application Installer')
    expect(t).not.toMatch(/Install (Success|Failure)/)
  })

  it('never-leaves-home: launch 200 but active app stays Roku', async () => {
    const { a } = await boot('never-leaves-home')
    expect((await post(a, '/launch/dev')).status).toBe(200)
    expect(await (await ecp(a, '/query/active-app')).text()).toContain('<app>Roku</app>')
  })

  it('replay-then-live: history on connect, then live lines; connection counter', async () => {
    const { stub, a } = await boot('replay-then-live')
    const out = await tcp(a.debugPort, { until: /live line 2/ })
    expect(out.indexOf('scene created')).toBeLessThan(out.indexOf('live line 1'))
    expect(stub.debugConnections).toBe(1)
    await tcp(a.debugPort, { timeout: 100 })
    expect(stub.debugConnections).toBe(2)
  })

  it('debugger-crash: transcript replayed on connect', async () => {
    const { a } = await boot('debugger-crash')
    const out = await tcp(a.debugPort, { until: /Debugger> $/ })
    expect(out).toContain('Runtime Error')
    expect(out).toContain('Backtrace:')
  })

  it.each([['large-tree-3k', 3000], ['large-tree-6k', 6000]])('%s has exactly %i nodes; nodes?node-id= and app-ui work', async (name, n) => {
    const { a } = await boot(name)
    const x = await (await ecp(a, '/query/sgnodes/all')).text()
    expect(x).toContain(`node-count="${n}"`)
    expect(x.match(/_sn="/g).length).toBe(n)
    const sub = await (await ecp(a, '/query/sgnodes/nodes?node-id=2')).text()
    expect(sub).toContain('<status>OK</status>')
    expect((await (await ecp(a, '/query/sgnodes/nodes?node-id=nope')).text())).toContain('FAILED')
    expect(await (await ecp(a, '/query/app-ui')).text()).toContain('<screen')
  })
})

describe('fake-roku features', () => {
  it('scriptable __bt_agent label in sgnodes/all and nodes?node-id=', async () => {
    const { stub, a } = await boot('healthy')
    stub.setAgentText('hello & <world>')
    const all = await (await ecp(a, '/query/sgnodes/all')).text()
    expect(all).toContain('text="hello &amp; &lt;world&gt;"')
    const id = all.match(/name="__bt_agent"[^>]*_sn="(\d+)"/)[1]
    expect(await (await ecp(a, `/query/sgnodes/nodes?node-id=${id}`)).text()).toContain('hello &amp;')
  })

  it('keydown/keyup/keypress entries in the keypress log; Home leaves the app', async () => {
    const { stub, a } = await boot('healthy')
    await post(a, '/keydown/Right'); await post(a, '/keyup/Right'); await post(a, '/keypress/Home')
    expect(stub.keypresses.map((k) => `${k.kind}:${k.key}`)).toEqual(['keydown:Right', 'keyup:Right', 'keypress:Home'])
    expect(await (await ecp(a, '/query/active-app')).text()).toContain('<app>Roku</app>')
  })

  it('runtime fault switches: setFault slow/hang/status', async () => {
    const { stub, a } = await boot('healthy')
    stub.setFault({ mode: 'status', status: 503, once: true })
    expect((await ecp(a, '/query/apps')).status).toBe(503)
    expect((await ecp(a, '/query/apps')).status).toBe(200)
    stub.setFault({ mode: 'hang' })
    await expect(ecp(a, '/query/apps', { signal: AbortSignal.timeout(150) })).rejects.toThrow()
    stub.setFault(null)
    expect((await ecp(a, '/query/apps')).status).toBe(200)
  })

  it('request log: JSONL file with endpoint, start/end, attempt and in-flight count', async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), 'r.jsonl')
    const { stub, a } = await boot('latency-200ms', { logFile })
    await Promise.all([ecp(a, '/query/apps'), ecp(a, '/query/active-app')])
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    for (const l of lines) {
      expect(l.service).toBe('ecp')
      expect(l.endMs).toBeGreaterThanOrEqual(l.startMs)
      expect(l.attempt).toBe(1)
    }
    expect(Math.max(...lines.map((l) => l.inFlight))).toBe(2)
    expect(stub.log).toHaveLength(2)
  })

  it('installer: Digest auth required; wrong password rejected', async () => {
    const { a } = await boot('healthy')
    expect((await fetch(a.installerUrl + '/plugin_install')).status).toBe(401)
    const f = form('Install')
    expect((await digest(a, 'POST', '/plugin_install', f.body, f.headers, 'wrong')).status).toBe(401)
    expect(await (await install(a)).text()).toContain('Install Success')
  })

  it('installer modes: compile failure, transient-once then success after Delete, delete failure, tcp80 closed', async () => {
    let { a } = await boot('healthy', { installerMode: 'compile-failure' })
    expect(await (await install(a)).text()).toContain('Compilation Failed')

    ;({ a } = await boot('healthy', { installerMode: 'transient-once' }))
    expect(await (await install(a)).text()).toContain('Install Failure')
    expect(await (await install(a, 'Delete')).text()).toContain('Deleted')
    expect(await (await install(a)).text()).toContain('Install Success')

    ;({ a } = await boot('healthy', { deleteFails: true }))
    expect(await (await install(a, 'Delete')).text()).toContain('Delete Failure')

    ;({ a } = await boot('healthy', { installerMode: 'tcp80-closed' }))
    await expect(fetch(a.installerUrl + '/')).rejects.toThrow()
    expect((await ecp(a, '/query/device-info')).status).toBe(200)
  })

  it('screenshots: PNG and JPEG via installer, plus "Screenshot not ok"', async () => {
    for (const [fmt, magic] of [['png', 0x89], ['jpg', 0xff]]) {
      const { a } = await boot('healthy', { screenshotFormat: fmt })
      const f = form('Screenshot')
      const page = await (await digest(a, 'POST', '/plugin_inspect', f.body, f.headers)).text()
      expect(page).toContain(`/pkgs/dev.${fmt}`)
      const img = Buffer.from(await (await digest(a, 'GET', `/pkgs/dev.${fmt}`)).arrayBuffer())
      expect(img[0]).toBe(magic)
    }
    const { a } = await boot('healthy', { screenshotOk: false })
    const f = form('Screenshot')
    expect(await (await digest(a, 'POST', '/plugin_inspect', f.body, f.headers)).text()).toContain('Screenshot not ok')
  })

  it('8080 console: banner with fake serial, target list, sgperf, chanperf, logrendezvous', async () => {
    const { a } = await boot('healthy')
    const out = await tcp(a.consolePort, { send: 'target list\r\nsgperf report\r\nchanperf\r\nlogrendezvous on\r\nlogrendezvous off\r\n', until: /rendezvous logging is off/ })
    expect(out).toContain('FAKE-SERIAL-0001 (Roku Ultra')
    expect(out).toContain('[2] Fake Channel')
    expect(out).toContain('thread node calls')
    expect(out).toContain('mem=28460KiB')
    expect(out).toContain('logging is on')
  })

  it('8080 console banner can be split across two TCP chunks', async () => {
    const { a } = await boot('healthy', { bannerSplit: true })
    const chunks = []
    await new Promise((resolve) => {
      const s = net.connect(a.consolePort, '127.0.0.1')
      s.on('data', (d) => { chunks.push(d.toString()); if (chunks.join('').endsWith('>')) { s.destroy(); resolve() } })
    })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).not.toContain('>')
    expect(chunks.join('')).toContain('FAKE-SERIAL-0001')
  })

  it('8085 replays history on every connect', async () => {
    const { stub, a } = await boot('healthy')
    for (let i = 0; i < 2; i++) expect(await tcp(a.debugPort, { until: /catalog loaded/ })).toContain('scene created')
    expect(stub.debugConnections).toBe(2)
  })

  it('emitDebug pushes live lines to connected 8085 clients', async () => {
    const { stub, a } = await boot('healthy')
    const p = tcp(a.debugPort, { until: /custom live/ })
    await new Promise((r) => setTimeout(r, 100))
    stub.emitDebug('custom live')
    expect(await p).toContain('custom live')
  })

  it('parseArgs', () => {
    expect(parseArgs(['--scenario', 'stall', '--ecp-port', '18060', '--list'])).toEqual({ scenario: 'stall', ecpPort: 18060, list: true })
  })
})

describe('fake-roku identifier hygiene (TP-SEC style)', () => {
  it('fixture sources contain only placeholder identifiers', () => {
    const dir = path.join(__dirname, 'fixtures', 'fake-roku')
    const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    const macs = src.match(/\b[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}\b/g) || []
    expect(macs.every((m) => m.startsWith('00:00:5E'))).toBe(true)
    const ips = src.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || []
    expect(ips.filter((i) => !/^(192\.0\.2\.|127\.|0\.0\.0\.0)/.test(i) && !/^16\.0\.4\.853$/.test(i))).toEqual([])
    expect(src).not.toMatch(/\b192\.168\.|\b10\.\d+\.\d+\.\d+\b|REDACTED/)
  })
})
