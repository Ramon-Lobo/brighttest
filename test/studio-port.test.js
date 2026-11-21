import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
// Isolate from the developer's real device cache: Studio resolves its device like the CLI lanes.
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-cache-')), 'devices.json');
const studio = require('../lib/studio/server.js')
const { parseStudioArgs } = require('../bin/cli.js')

// Two Studios on one machine (parallel worktrees): a busy port fails fast naming the process holding it,
// and the default port falls back to the next free one.
// lsof names the process holding a busy port; the pid assertion needs it (macOS and most Linux have it).
const hasLsof = process.platform !== 'win32' && !spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error
const open = []
afterEach(() => { for (const s of open.splice(0)) s.close() })
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-port-'))
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

describe('studio port collision', () => {
  it('a taken --port fails fast with EADDRINUSE naming the holder process and suggesting --port', async () => {
    const a = await studio.start({ port: 0, rootDir: root() }); open.push(a)
    const err = await studio.start({ port: a.address().port, rootDir: root() }).catch((e) => e)
    expect(err.code).toBe('EADDRINUSE')
    expect(err.message).toMatch(/--port/)
  })

  it.skipIf(!hasLsof)('names the process holding the port (needs lsof)', async () => {
    const a = await studio.start({ port: 0, rootDir: root() }); open.push(a)
    const err = await studio.start({ port: a.address().port, rootDir: root() }).catch((e) => e)
    expect(err.message).toMatch(new RegExp(`pid ${process.pid}`))
  })

  it('falls back to the next free port when the first is taken', async () => {
    const a = await studio.start({ port: 0, rootDir: root() }); open.push(a)
    const next = await freePort()
    const b = await studio.start({ port: a.address().port, portFallback: [a.address().port, next], rootDir: root() }); open.push(b)
    expect(b.address().port).toBe(next)
  })

  it('--port is optional (null → default with fallback)', () => {
    expect(parseStudioArgs([]).port).toBeNull()
    expect(parseStudioArgs(['--port', '8741']).port).toBe(8741)
  })
})
