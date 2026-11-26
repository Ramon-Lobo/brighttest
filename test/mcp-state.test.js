import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import { bootStub, startMcp, payload, tmpdir, cleanupMcp, PASSWORD } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const hubMod = require('../lib/instrument/hub.js')

// TP-STA-27 headless part: app_state_get / app_state_set / app_state_snapshot through the MCP transport, against the
// stub device and a loopback hub with a fake agent. The device part (real instrumented app) is a DQ batch.
afterEach(cleanupMcp)

const DOC = { v: 1, seq: 3, snapshot: { layers: { global: { user: { tier: 'gold', n: 2 } }, scene: { focus: 'a' } } } }
const isErr = (r) => !!r.result.isError

const TOKEN = 'ab'.repeat(16)
const AGENT = JSON.stringify(DOC)
const holders = (dir) => fs.readdirSync(dir).filter((k) => fs.existsSync(path.join(dir, k, 'holder.json')))

// A startLanHub stand-in: a real loopback hub plus a fake agent that says hello after helloMs, then long-polls and acks
// commands. hello:false means the agent never dials. The connect wait is shortened through limits.stateConnectMs.
function hubDeps({ script, helloMs = 20, hello = true } = {}) {
  const seen = { hubs: [], cmds: [], leases: [], starts: 0 }
  return {
    seen,
    startLanHub: async ({ lease, tokens, redactPaths }) => {
      seen.starts++
      seen.leases.push(lease)
      seen.redactPaths = redactPaths
      const hub = await hubMod.startHub({ tokens, lease: hubMod.localLease(), tickMs: 20, longPollMs: 60000, stateTimeouts: { received: 500, applied: 800, reflected: 800 } })
      seen.hubs.push(hub)
      hub.events.on('event', (ev) => {
        if (ev.kind !== 'cmd.sent') return
        const cmd = ev.data
        seen.cmds.push(cmd)
        const r = script ? script(cmd) : { result: {} }
        if (!r) return
        setTimeout(() => {
          for (const phase of ['received', 'applied']) hub.stateOps.onAck({ id: cmd.id, seq: cmd.seq, phase, session: hub.sessionId, ...(phase === 'applied' && r.error ? { ok: false, error: r.error } : {}), ...(phase === 'applied' && r.result ? { result: r.result } : {}) })
        }, 5)
      })
      if (hello) {
        setTimeout(async () => {
          const base = `http://127.0.0.1:${hub.port}/bt/${tokens[0]}`
          try {
            const h = await (await fetch(`${base}/hello`)).json()
            fetch(`${base}/cmd?session=${h.session}&after=${h.seq}`).catch(() => {}) // the long-poll stays open
          } catch { /* hub stopped */ }
        }, helloMs)
      }
      return hub
    },
  }
}

async function ready(opts = {}, stubExtra = {}, { env = { BRIGHTTEST_HUB_TOKEN: TOKEN }, limits = {} } = {}) {
  const { stub, a } = await bootStub('healthy', { agentText: AGENT, ...stubExtra })
  const h = hubDeps(opts)
  const c = startMcp({ a, startLanHub: h.startLanHub, env, limits: { queueWaitMs: 5000, stateConnectMs: 1500, ...limits } })
  await c.initialize()
  return { stub, a, c, h }
}

describe('app_state_get', () => {
  it('reads layers, a layer and a dotted path from the agent node', async () => {
    const { c } = await ready()
    const all = payload(await c.tool('app_state_get'))
    expect(all.source).toBe('agent')
    expect(all.value.global.user.tier).toBe('gold')
    expect(payload(await c.tool('app_state_get', { layer: 'GLOBAL', path: 'user.TIER' })).value).toBe('gold')
    const miss = payload(await c.tool('app_state_get', { layer: 'global', path: 'user.nope' }))
    expect(miss.code).toBe('STATE_PATH_NOT_FOUND')
    expect(payload(await c.tool('app_state_get', { layer: 'zzz' })).code).toBe('STATE_LAYER_NOT_FOUND')
  })
  it('says the build is not instrumented when nothing is published', async () => {
    const { c } = await ready({}, { tree: 'dialog-root' })
    expect(payload(await c.tool('app_state_get')).code).toBe('STATE_NOT_PUBLISHED')
  })
})

