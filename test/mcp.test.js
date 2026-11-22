import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import fs from 'node:fs'
import path from 'node:path'
import { bootStub, startMcp, payload, cleanupMcp, tmpdir, PASSWORD } from './fixtures/mcp-harness.js'

afterEach(cleanupMcp)

const FLOWS = path.resolve(__dirname, 'fixtures/fake-roku/flows')
const fakeLog = (stub, re) => stub.log.filter((e) => re.test(e.endpoint || ''))
const isErr = (res) => res.result.isError === true

async function ready(scenario = 'healthy', opts = {}) {
  const { stub, a } = await bootStub(scenario, opts.stub)
  const c = startMcp({ a, ...opts })
  await c.initialize()
  return { stub, a, c }
}

describe('TP-MCP-01 initialize handshake', () => {
  it('negotiates, answers ping, and keeps stdout to JSON lines', async () => {
    const c = startMcp({})
    const r = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(r.result.protocolVersion).toBe('2025-06-18')
    expect(r.result.capabilities.tools).toBeTruthy()
    expect(r.result.serverInfo.name).toContain('brighttest')
    expect(r.result.serverInfo.version).toMatch(/^\d+\.\d+/)
    expect(r.result.instructions).toContain('brighttest-mcp/v1')
    c.send({ method: 'notifications/initialized' })
    expect((await c.request('ping')).result).toEqual({})
    expect(c.stderr()).toBe('')
  })
  it('answers an unsupported protocolVersion with the latest supported one', async () => {
    const c = startMcp({})
    const r = await c.request('initialize', { protocolVersion: '1999-01-01' })
    expect(r.result.protocolVersion).toBe('2025-06-18')
  })
})

describe('TP-MCP-02 JSON-RPC error shapes', () => {
  it('maps every malformed input to its code and keeps serving', async () => {
    const { c } = await ready()
    c.sendRaw('this is not json')
    expect((await (async () => { for (let i = 0; i < 200; i++) { const m = c.lines.find((x) => x.error && x.error.code === -32700); if (m) return m; await new Promise((r) => setTimeout(r, 10)) } })()).id).toBe(null)
    c.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 903 }))
    await expect.poll(() => c.lines.find((m) => m.id === 903)).toMatchObject({ error: { code: -32600 } })
    expect((await c.request('foo/bar')).error.code).toBe(-32601)
    expect((await c.tool('no_such_tool')).error.code).toBe(-32602)
    const bad = await c.tool('press', { key: 'Down', count: 'abc' })
    expect(bad.error.code).toBe(-32602)
    expect(bad.error.message).toContain('arguments.count')
    expect((await c.tool('press', { key: 'Down', extra: 1 })).error.message).toContain('arguments.extra')
    expect((await c.tool('press', {})).error.message).toContain('arguments.key')
    expect((await c.request('ping')).result).toEqual({})
  })
  it('rejects a request before initialize without crashing', async () => {
    const c = startMcp({})
    const r = await c.request('tools/list')
    expect(r.error.code).toBe(-32002)
    expect((await c.request('ping')).result).toEqual({})
  })
})

describe('TP-MCP-04 list_devices and device_doctor', () => {
  it('lists the stub with model and firmware and no serial or password', async () => {
    const { c } = await ready()
    const text = JSON.stringify((await c.tool('list_devices')).result)
    const d = payload(await c.tool('list_devices'))
    expect(d.active).toMatchObject({ host: '127.0.0.1', reachable: true })
    expect(d.active.model).toBeTruthy()
    expect(d.active.firmware).toBeTruthy()
    expect(text).not.toContain('FAKE-SERIAL-0001')
    expect(text).not.toContain(PASSWORD)
  })
  it('doctor returns the capability record without the serial', async () => {
    const { c } = await ready()
    const res = await c.tool('device_doctor')
    expect(isErr(res)).toBe(false)
    const d = payload(res)
    expect(d).toMatchObject({ reachable: true, developerEnabled: true })
    expect(d.softwareVersion).toBeTruthy()
    expect(d.serial).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain('FAKE-SERIAL-0001')
  })
  it('limited mode reports the fix text', async () => {
    const { c } = await ready('limited')
    const d = payload(await c.tool('device_doctor'))
    expect(d.checks.find((k) => k.id === 'ecp-mode')).toMatchObject({ ok: false })
    expect(d.checks.find((k) => k.id === 'ecp-mode').fix).toContain('Permissive')
  })
  it('an unreachable device is a typed error, not a hang', async () => {
    const { c } = await ready('unreachable')
    const t0 = Date.now()
    const res = await c.tool('device_doctor')
    expect(isErr(res)).toBe(true)
    expect(payload(res)).toMatchObject({ code: 'DEVICE_UNREACHABLE' })
    expect(Date.now() - t0).toBeLessThan(10000)
    expect(payload(await c.tool('list_devices')).active.reachable).toBe(false)
  })
  it('no configured device is a typed error that names the out-of-band setup', async () => {
    const c = startMcp({})
    await c.initialize()
    const res = await c.tool('device_doctor')
    expect(payload(res).code).toBe('NO_DEVICE')
    expect(payload(res).message).toContain('ROKU_HOST')
  })
})

