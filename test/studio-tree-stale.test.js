import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const lease = require('../lib/device-lease.js')
const sg = require('../lib/e2e/sgnodes.js')
const studio = require('../lib/studio/server.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// /api/tree when the sgnodes read fails transiently (render thread busy): last good tree with stale:true,
// else 503 + Retry-After, never 502. Lease loss stays 423; other errors keep the 502 catch-all.
let dir, fake, server, port, prevPort, origFetch, impl
const typed = (code, msg = code) => Object.assign(new Error(msg), { code })

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
    }).on('error', reject)
  })
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-tree-stale-'))
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
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir, leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
})
afterEach(async () => {
  sg.fetchTree = origFetch
  server.close(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('/api/tree transient sgnodes failures', () => {
  it('serves the last good tree as stale after RPC_TIMEOUT, then recovers to a fresh tree', async () => {
    const fresh = await get('/api/tree')
    expect(fresh.status).toBe(200)
    expect(fresh.json).not.toHaveProperty('stale')
    impl = async () => { throw typed('RPC_TIMEOUT', 'sgnodes timed out after 4 attempts (render thread busy?).') }
    const stale = await get('/api/tree')
    expect(stale.status).toBe(200)
    expect(stale.json.stale).toBe(true)
    expect(Number.isNaN(Date.parse(stale.json.staleSince))).toBe(false)
    expect(stale.json.nodes).toEqual(fresh.json.nodes)
    impl = origFetch
    const back = await get('/api/tree')
    expect(back.status).toBe(200)
    expect(back.json).not.toHaveProperty('stale')
  })

  it.each(['SGNODES_FAILED', 'ECONNRESET'])('treats %s as transient too', async (code) => {
    await get('/api/tree')
    impl = async () => { throw typed(code) }
    expect((await get('/api/tree')).json.stale).toBe(true)
  })

  it('treats a fetch timeout (TimeoutError) as transient', async () => {
    await get('/api/tree')
    impl = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }
    expect((await get('/api/tree')).json.stale).toBe(true)
  })

  it('answers 503 with Retry-After when there is no good tree yet', async () => {
    impl = async () => { throw typed('RPC_TIMEOUT') }
    const r = await get('/api/tree')
    expect(r.status).toBe(503)
    expect(r.headers['retry-after']).toBe('1')
    expect(r.json).toMatchObject({ code: 'RPC_TIMEOUT', retryable: true })
  })

  it('keeps 502 for non-transient errors', async () => {
    impl = async () => { throw typed('LIMITED_MODE') }
    const r = await get('/api/tree')
    expect(r.status).toBe(502)
    expect(r.json.code).toBe('LIMITED_MODE')
  })

  it('still answers 423 (not stale, not 503) when another holder has the lease', async () => {
    await get('/api/tree')
    await fetchRelease() // Studio holds the lease after the first poll; free it so the other holder can take it
    const o = await lease.acquire({ dir, timers: false, identity: {}, key: `127.0.0.1_p${process.env.ROKU_ECP_PORT}`, agent: 'device-qa#1', purpose: 'e2e run', pid: process.ppid, waitMs: 0, exitOnLost: false })
    impl = async () => { throw typed('RPC_TIMEOUT') }
    const r = await get('/api/tree')
    expect(r.status).toBe(423)
    expect(r.json.code).toBe('LOCKED')
    o.release()
  })
})

function fetchRelease() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action: 'release' })
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/lease', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve) })
    r.on('error', reject); r.end(body)
  })
}
