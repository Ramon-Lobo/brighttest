import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { bootStub, startMcp, payload, cleanupMcp, tmpdir } from './fixtures/mcp-harness.js'

const require = createRequire(import.meta.url)
const { beginFlow } = require('../lib/e2e/state-steps.js')
const { LIMITS } = require('../lib/mcp/tools.js')

// STA-S-T15 T2: the window opened by a state tool (no net proxy), a later net tool mounting the proxy, one hub total.
// Real lease code in a temp lease dir, stub device, stubbed startLanHub. No state tool exists yet: the test drives
// session.withDevice(..., { window: 'state' }) the way the state tools will.
function hubStub() {
  const starts = []
  const stops = []
  const mounts = []
  const fn = async (o) => {
    starts.push(o)
    const h = { netMounted: !!o.netProxy, mountNet: (p) => { mounts.push(p); h.netMounted = true }, stop: async () => { stops.push(1) } }
    return h
  }
  return { fn, starts, stops, mounts }
}
const fakeCall = () => ({ signal: new AbortController().signal, lose() {}, begin() {}, releaseNow: null })
const holders = (dir) => fs.readdirSync(dir).filter((k) => fs.existsSync(path.join(dir, k, 'holder.json')))

async function boot({ cwd, env } = {}) {
  const { a } = await bootStub('healthy')
  const hub = hubStub()
  const c = startMcp({ a, cwd, env, startLanHub: hub.fn })
  await c.initialize()
  return { c, hub, s: c.server.session }
}
afterEach(async () => { await cleanupMcp() })

describe('session window opened by a state tool', () => {
  it('starts the hub without the net proxy, with the state redact paths and one session lease', async () => {
    const cwd = tmpdir()
    fs.writeFileSync(path.join(cwd, 'brighttest.json'), JSON.stringify({ instrument: { state: { redact: { paths: ['user.token'] } } } }))
    const { c, hub, s } = await boot({ cwd })
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    expect(hub.starts).toHaveLength(1)
    expect(hub.starts[0].netProxy).toBeUndefined()
    expect(hub.starts[0].redactPaths).toEqual(['user.token'])
    expect(hub.starts[0].tokens[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(s.win).not.toBeNull()
    expect(s.hubNet).toBe(false)
    expect(s._net).toBeFalsy() // the session proxy was never even built
    const hs = holders(c.lease)
    expect(hs).toHaveLength(1)
    expect(fs.readFileSync(path.join(c.lease, hs[0], 'holder.json'), 'utf8')).toContain('session hub window')
  })

  it('a following net_mock mounts the proxy into the same hub: one startLanHub call', async () => {
    const { c, hub, s } = await boot()
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    const r = await c.tool('net_mock', { match: { url: '**/x' }, respond: { status: 200, body: 'x' } })
    expect(r.result.isError).not.toBe(true)
    expect(hub.starts).toHaveLength(1)
    expect(hub.mounts).toEqual([s.net().proxy])
    expect(s.hubNet).toBe(true)
    await c.tool('net_requests') // second net call does not mount again
    expect(hub.mounts).toHaveLength(1)
  })

  it('a net opener starts the hub with the proxy and never mounts', async () => {
    const { c, hub, s } = await boot()
    await c.tool('net_requests')
    expect(hub.starts[0].netProxy).toBe(s.net().proxy)
    expect(hub.mounts).toHaveLength(0)
  })

  it('other tools re-enter the window lease; no second hub', async () => {
    const { c, hub, s } = await boot()
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    const r = await c.tool('inspect_tree')
    expect(r.result.isError).not.toBe(true)
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    expect(hub.starts).toHaveLength(1)
  })

  it('idle release stops the hub and the next opener starts a new one', async () => {
    const { c, hub, s } = await boot()
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    s.win.release('idle expiry')
    await new Promise((r) => setTimeout(r, 10))
    expect(holders(c.lease)).toEqual([])
    expect(hub.stops).toHaveLength(1)
    expect(s.win).toBeNull()
    expect(s.hubNet).toBe(false)
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    expect(hub.starts).toHaveLength(2)
  })

  it('lease loss mid-call ends the window and stops the call with LEASE_LOST', async () => {
    const { c, hub, s } = await boot()
    let lost = null
    const call = { signal: new AbortController().signal, lose: (why) => { lost = why }, begin() {}, releaseNow: null }
    await s.withDevice(call, async () => { s.win.release('lease lost', { fire: true }) }, { window: 'state' })
    expect(lost).toMatch(/lease lost/)
    expect(holders(c.lease)).toEqual([])
    expect(hub.stops).toHaveLength(1)
  })

  it('session end releases the window and leaves the lease dir empty', async () => {
    const { c, hub, s } = await boot()
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    await c.close()
    expect(hub.stops).toHaveLength(1)
    expect(holders(c.lease)).toEqual([])
  })

  it('sessionMax closes the window', async () => {
    const cwd = tmpdir()
    fs.writeFileSync(path.join(cwd, 'brighttest.json'), JSON.stringify({ deviceLease: { sessionMax: '1s' } }))
    const { hub, s } = await boot({ cwd })
    await s.withDevice(fakeCall(), async () => {}, { window: 'state' })
    for (let i = 0; i < 100 && s.win; i++) await new Promise((r) => setTimeout(r, 50))
    expect(s.win).toBeNull()
    expect(hub.stops).toHaveLength(1)
  })
})

describe('state-steps beginFlow helloBase', () => {
  const flow = { steps: [{ op: 'setState', line: 1 }], config: {}, file: 'f', name: 'f' }
  it('defaults to the hub hello count; an explicit 0 is honored', () => {
    const hub = { hellos: 3 }
    expect(beginFlow(flow, hub, {}, 'l').state.helloBase).toBe(3)
    expect(beginFlow(flow, hub, {}, 'l', { helloBase: 0 }).state.helloBase).toBe(0)
  })
})

describe('limits', () => {
  it('has a state tool budget of 45 s', () => { expect(LIMITS.stateToolTimeoutMs).toBe(45000) })
})
