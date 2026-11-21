import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createDevice } from '../lib/e2e/ecp.js'
import { execStep } from '../lib/e2e/run.js'
import { parseFlow } from '../lib/e2e/flow.js'
import { readAgentState, MAX_STATE_BYTES } from '../lib/e2e/appstate.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// STA-S-T2: layered read of the __bt_agent node over a fake Roku on 127.0.0.1.
const doc = {
  v: 1, seq: 4, instrumented: true, thread: 'render', renderMs: 3, truncated: [],
  snapshot: { layers: {
    global: { channel: 'Open Cinema', n: 7, tags: ['a', 'b'], cfg: { x: 1, y: [2] } },
    scene: { current: 'PlayerPanel' },
    focus: [{ id: 'rail', subtype: 'RowList' }],
  } },
}

let stub
afterEach(async () => { if (stub) await stub.stop(); stub = null })

async function boot(agentText) {
  stub = createFakeRoku({ scenario: 'healthy', agentText })
  const a = await stub.start()
  const device = createDevice({ host: '127.0.0.1', ecpPort: a.ecpPort })
  return { device, ctx: (ms = 400) => ({ device, stepTimeoutMs: ms }) }
}
const step = (o) => ({ op: 'assertState', ...o })
const paths = () => stub.log.map((e) => JSON.stringify(e))

describe('agent state read path', () => {
  it('flow syntax parses layer, deepEquals and exists', () => {
    const f = parseFlow('steps:\n  - assertState: { layer: global, path: cfg, deepEquals: { x: 1, y: [2] } }\n  - assertState: { path: scene.current, exists: false }\n')
    expect(f.steps[0]).toMatchObject({ op: 'assertState', layer: 'global', path: 'cfg', deepEquals: { x: 1, y: [2] } })
    expect(f.steps[1]).toMatchObject({ path: 'scene.current', exists: false })
    expect(() => parseFlow('steps:\n  - assertState: { path: a, exists: maybe }\n')).toThrow(/exists: must be true or false/)
  })

  it('reads layers from a fake Roku agent node end to end', async () => {
    const { device } = await boot(JSON.stringify(doc))
    const r = await readAgentState(device, { retries: 1, backoffMs: 10 })
    expect(r.layers.scene).toEqual({ current: 'PlayerPanel' })
    expect(r.seq).toBe(4)
    expect(paths().some((u) => /sgnodes\/nodes/.test(u) && /node-id=__bt_agent/.test(u))).toBe(true)
  })

  it('selects a layer, and without one the path starts at the layer name', async () => {
    const { ctx } = await boot(JSON.stringify(doc))
    await expect(execStep(step({ layer: 'scene', path: 'current', equals: 'PlayerPanel' }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'global', path: 'tags.1', equals: 'b' }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ path: 'global.channel', equals: 'Open Cinema' }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'scene', path: 'channel', equals: 'Open Cinema' }), ctx(300))).rejects.toThrow(/path "channel" not found/)
    await expect(execStep(step({ layer: 'nope', path: 'x', exists: true }), ctx(300))).rejects.toThrow(/layer "nope" not found \(have: global, scene, focus\)/)
  })

  it('deepEquals passes on structural equality and fails with the actual value', async () => {
    const { ctx } = await boot(JSON.stringify(doc))
    await expect(execStep(step({ layer: 'global', path: 'cfg', deepEquals: { y: [2], x: 1 } }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'global', path: 'n', deepEquals: 7 }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'global', path: 'cfg', deepEquals: { x: 1, y: [3] } }), ctx(300)))
      .rejects.toThrow(/deepEquals .* got \{"x":1,"y":\[2\]\}/)
    await expect(execStep(step({ layer: 'global', path: 'tags', deepEquals: ['b', 'a'] }), ctx(300))).rejects.toThrow(/deepEquals/)
  })

  it('exists passes on a present key, and on absence with exists: false; fails otherwise', async () => {
    const { ctx } = await boot(JSON.stringify(doc))
    await expect(execStep(step({ layer: 'global', path: 'channel', exists: true }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'global', path: 'gone', exists: false }), ctx())).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'global', path: 'gone', exists: true }), ctx(300))).rejects.toThrow(/exists true — path "gone" not found/)
    await expect(execStep(step({ layer: 'global', path: 'channel', exists: false }), ctx(300))).rejects.toThrow(/exists false — got "Open Cinema"/)
  })

  it('reports STATE_TOO_LARGE past 256 KB instead of truncating', async () => {
    const big = { ...doc, snapshot: { layers: { global: { blob: 'x'.repeat(MAX_STATE_BYTES + 10) } } } }
    const { ctx, device } = await boot(JSON.stringify(big))
    expect(MAX_STATE_BYTES).toBe(262144)
    await expect(readAgentState(device, { retries: 1, backoffMs: 10 })).rejects.toMatchObject({ code: 'STATE_TOO_LARGE' })
    await expect(execStep(step({ layer: 'global', path: 'blob', exists: true }), ctx(2000))).rejects.toMatchObject({ code: 'STATE_TOO_LARGE' })
  })

  it('a document just under the limit still reads', async () => {
    const ok = { ...doc, snapshot: { layers: { global: { blob: 'x'.repeat(MAX_STATE_BYTES - 1000) } } } }
    const { device } = await boot(JSON.stringify(ok))
    const r = await readAgentState(device, { retries: 1, backoffMs: 10 })
    expect(r.layers.global.blob.length).toBe(MAX_STATE_BYTES - 1000)
  })

  it('falls back to the full tree when node-id misses, and to __bt_state without an agent', async () => {
    const legacy = '<sgnodes><All_Nodes><Default name="" /><Scene name="root"><Label name="__bt_state" text="{&quot;current&quot;:&quot;Home&quot;}" /></Scene></All_Nodes><status>OK</status></sgnodes>'
    const urls = []
    const device = { async ecpGet(p) { urls.push(p); return { status: 200, text: p.includes('/nodes') ? '<sgnodes><status>FAILED</status></sgnodes>' : legacy } } }
    const r = await readAgentState(device, { retries: 1, backoffMs: 10 })
    expect(r.present).toBe(false)
    expect(r.fastPath).toBe(false)
    expect(urls[0]).toMatch(/sgnodes\/nodes\?node-id=__bt_agent/)
    expect(urls.some((u) => /sgnodes\/all/.test(u))).toBe(true)
    await expect(execStep(step({ path: 'current', equals: 'Home' }), { device, stepTimeoutMs: 400 })).resolves.toBeTruthy()
    await expect(execStep(step({ layer: 'scene', path: 'current', equals: 'Home' }), { device, stepTimeoutMs: 300 })).rejects.toThrow(/layer "scene" not found/)
  })

  it('node-id fast path hit returns fastPath true and no full-tree read', async () => {
    const node = '<sgnodes><status>OK</status><All_Nodes node-count="1"><Label name="__bt_agent" text="' + JSON.stringify(doc).replace(/"/g, '&quot;') + '" /></All_Nodes></sgnodes>'
    const urls = []
    const device = { async ecpGet(p) { urls.push(p); return { status: 200, text: node } } }
    const r = await readAgentState(device, { retries: 1, backoffMs: 10 })
    expect(r.fastPath).toBe(true)
    expect(r.layers.global.n).toBe(7)
    expect(urls).toHaveLength(1)
  })
})
