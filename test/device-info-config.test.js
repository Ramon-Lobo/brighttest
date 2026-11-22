import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { loadConfig, resolveDeviceInfo, toEngineDeviceInfo, DEVICE_INFO_DEFAULTS } from '../lib/config.js'

const require_ = createRequire(import.meta.url)
const { enginePackageMain } = require_('../lib/engines.js')

describe('deviceInfo config block (COV-02)', () => {
  it('defaults to the Ultra-like values', () => {
    expect(resolveDeviceInfo(undefined)).toEqual({ model: '4850X', uiResolution: '1080p', connectionType: 'WiFiConnection' })
    expect(DEVICE_INFO_DEFAULTS.osVersion).toBeUndefined()
  })
  it('a partial block merges over the defaults', () => {
    expect(resolveDeviceInfo({ uiResolution: '720p', locale: 'en_CA' })).toEqual({
      model: '4850X', uiResolution: '720p', connectionType: 'WiFiConnection', locale: 'en_CA',
    })
  })
  it('errors name the key', () => {
    expect(() => resolveDeviceInfo({ uiResolution: '4k' })).toThrow(/deviceInfo\.uiResolution must be one of 480p, 720p, 1080p/)
    expect(() => resolveDeviceInfo({ connectionType: 'Cable' })).toThrow(/deviceInfo\.connectionType/)
    expect(() => resolveDeviceInfo({ locale: 'english' })).toThrow(/deviceInfo\.locale must look like en_US/)
    expect(() => resolveDeviceInfo({ osVersion: '16.0.4' })).toThrow(/deviceInfo\.osVersion must be the engine's encoded firmware string/)
    expect(() => resolveDeviceInfo({ model: 5 })).toThrow(/deviceInfo\.model must be a non-empty string/)
    expect(() => resolveDeviceInfo({ token: 'x' })).toThrow(/deviceInfo\.token is not a known key/)
    expect(() => resolveDeviceInfo('x')).toThrow(/deviceInfo must be an object/)
  })
  it('loadConfig applies defaults and validates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-di-'))
    try {
      expect(loadConfig(tmp).deviceInfo).toBeUndefined() // unset: engine identity, CLI path
      fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify({ deviceInfo: { uiResolution: '720p' } }))
      expect(loadConfig(tmp).deviceInfo.model).toBe('4850X')
      fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify({ deviceInfo: { bogus: 1 } }))
      expect(() => loadConfig(tmp)).toThrow(/deviceInfo\.bogus/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
  it('maps to the engine customization', () => {
    expect(toEngineDeviceInfo(resolveDeviceInfo({ osVersion: '48G.04E05531A', locale: 'fr_CA', model: ' 4800X ' }))).toEqual({
      deviceModel: '4800X', firmwareVersion: '48G.04E05531A', locale: 'fr_CA', displayMode: '1080p', connectionInfo: { type: 'WiFiConnection' },
    })
  })

  const runEngine = (f, di = {}) => {
    const main = enginePackageMain('brsNode', { rootDir: path.dirname(f) })
    return spawnSync(process.execPath, [path.resolve('lib/engine-run.js'), main, JSON.stringify(toEngineDeviceInfo(resolveDeviceInfo(di))), f], { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 28 })
  }

  it('message-port waits work (control buffer is sized like the CLI)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-di-'))
    try {
      const f = path.join(tmp, 'wait.brs')
      fs.writeFileSync(f, 'sub Main()\n  p = CreateObject("roMessagePort")\n  if wait(10, p) = invalid then print "WAIT=invalid" else print "WAIT=msg"\nend sub\n')
      const r = runEngine(f)
      expect(r.stdout).toMatch(/WAIT=invalid/)
      expect(r.stderr).not.toMatch(/Invalid atomic access/)
      expect(r.status).toBe(0)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  it('large piped output keeps its last line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-di-'))
    try {
      const f = path.join(tmp, 'big.brs')
      fs.writeFileSync(f, 'sub Main()\n  for i = 1 to 40000\n    print "line " + i.toStr()\n  end for\n  print "__RESULT__ done"\nend sub\n')
      for (let n = 0; n < 3; n++) {
        const r = runEngine(f)
        expect(r.stdout).toContain('__RESULT__ done')
        expect(r.stdout.split('\n').length).toBeGreaterThan(40000)
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  // A branch on the UI resolution flips when `deviceInfo.uiResolution` changes (runs the real engine, headless).
  it('a spec branch flips when uiResolution changes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-di-'))
    try {
      const f = path.join(tmp, 'branch.brs')
      fs.writeFileSync(f, 'sub Main()\n  ui = CreateObject("roDeviceInfo").GetUIResolution().name\n  if ui = "FHD" then print "BRANCH=wide" else print "BRANCH=narrow"\nend sub\n')
      const main = enginePackageMain('brsNode', { rootDir: tmp })
      const run = (di) => spawnSync(process.execPath, [path.resolve('lib/engine-run.js'), main, JSON.stringify(toEngineDeviceInfo(resolveDeviceInfo(di))), f], { encoding: 'utf8', timeout: 60000 })
      expect(run({}).stdout).toMatch(/BRANCH=wide/)
      expect(run({ uiResolution: '720p' }).stdout).toMatch(/BRANCH=narrow/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})
