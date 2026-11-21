import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// The run path against the fake Roku: one 8085 connection per run, replayed history discarded, assertLog /
// expectNoLog, and the console crash path (debugger prompt -> Home + failure bundle).
let dir, cfg, out
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-logs-'))
  cfg = loadConfig(dir, null)
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const acquire = async () => ({ lease: { release() {} } })
async function runFlow(scenario, steps) {
  const stub = createFakeRoku({ scenario })
  const a = await stub.start()
  const flow = path.join(dir, 'log-smoke.e2e.yaml')
  fs.writeFileSync(flow, `appId: dev\nconfig: { timeout: 3 }\nsteps:\n${steps.map((s) => '  - ' + s).join('\n')}\n`)
  try {
    const code = await e2e.run(cfg, {
      e2eAction: 'run', flows: [flow], host: a.host, ecpPort: a.ecpPort, logPort: a.debugPort,
      screenshots: path.join(dir, 'shots'), screenshotsMode: 'off',
    }, { acquireForLane: acquire })
    return { code, stub }
  } finally { await stub.stop() }
}

describe('e2e run with 8085 log capture', () => {
  it('replay-then-live: assertLog sees live lines, history is excluded, one connection', async () => {
    const { code, stub } = await runFlow('replay-then-live', ['launch', 'assertLog: "FakeApp: live line 3"', 'expectNoLog: "ERROR"', 'expectNoLog: "catalog loaded"'])
    expect(out).toMatch(/assertLog/)
    expect(code).toBe(0)
    expect(stub.debugConnections).toBe(1)
    const art = fs.readFileSync(path.join(dir, 'shots', 'log-smoke.log'), 'utf8')
    expect(art).toMatch(/live line 3/)
    expect(art).not.toMatch(/scene created/)
    const seqs = art.trim().split('\n').map((l) => Number(l.split('\t')[0]))
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)).toBe(true)
  }, 15000)

  it('expectNoLog fails the flow when the line is present', async () => {
    const { code } = await runFlow('replay-then-live', ['launch', 'assertLog: "live line 2"', 'expectNoLog: "live line"'])
    expect(code).toBe(1)
    expect(out).toMatch(/expectNoLog "live line": matched seq/)
  }, 15000)

  it('debugger-crash: reports the backtrace, sends Home, writes a bundle', async () => {
    const { code, stub } = await runFlow('debugger-crash', ['launch', 'assertLog: "never printed"'])
    expect(code).toBe(1)
    expect(out).toMatch(/app crashed: Type Mismatch.*pkg:\/components\/Home\.brs\(42\)/)
    expect(JSON.stringify(stub.keypresses)).toMatch(/Home/)
    const bundle = path.join(dir, 'shots', 'log-smoke-failure')
    expect(fs.readFileSync(path.join(bundle, 'log-tail.txt'), 'utf8')).toMatch(/Brightscript Debugger>/)
    expect(JSON.parse(fs.readFileSync(path.join(bundle, 'error.json'), 'utf8')).crash.backtrace.line).toBe(42)
    expect(fs.existsSync(path.join(bundle, 'screenshot-error.json'))).toBe(true)
  }, 15000)
})
