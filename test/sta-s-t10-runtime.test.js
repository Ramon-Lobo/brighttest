import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// STA-S-T10 runtime (headless, fork engine): the focus op, the task layer, BT_dwHash/BT_dwEmit and BT_taskSnap.
// The Scene, the agent observer and real threads are not exercised here (device: DQ-5).
const brsCli = path.resolve(__dirname, '../node_modules/.bin/brs-cli')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = ['bt/BT_core.brs', 'bt/BT_write.brs', 'btop/BT_mOp.brs'].map(strip).join('\n')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-t10rt-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const MAIN = `
sub main()
    g = CreateObject("roSGNode", "Node")
    g.addFields({ user: { tier: "free" }, count: 1 })
    g.addFields({ "__btEv": "" })
    sc = CreateObject("roSGNode", "Node")
    p = CreateObject("roSGNode", "Node") : p.id = "panel" : sc.appendChild(p)
    ctx = { global: g, scene: sc, cfg: BT_config(), state: { subscribed: false } }
    print "F1:" + FormatJson(BT_wApply({ op: "focus", args: { node: { id: "panel" } } }, ctx))
    print "F2:" + FormatJson(BT_wApply({ op: "focus", args: { node: { id: "nope" } } }, ctx))
    print "F3:" + FormatJson(BT_wApply({ op: "dispatch", args: {} }, ctx))
    h0 = BT_dwHash(g)
    g.count = 2
    h1 = BT_dwHash(g)
    BT_dwEmit(g, "dispatchAction", { type: "user/upgraded", payload: { tier: "premium", authToken: "dummy-secret" } }, h0)
    print "H:" + FormatJson({ same: h0 = h1, len: Len(h0) > 0 })
    print "E:" + g.__btEv
    BT_dwEmit(g, "other", invalid, h1)
    print "E2:" + g.__btEv
    m.alpha = 1
    m.nested = { k: "v" }
    BT_taskSnap(g, "Poller", "entry", m)
    BT_taskSnap(g, "Poller", "exit", m)
    layers = BT_layers(g, sc, BT_config(), [])
    print "T:" + FormatJson(layers.task)
    print "K:" + FormatJson(layers.global.keys())
    print "S:" + FormatJson(BT_wApply({ op: "snapshot", args: {} }, ctx))
end sub
`
let out
beforeAll(async () => {
  const file = path.join(tmp, 't10.brs')
  fs.writeFileSync(file, `function BT_config() as object\n    return { token: "${'a'.repeat(32)}", hub: { host: "127.0.0.1", port: 1 }, caps: {}, publish: {} }\nend function\n${RUNTIME}\n${MAIN}`)
  const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  await new Promise((resolve) => child.on('close', () => { clearTimeout(timer); resolve() }))
}, 90000)
const tag = (t) => { const l = out.split(/\r?\n/).find((x) => x.startsWith(t)); return l === undefined ? undefined : JSON.parse(l.slice(t.length)) }

describe('focus op', () => {
  it('focuses a node by id and names it; an unknown id is NODE_NOT_FOUND', () => {
    expect(tag('F1:')).toEqual({ ok: true, result: { focus: 'panel' } })
    expect(tag('F2:').error).toMatch(/^NODE_NOT_FOUND/)
  })
  it('dispatch stays not supported (BTStore is STA-S-T11)', () => {
    expect(tag('F3:').error).toMatch(/^NOT_SUPPORTED/)
  })
})

describe('dispatch wrap runtime', () => {
  it('the hash follows the global state and the event carries type, payload, both hashes and the source', () => {
    expect(tag('H:')).toEqual({ same: false, len: true })
    const e = tag('E:')
    expect(e).toMatchObject({ source: 'wrap:dispatchAction', type: 'user/upgraded' })
    expect(e.hashBefore).not.toBe(e.hashAfter)
    expect(e.payload.tier).toBe('premium')
    expect(e.payload.authToken).toMatch(/^<redacted:/)
    expect(tag('E2:')).toMatchObject({ source: 'wrap:other' })
    expect(tag('E2:')).not.toHaveProperty('type')
  })
})

describe('Task snapshots runtime', () => {
  it('publish the filtered m under the task layer and keep the bookkeeping fields out of the global layer', () => {
    const t = tag('T:')
    expect(t.Poller.event).toBe('exit')
    expect(t.Poller.m).toEqual({ alpha: 1, nested: { k: 'v' } })
    expect(tag('K:')).toEqual(expect.arrayContaining(['count', 'user']))
    expect(tag('K:').filter((k) => k.startsWith('__bt'))).toEqual([])
    expect(JSON.stringify(tag('S:'))).toContain('"task"')
  })
})