describe('app_state_set / app_state_snapshot on the session window', () => {
  it('opens one session window, sends one set command, and keeps the lease until the window ends', async () => {
    const { c, h } = await ready()
    const r = await c.tool('app_state_set', { layer: 'global', path: 'user.tier', value: 'premium' })
    expect(isErr(r), JSON.stringify(payload(r))).toBe(false)
    expect(h.seen.cmds).toHaveLength(1)
    expect(h.seen.cmds[0].op).toBe('set')
    expect(h.seen.cmds[0].args).toEqual({ layer: 'global', path: 'user.tier', value: 'premium' })
    expect(h.seen.starts).toBe(1)
    expect(c.server.session.hubNet).toBe(false)
    expect(holders(c.lease)).toHaveLength(1) // the window's session lease
    await c.close()
    expect(holders(c.lease)).toEqual([])
  })
  it('a late first hello still succeeds, and the second call neither waits nor starts a hub', async () => {
    const { c, h } = await ready({ helloMs: 700 })
    const t0 = Date.now()
    expect(isErr(await c.tool('app_state_set', { path: 'user.n', value: 1 }))).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600)
    const t1 = Date.now()
    expect(isErr(await c.tool('app_state_set', { path: 'user.n', value: 2 }))).toBe(false)
    expect(Date.now() - t1).toBeLessThan(500)
    expect(h.seen.starts).toBe(1)
    expect(h.seen.cmds).toHaveLength(2)
    expect(holders(c.lease)).toHaveLength(1)
  })
  it('passes the redact paths to the hub', async () => {
    const cwd = tmpdir()
    fs.writeFileSync(path.join(cwd, 'brighttest.json'), JSON.stringify({ instrument: { state: { redact: { paths: ['user.token'] } } } }))
    const { a } = await bootStub('healthy', { agentText: AGENT })
    const h = hubDeps()
    const c = startMcp({ a, cwd, startLanHub: h.startLanHub, env: { BRIGHTTEST_HUB_TOKEN: TOKEN } })
    await c.initialize()
    await c.tool('app_state_set', { path: 'a', value: 1 })
    expect(h.seen.redactPaths).toEqual(['user.token'])
  })
  it('passes the agent refusal through as a typed error and keeps serving', async () => {
    const { c } = await ready({ script: (cmd) => (cmd.args.value === 'x' ? { error: 'type mismatch: user.n is an integer' } : { result: {} }) })
    const bad = payload(await c.tool('app_state_set', { path: 'user.n', value: 'x' }))
    expect(bad.code).toBe('STATE_CMD_FAILED')
    expect(bad.message).toMatch(/type mismatch/)
    expect(isErr(await c.tool('app_state_set', { path: 'user.n', value: 5 }))).toBe(false)
  })
  it('validates with the flow-step rules before any device, lease or hub call', async () => {
    const { c, h, stub } = await ready()
    const before = stub.log.length
    for (const args of [{ layer: 'nope', path: 'a', value: 1 }, { layer: 'node', path: 'a', value: 1 }, { path: '..a', value: 1 }, { layer: 'registry', path: 'nodot', value: 1 }, { layer: 'global', node: { id: 'x' }, path: 'a', value: 1 }]) {
      const r = await c.tool('app_state_set', args)
      expect(isErr(r), JSON.stringify(args)).toBe(true)
      expect(payload(r).code).toBe('INVALID_ARGS')
    }
    expect((await c.tool('app_state_set', { path: 'a', value: 1, password: 'x' })).error.code).toBe(-32602)
    expect(payload(await c.tool('app_state_snapshot', { name: 'bad name!' })).code).toBe('INVALID_ARGS')
    expect(h.seen.starts).toBe(0)
    expect(stub.log.length).toBe(before)
    expect(holders(c.lease)).toEqual([])
  })
  it('returns the layers of a snapshot', async () => {
    const { c, h } = await ready({ script: () => ({ result: { layers: { global: { a: 1 } } } }) })
    const r = payload(await c.tool('app_state_snapshot', { name: 'fresh' }))
    expect(r.layers).toEqual({ global: { a: 1 } })
    expect(h.seen.cmds[0].op).toBe('snapshot')
  })
  it('reports a hub that cannot start as NET_FAILED and releases the window', async () => {
    const { a } = await bootStub('healthy', { agentText: AGENT })
    const c = startMcp({ a, startLanHub: async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }) }, env: { BRIGHTTEST_HUB_TOKEN: TOKEN } })
    await c.initialize()
    expect(payload(await c.tool('app_state_snapshot', { name: 'x' })).code).toBe('NET_FAILED')
    expect(holders(c.lease)).toEqual([])
  })
})

