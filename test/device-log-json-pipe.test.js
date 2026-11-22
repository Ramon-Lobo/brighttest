import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.join(__dirname, '..', 'bin', 'cli.js')

describe('device log --json when piped (CLI-LOGJSON)', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-logjson-'))
    const keyDir = path.join(dir, 'fake-host_8060')
    fs.mkdirSync(keyDir, { recursive: true })
    const lines = []
    for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ t: new Date(1700000000000 + i * 1000).toISOString(), key: 'fake-host:8060', ev: 'acquired', agent: 'agent-' + i, purpose: 'generated event ' + i }))
    fs.writeFileSync(path.join(keyDir, 'events.log'), lines.join('\n') + '\n')
  })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const env = () => ({ ...process.env, BRIGHTTEST_LEASE_DIR: dir })

  it('writes the complete JSON to a pipe, byte-identical to a file redirect', () => {
    const piped = spawnSync(process.execPath, [cli, 'device', 'log', '--json', '--tail', '400'], { env: env(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    expect(piped.status).toBe(0)
    expect(piped.stdout.length).toBeGreaterThan(8192 * 4)
    const outFile = path.join(dir, 'out.json')
    const fd = fs.openSync(outFile, 'w')
    const redirected = spawnSync(process.execPath, [cli, 'device', 'log', '--json', '--tail', '400'], { env: env(), stdio: ['ignore', fd, 'pipe'] })
    fs.closeSync(fd)
    expect(redirected.status).toBe(0)
    expect(piped.stdout).toBe(fs.readFileSync(outFile, 'utf8'))
    expect(JSON.parse(piped.stdout)).toHaveLength(400)
  })
})
