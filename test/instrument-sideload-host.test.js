import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const { resolveSideloadHost } = createRequire(import.meta.url)('../lib/instrument/build')

describe('instrument build --sideload host resolution', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sideload-host-'))
  it('falls back to ROKU_HOST when --host is absent', () => {
    expect(resolveSideloadHost(null, { ROKU_HOST: '192.0.2.7' }, empty)).toMatchObject({ host: '192.0.2.7' })
  })
  it('--host wins over ROKU_HOST', () => {
    expect(resolveSideloadHost('192.0.2.5', { ROKU_HOST: '192.0.2.7' }, empty)).toMatchObject({ host: '192.0.2.5' })
  })
  it('reads ROKU_HOST from the project .env after the process env', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sideload-env-'))
    fs.writeFileSync(path.join(d, '.env'), 'ROKU_HOST=192.0.2.9\n')
    expect(resolveSideloadHost(null, {}, d)).toMatchObject({ host: '192.0.2.9' })
    expect(resolveSideloadHost(null, { ROKU_HOST: '192.0.2.7' }, d)).toMatchObject({ host: '192.0.2.7' })
    fs.rmSync(d, { recursive: true, force: true })
  })
  it('returns null with neither', () => {
    expect(resolveSideloadHost(null, {}, empty)).toBeNull()
  })
})
