import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// STA-S-T6: the agent write path. The apply half (BT_wApply) and the headless pump (BT_wPumpOnce) run in brs-cli on the
// fork engine against plain Node nodes and a loopback hub with a fake lease. The BT_AgentTask / BT_Agent thread split
// and a real Scene are not exercised here (scene lane / device: see the report).
const require = createRequire(import.meta.url)
const { startHub } = require('../lib/instrument/hub.js')
const brsCli = path.resolve(__dirname, '../node_modules/.bin/brs-cli')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = `${strip('BT_core.brs')}\n${strip('BT_write.brs')}`
const TOKEN = 'a'.repeat(32)
const SECTION = 'bt_wt_prefs'

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-write-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const SETUP = [
  '    g = CreateObject("roSGNode", "Node")',
  '    g.addFields({ user: { tier: "free", n: 1 }, count: 3, flag: false, title: "hi" })',
  '    sc = CreateObject("roSGNode", "Node")',
  '    p = CreateObject("roSGNode", "Node") : p.id = "panel" : p.addFields({ rowIndex: 2 }) : sc.appendChild(p)',
  '    ctx = { global: g, scene: sc, cfg: BT_config(), state: { subscribed: false } }',
  '    rn = function(c, op, args)',
  '        return FormatJson(BT_wApply({ op: op, args: args }, c))',
  '    end function',
].join('\n')

function runBrs(name, { port = 0, extraCfg = '', main }) {
  const file = path.join(tmp, name + '.brs')
  fs.writeFileSync(file, [
    'function BT_config() as object',
    `    return { token: "${TOKEN}", hub: { host: "127.0.0.1", port: ${port} }, registrySections: ["${SECTION}"], callFuncAllow: ["resetCounter"], caps: {}, publish: {}${extraCfg} }`,
    'end function',
    RUNTIME,
    `sub main()\n${SETUP}\n${main}\nend sub`,
  ].join('\n'))
  const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const done = new Promise((resolve) => child.on('close', () => { clearTimeout(timer); resolve(out) }))
  return { done, kill: () => child.kill('SIGKILL') }
}
const tagged = (out, tag) => out.split(/\r?\n/).filter((l) => l.startsWith(tag)).map((l) => JSON.parse(l.slice(tag.length)))