describe('TP-MCP-05 inspect_tree', () => {
  it('returns the tree, matches by selector, and an empty match is not an error', async () => {
    const { c } = await ready()
    const full = payload(await c.tool('inspect_tree'))
    expect(full.nodes.length).toBeGreaterThan(3)
    expect(full.nodes.find((n) => n.id === 'title')).toMatchObject({ subtype: 'Label', text: 'Home' })
    const one = payload(await c.tool('inspect_tree', { selector: { id: 'title' } }))
    expect(one.matches).toHaveLength(1)
    expect(one.matches[0]).toMatchObject({ id: 'title', text: 'Home' })
    const none = await c.tool('inspect_tree', { selector: { id: 'neverThere' } })
    expect(isErr(none)).toBe(false)
    expect(payload(none).matches).toEqual([])
  })
  it('flags truncation on a large tree and never returns more than the cap', async () => {
    const { c } = await ready('large-tree-3k', { limits: { maxTreeNodes: 100 } })
    const d = payload(await c.tool('inspect_tree'))
    expect(d.totalNodes).toBeGreaterThan(2000)
    expect(d.returned).toBe(100)
    expect(d.truncated).toBe(true)
    expect(d.truncatedReason).toBe('node-cap')
  })
  it('flags a byte cap', async () => {
    const { c } = await ready('large-tree-3k', { limits: { maxTreeBytes: 2000 } })
    const d = payload(await c.tool('inspect_tree'))
    expect(d.truncated).toBe(true)
    expect(d.truncatedReason).toBe('byte-cap')
    expect(d.bytes).toBeLessThanOrEqual(2000)
  })
  it('a selector with no matching key is a typed error', async () => {
    const { c } = await ready()
    expect(payload(await c.tool('inspect_tree', { selector: { index: 1 } })).code).toBe('INVALID_SELECTOR')
    expect((await c.tool('inspect_tree', { selector: {} })).error.code).toBe(-32602)
  })
})

