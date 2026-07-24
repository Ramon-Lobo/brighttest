import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDevice, rememberDevice, cachedPassword, cachedDevices, loadDotEnv } from '../lib/devices.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dev-'))
  process.env.BRIGHTTEST_CACHE = path.join(dir, 'devices.json')
  delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD
})
afterEach(() => { delete process.env.BRIGHTTEST_CACHE; delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD })

describe('devices cache + resolve', () => {
  it('remembers a device and resolves it from cache when nothing else is given', () => {
    rememberDevice('10.0.0.5', 'pw', 'Roku X')
    expect(cachedPassword('10.0.0.5')).toBe('pw')
    expect(resolveDevice({ cwd: dir })).toMatchObject({ host: '10.0.0.5', password: 'pw', source: 'cache' })
    expect(cachedDevices()[0]).toMatchObject({ host: '10.0.0.5', hasPassword: true, last: true })
  })

  it('honors precedence: flag > env > cache', () => {
    rememberDevice('10.0.0.5', 'cachepw')
    process.env.ROKU_HOST = '10.0.0.9'; process.env.ROKU_PASSWORD = 'envpw'
    expect(resolveDevice({ cwd: dir })).toMatchObject({ host: '10.0.0.9', password: 'envpw', source: 'env' })
    expect(resolveDevice({ host: '1.2.3.4', password: 'flagpw', cwd: dir })).toMatchObject({ host: '1.2.3.4', password: 'flagpw', source: 'flag' })
  })

  it('fills a cached password for a host given without one', () => {
    rememberDevice('10.0.0.5', 'cachepw')
    process.env.ROKU_HOST = '10.0.0.5'
    expect(resolveDevice({ cwd: dir }).password).toBe('cachepw')
  })

  it('reads ROKU_* from a project .env', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ROKU_HOST=10.0.0.7\nROKU_PASSWORD="secret"\n')
    expect(loadDotEnv(dir)).toMatchObject({ ROKU_HOST: '10.0.0.7', ROKU_PASSWORD: 'secret' })
    expect(resolveDevice({ cwd: dir })).toMatchObject({ host: '10.0.0.7', password: 'secret' })
  })
})
