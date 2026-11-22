import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// STA-S-T9 headless half: BT_mOp (the component-side body of BT_op) on a plain AA standing in for `m`, the host-side `m`
// routing (BT_wRoot/BT_wGet/BT_wSet) against plain Node nodes, and the publish rate cap. A real component, callFunc and
// the executing thread are device-only (TP-STA-20 device part, DQ-5).
const require = createRequire(import.meta.url)
const brsCli = path.resolve(__dirname, '../node_modules/.bin/brs-cli')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = ['bt/BT_core.brs', 'bt/BT_write.brs', 'btop/BT_mOp.brs'].map(strip).join('\n')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-op-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function runBrs(main) {
  const file = path.join(tmp, 'op.brs')
  fs.writeFileSync(file, [
    'function BT_config() as object',
    '    return { token: "' + 'a'.repeat(32) + '", registrySections: [], callFuncAllow: [], caps: {}, publish: {}, redact: { paths: ["m.secret.*"] } }',
    'end function',
    RUNTIME,
    `sub main()\n${main}\nend sub`,
  ].join('\n'))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}
const tagged = (out, tag) => out.split(/\r?\n/).filter((l) => l.startsWith(tag)).map((l) => JSON.parse(l.slice(tag.length)))

describe('BT_mOp and the m layer (headless, fork engine)', () => {
  let out
  beforeAll(async () => {
    const op = (tag, a) => `    print "${tag}:" + FormatJson(BT_mOp(mm, ${a}))`
    out = await runBrs([
      '    mm = { rowIndex: 2, title: "hi", list: [1, 2], nested: { a: 1 }, top: "t", global: "g", __bt_x: 1 }',
      '    mm.ref = CreateObject("roSGNode", "Node")',
      op('G1', '{ op: "get", path: ["rowIndex"] }'),
      op('G2', '{ op: "get", path: ["nested", "a"] }'),
      op('G3', '{ op: "get", path: ["list", "1"] }'),
      op('G4', '{ op: "get", path: ["nope"] }'),
      op('G5', '{ op: "get", path: ["top"] }'),
      op('G6', '{ op: "get", path: ["__bt_x"] }'),
      op('G7', '{ op: "get", path: ["ref", "id"] }'),
      '    print "G8:" + FormatJson(BT_mOp(mm, { op: "get", path: [] }).value.keys())',
      op('S1', '{ op: "set", path: ["rowIndex"], value: 5 }'),
      '    print "S1M:" + FormatJson([mm.rowIndex])',
      op('S2', '{ op: "set", path: ["rowIndex"], value: "x" }'),
      op('S3', '{ op: "set", path: ["newkey"], value: 1 }'),
      op('S4', '{ op: "set", path: ["nested", "b"], value: 1 }'),
      op('S5', '{ op: "set", path: ["global"], value: "z" }'),
      op('S6', '{ op: "set", path: ["__bt_x"], value: 2 }'),
      op('S7', '{ op: "set", path: ["ref", "id"], value: "q" }'),
      op('S8', '{ op: "set", path: ["list", "1"], value: 9 }'),
      '    print "S8M:" + FormatJson(mm.list)',
      op('S9', '{ op: "set", path: ["nested", "a"], value: 7, dry: true }'),
      '    print "S9M:" + FormatJson([mm.nested.a])',
      op('S10', '{ op: "set", path: ["rowIndex"], value: 1.5 }'),
      op('P1', 'invalid'),
      // host side against plain nodes
      '    g = CreateObject("roSGNode", "Node") : sc = CreateObject("roSGNode", "Node")',
      '    p = CreateObject("roSGNode", "Node") : p.id = "panel" : sc.appendChild(p)',
      '    ctx = { global: g, scene: sc, cfg: BT_config(), state: { subscribed: false } }',
      '    print "H1:" + FormatJson(BT_wApply({ op: "get", args: { layer: "m", node: { id: "panel" }, path: "rowIndex" } }, ctx))',
      '    print "H2:" + FormatJson(BT_wApply({ op: "set", args: { layer: "m", node: { id: "panel" }, path: "rowIndex", value: 3 } }, ctx))',
      '    print "H3:" + FormatJson(BT_wApply({ op: "get", args: { layer: "m", node: { id: "ghost" }, path: "rowIndex" } }, ctx))',
      '    print "H4:" + FormatJson(BT_wApply({ op: "snapshot", args: { nodes: ["panel"] } }, ctx).result.layers.keys())',
      '    print "H5:" + FormatJson(BT_layers(g, sc, BT_config(), []).keys())',
      // host m layer through a fake component whose callFunc forwards to BT_mOp
      '    fm = { rowIndex: 2, nested: { a: 1 }, secret: { x: "s3" }, top: "t" }',
      '    fm.callFunc = function(n as string, a as dynamic) as dynamic',
      '        return BT_mOp(m.fm, a)',
      '    end function',
      '    fm.fm = fm',
      '    print "F1:" + FormatJson(BT_wMCall(fm, { op: "set", path: ["top"], value: "z" }))',
      '    print "F2:" + FormatJson(BT_wMCall(fm, { op: "set", path: ["nope"], value: 1 }))',
      '    print "F3:" + FormatJson(BT_wMCall(fm, { op: "set", path: ["rowIndex"], value: "x" }))',
      '    print "F4:" + FormatJson(BT_wSetPathX({ node: fm, layer: "m" }, ["rowIndex"], "x", true))',
      '    print "F5:" + FormatJson(BT_wSetPathX({ node: fm, layer: "m" }, ["nope"], 1, true))',
      '    print "F6:" + FormatJson(BT_wSetPathX({ node: fm, layer: "m" }, ["rowIndex"], 7, false))',
      '    print "F6M:" + FormatJson([fm.rowIndex])',
      '    print "F7:" + FormatJson(BT_wMGet(fm, [], { path: "" }, BT_capsFrom(BT_config()), invalid, []))',
      '    print "F8:" + FormatJson(BT_wMGet(fm, ["secret", "x"], { path: "secret.x" }, BT_capsFrom(BT_config()), BT_config().redact.paths, []))',
      '    print "F9:" + FormatJson(BT_wMGet(fm, ["nested", "a"], { path: "nested.a" }, BT_capsFrom(BT_config()), BT_config().redact.paths, []))',
      '    nb = { callFunc: function(n as string, a as dynamic) as dynamic',
      '        return invalid',
      '    end function }',
      '    print "F10:" + FormatJson(BT_wMCall(nb, {}))',
      // rate cap
      '    print "C1:" + FormatJson([BT_wCadence(BT_config(), false, false, 16384), BT_wCadence(BT_config(), false, false, 16385), BT_wCadence(BT_config(), false, true, 20000), BT_wCadence({ publish: { intervalMs: 2000 } }, false, false, 20000)])',
      '    print "C2:" + BT_wClampEvent(BT_config(), 16384, "s") + "|" + BT_wClampEvent(BT_config(), 16385, "s") + "|" + BT_wClampEvent({ publish: { intervalMs: 1000 } }, 99999, "s")',
    ].join('\n'))
  }, 90000)
  const t = (tag) => tagged(out, tag + ':')[0]

  it('get reaches existing fields, nested paths and array items; a miss is found:false', () => {
    expect(t('G1')).toMatchObject({ ok: true, btop: true, found: true, value: 2 })
    expect(t('G2').value).toBe(1)
    expect(t('G3').value).toBe(2)
    expect(t('G4')).toMatchObject({ ok: true, found: false })
    expect(t('G8').map((k) => k.toLowerCase())).toEqual(['list', 'nested', 'ref', 'rowindex', 'title'])
  })
  it('top, global and __bt* are unreachable on read and write; no path crosses a node', () => {
    for (const k of ['G5', 'G6', 'S5', 'S6']) expect(t(k).error, k).toMatch(/^M_PATH_FORBIDDEN/)
    expect(t('G7').error).toMatch(/^PATH_UNDER_NODE/)
    expect(t('S7').error).toMatch(/^PATH_UNDER_NODE/)
  })
  it('set is type-checked, never creates a key and honours dry', () => {
    expect(t('S1')).toMatchObject({ ok: true })
    expect(t('S1M')).toEqual([5])
    expect(t('S2').error).toMatch(/^TYPE_MISMATCH/)
    expect(t('S10').error).toMatch(/^TYPE_MISMATCH/)
    expect(t('S3').error).toMatch(/^FIELD_NOT_FOUND/)
    expect(t('S4').error).toMatch(/^FIELD_NOT_FOUND/)
    expect(t('S8')).toMatchObject({ ok: true })
    expect(t('S8M')).toEqual([1, 9])
    expect(t('S9')).toMatchObject({ ok: true })
    expect(t('S9M')).toEqual([1])
  })
  it('no op answers the BT_op marker', () => {
    expect(t('P1')).toEqual({ ok: true, btop: true })
  })
  it('host: a node without BT_op answers M_NOT_AVAILABLE, an unknown id NODE_NOT_FOUND', () => {
    expect(t('H1').error).toMatch(/^M_NOT_AVAILABLE/)
    expect(t('H2').error).toMatch(/^M_NOT_AVAILABLE/)
    expect(t('H3').error).toMatch(/^NODE_NOT_FOUND/)
  })
  it('host: m-layer refusals pass through BT_wMCall, not M_NOT_AVAILABLE', () => {
    expect(t('F1').error).toMatch(/^M_PATH_FORBIDDEN/)
    expect(t('F2').error).toMatch(/^FIELD_NOT_FOUND/)
    expect(t('F3').error).toMatch(/^TYPE_MISMATCH/)
    expect(t('F4').error).toMatch(/^TYPE_MISMATCH/)
    expect(t('F5').error).toMatch(/^FIELD_NOT_FOUND/)
    expect(t('F10').error).toMatch(/^M_NOT_AVAILABLE/)
  })
  it('host: m get with no path works, redacts configured paths, and a set round-trips', () => {
    expect(t('F6')).toMatchObject({ ok: true })
    expect(t('F6M')).toEqual([7])
    expect(t('F7').ok).toBe(true)
    expect(JSON.stringify(t('F7'))).toContain('rowIndex')
    expect(JSON.stringify(t('F8'))).not.toContain('s3')
    expect(JSON.stringify(t('F8'))).toMatch(/redacted/)
    expect(t('F9').result.value).toBe(1)
  })
  it('the m layer is never in the snapshot or the published layers', () => {
    expect(t('H4')).not.toContain('m')
    expect(t('H5')).toEqual(['focus', 'global', 'scene'])
  })
  it('rate cap: a doc over 16384 bytes clamps the interval to max(intervalMs, 1000) and logs an event', () => {
    expect(t('C1')).toEqual([500, 1000, 10000, 2000])
    const ev = out.split(/\r?\n/).find((l) => l.startsWith('C2:')).slice(3).split('|')
    expect(ev[0]).toBe('')
    expect(ev[2]).toBe('')
    expect(JSON.parse(ev[1])).toMatchObject({ kind: 'agent.rate', session: 's', data: { docChars: 16385, intervalMs: 500, clampedMs: 1000 } })
  })
})

describe('BT_op in the real-state runtime source', () => {
  it('BT_op delegates to BT_mOp with the component m; the stub build keeps the plain marker', () => {
    const { runtimeSource, RESERVED_NAMES } = require('../lib/instrument/plugin.js')
    const real = runtimeSource(false, true)
    expect(real).toMatch(/function BT_mOp\(mm as object, args as dynamic\)/)
    expect(real).toMatch(/function BT_op\(args as dynamic\) as dynamic\n {4}return BT_mOp\(m, args\)/)
    expect(runtimeSource(false, false)).toMatch(/function BT_op[^]*return \{ ok: true \}/)
    for (const n of ['BT_mOp', 'BT_mBad', 'BT_wMCall', 'BT_wMGet', 'BT_wClampEvent']) expect(RESERVED_NAMES).toContain(n)
  })
})
