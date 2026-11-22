import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'
import { parseFlow } from '../lib/e2e/flow.js'
import ss from '../lib/e2e/state-steps.js'
import hubMod from '../lib/instrument/hub.js'

// TP-STA-14: state flow steps against a real loopback hub with a fake agent (acks fed through hub.stateOps; no device).
const TOKEN = 'tok-state-steps'
const BASE = 'appId: dev\nsteps:\n'
let dir, cfg, hub, ctx, sent
const flowOf = (src, name = 'f') => ({ ...parseFlow(src), name })
const steps = (src) => flowOf(BASE + src).steps

// A fake agent: acks every command queued on the hub. `script(cmd)` returns { phases?, result?, error? } or null to stay silent.
function agent(script) {
  hub.events.on('event', (ev) => {
    if (ev.kind !== 'cmd.sent') return
    const cmd = ev.data
    sent.push(cmd)
    const r = script(cmd)
    if (!r) return
    setTimeout(() => {
      for (const phase of r.phases || ['received', 'applied']) {
        hub.stateOps.onAck({ id: cmd.id, seq: cmd.seq, phase, session: hub.sessionId, ...(phase !== 'received' && r.error ? { ok: false, error: r.error } : {}), ...(phase === 'applied' && r.result ? { result: r.result } : {}) })
      }
    }, 5)
  })
}
async function setup(flow, { hello = true, config = cfg } = {}) {
  hub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease(), tickMs: 20, stateTimeouts: { received: 200, applied: 300, reflected: 300 } })
  const begun = ss.beginFlow(flow, hub, config)
  expect(begun.error).toBeUndefined()
  ctx = { state: begun.state, stepTimeoutMs: 600, opts: { netHandshakeMs: 150 } }
  if (hello) await fetch(`http://127.0.0.1:${hub.port}/bt/${TOKEN}/hello`)
  return ctx
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-state-steps-')); cfg = loadConfig(dir, null); sent = [] })
afterEach(async () => { if (hub) await hub.stop(); hub = null; vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('state steps: parse', () => {
  it('parses every state step and config.state.ack', () => {
    const f = parseFlow('appId: dev\nconfig: { state: { ack: reflected } }\nsteps:\n  - waitForAgent: { timeout: 10 }\n  - waitForAgent\n'
      + '  - setState: { layer: global, path: user.tier, value: premium }\n'
      + '  - setState: { layer: global, ops: [ { path: a, value: 1 }, { path: b, value: 2 } ] }\n'
      + '  - setState: { layer: registry, path: sec.key, value: "[]", ack: applied }\n'
      + '  - snapshot: fresh\n  - restore: fresh\n  - callFunc: { node: { id: homePanel }, fn: bt_resetHome, args: [] }\n')
    expect(f.config.state).toEqual({ ack: 'reflected' })
    expect(f.steps.map((s) => s.op)).toEqual(['waitForAgent', 'waitForAgent', 'setState', 'setState', 'setState', 'snapshot', 'restore', 'callFunc'])
    expect(f.steps[0].timeout).toBe(10)
    expect(f.steps[3].ops).toEqual([{ path: 'a', value: 1 }, { path: 'b', value: 2 }])
  })
  it.each([
    ['setState: { layer: global, path: a, value: 1, bogus: 2 }', /unknown key "bogus"/],
    ['setState: { layer: nope, path: a, value: 1 }', /layer must be one of/],
    ['setState: { layer: global, path: a }', /needs a value/],
    ['setState: { layer: global, path: a, value: 1, ops: [ { path: b, value: 1 } ] }', /cannot be combined/],
    ['setState: { layer: node, path: a, value: 1 }', /node must be \{ id/],
    ['setState: { layer: global, ops: [] }', /non-empty list/],
    ['setState: { layer: global, path: a, value: 1, ack: soon }', /ack must be one of/],
    ['setState: { layer: registry, path: onlysection, value: 1 }', /<section>\.<key>/],
    ['snapshot: "bad name"', /name must be/],
    ['callFunc: { node: { id: x }, fn: "bad name" }', /fn must be a function name/],
    ['callFunc: { node: { id: x }, fn: bt_a, args: 3 }', /args must be a list/],
    ['waitForAgent: { bogus: 1 }', /unknown key "bogus"/],
  ])('rejects %s', (step, re) => {
    expect(() => parseFlow(BASE + '  - ' + step + '\n')).toThrow(re)
  })
  it('rejects a bad config.state', () => {
    expect(() => parseFlow('appId: dev\nconfig: { state: { ack: later } }\nsteps:\n  - launch\n')).toThrow(/config.state.ack/)
    expect(() => parseFlow('appId: dev\nconfig: { state: { x: 1 } }\nsteps:\n  - launch\n')).toThrow(/unknown key "x"/)
  })
})

describe('state steps: run', () => {
  it('setState single and ops batch are one command each, in order', async () => {
    const flow = flowOf(BASE + '  - setState: { layer: global, path: user.tier, value: premium }\n  - setState: { layer: global, ops: [ { path: a, value: 1 }, { path: b, value: 2 } ] }\n')
    await setup(flow); agent(() => ({}))
    const [one, batch] = flow.steps
    await ss.execStep(one, ctx)
    await ss.execStep(batch, ctx)
    expect(sent.map((c) => [c.op, c.args])).toEqual([
      ['set', { layer: 'global', path: 'user.tier', value: 'premium' }],
      ['set', { layer: 'global', ops: [{ path: 'a', value: 1 }, { path: 'b', value: 2 }] }],
    ])
  })
  it('registry layer maps to registry.write', async () => {
    const flow = flowOf(BASE + '  - setState: { layer: registry, path: sec.a.b, value: x }\n')
    await setup(flow); agent(() => ({}))
    await ss.execStep(flow.steps[0], ctx)
    expect(sent[0]).toMatchObject({ op: 'registry.write', args: { section: 'sec', key: 'a.b', value: 'x' } })
  })
  it('snapshot then restore sends the stored layers; restore without a snapshot is typed', async () => {
    const flow = flowOf(BASE + '  - snapshot: fresh\n  - restore: fresh\n  - restore: other\n')
    await setup(flow)
    agent((c) => (c.op === 'snapshot' ? { result: { layers: { global: { n: 1 } } } } : {}))
    await ss.execStep(flow.steps[0], ctx)
    await ss.execStep(flow.steps[1], ctx)
    expect(sent[1]).toMatchObject({ op: 'restore', args: { name: 'fresh', layers: { global: { n: 1 } } } })
    await expect(ss.execStep(flow.steps[2], ctx)).rejects.toMatchObject({ code: 'STATE_SNAPSHOT_NOT_FOUND' })
    expect(sent).toHaveLength(2)
  })
  it('callFunc sends node, fn and args and shows the returned value', async () => {
    const flow = flowOf(BASE + '  - callFunc: { node: { id: p }, fn: bt_reset, args: [1] }\n')
    await setup(flow); agent(() => ({ result: { value: 'ok' } }))
    const r = await ss.execStep(flow.steps[0], ctx)
    expect(sent[0]).toMatchObject({ op: 'callFunc', args: { node: { id: 'p' }, fn: 'bt_reset', args: [1] } })
    expect(r.detail).toContain('"ok"')
  })
  it('config.state.ack and a step ack choose the phase to wait for', async () => {
    const flow = flowOf('appId: dev\nconfig: { state: { ack: reflected } }\nsteps:\n  - setState: { path: a, value: 1 }\n  - setState: { path: b, value: 2, ack: applied }\n')
    await setup(flow)
    agent(() => ({ phases: ['received', 'applied', 'reflected'] }))
    await ss.execStep(flow.steps[0], ctx); await ss.execStep(flow.steps[1], ctx)
    expect(hub.stateOps.list().map((c) => c.want)).toEqual(['reflected', 'applied'])
  })
  it('a failed command reports the ack phase reached', async () => {
    const flow = flowOf(BASE + '  - setState: { path: a, value: 1 }\n')
    await setup(flow); agent(() => ({ error: 'TYPE_MISMATCH: a is an integer' }))
    await expect(ss.execStep(flow.steps[0], ctx)).rejects.toMatchObject({ code: 'STATE_CMD_FAILED', message: expect.stringMatching(/TYPE_MISMATCH.*ack phase reached: applied/) })
  })
  it('a silent agent times out naming the phase reached', async () => {
    const flow = flowOf(BASE + '  - setState: { path: a, value: 1, ack: reflected }\n')
    await setup(flow); agent(() => ({ phases: ['received', 'applied'] }))
    await expect(ss.execStep(flow.steps[0], ctx)).rejects.toMatchObject({ code: 'STATE_CMD_FAILED', message: expect.stringMatching(/ack phase reached: applied/) })
  })
  it('waitForAgent resolves on hello and times out typed without one', async () => {
    const flow = flowOf(BASE + '  - waitForAgent: { timeout: 0.1 }\n')
    await setup(flow, { hello: false })
    await expect(ss.execStep(flow.steps[0], ctx)).rejects.toMatchObject({ code: 'STATE_NOT_INSTRUMENTED' })
    await fetch(`http://127.0.0.1:${hub.port}/bt/${TOKEN}/hello`)
    await expect(ss.execStep(flow.steps[0], ctx)).resolves.toMatchObject({ detail: 'agent connected' })
  })
})

describe('state steps: fail fast', () => {
  it('a build that never dials the hub fails after launch with a typed error, and steps refuse to send', async () => {
    const flow = flowOf(BASE + '  - launch\n  - setState: { path: a, value: 1 }\n')
    await setup(flow, { hello: false })
    const t0 = Date.now()
    await expect(ss.awaitHandshake(ctx)).rejects.toMatchObject({ code: 'STATE_NOT_INSTRUMENTED' })
    expect(Date.now() - t0).toBeLessThan(1000)
    await expect(ss.execStep(flow.steps[1], ctx)).rejects.toMatchObject({ code: 'STATE_NOT_INSTRUMENTED' })
    expect(hub.stateOps.list()).toHaveLength(0)
  })
  it('callFunc outside instrument.state.callable (and not bt_) fails before the device is touched', () => {
    const flow = flowOf(BASE + '  - callFunc: { node: { id: p }, fn: reset }\n')
    const hubStub = { hellos: 0 }
    expect(ss.beginFlow(flow, hubStub, cfg).error).toMatch(/line 3: callFunc: "reset" is not allowed/)
    const ok = ss.beginFlow(flow, hubStub, { ...cfg, instrument: { state: { callable: ['reset'] } } })
    expect(ok.error).toBeUndefined()
  })
  it('state steps with no hub fail before the device is touched (e2e.run), and the hub starts for them', async () => {
    const calls = []
    const createDevice = () => ({ deviceInfo: async () => { calls.push('info'); return { model: 'Stub', developerEnabled: true } }, launch: async () => calls.push('launch'), keypress: async () => calls.push('key') })
    const flowFile = path.join(dir, 's.e2e.yaml')
    fs.writeFileSync(flowFile, BASE + '  - launch\n  - setState: { path: a, value: 1 }\n')
    const out = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const started = []
    const lease = { release() {}, onLost() {}, onExpire() {} }
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flowFile], host: '10.0.0.1', logs: false }, {
      createDevice, acquireForLane: async () => ({ lease }), startLanHub: async () => { started.push(1); return null },
    })
    expect(started).toEqual([1]) // the hub is started because a flow uses state steps
    expect(code).toBe(1)
    expect(calls).toEqual(['info'])
    expect(out.join('')).toMatch(/state steps need the instrument hub/)
  })
  it('a state step with no ctx.state is typed', async () => {
    await expect(ss.execStep({ op: 'snapshot', name: 'x' }, {})).rejects.toMatchObject({ code: 'STATE_NO_HUB' })
  })
})
