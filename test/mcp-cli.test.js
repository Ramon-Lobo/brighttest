import { describe, it, expect } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const cli = path.resolve(__dirname, '..', 'bin', 'cli.js')

describe('brighttest mcp (CLI)', () => {
  it('--help lists the tools and exits 0', () => {
    const r = spawnSync('node', [cli, 'mcp', '--help'], { encoding: 'utf8', timeout: 20000 })
    expect(r.status).toBe(0)
    for (const t of ['list_devices', 'device_doctor', 'inspect_tree', 'press', 'navigate_to', 'screenshot', 'app_state', 'run_flow', 'net_requests', 'net_mock']) expect(r.stdout).toContain(t)
  })
  it('rejects arguments with exit 2', () => {
    expect(spawnSync('node', [cli, 'mcp', '--host', 'x'], { encoding: 'utf8', timeout: 20000 }).status).toBe(2)
  })
  it('serves the handshake on stdio and exits 0 when stdin closes, stdout carrying JSON only', () => {
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n'
    const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mcp-cli-')), 'devices.json')
    const r = spawnSync('node', [cli, 'mcp'], { input, encoding: 'utf8', timeout: 20000, env: { ...process.env, ROKU_HOST: '', BRIGHTTEST_CACHE: cache } })
    expect(r.status).toBe(0)
    const msgs = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2])
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe('brighttest-mcp')
  })
  it('an empty ROKU_HOST falls back to the device cache (documented behaviour)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mcp-cli-'))
    const cache = path.join(dir, 'devices.json')
    fs.writeFileSync(cache, JSON.stringify({ devices: { '127.0.0.1': { name: 'cached-stub', password: null } }, lastHost: '127.0.0.1' }))
    const child = spawn('node', [cli, 'mcp'], { cwd: dir, env: { ...process.env, ROKU_HOST: '', ROKU_ECP_PORT: '1', BRIGHTTEST_CACHE: cache }, stdio: ['pipe', 'pipe', 'ignore'] })
    const kill = setTimeout(() => child.kill('SIGKILL'), 30000)
    try {
      const got = new Promise((resolve) => {
        let buf = ''
        child.stdout.on('data', (d) => {
          buf += d
          const m = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === 2)
          if (m) resolve(m)
        })
      })
      for (const m of [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { id: 2, method: 'tools/call', params: { name: 'list_devices', arguments: {} } }]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
      const d = JSON.parse((await got).result.content[0].text)
      expect(d.active).toMatchObject({ host: '127.0.0.1', source: 'cache', reachable: false })
    } finally { clearTimeout(kill); child.stdin.end(); child.kill() }
  })
})