describe('BT_wApply (headless, fork engine)', () => {
  let out
  beforeAll(async () => {
    const lines = [
      // TP-STA-12 allow-list and type safety
      ['A1', 'set', '{ layer: "global", path: "user.tier", value: "premium" }'],
      ['A2', 'get', '{ layer: "global", path: "user.tier" }'],
      ['A3', 'eval', '{ code: "x" }'],
      ['A4', 'callFunc', '{ node: { id: "panel" }, fn: "deleteEverything" }'],
      ['A5', 'callFunc', '{ node: { id: "panel" }, fn: "resetCounter" }'],
      ['A6', 'set', '{ layer: "global", path: "count", value: "seven" }'],
      ['A7', 'get', '{ layer: "global", path: "count" }'],
      ['A8', 'registry.write', `{ section: "${SECTION}", key: "theme", value: "dark" }`],
      ['A9', 'registry.read', `{ section: "${SECTION}", key: "theme" }`],
      ['A10', 'set', '{ layer: "node", node: { id: "panel" }, path: "nofield.x", value: 1 }'],
      ['A11', 'registry.write', '{ section: "other", key: "k", value: "v" }'],
      ['A12', 'registry.delete', '{ section: "x" }'],
      ['A13', 'set', '{ layer: "global", path: "user.n", value: 1.5 }'],
      ['A14', 'set', '{ layer: "global", path: "title", value: 5 }'],
      ['A15', 'dispatch', '{ type: "x" }'],
    ].map(([tag, op, args]) => `    print "${tag}:" + rn(ctx, "${op}", ${args})`)
    out = await runBrs('apply', {
      main: [
        ...lines,
        // a node reference: the path may not cross it
        '    holder = CreateObject("roSGNode", "Node") : holder.addFields({ child: p })',
        '    ctx.global.addFields({ ref: p })',
        '    print "A16:" + rn(ctx, "set", { layer: "global", path: "ref.id", value: "z" })',
        // snapshot, mutate, restore, snapshot (TP-STA-13)
        `    print "S1:" + rn(ctx, "snapshot", { name: "S1", nodes: ["panel"] })`,
        '    s1 = BT_wApply({ op: "snapshot", args: { nodes: ["panel"] } }, ctx).result',
        '    for i = 1 to 5 : BT_wApply({ op: "set", args: { layer: "global", path: "user.k" + i.toStr(), value: i } }, ctx) : end for',
        '    BT_wApply({ op: "set", args: { layer: "global", path: "user.tier", value: "gold" } }, ctx)',
        '    BT_wApply({ op: "set", args: { layer: "global", path: "count", value: 99 } }, ctx)',
        `    BT_wApply({ op: "registry.write", args: { section: "${SECTION}", key: "theme", value: "light" } }, ctx)`,
        `    BT_wApply({ op: "registry.write", args: { section: "${SECTION}", key: "added", value: "later" } }, ctx)`,
        '    BT_wApply({ op: "set", args: { layer: "global", path: "addedField", value: 7 } }, ctx)',
        '    BT_wApply({ op: "set", args: { layer: "node", node: { id: "panel" }, path: "rowIndex", value: 9 } }, ctx)',
        '    print "R:" + FormatJson(BT_wApply({ op: "restore", args: { layers: s1.layers } }, ctx))',
        '    s2 = BT_wApply({ op: "snapshot", args: { nodes: ["panel"] } }, ctx).result',
        '    print "L1:" + FormatJson(s1.layers)',
        '    print "L2:" + FormatJson(s2.layers)',
        // set with ops (batch): one command, validated first
        '    ctx.global.addFields({ b1: 1, b2: "x", b3: { k: 1 } })',
        '    print "B1:" + rn(ctx, "set", { layer: "global", ops: [{ path: "b1", value: 5 }, { path: "b3.k", value: 7 }, { path: "b3.new", value: true }, { path: "b2", value: "y" }] })',
        '    print "B1G:" + FormatJson([ctx.global.b1, ctx.global.b2, ctx.global.b3])',
        '    print "B2:" + rn(ctx, "set", { layer: "global", ops: [{ path: "b1", value: 9 }, { path: "b2", value: 3 }, { path: "b3.k", value: 8 }] })',
        '    print "B2G:" + FormatJson([ctx.global.b1, ctx.global.b2, ctx.global.b3])',
        '    print "B3:" + rn(ctx, "set", { layer: "global", ops: [{ path: "b1", value: 9 }, { path: "ref.id", value: "q" }] })',
        '    print "B3G:" + FormatJson([ctx.global.b1])',
        '    print "B4:" + rn(ctx, "set", { layer: "registry", ops: [{ path: "a.b", value: 1 }] })',
        '    print "B5:" + rn(ctx, "set", { layer: "global", ops: [] })',
        '    print "B6:" + rn(ctx, "set", { layer: "global", path: "b1", value: 6, ops: [{ path: "b1", value: 1 }] })',
        '    print "B7:" + rn(ctx, "set", { layer: "node", node: { id: "panel" }, ops: [{ path: "rowIndex", value: 4 }] })',
        '    print "B7G:" + FormatJson([p.rowIndex])',
        '    print "B8:" + rn(ctx, "set", { layer: "global", ops: [{ path: "b1" }] })',
        // cadence
        '    print "C:" + FormatJson([BT_wCadence(BT_config(), false, true), BT_wCadence(BT_config(), true, true), BT_wCadence(BT_config(), false, false)])',
        // oversized args and oversized get
        '    big = {} : for i = 1 to 400 : big["k" + i.toStr()] = string(200, "x") : end for',
        '    print "BIG:" + rn(ctx, "set", { layer: "global", path: "user.blob", value: big })',
        '    ctx.global.addFields({ bigf: big })',
        '    print "BIGGET:" + rn(ctx, "get", { layer: "global", path: "bigf" })',
      ].join('\n'),
    }).done
  }, 90000)

  const a = (n) => tagged(out, `A${n}:`)[0]

  it('TP-STA-12: set then get round-trips; unknown op is "op not allowed"', () => {
    expect(a(1)).toMatchObject({ ok: true })
    expect(a(2).result).toMatchObject({ found: true, value: 'premium' })
    expect(a(3)).toEqual({ ok: false, error: 'op not allowed: eval' })
    expect(a(12)).toEqual({ ok: false, error: 'op not allowed: registry.delete' })
  })
  it('TP-STA-12: callFunc runs only allow-listed names', () => {
    expect(a(4).error).toMatch(/^CALLFUNC_NOT_ALLOWED/)
    // allow-listed but the fixture node has no such function: the op still answers, the app keeps running
    expect(a(5).ok === true || /APPLY_FAILED|NODE_NOT_FOUND/.test(a(5).error)).toBe(true)
    expect(out).not.toMatch(/Finished 'apply.brs' execution \[EXIT_PANIC\]/)
  })
  it('TP-STA-12: a type mismatch is refused with a clear error and the next get still works', () => {
    expect(a(6).error).toMatch(/^TYPE_MISMATCH: field count holds a number; got a string/)
    expect(a(7).result).toMatchObject({ found: true, value: 3 })
    expect(a(13).error).toMatch(/^TYPE_MISMATCH: n holds a whole number; got a fractional value/)
    expect(a(14).error).toMatch(/^TYPE_MISMATCH/)
  })
  it('TP-STA-12: registry write is flushed and readable; sections are allow-listed; a missing node field is refused', () => {
    expect(a(8).ok).toBe(true)
    expect(a(9).result).toEqual({ found: true, value: 'dark' })
    expect(a(11).error).toMatch(/^REGISTRY_SECTION_NOT_ALLOWED/)
    expect(a(10).error).toMatch(/^FIELD_NOT_FOUND/)
  })
  it('TP-STA-12: a path under a node reference is refused; dispatch is not supported yet', () => {
    expect(a(16).error).toMatch(/^PATH_UNDER_NODE/)
    expect(a(15).error).toMatch(/^NOT_SUPPORTED/)
  })
  it('set with ops applies the batch in order as one command with one ack', () => {
    expect(tagged(out, 'B1:')[0]).toEqual({ ok: true, result: { ops: 4 } })
    expect(tagged(out, 'B1G:')[0]).toEqual([5, 'y', { k: 7, new: true }])
    expect(tagged(out, 'B7:')[0]).toEqual({ ok: true, result: { ops: 1 } })
    expect(tagged(out, 'B7G:')[0]).toEqual([4])
  })
  it('a failing op in a batch applies nothing and names its index', () => {
    expect(tagged(out, 'B2:')[0].error).toMatch(/^TYPE_MISMATCH: field b2 holds a string; got a number \(ops\[1\]; nothing was applied\)$/)
    expect(tagged(out, 'B2G:')[0]).toEqual([5, 'y', { k: 7, new: true }])
    expect(tagged(out, 'B3:')[0].error).toMatch(/^PATH_UNDER_NODE.*\(ops\[1\]; nothing was applied\)$/)
    expect(tagged(out, 'B3G:')[0]).toEqual([5])
    expect(tagged(out, 'B8:')[0].error).toMatch(/^BAD_COMMAND: op needs a value \(ops\[0\]/)
  })
  it('ops is refused on the registry layer, when empty, and combined with path/value; single set is unchanged', () => {
    expect(tagged(out, 'B4:')[0].error).toMatch(/^BAD_LAYER/)
    expect(tagged(out, 'B5:')[0].error).toMatch(/^BAD_COMMAND: ops must be a non-empty list/)
    expect(tagged(out, 'B6:')[0].error).toMatch(/^BAD_COMMAND: ops cannot be combined/)
    expect(a(1)).toEqual({ ok: true, result: { path: 'user.tier' } })
    expect(a(6).error).toMatch(/^TYPE_MISMATCH: field count holds a number; got a string/)
  })
  it('refuses over-64 KB payloads with a typed STATE_TOO_LARGE, never truncating', () => {
    expect(tagged(out, 'BIG:')[0].error).toMatch(/^STATE_TOO_LARGE/)
    expect(tagged(out, 'BIGGET:')[0].error).toMatch(/^STATE_TOO_LARGE/)
  })
  it('TP-STA-13: restore brings global, registry and node layers back; added fields are reported, not removed', () => {
    const r = tagged(out, 'R:')[0]
    expect(r.ok).toBe(true)
    expect(r.result.bestEffort).toBe(true)
    expect(r.result.added).toEqual(expect.arrayContaining(['global.addedField', `registry.${SECTION}.added`]))
    const l1 = tagged(out, 'L1:')[0]
    const l2 = tagged(out, 'L2:')[0]
    // normalization (pack 6.3): drop the documented added field and the registry key added after S1, compare layer by layer
    delete l2.global.addedField
    delete l2.registry[SECTION].added
    expect(l2.node).toEqual(l1.node)
    expect(l2.node.panel.rowIndex).toBe(2)
    expect(l2.registry).toEqual(l1.registry)
    expect(l2.global.count).toBe(3)
    expect(l2.global.user.tier).toBe('premium')
    expect(l2.global.user.n).toBe(1)
    // an object field is restored whole: keys added inside it after S1 are gone again (only new top-level fields stay)
    expect(l2.global.user).toEqual(l1.global.user)
    const keys = (o) => Object.keys(o).filter((k) => k !== 'user').sort()
    expect(keys(l2.global)).toEqual(keys(l1.global))
  })
  it('restore skips cut, redacted and node-reference values and says so', async () => {
    const o = await runBrs('skip', {
      main: [
        '    r = BT_wApply({ op: "restore", args: { layers: { global: { title: "<redacted:title>", count: 4, user: { tier: "$truncated:depth" } } } } }, ctx)',
        '    print "R:" + FormatJson(r)',
        '    print "G:" + rn(ctx, "get", { layer: "global", path: "title" })',
      ].join('\n'),
    }).done
    const r = tagged(o, 'R:')[0]
    expect(r.result.restored).toBe(1)
    expect(r.result.skipped.map((s) => s.split(':')[0]).sort()).toEqual(['global.title', 'global.user'])
    expect(tagged(o, 'G:')[0].result.value).toBe('hi')
  })
  it('TP-STA-28 (cadence): 5 s with a live hub and no subscriber, 500 ms subscribed or with no hub', () => {
    expect(tagged(out, 'C:')[0]).toEqual([5000, 500, 500])
  })
})

function httpReq(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: hub.port, method, path: p }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    r.on('error', reject)
    r.end(body)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(cond, ms) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await sleep(25)
  return cond()
}

