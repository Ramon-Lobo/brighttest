import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveDeviceInfo, toEngineDeviceInfo } = require('../lib/config.js')
const cov = require('../lib/coverage-headless.js')

describe('deviceInfo friendlyName and country', () => {
  it('accepts both keys and maps country to countryCode', () => {
    const di = resolveDeviceInfo({ friendlyName: ' Living Room ', country: 'CA' })
    expect(di.friendlyName).toBe('Living Room')
    expect(toEngineDeviceInfo(di)).toMatchObject({ friendlyName: 'Living Room', countryCode: 'CA', deviceModel: '4850X' })
  })
  it('omits both from the engine data when unset', () => {
    const out = toEngineDeviceInfo(resolveDeviceInfo({ locale: 'en_US' }))
    expect(out).not.toHaveProperty('friendlyName')
    expect(out).not.toHaveProperty('countryCode')
  })
  it('validates them by key name and still rejects unknown keys', () => {
    expect(() => resolveDeviceInfo({ country: 'usa' })).toThrow(/deviceInfo\.country must be a two-letter/)
    expect(() => resolveDeviceInfo({ friendlyName: '' })).toThrow(/deviceInfo\.friendlyName must be a non-empty string/)
    expect(() => resolveDeviceInfo({ countryCode: 'US' })).toThrow(/deviceInfo\.countryCode is not a known key/)
  })
})

describe('scene lane --device-data', () => {
  const cfg = { deviceInfo: { model: '4850X', country: 'US' } }
  afterEach(() => vi.restoreAllMocks())

  it('passes the engine device data when the engine has the flag', () => {
    const eng = () => ({ kind: 'brsNode', version: '2.7.1', stamp: { flags: ['device-data'] } })
    const args = cov.deviceDataArgs(cfg, { engineFor: eng })
    expect(args[0]).toBe('--device-data')
    expect(JSON.parse(args[1])).toEqual({ deviceModel: '4850X', countryCode: 'US' })
  })
  it('passes nothing without a deviceInfo block', () => {
    expect(cov.deviceDataArgs({}, { engineFor: () => { throw new Error('unused') } })).toEqual([])
  })
  it('warns once and passes nothing when the engine lacks the flag', () => {
    const w = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const eng = () => ({ kind: 'brsNode', version: '2.7.1', stamp: { flags: [] } })
    expect(cov.deviceDataArgs(cfg, { engineFor: eng })).toEqual([])
    expect(cov.deviceDataArgs(cfg, { engineFor: eng })).toEqual([])
    const warns = w.mock.calls.filter((c) => /no --device-data flag/.test(String(c[0])))
    expect(warns).toHaveLength(1)
  })
})
