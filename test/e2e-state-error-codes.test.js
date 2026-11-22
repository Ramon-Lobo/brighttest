import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const ss = require('../lib/e2e/state-steps.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// Typed state errors reach the console line (`STATE_X: message`) and error.json (`code`), against the fake Roku.
// The step itself is stubbed to throw each typed error; the hub and the fake agent paths are covered in state-steps.test.js.
const CODES = ['STATE_NO_HUB', 'STATE_NOT_INSTRUMENTED', 'STATE_ACK_TIMEOUT', 'STATE_CMD_FAILED', 'STATE_SNAPSHOT_NOT_FOUND', 'STATE_TOO_LARGE', 'STATE_BAD_COMMAND']
let dir, cfg, out
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-state-err-'))
  cfg = loadConfig(dir, null)
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const acquire = async () => ({ lease: { release() {} } })
async function runFlow(steps) {
  const stub = createFakeRoku({ scenario: 'replay-then-live' })
  const a = await stub.start()
  const flow = path.join(dir, 'st.e2e.yaml')
  fs.writeFileSync(flow, `appId: dev\nconfig: { timeout: 3 }\nsteps:\n${steps.map((s) => '  - ' + s).join('\n')}\n`)
  try {
    const code = await e2e.run(cfg, {
      e2eAction: 'run', flows: [flow], host: a.host, ecpPort: a.ecpPort, logPort: a.debugPort,
      screenshots: path.join(dir, 'shots'), screenshotsMode: 'off',
    }, { acquireForLane: acquire })
    return code
  } finally { await stub.stop() }
}
const bundleJson = () => JSON.parse(fs.readFileSync(path.join(dir, 'shots', 'st-failure', 'error.json'), 'utf8'))

describe('typed state errors in the console line and error.json', () => {
  it.each(CODES)('%s is printed with its code and written to error.json', async (code) => {
    vi.spyOn(ss, 'execStep').mockImplementation(async () => { throw new ss.StateStepError(code, `boom for ${code}`) })
    expect(await runFlow(['snapshot: s'])).toBe(1)
    expect(out).toContain(`${code}: boom for ${code}`)
    expect(bundleJson()).toMatchObject({ code, message: `boom for ${code}` })
  }, 15000)

  it('a failure without a state code adds no code field and no prefix', async () => {
    expect(await runFlow(['assertLog: "never printed"'])).toBe(1)
    expect(out).not.toMatch(/STATE_/)
    expect(bundleJson()).not.toHaveProperty('code')
  }, 15000)
})
