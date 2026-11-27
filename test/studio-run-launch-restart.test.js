import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const studio = require('../lib/studio/server.js')
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')

// STUDIO-RUN-LAUNCH-RESTART: a Studio Run whose launch step meets a running dev channel relaunches it first.
let dir, fake, server, port, prevPort

function runFlow(file) {
  return new Promise((resolve) => {
    const events = []
    http.get({ host: '127.0.0.1', port, path: `/api/run?file=${file}` }, (res) => {
      let buf = ''
      res.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)))
        }
      })
      res.on('end', () => resolve(events))
    })
  })
}
const FLOW = 'appId: dev\nsteps:\n  - launch: {}\n'

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-relaunch-'))
  fake = createFakeRoku({ scenario: 'healthy', ecpPort: 0, installerPort: 0, consolePort: 0, debugPort: 0 })
  const a = await fake.start()
  prevPort = process.env.ROKU_ECP_PORT
  process.env.ROKU_ECP_PORT = String(a.ecpPort)
  process.env.BRIGHTTEST_LEASE_DIR = dir
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  delete process.env.BRIGHTTEST_HUB_TOKEN
  server = await studio.start({ host: '127.0.0.1', password: 'rokudev-test', port: 0, rootDir: dir,
    leaseOpts: { acquireOpts: { dir, timers: false, identity: {} }, tickMs: 20 } })
  port = server.address().port
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'flows', 'l.e2e.yaml'), FLOW)
})
afterEach(async () => {
  server.close(); await fake.stop()
  if (prevPort === undefined) delete process.env.ROKU_ECP_PORT; else process.env.ROKU_ECP_PORT = prevPort
  delete process.env.BRIGHTTEST_LEASE_DIR; delete process.env.BRIGHTTEST_CACHE
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Studio Run launch step', () => {
  it('presses Home before launching when the dev channel is already running', async () => {
    fake.setActiveApp('dev')
    const ev = await runFlow('l.e2e.yaml')
    expect(ev.find((e) => e.type === 'done')).toMatchObject({ ok: true })
    expect(fake.keypresses.map((k) => k.key)).toContain('Home')
  })

  it('reports the relaunch failure, not a handshake error, when the relaunch fails', async () => {
    fake.setActiveApp('dev')
    fake.setFault({ mode: 'status', status: 500, path: '/keypress/Home' })
    const ev = await runFlow('l.e2e.yaml')
    const step = ev.find((e) => e.type === 'step' && e.status === 'fail')
    expect(step.error).toMatch(/relaunch of the running dev channel failed/)
    expect(step.error).not.toMatch(/handshake/i)
  })

  it('does not press Home when no channel is running', async () => {
    fake.setActiveApp('roku')
    const ev = await runFlow('l.e2e.yaml')
    expect(ev.find((e) => e.type === 'done')).toMatchObject({ ok: true })
    expect(fake.keypresses.map((k) => k.key)).not.toContain('Home')
  })
})
