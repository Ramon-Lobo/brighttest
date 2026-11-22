import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const cli = path.resolve(__dirname, '..', 'bin', 'cli.js')

describe('brighttest mcp (CLI)', () => {
  it('--help lists the tools and exits 0', () => {
    const r = spawnSync('node', [cli, 'mcp', '--help'], { encoding: 'utf8', timeout: 20000 })
    expect(r.status).toBe(0)
    for (const t of ['list_devices', 'device_doctor', 'inspect_tree', 'press', 'navigate_to', 'screenshot', 'app_state', 'run_flow']) expect(r.stdout).toContain(t)
  })
  it('rejects arguments with exit 2', () => {
    expect(spawnSync('node', [cli, 'mcp', '--host', 'x'], { encoding: 'utf8', timeout: 20000 }).status).toBe(2)
  })
  it('serves the handshake on stdio and exits 0 when stdin closes, stdout carrying JSON only', () => {
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n'
    const r = spawnSync('node', [cli, 'mcp'], { input, encoding: 'utf8', timeout: 20000 })
    expect(r.status).toBe(0)
    const msgs = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2])
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe('brighttest-mcp')
  })
})
