import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const { createDevice } = require('../lib/e2e/ecp.js')
const { resolveEcpPort, DEFAULT_ECP_PORT } = require('../lib/devices.js')
const { parseE2eArgs } = require('../bin/cli.js')
const { PerfettoCapture } = require('../lib/studio/perfetto.js')
const { resolveTarget, parseTargets } = require('../lib/e2e/run.js')

afterEach(() => { delete process.env.ROKU_ECP_PORT })

describe('resolveEcpPort', () => {
  it('defaults to 8060', () => { expect(resolveEcpPort(undefined, {})).toBe(DEFAULT_ECP_PORT) })
  it('reads ROKU_ECP_PORT, and the flag wins over env', () => {
    expect(resolveEcpPort(undefined, { ROKU_ECP_PORT: '18060' })).toBe(18060)
    expect(resolveEcpPort('19000', { ROKU_ECP_PORT: '18060' })).toBe(19000)
    expect(resolveEcpPort(null, { ROKU_ECP_PORT: ' ' })).toBe(8060)
  })
  it('rejects invalid ports', () => {
    for (const bad of ['0', '70000', 'abc', '80.5', '-1']) expect(() => resolveEcpPort(bad, {})).toThrow(/invalid ECP port/)
  })
})

describe('--ecp-port parsing', () => {
  it('parses both forms and leaves --host ip:pw untouched', () => {
    expect(parseE2eArgs(['run', 'f.yaml', '--host', '127.0.0.1:pw', '--ecp-port', '18060'])).toMatchObject({ host: '127.0.0.1:pw', ecpPort: '18060' })
    expect(parseE2eArgs(['--ecp-port=18061']).ecpPort).toBe('18061')
    expect(parseE2eArgs([]).ecpPort).toBe(null)
  })
  it('resolveTarget: flag > env > default; parseTargets still reads ip:pw', () => {
    process.env.ROKU_ECP_PORT = '18060'
    expect(resolveTarget({ ecpPort: '19000' }).ecpPort).toBe(19000)
    expect(resolveTarget({}).ecpPort).toBe(18060)
    delete process.env.ROKU_ECP_PORT
    expect(resolveTarget({}).ecpPort).toBe(8060)
    expect(parseTargets({ host: '10.0.0.5:Test1234' }).passwords.get('10.0.0.5')).toBe('Test1234')
  })
})

describe('request URLs', () => {
  it('perfetto carries the port', () => {
    expect(new PerfettoCapture({ host: 'h', dir: '/x' }).ecpPort).toBe(8060)
    expect(new PerfettoCapture({ host: 'h', dir: '/x', ecpPort: 18060 }).ecpPort).toBe(18060)
  })
  it('createDevice requests the configured port (default 8060 unchanged)', async () => {
    const seen = []
    const srv = http.createServer((req, res) => { seen.push(req.url); res.end('<device-info></device-info>') })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const port = srv.address().port
      await createDevice({ host: '127.0.0.1', ecpPort: port }).deviceInfo()
      process.env.ROKU_ECP_PORT = String(port)
      await createDevice({ host: '127.0.0.1' }).deviceInfo()
      expect(seen).toEqual(['/query/device-info', '/query/device-info'])
      delete process.env.ROKU_ECP_PORT
      await expect(createDevice({ host: '127.0.0.1', ecpPort: 1 }).deviceInfo()).rejects.toThrow()
    } finally { await new Promise((r) => srv.close(r)) }
  })
})

describe('e2e device against loopback fake Roku on a non-8060 port', () => {
  it('drives ECP on the fake ecp port while the installer port stays separate', async () => {
    const stub = createFakeRoku({ scenario: 'healthy' })
    const a = await stub.start()
    try {
      expect(a.ecpPort).not.toBe(8060)
      expect(a.installerPort).not.toBe(a.ecpPort)
      const dev = createDevice({ host: a.host, ecpPort: a.ecpPort })
      const info = await dev.deviceInfo()
      expect(info.developerEnabled).toBe(true)
      expect(await dev.activeApp()).toBeDefined()
    } finally { await stub.stop() }
  })
})
