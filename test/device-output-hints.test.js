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
