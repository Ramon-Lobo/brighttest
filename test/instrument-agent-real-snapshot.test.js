import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// INS-SNAP-ACK-C54: the snapshot ack from the REAL in-app agent (BT_core.brs + BT_write.brs, unmodified) running
// headless on the fork engine (brs-cli), driven through a loopback hub the way Studio / the MCP tool queue a command.
// Nothing about the agent is mocked; the Scene is a plain Node (no device, no real SceneGraph).
const require = createRequire(import.meta.url)
const { startHub } = require('../lib/instrument/hub.js')
const brsCli = path.resolve(__dirname, '../node_modules/.bin/brs-cli')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = `${strip('BT_core.brs')}\n${strip('BT_write.brs')}`
const TOKEN = 'b'.repeat(32)

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-snapack-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(cond, ms) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await sleep(25)
  return cond()
}
function post(hub, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: hub.port, method: 'POST', path: p }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => resolve(JSON.parse(b)))
    })
    r.on('error', reject)
    r.end(body)
  })
}

// One run: start the hub, start the real agent pump, queue a snapshot, capture its applied ack, stop everything.
async function captureAck() {
  let lost = null
  const hub = await startHub({ host: '127.0.0.1', port: 0, mode: 'headless', tokens: [TOKEN], longPollMs: 250, lease: { held: () => true, onLost(cb) { lost = cb }, leaseId: 'lease-snapack' } })
  const file = path.join(tmp, 'agent.brs')
  fs.writeFileSync(file, [
    'function BT_config() as object',
    `    return { token: "${TOKEN}", hub: { host: "127.0.0.1", port: ${hub.port} }, registrySections: [], callFuncAllow: [], caps: {}, publish: {} }`,
    'end function',
    RUNTIME,
    'sub main()',
    '    g = CreateObject("roSGNode", "Node")',
    '    g.addFields({ user: { tier: "free" }, count: 3 })',
    '    sc = CreateObject("roSGNode", "Node")',
    '    ctx = { global: g, scene: sc, cfg: BT_config(), state: { subscribed: false } }',
    '    st = { session: "", after: 0 }',
    '    clock = CreateObject("roTimespan")',
    '    while clock.TotalMilliseconds() < 30000',
    '        if BT_wPumpOnce(ctx, st, 3000) < 0 then exit while',
    '    end while',
    'end sub',
  ].join('\n'))
  const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  const closed = new Promise((resolve) => child.on('close', () => { clearTimeout(timer); resolve() }))
  try {
    expect(await until(() => hub.hellos > 0, 20000)).toBe(true)
    const c = await post(hub, `/bt/${TOKEN}/state`, JSON.stringify({ op: 'snapshot', args: { name: 'S1' } }))
    expect(await until(() => ['done', 'failed'].includes(hub.stateOps.get(c.id).status), 15000)).toBe(true)
    const ack = hub.log.since(0).map((e) => e).find((e) => e.kind === 'cmd.ack' && e.data.id === c.id && e.data.phase === 'applied')
    return { ack: ack.data, stored: hub.stateOps.getSnapshot('S1') }
  } finally {
    if (lost) lost()
    child.kill('SIGKILL')
    await closed
    await hub.stop()
  }
}

describe('real agent snapshot ack (headless, fork engine)', () => {
  let got
  beforeAll(async () => { got = await captureAck() }, 90000)

  it('the applied ack is ok and carries result.layers as an object, small enough to keep as a fixture', () => {
    expect(got.ack).toMatchObject({ phase: 'applied', ok: true })
    expect(got.ack.result.layers).toBeTypeOf('object')
    expect(Array.isArray(got.ack.result.truncated)).toBe(true)
    expect(JSON.stringify(got.ack).length).toBeLessThan(8 * 1024)
  })

  it('layers include global and scene, and the hub stored exactly those layers (state-ops keys by layer name)', () => {
    const layers = got.ack.result.layers
    expect(layers.global.user).toEqual({ tier: 'free' })
    expect(layers.global.count).toBe(3)
    expect(layers).toHaveProperty('scene')
    expect(got.stored).toEqual(layers)
  })

  // SNAP-ACK-C54 (decided): BT_wSnapshot (BT_write.brs:359) does `layers.delete("focus")` on purpose. Focus is not
  // restorable and the ack layers must be restorable, so the ack carries global and scene (plus node/registry when
  // asked) and never focus, although the published Label (BT_layers) does include it.
  it('SNAP-ACK-C54: the ack layers have no focus layer (restorable layers only)', () => {
    expect(got.ack.result.layers).not.toHaveProperty('focus')
    expect(Object.keys(got.ack.result.layers).sort()).toEqual(['global', 'scene'])
  })

  it('the keys the Studio save/restore routes depend on are present', () => {
    expect(got.ack.phase).toBe('applied')
    expect(got.ack.ok).toBe(true)
    expect(got.ack.seq).toBeTypeOf('number')
    expect(got.ack.id).toBeTypeOf('string')
    expect(got.ack.result.layers).toHaveProperty('global')
    expect(got.ack.result.layers).toHaveProperty('scene')
    expect(Array.isArray(got.ack.result.truncated)).toBe(true)
  })
})
