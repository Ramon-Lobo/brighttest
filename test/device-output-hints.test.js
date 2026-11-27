import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dc = require('../lib/device-command.js')

// LMA-F1: the host source line for a host taken from the project .env.
describe('device with: host source', () => {
  afterEach(() => vi.restoreAllMocks())
  it('names the key and the file for a .env host, no secret', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    dc.announceCachedHost({ host: '192.0.2.5', password: 'hunter2', source: 'dotenv', dotenvPath: '/proj/.env' })
    const out = err.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('ROKU_HOST 192.0.2.5 from /proj/.env')
    expect(out).not.toContain('hunter2')
  })
  it('stays silent for a flag host', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    dc.announceCachedHost({ host: '192.0.2.5', source: 'flag' })
    expect(err).not.toHaveBeenCalled()
  })
})

// LMA-F3: device log installed events, and the Studio-holder wait line.
describe('device log: installed events', () => {
  afterEach(() => vi.restoreAllMocks())
  it('prints one readable line, no [object Object], no full sha256', async () => {
    const lease = require('../lib/device-lease.js')
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-log-'))
    const old = process.env.BRIGHTTEST_LEASE_DIR; process.env.BRIGHTTEST_LEASE_DIR = dir
    try {
      const sha = 'a'.repeat(64)
      const store = lease.createStore({ dir })
      store.logEvent('192.0.2.7', { ev: 'installed', at: new Date().toISOString(), sha256: sha, manifest: { title: 'Fixture App', version: '1.2.3' }, by: { agent: 'agent-a' }, via: 'cli' })
      const out = vi.spyOn(console, 'log').mockImplementation(() => {})
      expect(await dc.run({ deviceAction: 'log' }, {})).toBe(0)
      const text = out.mock.calls.map((c) => String(c[0])).join('\n')
      expect(text).not.toContain('[object Object]')
      expect(text).toMatch(/installed .*Fixture App 1\.2\.3/)
      expect(text).toContain('agent-a')
      expect(text).not.toContain(sha)
    } finally { if (old === undefined) delete process.env.BRIGHTTEST_LEASE_DIR; else process.env.BRIGHTTEST_LEASE_DIR = old; fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('wait line with a Studio holder', () => {
  afterEach(() => vi.restoreAllMocks())
  const snap = (command) => ({
    key: 'k1', pool: false, corrupt: false, position: 2, etaMs: null, etaNote: 'ETA unknown (no --expect)',
    holder: { acquiredAt: new Date().toISOString(), deadline: new Date(Date.now() + 36e5).toISOString(), holder: { agent: 'studio-agent', purpose: 'studio :1', command } },
    queue: [{ leaseId: 'x', agent: 'a', verb: 'run' }],
  })
  it('counts the Studio hold in the ETA and shows the yields hint', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    dc.printWait(snap(['brighttest', 'studio']))
    const t = err.mock.calls.map((c) => String(c[0])).join('')
    expect(t).toContain('Studio yields')
    expect(t).toMatch(/est\. wait ~/)
  })
  it('no hint for another holder', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    dc.printWait(snap(['brighttest', 'run']))
    expect(err.mock.calls.map((c) => String(c[0])).join('')).not.toContain('Studio yields')
  })
})