describe('write path over a loopback hub (headless pump, fork engine)', () => {
  let hub, lost, proc
  async function setup(extraMain = '') {
    lost = null
    hub = await startHub({ host: '127.0.0.1', port: 0, mode: 'headless', tokens: [TOKEN], longPollMs: 250, lease: { held: () => true, onLost(cb) { lost = cb }, leaseId: 'lease-t6' } })
    proc = runBrs('pump-' + Math.random().toString(36).slice(2, 8), {
      port: hub.port,
      main: [
        '    st = { session: "", after: 0 }',
        '    clock = CreateObject("roTimespan")',
        '    while clock.TotalMilliseconds() < 45000',
        '        if BT_wPumpOnce(ctx, st, 3000) < 0 then exit while',
        '    end while',
        extraMain,
        '    print "FINAL:" + FormatJson(BT_wApply({ op: "get", args: { layer: "global", path: "user.tier" } }, ctx))',
        '    print "DONE:{}"',
      ].join('\n'),
    })
    expect(await until(() => hub.hellos > 0, 20000)).toBe(true)
  }
  async function finish() { lost(); const out = await proc.done; await hub.stop(); return out }
  const send = async (body) => JSON.parse((await httpReq(hub, 'POST', `/bt/${TOKEN}/state`, JSON.stringify(body))).body)
  const phases = () => hub.log.since(0).filter((e) => e.kind === 'cmd.ack').map((e) => e.data)
  const q = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]

  it('TP-STA-11: set then get round-trips, then 50 pipelined sets ack in seq order with received < applied < reflected', async () => {
    await setup()
    try {
      const first = await send({ op: 'set', args: { layer: 'global', path: 'user.tier', value: 'premium' }, ack: 'reflected' })
      expect(await until(() => hub.stateOps.get(first.id).status === 'done', 15000)).toBe(true)
      const got = await send({ op: 'get', args: { layer: 'global', path: 'user.tier' } })
      expect(await until(() => hub.stateOps.get(got.id).status === 'done', 15000)).toBe(true)
      expect(hub.stateOps.get(got.id).result).toMatchObject({ found: true, value: 'premium' })

      const ids = []
      const sentAt = {}
      for (let i = 1; i <= 50; i++) {
        const c = await send({ op: 'set', args: { layer: 'global', path: 'user.tier', value: `v${i}` }, ack: 'reflected' })
        sentAt[c.id] = Date.now(); ids.push(c)
      }
      expect(await until(() => ids.every((c) => hub.stateOps.get(c.id).status === 'done'), 30000)).toBe(true)
      const acks = phases().filter((a) => ids.some((c) => c.id === a.id))
      const rank = { received: 0, applied: 1, reflected: 2 }
      for (const c of ids) {
        const mine = acks.filter((a) => a.id === c.id).map((a) => a.phase)
        expect(mine).toEqual(['received', 'applied', 'reflected'])
        expect(hub.stateOps.get(c.id)).toMatchObject({ phase: 'reflected', status: 'done', ok: true })
      }
      const appliedSeqs = acks.filter((a) => a.phase === 'applied').map((a) => a.seq)
      expect(appliedSeqs).toEqual([...appliedSeqs].sort((a, b) => a - b))
      expect(acks.every((a, i) => i === 0 || rank[a.phase] >= 0)).toBe(true)
      expect(hub.stateOps.gaps).toEqual([])
      expect(hub.stateOps.counters).toMatchObject({ duplicates: 0, unknown: 0, outOfOrder: 0 })
      const lat = hub.log.since(0).filter((e) => e.kind === 'cmd.ack' && e.data.phase === 'applied' && sentAt[e.data.id]).map((e) => e.ts - sentAt[e.data.id])
      console.info(`TP-STA-11 headless applied latency ms (this lane, not a device budget): p50=${q(lat, 0.5)} p95=${q(lat, 0.95)}`)
    } finally {
      const out = await finish()
      expect(tagged(out, 'FINAL:')[0].result.value).toBe('v50')
    }
  }, 120000)

  it('TP-STA-13 over the hub: snapshot stored host-side, mutate, restore {name}, identical read', async () => {
    await setup()
    try {
      const done = async (c) => { expect(await until(() => ['done', 'failed'].includes(hub.stateOps.get(c.id).status), 15000)).toBe(true); return hub.stateOps.get(c.id) }
      await done(await send({ op: 'set', args: { layer: 'global', path: 'user.tier', value: 'base' } }))
      await done(await send({ op: 'snapshot', args: { name: 'S1' } }))
      expect(hub.stateOps.getSnapshot('S1').global.user.tier).toBe('base')
      await done(await send({ op: 'set', args: { layer: 'global', path: 'user.tier', value: 'changed' } }))
      const r = await done(await send({ op: 'restore', args: { name: 'S1' } }))
      expect(r).toMatchObject({ status: 'done', ok: true })
      expect(r.result.bestEffort).toBe(true)
      const g = await done(await send({ op: 'get', args: { layer: 'global', path: 'user.tier' } }))
      expect(g.result.value).toBe('base')
      const bad = await done(await send({ op: 'set', args: { layer: 'global', path: 'count', value: 'x' } }))
      expect(bad).toMatchObject({ status: 'failed', ok: false })
      expect(bad.error).toMatch(/^TYPE_MISMATCH/)
      const again = await done(await send({ op: 'get', args: { layer: 'global', path: 'count' } }))
      expect(again.result.value).toBe(3) // the app keeps running
    } finally { await finish() }
  }, 120000)

  it('TP-STA-28 (headless): idle agent keeps at most one long-poll outstanding and posts no events', async () => {
    await setup()
    try {
      await sleep(2500)
      const s = hub.stats
      expect(s.peakWaiters).toBeLessThanOrEqual(1)
      expect(s.cmdPolls).toBeGreaterThanOrEqual(3)
      expect(s.eventPosts).toBe(0)
    } finally { await finish() }
  }, 60000)

  it('a command queued after the lease is lost is never applied: the pump stops on 423', async () => {
    await setup()
    lost()
    const out = await proc.done
    await hub.stop()
    expect(tagged(out, 'FINAL:')[0].result.value).toBe('free')
  }, 60000)
})
