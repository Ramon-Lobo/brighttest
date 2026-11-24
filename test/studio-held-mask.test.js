import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const sg = require('../lib/e2e/sgnodes.js')
const studio = require('../lib/studio/server.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// Studio with no hub net handed in: the mask paths come from cfg (statePaths fallback). Covers the stale-cache
// /api/tree branch and an old, unmasked run trace on disk. Values are fixtures, not credentials.
let dir, fake, server, port, prevPort, origFetch, impl
const LEAK = /tok-secret|Zed|LEAKME/
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
  }).on('error', reject)
})
const cfg = { instrument: { state: { redact: { paths: ['global.user.nickname', 'a.b'] } } } }

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-held-mask-'))
  const old = path.join(dir, '.brighttest', 'studio', 'runs', '5')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'meta.json'), JSON.stringify({ id: 5, flow: 'x', startedAt: 1, ok: true, steps: [{ index: 0, op: 'press', status: 'pass', nodes: [{ id: '__bt_agent', text: '"LEAKME"', attrs: { text: 'LEAKME' } }], appState: { present: true, state: { token: 'LEAKME', a: { b: 'LEAKME' }, n: 1 }, error: null, raw: 'LEAKME' } }] }))
  fs.mkdirSync(path.join(dir, '.brighttest', 'studio', 'runs', '6'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.brighttest', 'studio', 'runs', '6', 'meta.json'), JSON.stringify({ id: 6, flow: 'y' }))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  origFetch = sg.fetchTree
  const real = origFetch
  impl = (...args) => real(...args)
  sg.fetchTree = (...args) => impl(...args)
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, cfg, leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
})
afterEach(async () => {
  sg.fetchTree = origFetch
  server.close(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Studio masking without a handed-in net (cfg fallback)', () => {
  it('masks /api/tree with instrument.state.redact.paths from cfg, fresh and from the stale cache', async () => {
    fake.setAgentText(JSON.stringify({ v: 1, seq: 1, snapshot: { layers: { global: { user: { token: 'tok-secret', nickname: 'Zed', tier: 'free' } } } } }))
    const fresh = await get('/api/tree')
    expect(fresh.status).toBe(200)
    expect(fresh.json.agent.layers.global.state.user).toEqual({ token: '<redacted:token>', nickname: '<redacted:nickname>', tier: 'free' })
    expect(fresh.text).not.toMatch(LEAK)
    impl = async () => { throw Object.assign(new Error('busy'), { code: 'RPC_TIMEOUT' }) }
    const stale = await get('/api/tree')
    expect(stale.json.stale).toBe(true)
    expect(stale.text).not.toMatch(LEAK)
    expect(stale.json.agent.layers.global.state.user.nickname).toBe('<redacted:nickname>')
  })
  it('skips a meta.json without a steps array and masks each step field on its own', () => {
    const { maskStep } = studio._test
    const s = maskStep({ index: 0, nodes: [{ id: '__bt_agent', text: '"LEAKME"' }], appState: { present: true, state: { token: 'LEAKME' } } }, [])
    expect(JSON.stringify(s)).not.toMatch(LEAK)
    // a throwing nodes list nulls only nodes; appState stays masked
    const bad = { get id() { throw new Error('boom') } }
    const t = maskStep({ index: 1, nodes: [bad], appState: { present: true, state: { token: 'LEAKME', n: 1 } } }, [])
    expect(t.nodes).toBeNull()
    expect(t.appState.state).toEqual({ token: '<redacted:token>', n: 1 })
  })
  it('serves and rewrites a pre-fix unmasked run trace masked', async () => {
    const r = await get('/api/runs/5')
    expect(r.status).toBe(200)
    expect((await get('/api/runs/6')).status).toBe(404)
    expect(r.text).not.toMatch(LEAK)
    expect(r.json.steps[0].appState.state).toEqual({ token: '<redacted:token>', a: { b: '<redacted:b>' }, n: 1 })
    expect(r.json.steps[0].appState).not.toHaveProperty('raw')
    expect(r.json.steps[0].nodes[0].text).toBe('<redacted:text>')
    expect(fs.readFileSync(path.join(dir, '.brighttest', 'studio', 'runs', '5', 'meta.json'), 'utf8')).not.toMatch(LEAK)
  })
})
