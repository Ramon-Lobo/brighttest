import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'

const require = createRequire(import.meta.url)
const { createMcpServer } = require('../lib/mcp/server.js')
const { TOOLS, confineFlowPath } = require('../lib/mcp/tools.js')

// TP-MCP-03: the tools/list result is the public brighttest-mcp/v1 contract. A breaking change here (tool
// names, input schemas) needs a contract version bump and a skill update (ADR 0003); description-only edits do not.
// Regenerate with BT_UPDATE_MCP_SNAPSHOT=1.
const SNAPSHOT = path.join(__dirname, 'fixtures', 'mcp-tools-list.json')

const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v

async function toolsList() {
  const input = new PassThrough(); const output = new PassThrough()
  let buf = ''
  const got = new Promise((resolve) => output.on('data', (d) => {
    buf += d.toString()
    const lines = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const r = lines.find((m) => m.id === 2)
    if (r) resolve(r)
  }))
  const server = createMcpServer({ input, output, errput: new PassThrough(), cwd: __dirname })
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  const r = await got
  input.end(); await server.done
  return r.result
}

describe('TP-MCP-03 tools/list schema snapshot', () => {
  it('matches the committed snapshot', async () => {
    const result = canon(await toolsList())
    result.tools.sort((a, b) => a.name.localeCompare(b.name))
    if (process.env.BT_UPDATE_MCP_SNAPSHOT) fs.writeFileSync(SNAPSHOT, JSON.stringify(result, null, 2) + '\n')
    expect(result).toEqual(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')))
  })
  it('has exactly the v1 tool set plus the net, state and perf tools, each with a description and a closed object schema', async () => {
    const { tools } = await toolsList()
    expect(tools.map((t) => t.name).sort()).toEqual(['app_state', 'app_state_get', 'app_state_set', 'app_state_snapshot', 'device_doctor', 'inspect_tree', 'list_devices', 'navigate_to', 'net_mock', 'net_requests', 'perf_summary', 'perf_trace_summary', 'press', 'run_flow', 'screenshot'])
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20)
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.inputSchema.additionalProperties, t.name).toBe(false)
    }
  })
  it('has no password-like or host-like parameter anywhere in any schema', async () => {
    const { tools } = await toolsList()
    const walk = (s, names) => { if (s && typeof s === 'object') { for (const [k, v] of Object.entries(s.properties || {})) { names.add(k.toLowerCase()); walk(v, names) } } return names }
    // net_* take a URL glob (a request filter, not a device or credential parameter): only the `url` key is exempt, per tool
    const URL_OK = new Set(['net_requests', 'net_mock'])
    for (const t of tools) {
      const names = walk(t.inputSchema, new Set())
      if (URL_OK.has(t.name)) { expect(names.has('url'), t.name).toBe(true); names.delete('url') }
      for (const bad of ['password', 'pass', 'pwd', 'token', 'secret', 'auth', 'host', 'ip', 'address', 'url']) expect(names.has(bad), `${t.name}.${bad}`).toBe(false)
    }
  })
  it('only the declared handlers exist', () => {
    expect(TOOLS.every((t) => typeof t.handler === 'function')).toBe(true)
  })
})

describe('confineFlowPath', () => {
  it('accepts a flow inside the project and names the rule on rejection', () => {
    const root = path.join(__dirname, 'fixtures', 'fake-roku')
    expect(confineFlowPath(root, 'flows/fake-smoke.e2e.yaml')).toBe(fs.realpathSync(path.join(root, 'flows/fake-smoke.e2e.yaml')))
    expect(() => confineFlowPath(root, '../x.e2e.yaml')).toThrow(/\.\./)
    expect(() => confineFlowPath(root, '/etc/x.e2e.yaml')).toThrow(/absolute/)
    expect(() => confineFlowPath(root, 'flows/a.txt')).toThrow(/only/)
    expect(() => confineFlowPath(root, '')).toThrow(/non-empty/)
  })
})