describe('TP-MCP-06 press goes through the queue', () => {
  it('serializes presses with the configured gap, also across concurrent calls', async () => {
    const { stub, c } = await ready('healthy', { limits: { pressGapMs: 120 } })
    const a = c.toolAsync('press', { key: 'Down', count: 3 })
    const b = c.toolAsync('press', { key: 'Up', count: 2 })
    expect(payload(await a).pressed).toBe(3)
    expect(payload(await b).pressed).toBe(2)
    const presses = fakeLog(stub, /^\/keypress\//).sort((x, y) => x.startMs - y.startMs)
    expect(presses.map((p) => p.endpoint)).toHaveLength(5)
    for (let i = 1; i < presses.length; i++) {
      expect(presses[i].startMs - presses[i - 1].endMs).toBeGreaterThanOrEqual(100)
    }
  })
  it('an invalid key lists the valid keys and sends no ECP request', async () => {
    const { stub, c } = await ready()
    const before = stub.log.length
    const res = await c.tool('press', { key: 'Dwon' })
    expect(isErr(res)).toBe(true)
    expect(payload(res).code).toBe('INVALID_KEY')
    expect(payload(res).message).toContain('Down')
    expect(stub.log.length).toBe(before)
  })
})

describe('TP-MCP-07 navigate_to and screenshot', () => {
  it('navigates a grid and reports keys and the focused node', async () => {
    const { c } = await ready('focus-grid', { limits: { pressGapMs: 0 } })
    const d = payload(await c.tool('navigate_to', { selector: { id: 'item5' } }))
    expect(d.keys.length).toBe(d.presses)
    expect(d.presses).toBeGreaterThan(0)
    expect(d.focused.id).toBe('item5')
  })
  it('an unreachable target returns the last focused node', async () => {
    const { c } = await ready('focus-grid', { limits: { pressGapMs: 0 } })
    const res = await c.tool('navigate_to', { selector: { id: 'nope' } })
    expect(isErr(res)).toBe(true)
    expect(payload(res)).toMatchObject({ code: 'FOCUS_FAILED' })
    expect(payload(res).lastFocused.id).toBe('item1')
  })
  it('screenshot returns an MCP image', async () => {
    const { c } = await ready('healthy')
    const res = await c.tool('screenshot')
    const img = res.result.content.find((x) => x.type === 'image')
    expect(['image/png', 'image/jpeg']).toContain(img.mimeType)
    const bytes = Buffer.from(img.data, 'base64')
    expect(bytes.length).toBeGreaterThan(8)
    expect(img.mimeType === 'image/png' ? bytes[0] === 0x89 : bytes[0] === 0xff).toBe(true)
  })
  it('"Screenshot not ok" is a typed error without a retry loop', async () => {
    const { stub, c } = await ready('healthy', { stub: { screenshotOk: false } })
    const res = await c.tool('screenshot')
    expect(payload(res).code).toBe('SCREENSHOT_NOT_FOREGROUND')
    expect(stub.log.filter((e) => e.endpoint === '/plugin_inspect' && e.status === 200).length).toBe(1)
  })
  it('screenshot over the byte cap is a typed error', async () => {
    const { c } = await ready('healthy', { limits: { maxScreenshotBytes: 4 } })
    expect(payload(await c.tool('screenshot')).code).toBe('SCREENSHOT_TOO_LARGE')
  })
  it('without a dev password the error names the out-of-band setup', async () => {
    const { a } = await bootStub('healthy')
    const c = startMcp({ a, password: null })
    await c.initialize()
    const d = payload(await c.tool('screenshot'))
    expect(d.code).toBe('NO_DEV_PASSWORD')
  })
})

describe('app_state', () => {
  it('says the build is not instrumented when __bt_state is absent', async () => {
    const { c } = await ready()
    expect(payload(await c.tool('app_state')).code).toBe('STATE_NOT_PUBLISHED')
  })
})

describe('TP-MCP-08 run_flow and path confinement', () => {
  function project() {
    const dir = tmpdir('bt-mcp-proj-')
    fs.mkdirSync(path.join(dir, 'flows'))
    for (const f of ['fake-smoke.e2e.yaml', 'fake-wait-missing.e2e.yaml']) fs.copyFileSync(path.join(FLOWS, f), path.join(dir, 'flows', f))
    return dir
  }
  it('runs a passing flow and reports a failing one with the step', async () => {
    const cwd = project()
    const { c } = await ready('healthy', { cwd, limits: { pressGapMs: 0 } })
    const ok = await c.tool('run_flow', { path: 'flows/fake-smoke.e2e.yaml' })
    expect(isErr(ok)).toBe(false)
    const d = payload(ok)
    expect(d.steps.every((s) => s.ok)).toBe(true)
    expect(d.passed).toBe(d.total)
    const bad = await c.tool('run_flow', { path: 'flows/fake-wait-missing.e2e.yaml' })
    expect(isErr(bad)).toBe(true)
    const f = payload(bad)
    expect(f.code).toBe('FLOW_FAILED')
    expect(f.steps.find((s) => !s.ok)).toMatchObject({ index: 1, ok: false })
    expect(f.failedStep).toBe(1)
  }, 30000)
  it('rejects every confinement row before any file read or ECP call', async () => {
    const cwd = project()
    const outside = tmpdir('bt-mcp-out-')
    fs.copyFileSync(path.join(FLOWS, 'fake-smoke.e2e.yaml'), path.join(outside, 'x.e2e.yaml'))
    fs.symlinkSync(path.join(outside, 'x.e2e.yaml'), path.join(cwd, 'flows', 'link.e2e.yaml'))
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x')
    const { stub, c } = await ready('healthy', { cwd })
    const rows = ['../outside.e2e.yaml', path.join(outside, 'x.e2e.yaml'), 'flows/../../package.json', 'flows/link.e2e.yaml', 'notes.txt', 'C:\\x.e2e.yaml']
    const table = []
    for (const p of rows) {
      const before = stub.log.length
      const res = await c.tool('run_flow', { path: p })
      expect(isErr(res), p).toBe(true)
      expect(payload(res).code, p).toBe('PATH_REJECTED')
      expect(payload(res).message, p).toMatch(/absolute|\.\.|only \*\.e2e|outside/)
      expect(stub.log.length, p).toBe(before)
      table.push({ input: p, rejected: true })
    }
    expect(table).toHaveLength(rows.length)
    expect(payload(await c.tool('run_flow', { path: 'flows/missing.e2e.yaml' })).code).toBe('FLOW_NOT_FOUND')
  })
})

describe('run_flow nested runFlow confinement', () => {
  it('confines every nested file like the top-level path and echoes no file content', async () => {
    const cwd = tmpdir('bt-mcp-proj-')
    const outside = tmpdir('bt-mcp-out-')
    fs.mkdirSync(path.join(cwd, 'flows'))
    fs.writeFileSync(path.join(outside, 'secret.e2e.yaml'), 'TOP-SECRET-CONTENT: [\n')
    fs.copyFileSync(path.join(FLOWS, 'fake-smoke.e2e.yaml'), path.join(outside, 'ok.e2e.yaml'))
    fs.symlinkSync(path.join(outside, 'ok.e2e.yaml'), path.join(cwd, 'flows', 'link.e2e.yaml'))
    fs.copyFileSync(path.join(FLOWS, 'fake-smoke.e2e.yaml'), path.join(cwd, 'flows', 'inside.e2e.yaml'))
    fs.writeFileSync(path.join(cwd, 'flows', 'bad.e2e.yaml'), 'LOCAL-FILE-CONTENT: [\n')
    const mk = (name, file) => fs.writeFileSync(path.join(cwd, 'flows', name), `appId: dev\nsteps:\n  - runFlow: { file: ${JSON.stringify(file)} }\n`)
    const rows = {
      'outside.e2e.yaml': path.join('..', '..', path.basename(outside), 'secret.e2e.yaml'),
      'dots.e2e.yaml': '../../x.e2e.yaml',
      'abs.e2e.yaml': path.join(outside, 'secret.e2e.yaml'),
      'sym.e2e.yaml': 'link.e2e.yaml',
    }
    for (const [name, file] of Object.entries(rows)) mk(name, file)
    mk('badparse.e2e.yaml', 'bad.e2e.yaml')
    mk('good.e2e.yaml', 'inside.e2e.yaml')
    const { stub, c } = await ready('healthy', { cwd, limits: { pressGapMs: 0, maxFlowRunsPerSession: 20 } })
    for (const name of Object.keys(rows)) {
      const before = fakeLog(stub, /^\/keypress\//).length
      const res = await c.tool('run_flow', { path: `flows/${name}` })
      const d = payload(res)
      expect(isErr(res), name).toBe(true)
      expect(d.message, name).toMatch(/PATH_REJECTED|path rejected/)
      expect(JSON.stringify(res), name).not.toContain('TOP-SECRET-CONTENT')
      expect(fakeLog(stub, /^\/keypress\//).length, name).toBe(before)
    }
    const bad = await c.tool('run_flow', { path: 'flows/badparse.e2e.yaml' })
    expect(isErr(bad)).toBe(true)
    expect(JSON.stringify(bad)).not.toContain('LOCAL-FILE-CONTENT')
    expect(isErr(await c.tool('run_flow', { path: 'flows/good.e2e.yaml' }))).toBe(false)
  }, 60000)
})

describe('protocol hygiene', () => {
  it('never answers a notification, ignores client responses, rejects object ids', async () => {
    const c = startMcp({})
    c.send({ method: 'initialize', params: { protocolVersion: '2025-06-18' } }) // initialize as a notification
    c.send({ method: 'foo/bar' })
    c.send({ method: 'tools/call', params: { name: 'nope' } })
    c.send({ id: 5, result: {} })
    c.send({ id: 6, error: { code: 1, message: 'x' } })
    c.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 7 }))
    c.send({ id: { a: 1 }, method: 'ping' })
    expect((await c.request('ping')).result).toEqual({})
    await new Promise((r) => setTimeout(r, 100))
    const answered = c.lines.filter((m) => !(m.id >= 1000 || m.id === 1))
    expect(answered.filter((m) => m.error && m.id === null).map((m) => m.error.code)).toEqual([-32600, -32600])
    expect(c.lines.some((m) => m.id === 5 || m.id === 6)).toBe(false)
    expect(c.lines).toHaveLength(3) // two -32600 plus the ping answer
  })
  it('drops 2025-03-26 and answers with a supported version', async () => {
    const c = startMcp({})
    expect((await c.request('initialize', { protocolVersion: '2025-03-26' })).result.protocolVersion).toBe('2025-06-18')
  })
  it('rejects an over-long line without crashing', async () => {
    const c = startMcp({})
    await c.initialize()
    c.sendRaw('x'.repeat(1024 * 1024 + 10))
    await expect.poll(() => c.lines.some((m) => m.error && m.error.code === -32700)).toBe(true)
    expect((await c.request('ping')).result).toEqual({})
  })
  it('blocks power and input-switch keys but allows volume keys', async () => {
    const { stub, c } = await ready('healthy', { limits: { pressGapMs: 0 } })
    for (const k of ['PowerOff', 'InputHDMI1', 'InputTuner', 'InputAV1']) expect(payload(await c.tool('press', { key: k })).code, k).toBe('KEY_NOT_ALLOWED')
    expect(fakeLog(stub, /^\/keypress\//)).toHaveLength(0)
    expect(isErr(await c.tool('press', { key: 'VolumeUp' }))).toBe(false)
  })
  it('counts bytes, not characters, for an over-long line', async () => {
    const c = startMcp({})
    await c.initialize()
    c.sendRaw('\u20ac'.repeat(400000)) // 400k characters, 1.2 MB
    await expect.poll(() => c.lines.some((m) => m.error && m.error.code === -32700)).toBe(true)
    expect((await c.request('ping')).result).toEqual({})
  })
  it('says "an object" in argument errors', async () => {
    const { c } = await ready()
    expect((await c.tool('inspect_tree', { selector: 5 })).error.message).toContain('must be an object')
  })
})

describe('TP-MCP-09 lease per tool call', () => {
  const leaseLib = require('../lib/device-lease.js')
  const tryLease = (a, dir) => leaseLib.acquire({ host: '127.0.0.1', port: a.ecpPort, waitMs: 0, mode: 'command', env: { ...process.env, BRIGHTTEST_LEASE_DIR: dir, BRIGHTTEST_LEASE: '' }, onWait: () => {}, purpose: 'test holder' })

  it('holds the lease only while a device call runs, and read-only tools take none', async () => {
    const { a } = await bootStub('healthy')
    const leaseDir = tmpdir('bt-mcp-lease-')
    const A = startMcp({ a, leaseDir, limits: { pressGapMs: 0 } })
    await A.initialize()
    expect(isErr(await A.tool('device_doctor'))).toBe(false)
    expect(isErr(await A.tool('list_devices'))).toBe(false)
    expect(isErr(await A.tool('press', { key: 'Down' }))).toBe(false)
    expect(A.server.session.lease).toBe(null)
    const l = await tryLease(a, leaseDir) // free between calls: another party can take it
    l.release()
    expect(isErr(await A.tool('inspect_tree'))).toBe(false)
  })
  it('fails fast with DEVICE_BUSY and sends no ECP request while another party holds the device', async () => {
    const { stub, a } = await bootStub('healthy')
    const leaseDir = tmpdir('bt-mcp-lease-')
    const B = startMcp({ a, leaseDir, limits: { pressGapMs: 0 } })
    await B.initialize()
    const holder = await tryLease(a, leaseDir)
    const before = stub.log.length
    for (const [n, args] of [['press', { key: 'Down' }], ['inspect_tree'], ['screenshot'], ['app_state'], ['navigate_to', { selector: { id: 'x' } }]]) {
      expect(payload(await B.tool(n, args)).code, n).toBe('DEVICE_BUSY')
    }
    expect(stub.log.length).toBe(before)
    holder.release()
    expect(isErr(await B.tool('press', { key: 'Down' }))).toBe(false)
  })
  it('releases the lease after a timeout only once the stuck request has ended', async () => {
    const { stub, a } = await bootStub('healthy', { fault: { mode: 'slow', ms: 2500, path: '/keypress/*' } })
    const leaseDir = tmpdir('bt-mcp-lease-')
    const A = startMcp({ a, leaseDir, limits: { toolTimeoutMs: 500, pressGapMs: 0 } })
    await A.initialize()
    const t0 = Date.now()
    expect(payload(await A.tool('press', { key: 'Down' })).code).toBe('TOOL_TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(2000)
    await expect(tryLease(a, leaseDir)).rejects.toMatchObject({ code: expect.stringMatching(/BUSY|TIMEOUT/) }) // still held: request in flight
    let l = null
    for (let i = 0; i < 120 && !l; i++) { try { l = await tryLease(a, leaseDir) } catch { await new Promise((r) => setTimeout(r, 50)) } }
    expect(l).toBeTruthy()
    const acquiredAt = Date.now()
    l.release()
    const presses = fakeLog(stub, /^\/keypress\//)
    expect(presses).toHaveLength(1)
    expect(presses[0].endMs).toBeLessThanOrEqual(acquiredAt) // no keypress reaches the device under another holder
  }, 20000)
  it('releases the lease when a call errors', async () => {
    const { a } = await bootStub('healthy')
    const leaseDir = tmpdir('bt-mcp-lease-')
    const A = startMcp({ a, leaseDir })
    await A.initialize()
    expect(payload(await A.tool('inspect_tree', { selector: { index: 1 } })).code).toBe('INVALID_SELECTOR')
    ;(await tryLease(a, leaseDir)).release()
  })
  it('closing stdin mid-call stops the call and releases the lease', async () => {
    const { stub, a } = await bootStub('healthy')
    const leaseDir = tmpdir('bt-mcp-lease-')
    const A = startMcp({ a, leaseDir, limits: { pressGapMs: 250 } })
    await A.initialize()
    const p = A.toolAsync('press', { key: 'Down', count: 20 })
    for (let i = 0; i < 400 && fakeLog(stub, /^\/keypress\//).length < 3; i++) await new Promise((r) => setTimeout(r, 10))
    await A.close()
    const n = fakeLog(stub, /^\/keypress\//).length
    expect(n).toBeGreaterThanOrEqual(3)
    expect(n).toBeLessThan(20)
    expect(payload(await p).code).toBe('SESSION_CLOSED')
    await new Promise((r) => setTimeout(r, 600))
    expect(fakeLog(stub, /^\/keypress\//).length).toBeLessThanOrEqual(n)
    expect(A.server.session.lease).toBe(null)
    ;(await tryLease(a, leaseDir)).release()
  }, 20000)
  it('a lost lease is a LEASE_LOST tool error, never a process exit', async () => {
    const { a } = await bootStub('healthy')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called') })
    let lost
    const fakeLib = { acquire: async (o) => { lost = o.onLost; return { release() {} } } }
    // a real gap keeps the call running when the lease is lost (a zero gap can finish all 20 presses first)
    const c = startMcp({ a, leaseLib: fakeLib, limits: { pressGapMs: 250 } })
    await c.initialize()
    const p = c.toolAsync('press', { key: 'Down', count: 20 })
    for (let i = 0; i < 100 && !lost; i++) await new Promise((r) => setTimeout(r, 10))
    lost('heartbeat failed')
    const res = await p
    expect(payload(res).code).toBe('LEASE_LOST')
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})

describe('TP-MCP-10 budgets and timeouts', () => {
  it('refuses presses past the session cap with a typed error and keeps counting honestly', async () => {
    const { stub, c } = await ready('healthy', { limits: { maxPressesPerSession: 3, pressGapMs: 0 } })
    expect(payload(await c.tool('press', { key: 'Down', count: 3 })).pressed).toBe(3)
    const res = await c.tool('press', { key: 'Down' })
    expect(isErr(res)).toBe(true)
    expect(payload(res)).toMatchObject({ code: 'PRESS_BUDGET_EXHAUSTED', cap: 3 })
    expect(payload(res).message).toContain('new MCP session')
    expect(fakeLog(stub, /^\/keypress\//)).toHaveLength(3)
  })
  it('refuses flow runs past the session cap', async () => {
    const cwd = tmpdir('bt-mcp-proj-')
    fs.copyFileSync(path.join(FLOWS, 'fake-smoke.e2e.yaml'), path.join(cwd, 'a.e2e.yaml'))
    const { c } = await ready('healthy', { cwd, limits: { maxFlowRunsPerSession: 1, pressGapMs: 0 } })
    expect(isErr(await c.tool('run_flow', { path: 'a.e2e.yaml' }))).toBe(false)
    expect(payload(await c.tool('run_flow', { path: 'a.e2e.yaml' })).code).toBe('FLOW_BUDGET_EXHAUSTED')
  })
  it('a hung device call times out while the server keeps answering ping', async () => {
    const { c } = await ready('stall', { limits: { toolTimeoutMs: 400 } })
    const pending = c.toolAsync('inspect_tree')
    expect((await c.request('ping')).result).toEqual({})
    const res = await pending
    expect(payload(res)).toMatchObject({ code: 'TOOL_TIMEOUT', budgetMs: 400 })
    expect((await c.request('ping')).result).toEqual({})
  })
})

describe('TP-MCP-10b timeouts stop the work', () => {
  it('sends no ECP request after TOOL_TIMEOUT', async () => {
    const { stub, c } = await ready('healthy', { limits: { toolTimeoutMs: 700, pressGapMs: 250 } })
    const res = await c.tool('press', { key: 'Down', count: 20 })
    expect(payload(res).code).toBe('TOOL_TIMEOUT')
    expect(payload(res).message).toContain('no further device requests')
    const atTimeout = fakeLog(stub, /^\/keypress\//).length
    expect(atTimeout).toBeGreaterThan(0)
    expect(atTimeout).toBeLessThan(20)
    await new Promise((r) => setTimeout(r, 1000))
    expect(fakeLog(stub, /^\/keypress\//).length).toBeLessThanOrEqual(atTimeout + 1) // one request may have been in flight
  })
  it('a call that times out while queued never runs', async () => {
    const { stub, c } = await ready('healthy', { limits: { toolTimeoutMs: 5000, queueWaitMs: 150, pressGapMs: 250 } })
    const first = c.toolAsync('press', { key: 'Down', count: 4 })
    const second = c.toolAsync('press', { key: 'Left' })
    const res = await second
    expect(payload(res).code).toBe('QUEUE_TIMEOUT')
    expect(payload(res).message).toContain('before it ran')
    expect(payload(await first).pressed).toBe(4)
    await new Promise((r) => setTimeout(r, 400))
    expect(fakeLog(stub, /^\/keypress\/Left/)).toHaveLength(0)
  })
})

describe('TP-MCP-11 transient ECP failure', () => {
  it('retries an idempotent read once after a 503', async () => {
    const { stub, c } = await ready('5xx-once')
    expect(isErr(await c.tool('inspect_tree'))).toBe(false)
    const reads = fakeLog(stub, /^\/query\/sgnodes\/all/)
    expect(reads.map((r) => r.status).slice(0, 2)).toEqual([503, 200])
  })
  it('does not retry a keypress after a 5xx (it may have been delivered) and reports it', async () => {
    const { stub, c } = await ready('5xx-once', { limits: { pressGapMs: 0 } })
    const res = await c.tool('press', { key: 'Down' })
    expect(isErr(res)).toBe(true)
    expect(payload(res).pressed).toBe(0)
    expect(fakeLog(stub, /^\/keypress\//)).toHaveLength(1)
  })
  it('does not retry client errors', async () => {
    const { stub, c } = await ready('404', { limits: { pressGapMs: 0 } })
    expect(isErr(await c.tool('press', { key: 'Down' }))).toBe(true)
    expect(fakeLog(stub, /^\/keypress\//)).toHaveLength(1)
  })
})

describe('TP-MCP-12 no secrets in any output', () => {
  it('never echoes the password or the serial', async () => {
    const marker = 'PW-MARKER-9f3a1c'
    const { a } = await bootStub('healthy', { password: marker })
    const cwd = tmpdir('bt-mcp-proj-')
    fs.copyFileSync(path.join(FLOWS, 'fake-smoke.e2e.yaml'), path.join(cwd, 'a.e2e.yaml'))
    const c = startMcp({ a, cwd, password: marker, limits: { pressGapMs: 0 } })
    await c.initialize()
    for (const [n, args] of [['list_devices'], ['device_doctor'], ['inspect_tree'], ['press', { key: 'Down' }], ['screenshot'], ['app_state'], ['run_flow', { path: 'a.e2e.yaml' }]]) await c.tool(n, args)
    const all = JSON.stringify(c.lines) + c.stderr()
    expect(all).not.toContain(marker)
    expect(all).not.toContain('FAKE-SERIAL-0001')
  }, 30000)
})