describe('typed setup and connect failures', () => {
  it('STATE_AGENT_UNREACHABLE when the agent never dials; the window stays open', async () => {
    const { c, h } = await ready({ hello: false }, {}, { limits: { stateConnectMs: 400 } })
    const r = payload(await c.tool('app_state_set', { path: 'a', value: 1 }))
    expect(r.code).toBe('STATE_AGENT_UNREACHABLE')
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(h.seen.cmds).toHaveLength(0)
    expect(c.server.session.win).not.toBeNull()
    expect(holders(c.lease)).toHaveLength(1)
  })
  it('STATE_AGENT_GONE when the agent stops polling after it connected', async () => {
    const { c, h } = await ready({}, {}, { limits: { stateConnectMs: 400 } })
    expect(isErr(await c.tool('app_state_set', { path: 'a', value: 1 }))).toBe(false)
    h.seen.hubs[0].agentLive = () => false
    expect(payload(await c.tool('app_state_set', { path: 'a', value: 2 })).code).toBe('STATE_AGENT_GONE')
    expect(h.seen.cmds).toHaveLength(1)
  })
  it('STATE_AGENT_GONE when the agent drops before it acks', async () => {
    const { c, h } = await ready({ script: () => null }, {}, { limits: { stateConnectMs: 400, stateStepMs: 500 } })
    const p = c.toolAsync('app_state_set', { path: 'a', value: 1 })
    for (let i = 0; i < 100 && !h.seen.cmds.length; i++) await new Promise((r) => setTimeout(r, 20))
    h.seen.hubs[0].agentLive = () => false
    expect(payload(await p).code).toBe('STATE_AGENT_GONE')
  }, 20000)
  it('STATE_NOT_INSTRUMENTED with no hub started and no lease held when there is no agent node', async () => {
    const { c, h } = await ready({}, { tree: 'dialog-root' })
    const probe = payload(await c.tool('app_state_set', { path: 'a', value: 1 }))
    expect(probe.code).toBe('STATE_NOT_INSTRUMENTED')
    expect(h.seen.starts).toBe(0)
    expect(holders(c.lease)).toEqual([])
    expect(c.server.session.win).toBeNull()
  })
  it('STATE_NO_HUB_TOKEN with no lease taken and no device request', async () => {
    const { c, h, stub } = await ready({}, {}, { env: { BRIGHTTEST_HUB_TOKEN: '' } })
    const before = stub.log.length
    for (const [n, args] of [['app_state_set', { path: 'a', value: 1 }], ['app_state_snapshot', { name: 's' }]]) {
      expect(payload(await c.tool(n, args)).code, n).toBe('STATE_NO_HUB_TOKEN')
    }
    expect(h.seen.starts).toBe(0)
    expect(stub.log.length).toBe(before)
    expect(holders(c.lease)).toEqual([])
  })
  it('the 45 s budget applies to the two write tools only', async () => {
    const { c } = await ready()
    const s = c.server.session
    expect(s.limits.stateToolTimeoutMs).toBe(45000)
    expect(s.limits.toolTimeoutMs).toBe(30000)
    expect(s.limits.stateConnectMs).toBeLessThan(s.limits.stateToolTimeoutMs)
  })
})

describe('app_state_get and the window', () => {
  it('takes a command lease per call outside a window and never opens one', async () => {
    const { c, h } = await ready()
    expect(isErr(await c.tool('app_state_get'))).toBe(false)
    expect(holders(c.lease)).toEqual([])
    expect(h.seen.starts).toBe(0)
  })
  it('re-enters the window lease inside one (no second lease)', async () => {
    const { c } = await ready()
    await c.tool('app_state_set', { path: 'a', value: 1 })
    expect(holders(c.lease)).toHaveLength(1)
    const r = await c.tool('app_state_get', { layer: 'global' })
    expect(isErr(r), JSON.stringify(payload(r))).toBe(false)
    expect(holders(c.lease)).toHaveLength(1)
  })
})

describe('lease and secrets', () => {
  it('refuses all three tools with DEVICE_BUSY and sends no request or hub start while another party holds the device', async () => {
    const { a } = await bootStub('healthy', { agentText: AGENT })
    const leaseDir = tmpdir('bt-mcp-lease-')
    const h = hubDeps()
    const B = startMcp({ a, leaseDir, startLanHub: h.startLanHub, env: { BRIGHTTEST_HUB_TOKEN: TOKEN } })
    await B.initialize()
    const L = require('../lib/device-lease.js')
    const holder = await L.acquire({ host: '127.0.0.1', port: a.ecpPort, agent: 'other', purpose: 'test', command: ['x'], secrets: [], env: { ...process.env, BRIGHTTEST_LEASE_DIR: leaseDir }, mode: 'command', waitMs: 0, identity: { worktree: null, branch: null }, cwd: process.cwd(), maxHoldMs: 60000, idleMs: 60000, onWait: () => {}, onWarn: () => {} })
    try {
      for (const [n, args] of [['app_state_get'], ['app_state_set', { path: 'a', value: 1 }], ['app_state_snapshot', { name: 's' }]]) {
        expect(payload(await B.tool(n, args)).code, n).toBe('DEVICE_BUSY')
      }
      expect(h.seen.starts).toBe(0)
    } finally { holder.release() }
  })
  it('never leaks the dev password or the hub token in any output or stderr', async () => {
    const { c } = await ready({ script: () => ({ error: `boom ${PASSWORD}` }) })
    const r = await c.tool('app_state_set', { path: 'a', value: 1 })
    const all = JSON.stringify([r, await c.tool('app_state_snapshot', { name: 'x' }), await c.tool('net_requests')])
    for (const secret of [PASSWORD, TOKEN]) {
      expect(all).not.toContain(secret)
      expect(c.stderr()).not.toContain(secret)
    }
  })
})
