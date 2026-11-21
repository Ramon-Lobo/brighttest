import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import e2e from '../lib/e2e/run.js'
import { createDevice } from '../lib/e2e/ecp.js'
import { loadConfig } from '../lib/config.js'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// ROB-11 TP-ROB-20(a): an id selector against a 6k-node tree reads nodes?node-id=, not sgnodes/all per poll.
let dir, stub
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-big-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(async () => { vi.restoreAllMocks(); if (stub) await stub.stop(); stub = null; fs.rmSync(dir, { recursive: true, force: true }) })

it('assertVisible by id on a 6k tree uses the node-id fast path', async () => {
  stub = createFakeRoku({ scenario: 'large-tree-6k' })
  const a = await stub.start()
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  try {
    const flow = path.join(dir, 'big.e2e.yaml')
    fs.writeFileSync(flow, 'appId: dev\nsteps:\n  - launch\n  - assertVisible: { id: n100 }\n')
    const cfg = loadConfig(dir, null)
    const code = await e2e.run(cfg, { e2eAction: 'run', flows: [flow], host: '127.0.0.1', screenshotsMode: 'off' },
      { createDevice, acquireForLane: async () => ({ lease: { release() {} } }) })
    expect(code).toBe(0)
    const urls = stub.log.map((e) => JSON.stringify(e))
    expect(urls.some((u) => /sgnodes\/nodes/.test(u) && /node-id=n100/.test(u))).toBe(true)
    // Full reads: only the launch/ready ones, not one per assert poll.
    expect(urls.filter((u) => /sgnodes\/all/.test(u)).length).toBeLessThanOrEqual(3)
  } finally { delete process.env.ROKU_ECP_PORT }
}, 60000)
