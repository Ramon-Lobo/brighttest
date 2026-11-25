import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Flow `snapshot: { name, nodes: [...] }` then `restore`, headless on the fork engine. The command arguments come from
// the real flow parser (normalizeStep / setStateCommand), and the agent half (BT_wApply) runs against a scene that has
// a Label with id tierLabel, as the legacy example scene does. Real device behavior is not covered here.
const require = createRequire(import.meta.url)
const { parseFlow } = require('../lib/e2e/flow.js')
const { setStateCommand } = require('../lib/e2e/state-steps.js')
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = `${strip('BT_core.brs')}\n${strip('BT_write.brs')}`

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-restore-node-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const flow = parseFlow([
  'appId: dev', 'steps:',
  '  - snapshot: { name: s, nodes: [tierLabel, goneNode, tierLabel] }',
  '  - setState: { layer: node, node: { id: tierLabel }, path: text, value: "Tier: premium" }',
  '  - restore: s',
].join('\n'))
const snapArgs = { name: flow.steps[0].name, nodes: flow.steps[0].nodes }
const setCmd = setStateCommand(flow.steps[1])
const bsLit = (o) => `ParseJson("${JSON.stringify(o).replace(/"/g, '""')}")`

function runBrs(main) {
  const file = path.join(tmp, `t${Math.random().toString(36).slice(2)}.brs`)
  fs.writeFileSync(file, [
    'function BT_config() as object',
    '    return { token: "' + 'a'.repeat(32) + '", hub: { host: "127.0.0.1", port: 0 }, registrySections: [], callFuncAllow: [], caps: {}, publish: {} }',
    'end function',
    RUNTIME,
    'sub main()',
    '    g = CreateObject("roSGNode", "Node")',
    '    sc = CreateObject("roSGNode", "Node")',
    '    t = CreateObject("roSGNode", "Label") : t.id = "tierLabel" : t.text = "Tier: free" : sc.appendChild(t)',
    '    ctx = { global: g, scene: sc, cfg: BT_config(), state: { subscribed: false } }',
    main,
    'end sub',
  ].join('\n'))
  const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
  return new Promise((resolve) => child.on('close', () => { clearTimeout(timer); resolve(out) }))
}
const tagged = (out, tag) => {
  // Windows: the engine's font warning has no trailing newline, so the next print is glued onto it.
  const clean = out.replace(/couldn't load font[^\r\n]*?expect ugly output\./g, '\n')
  const hits = clean.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(tag)).map((l) => JSON.parse(l.slice(tag.length)))
  if (!hits.length) throw new Error(`no ${tag} line in engine output:\n${out}`)
  return hits
}

describe('flow snapshot nodes then restore (headless, fork engine)', () => {
  it('parses to args.nodes with the repeat dropped', () => {
    expect(snapArgs.nodes).toEqual(['tierLabel', 'goneNode'])
    expect(setCmd).toEqual({ op: 'set', args: { layer: 'node', node: { id: 'tierLabel' }, path: 'text', value: 'Tier: premium' } })
  })

  it('restore writes the snapshotted text back; a node missing at snapshot time is left out', async () => {
    const out = await runBrs([
      `    snap = BT_wApply({ op: "snapshot", args: ${bsLit(snapArgs)} }, ctx)`,
      '    print "S:" + FormatJson(snap)',
      `    print "W:" + FormatJson(BT_wApply(${bsLit(setCmd)}, ctx))`,
      '    print "T1:" + t.text',
      '    r = BT_wApply({ op: "restore", args: { layers: snap.result.layers } }, ctx)',
      '    print "R:" + FormatJson(r)',
      '    print "T2:" + t.text',
    ].join('\n'))
    const snap = tagged(out, 'S:')[0]
    expect(Object.keys(snap.result.layers.node)).toEqual(['tierLabel'])
    expect(snap.result.layers.node.tierLabel.text).toBe('Tier: free')
    expect(out).toContain('T1:Tier: premium')
    expect(tagged(out, 'R:')[0].ok).toBe(true)
    expect(out).toContain('T2:Tier: free')
  }, 90000)

  it('a node gone at restore time is listed in skipped, not fatal', async () => {
    const out = await runBrs([
      `    snap = BT_wApply({ op: "snapshot", args: ${bsLit({ name: 's', nodes: ['tierLabel'] })} }, ctx)`,
      '    sc.removeChild(t)',
      '    r = BT_wApply({ op: "restore", args: { layers: snap.result.layers } }, ctx)',
      '    print "R:" + FormatJson(r)',
    ].join('\n'))
    const r = tagged(out, 'R:')[0]
    expect(r.ok).toBe(true)
    expect(r.result.skipped).toContain('node.tierLabel: node not found')
  }, 90000)

  it('a snapshot over 64 KB answers STATE_TOO_LARGE', async () => {
    const out = await runBrs([
      '    big = {} : for i = 1 to 400 : big["k" + i.toStr()] = string(200, "x") : end for',
      '    g.addFields({ bigf: big })',
      `    print "R:" + FormatJson(BT_wApply({ op: "snapshot", args: ${bsLit({ name: 's', nodes: ['tierLabel'] })} }, ctx))`,
    ].join('\n'))
    expect(tagged(out, 'R:')[0].error).toMatch(/^STATE_TOO_LARGE/)
  }, 90000)
})
