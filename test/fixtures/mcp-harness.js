import { createRequire } from 'module'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fake-roku/server.js')
const { createMcpServer } = require('../../lib/mcp/server.js')
const { createDevice } = require('../../lib/e2e/ecp.js')

export const PASSWORD = 'rokudev-test'
const stubs = []
const clients = []
const dirs = []

export function tmpdir(prefix = 'bt-mcp-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}

export async function bootStub(scenario = 'healthy', extra = {}) {
  const stub = createFakeRoku({ scenario, ...extra })
  const a = await stub.start()
  stubs.push(stub)
  return { stub, a }
}

// An in-process MCP server on PassThrough streams, pointed at a stub device. Real lease code, isolated lease dir.
export function startMcp({ a, cwd, limits, leaseDir, password = PASSWORD, env = {}, leaseLib, startLanHub } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const errput = new PassThrough()
  const lines = []
  const waiters = []
  let buf = ''
  let stderr = ''
  output.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      const msg = JSON.parse(line) // stdout must be JSON lines only
      lines.push(msg)
      for (const w of waiters.splice(0)) w()
    }
  })
  errput.on('data', (d) => { stderr += d.toString() })
  const lease = leaseDir || tmpdir('bt-mcp-lease-')
  const sessionEnv = { ...process.env, BRIGHTTEST_LEASE_DIR: lease, BRIGHTTEST_AGENT: 'mcp-test', ...env }
  delete sessionEnv.BRIGHTTEST_LEASE
  delete sessionEnv.BRIGHTTEST_NO_LEASE
  const devices = {
    resolveDevice: () => ({ host: a ? '127.0.0.1' : null, password, source: 'env' }),
    resolveEcpPort: () => (a ? a.ecpPort : 8060),
    cachedDevices: () => [],
  }
  const server = createMcpServer({
    input, output, errput, cwd: cwd || tmpdir(), limits, env: sessionEnv,
    deps: { devices, startLanHub: startLanHub || (async () => ({ stop: async () => {} })), ...(leaseLib ? { leaseLib } : {}), createDevice: (o) => createDevice({ ...o, installerPort: a && a.installerPort }) },
  })
  const waitFor = async (pred) => {
    for (let i = 0; i < 2000; i++) {
      const hit = lines.find(pred)
      if (hit) return hit
      await new Promise((r) => { waiters.push(r); setTimeout(r, 25) })
    }
    throw new Error('timed out waiting for a response')
  }
  let nextId = 1
  const client = {
    server, lines, lease,
    stderr: () => stderr,
    sendRaw: (s) => input.write(s + '\n'),
    send: (o) => input.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'),
    request: async (method, params) => { const id = nextId++; client.send({ id, method, params }); return waitFor((m) => m.id === id) },
    async initialize() {
      const r = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      client.send({ method: 'notifications/initialized' })
      return r
    },
    tool: (name, args) => client.request('tools/call', { name, arguments: args || {} }),
    // fire without waiting; returns a promise of the response
    toolAsync: (name, args) => { const id = nextId++; client.send({ id, method: 'tools/call', params: { name, arguments: args || {} } }); return waitFor((m) => m.id === id) },
    async close() { input.end(); return server.done },
  }
  clients.push(client)
  return client
}

export const payload = (res) => JSON.parse(res.result.content.find((c) => c.type === 'text').text)

export async function cleanupMcp() {
  // Stub first (drops sockets, so a stuck in-flight request ends at once), while the sessions drain.
  await Promise.all([...stubs.splice(0).map((s) => s.stop()), ...clients.splice(0).map((c) => c.close().catch(() => {}))])
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}
