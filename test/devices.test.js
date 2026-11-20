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

describe('saveCache atomicity (LSE-T1b)', () => {
  it('two concurrent writer processes leave valid 0600 JSON and no tmp files', async () => {
    const { spawn } = await import('node:child_process')
    const lib = path.resolve(import.meta.dirname, '../lib/devices.js')
    const code = `const d=require(${JSON.stringify(lib)});for(let i=0;i<150;i++)d.rememberDevice('127.0.0.'+(i%5+1),'pw'+i,'n'+i)`
    const run = () => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['-e', code], { env: { ...process.env, BRIGHTTEST_CACHE: process.env.BRIGHTTEST_CACHE }, stdio: 'ignore' })
      c.on('exit', (n) => (n === 0 ? res() : rej(new Error('child exit ' + n))))
    })
    await Promise.all([run(), run()])
    const f = process.env.BRIGHTTEST_CACHE
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
    expect(typeof parsed.devices).toBe('object')
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('does not throw when the cache dir is unwritable', async () => {
    const { saveCache } = await import('../lib/devices.js')
    process.env.BRIGHTTEST_CACHE = path.join(dir, 'file-not-dir', 'devices.json')
    fs.writeFileSync(path.join(dir, 'file-not-dir'), 'x')
    expect(() => saveCache({ devices: {}, lastHost: null })).not.toThrow()
  })
})

describe('parseDeviceInfo (ROB-03a)', () => {
  const fx = (n) => fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/device-info', n), 'utf8')
  it('parses a permissive, developer-enabled device', async () => {
    const { parseDeviceInfo } = await import('../lib/devices.js')
    expect(parseDeviceInfo(fx('ultra-permissive.xml'))).toEqual({
      developerEnabled: true, ecpSettingMode: 'permissive', softwareVersion: '16.0.4', softwareBuild: '853',
      brightscriptDebuggerVersion: '3.5.0', videoMode: '1080p', uiResolution: '1080p',
      isTv: false, isStick: false, serial: 'REDACTED',
    })
  })
  it('parses a Limited-mode stick; video-mode wins over ui-resolution', async () => {
    const { parseDeviceInfo } = await import('../lib/devices.js')
    expect(parseDeviceInfo(fx('limited.xml'))).toMatchObject({
      developerEnabled: false, ecpSettingMode: 'limited', isStick: true, isTv: false,
      videoMode: '720p', uiResolution: '1080p', brightscriptDebuggerVersion: null,
    })
  })
  it('returns nulls and never throws on missing or bad input', async () => {
    const { parseDeviceInfo } = await import('../lib/devices.js')
    for (const x of ['', '<device-info/>', null, undefined, 42, '<<<']) {
      const r = parseDeviceInfo(x)
      expect(Object.values(r).every((v) => v === null)).toBe(true)
    }
  })
})
