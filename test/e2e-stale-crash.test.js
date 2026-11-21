import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e, { crashedError } from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// A crash from a previous run must not fail the next run, and a crash during a press step carries the
// APP_CRASHED code like the selector-wait path does.
let dir, cfg, out
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-stale-'))
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
  const flow = path.join(dir, 'stale.e2e.yaml')
  fs.writeFileSync(flow, `appId: dev\nconfig: { timeout: 3 }\nsteps:\n${steps.map((s) => '  - ' + s).join('\n')}\n`)
  try {
    const code = await e2e.run(cfg, {
      e2eAction: 'run', flows: [flow], host: a.host, ecpPort: a.ecpPort, logPort: a.debugPort,
      screenshots: path.join(dir, 'shots'), screenshotsMode: 'off',
    }, { acquireForLane: acquire })
    return { code, stub }
  } finally { await stub.stop() }
}

describe('stale crash state', () => {
  it('a debugger prompt replayed on connect (previous run crashed) does not fail launch', async () => {
    const { code } = await runFlow('debugger-crash', ['launch'])
    expect(out).not.toMatch(/app crashed/)
    expect(code).toBe(0)
  }, 15000)
})

describe('press step crash code', () => {
  it('crashedError carries APP_CRASHED, retryable false, and the summary', () => {
    const err = crashedError({ opts: { app: 'dev' } }, { summary: 'Type Mismatch at pkg:/components/Home.brs(42)' })
    expect(err.code).toBe('APP_CRASHED')
    expect(err.retryable).toBe(false)
    expect(err.message).toBe('APP_CRASHED: app crashed: Type Mismatch at pkg:/components/Home.brs(42)')
  })

  it('run output for a press-step crash starts with APP_CRASHED:', async () => {
    const { code } = await runFlow('crash-mid-flow', ['launch', 'press: { key: Down, count: 3 }'])
    expect(code).toBe(1)
    expect(out).toMatch(/APP_CRASHED: app crashed: Type Mismatch/)
  }, 15000)
})
