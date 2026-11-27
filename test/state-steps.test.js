import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'
import { parseFlow } from '../lib/e2e/flow.js'
import ss from '../lib/e2e/state-steps.js'
import hubMod from '../lib/instrument/hub.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

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
    }, r.delay || 5)
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
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-state-steps-')); cfg = { ...loadConfig(dir, null), instrument: { state: { callable: ['bt_reset'] } } }; sent = [] })
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
  it('accepts the m layer with a node selector (STA-S-T9)', () => {
    const f = parseFlow(BASE + '  - setState: { layer: m, node: { id: panel }, path: rowIndex, value: 3 }\n')
    expect(f.steps[0]).toMatchObject({ op: 'setState', layer: 'm', node: { id: 'panel' }, path: 'rowIndex', value: 3 })
  })
  it.each([
    ['setState: { layer: global, path: a, value: 1, bogus: 2 }', /unknown key "bogus"/],
    ['setState: { layer: nope, path: a, value: 1 }', /layer must be one of/],
    ['setState: { layer: global, path: a }', /needs a value/],
    ['setState: { layer: global, path: a, value: 1, ops: [ { path: b, value: 1 } ] }', /cannot be combined/],
    ['setState: { layer: node, path: a, value: 1 }', /node must be \{ id/],
    ['setState: { layer: m, path: a, value: 1 }', /node must be \{ id/],
    ['setState: { layer: global, path: a, value: 1, node: { id: x } }', /node only applies to layer: node or m/],
    ['setState: { layer: global, ops: [] }', /non-empty list/],
    ['setState: { layer: global, path: a, value: 1, ack: soon }', /ack must be one of/],
    ['setState: { layer: registry, path: onlysection, value: 1 }', /<section>\.<key>/],
    ['snapshot: "bad name"', /name must be/],
    ['snapshot: { name: s, nodes: [] }', /nodes must be a non-empty list/],
    ['snapshot: { name: s, nodes: tierLabel }', /nodes must be a non-empty list/],
    ['snapshot: { name: s, nodes: [a, ""] }', /nodes must be a non-empty list/],
    ['snapshot: { name: s, nodes: [a, 3] }', /nodes must be a non-empty list/],
    ['restore: { name: s, nodes: [a] }', /unknown key "nodes"/],
    ['callFunc: { node: { id: x }, fn: "bad name" }', /fn must be a function name/],
    ['callFunc: { node: { id: x }, fn: bt_a, args: 3 }', /args must be a list/],
    ['waitForAgent: { bogus: 1 }', /unknown key "bogus"/],
    ['waitForAgent: { timeout: 0 }', /positive number/],
    ['setState: { path: a, value: 1, timeout: 0 }', /positive number/],
    ['callFunc: { node: { id: x }, fn: a, args: [1, 2] }', /at most one argument/],
  ])('rejects %s', (step, re) => {
    expect(() => parseFlow(BASE + '  - ' + step + '\n')).toThrow(re)
  })
  it('state-step parse errors carry the validation flag (the run stops before any device call)', () => {
    for (const src of ['  - setState: { layer: nope, path: a, value: 1 }\n', '  - callFunc: { fn: x }\n']) {
      try { parseFlow(BASE + src); throw new Error('no throw') } catch (e) { expect(e.validation).toBe(true) }
    }
    try { parseFlow('appId: dev\nconfig: { state: { ack: x } }\nsteps:\n  - launch\n'); throw new Error('no throw') } catch (e) { expect(e.validation).toBe(true) }
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
  it('snapshot with nodes de-duplicates them and sends args.nodes; without nodes the command is unchanged', async () => {
    const flow = flowOf(BASE + '  - snapshot: { name: a, nodes: [tierLabel, panel, tierLabel] }\n  - snapshot: b\n')
    expect(flow.steps[0].nodes).toEqual(['tierLabel', 'panel'])
    await setup(flow)
    agent(() => ({ result: { layers: { global: {} } } }))
    await ss.execStep(flow.steps[0], ctx)
    await ss.execStep(flow.steps[1], ctx)
    expect(sent[0]).toMatchObject({ op: 'snapshot', args: { name: 'a', nodes: ['tierLabel', 'panel'] } })
    expect(sent[1].args).toEqual({ name: 'b' })
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
  it('a missing reflected ack times out as STATE_ACK_TIMEOUT at the step timeout, naming the phase reached', async () => {
    const flow = flowOf(BASE + '  - setState: { path: a, value: 1, ack: reflected, timeout: 0.5 }\n')
    await setup(flow); agent(() => ({ phases: ['received', 'applied'] }))
    const t0 = Date.now()
    await expect(ss.execStep(flow.steps[0], ctx)).rejects.toMatchObject({ code: 'STATE_ACK_TIMEOUT', message: expect.stringMatching(/no reflected ack within 0\.5s.*ack phase reached: applied/) })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
  })
  it('honours the step timeout over the hub limit: a late ack after the hub timed the command out still succeeds', async () => {
    const flow = flowOf(BASE + '  - setState: { path: a, value: 1, timeout: 2 }\n')
    await setup(flow); agent(() => ({ delay: 700 })) // hub applied limit in this test is 300 ms
    await expect(ss.execStep(flow.steps[0], ctx)).resolves.toBeTruthy()
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
  it('callFunc outside instrument.state.callable fails before the first step, with no bt_ bypass; names match ignoring case', () => {
    const flow = flowOf(BASE + '  - callFunc: { node: { id: p }, fn: reset }\n')
    const hubStub = { hellos: 0 }
    const none = { ...cfg, instrument: {} }
    expect(ss.beginFlow(flow, hubStub, none).error).toMatch(/line 3: callFunc: "reset" is not in instrument.state.callable/)
    expect(ss.beginFlow(flowOf(BASE + '  - callFunc: { node: { id: p }, fn: bt_reset }\n'), hubStub, none).error).toMatch(/"bt_reset" is not in instrument.state.callable/)
    expect(ss.beginFlow(flow, hubStub, { ...cfg, instrument: { state: { callable: ['RESET'] } } }).error).toBeUndefined()
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

// beginFlow stamps the hellos seen so far; in a real run `launch` brings the new hello after it.
const begin = (f, label) => { const r = ss.beginFlow(f, hub, cfg, label); if (r.state) r.state.helloBase = 0; return r }

describe('state steps: snapshot scope', () => {
  it('21 flows each taking a snapshot all pass (a flow drops its snapshots at its end)', async () => {
    const f0 = flowOf(BASE + '  - snapshot: s\n')
    await setup(f0)
    agent(() => ({ result: { layers: { global: { n: 1 } } } }))
    ctx.state.snapshots.clear()
    for (let i = 0; i < 21; i++) {
      const f = { ...flowOf(BASE + '  - snapshot: s\n  - restore: s\n', `flow${i}`), file: path.join(dir, `flow${i}.e2e.yaml`) }
      const { state, error } = begin(f)
      expect(error).toBeUndefined()
      const c = { state, stepTimeoutMs: 600 }
      await ss.execStep(f.steps[0], c)
      await ss.execStep(f.steps[1], c)
      ss.endFlow(state)
    }
    expect(hub.stateOps.listSnapshots()).toEqual([])
  })
  it('same file with another unit label (or another path with the same name) never shares snapshots', async () => {
    const f = { ...flowOf(BASE + '  - snapshot: s\n  - restore: s\n'), file: path.join(dir, 'a', 'x.e2e.yaml') }
    await setup(f)
    agent(() => ({ result: { layers: { global: { n: 1 } } } }))
    const one = begin(f, 'user=a').state
    await ss.execStep(f.steps[0], { state: one, stepTimeoutMs: 600 })
    for (const [file, label] of [[f.file, 'user=b'], [path.join(dir, 'b', 'x.e2e.yaml'), 'user=a']]) {
      const other = begin({ ...f, file }, label).state
      await expect(ss.execStep(f.steps[1], { state: other, stepTimeoutMs: 600 })).rejects.toMatchObject({ code: 'STATE_SNAPSHOT_NOT_FOUND' })
    }
    await expect(ss.execStep(f.steps[1], { state: one, stepTimeoutMs: 600 })).resolves.toBeTruthy()
  })
  it('a full store gives an actionable error', async () => {
    const flow = flowOf(BASE + '  - snapshot: s\n')
    await setup(flow)
    for (let i = 0; i < 20; i++) hub.stateOps.saveSnapshot(`x${i}`, { g: 1 }, 0)
    agent(() => ({ result: { layers: { global: {} } } }))
    await expect(ss.execStep(flow.steps[0], ctx)).rejects.toThrow(/at most 20 snapshots per run/)
  })
})

describe('hello hand-off (no replay after a relaunch)', () => {
  const get = async (p) => (await fetch(`http://127.0.0.1:${hub.port}/bt/${TOKEN}/${p}`))
  it('hello returns the current command seq; a fresh agent polling from it gets nothing from earlier flows', async () => {
    hub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease(), longPollMs: 100 })
    const a = hub.push({ op: 'set', args: { layer: 'global', path: 'a', value: 1 } }, { ack: 'applied' })
    const h1 = await (await get('hello')).json()
    expect(h1.seq).toBe(a.seq)
    expect((await get(`cmd?after=${h1.seq}&session=${h1.session}`)).status).toBe(204)
    const b = hub.push({ op: 'set', args: { layer: 'global', path: 'b', value: 2 } }, { ack: 'applied' })
    const got = await (await get(`cmd?after=${h1.seq}&session=${h1.session}`)).json()
    expect(got.map((c) => c.id)).toEqual([b.id])
    // a legacy agent that ignores seq and polls after=0 still sees everything (old behaviour, field is additive)
    expect((await (await get(`cmd?after=0&session=${h1.session}`)).json()).length).toBe(2)
  })
  it('a new hello abandons open commands, so a late ack of an old command cannot land', async () => {
    hub = await hubMod.startHub({ tokens: [TOKEN], lease: hubMod.localLease() })
    const old = hub.push({ op: 'set', args: { layer: 'global', path: 'a', value: 1 } }, { ack: 'applied' })
    await get('hello')
    expect(hub.stateOps.get(old.id)).toMatchObject({ status: 'abandoned', ok: false })
    hub.stateOps.onAck({ id: old.id, seq: old.seq, phase: 'applied', session: hub.sessionId })
    expect(hub.stateOps.get(old.id)).toMatchObject({ status: 'abandoned', ok: false })
  })
})

describe('loggable redaction', () => {
  const { loggable } = require('../lib/instrument/state-ops.js')
  it('redacts sensitive values inside an ops batch and callFunc args', () => {
    const l = loggable({ id: 'c1', seq: 1, op: 'set', args: { layer: 'global', ops: [{ path: 'user.token', value: 'sekret' }, { path: 'user.tier', value: 'gold' }] } }, [])
    expect(JSON.stringify(l)).not.toContain('sekret')
    expect(JSON.stringify(l)).toContain('gold')
    const c = loggable({ id: 'c2', seq: 2, op: 'callFunc', args: { fn: 'f', args: [{ password: 'hunter2', name: 'n' }] } }, [])
    expect(JSON.stringify(c)).not.toContain('hunter2')
    expect(JSON.stringify(c)).toContain('"n"')
  })
})

// STUDIO-NS-T4: assertState with layer node|m reads one node through the hub `get` op.
describe('assertState: layer node|m (NS-T4)', () => {
  const NODE = '  - assertState: { layer: node, node: { id: hero }, path: opacity, equals: 1 }\n'
  it('parses node with layer node and m, and rejects bad shapes', () => {
    const f = parseFlow(BASE + NODE + '  - assertState: { layer: m, node: { id: panel }, path: rowIndex, exists: true }\n')
    expect(f.steps[0]).toMatchObject({ op: 'assertState', layer: 'node', node: { id: 'hero' }, path: 'opacity', equals: 1 })
    expect(f.steps[1]).toMatchObject({ layer: 'm', node: { id: 'panel' } })
    expect(() => parseFlow(BASE + '  - assertState: { layer: node, path: a, equals: 1 }\n')).toThrow(/needs node: \{ id/)
    expect(() => parseFlow(BASE + '  - assertState: { layer: global, node: { id: x }, path: a, equals: 1 }\n')).toThrow(/node only applies/)
    expect(() => parseFlow(BASE + '  - assertState: { layer: node, node: { id: x, y: 1 }, path: a, equals: 1 }\n')).toThrow(/needs node/)
  })
  it('usesState includes node and m asserts only', () => {
    expect(ss.usesState(flowOf(BASE + NODE))).toBe(true)
    expect(ss.usesState(flowOf(BASE + '  - assertState: { layer: global, path: a, equals: 1 }\n'))).toBe(false)
  })
  it('passes when the hub get returns the value, sending layer, node and path', async () => {
    const f = flowOf(BASE + NODE)
    const c = await setup(f)
    agent(() => ({ result: { found: true, value: 1 } }))
    const r = await e2e.execStep(f.steps[0], c)
    expect(r.detail).toMatch(/node:hero\.opacity = "1"/)
    expect(sent[0]).toMatchObject({ op: 'get', args: { layer: 'node', node: { id: 'hero' }, path: 'opacity' } })
  })
  it('fails with the last value when it never matches', async () => {
    const f = flowOf(BASE + NODE)
    const c = await setup(f)
    agent(() => ({ result: { found: true, value: 0.5 } }))
    await expect(e2e.execStep({ ...f.steps[0], timeout: 0.3 }, c)).rejects.toThrow(/node:hero\.opacity equals "1" — got 0\.5/)
  })
  it('fails on a masked value without printing it, but exists passes', async () => {
    const f = flowOf(BASE + NODE)
    const c = await setup(f)
    agent(() => ({ result: { found: true, value: '<redacted:token>' } }))
    const err = await e2e.execStep({ ...f.steps[0], timeout: 0.2 }, c).catch((e) => e)
    expect(err.message).toMatch(/masked/)
    await expect(e2e.execStep({ op: 'assertState', layer: 'm', node: { id: 'hero' }, path: 'token', exists: true }, c)).resolves.toBeTruthy()
  })
  it('exists: false passes on found:false, and a refusal fails fast', async () => {
    const f = flowOf(BASE + NODE)
    const c = await setup(f)
    agent((cmd) => (cmd.args.path === 'gone' ? { result: { found: false } } : { error: 'M_NOT_AVAILABLE: built-in node' }))
    await expect(e2e.execStep({ op: 'assertState', layer: 'node', node: { id: 'hero' }, path: 'gone', exists: false }, c)).resolves.toBeTruthy()
    await expect(e2e.execStep({ ...f.steps[0] }, c)).rejects.toThrow(/M_NOT_AVAILABLE/)
  })
  it('no hub: typed error', async () => {
    const f = flowOf(BASE + NODE)
    await expect(e2e.execStep(f.steps[0], { state: null, stepTimeoutMs: 100 })).rejects.toMatchObject({ code: 'STATE_NO_HUB' })
  })
  it('e2e plan starts the hub for a node assert', () => {
    expect(ss.planSession([{ file: 'x' }], () => flowOf(BASE + NODE))).toBe(true)
  })
})
