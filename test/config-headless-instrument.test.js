import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadConfig, resolveHeadlessInstrument, InstrumentConfigError } = require('../lib/config')

let tmp
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hinst-'))
  fs.mkdirSync(path.join(tmp, 'source'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'manifest'), 'title=T\n')
})
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const cfgOf = (instrument, extra = {}) => {
  const raw = { ...extra }
  if (instrument !== undefined) raw.instrument = instrument
  fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify(raw))
  return loadConfig(tmp)
}
const msg = (cfg, opts = { instrument: true }) => { try { resolveHeadlessInstrument(cfg, opts) } catch (e) { expect(e).toBeInstanceOf(InstrumentConfigError); expect(e.name).toBe('InstrumentConfigError'); return e.message } return null }

describe('resolveHeadlessInstrument: valid and defaults', () => {
  it('no block: off, state defaults, net off', () => {
    expect(resolveHeadlessInstrument(cfgOf(undefined))).toEqual({ enabled: false, state: {}, net: false })
  })
  it('enabled with state unset or true: state on with defaults', () => {
    expect(resolveHeadlessInstrument(cfgOf({ enabled: true }))).toEqual({ enabled: true, state: {}, net: false })
    expect(resolveHeadlessInstrument(cfgOf({ enabled: true, state: true })).state).toEqual({})
  })
  it('state object is passed through', () => {
    const state = { redact: { paths: ['a.b'] }, callable: ['doIt'] }
    expect(resolveHeadlessInstrument(cfgOf({ enabled: true, state })).state).toEqual(state)
  })
  it('state false with net on is allowed (net only)', () => {
    expect(resolveHeadlessInstrument(cfgOf({ enabled: true, state: false, net: true }))).toEqual({ enabled: true, state: false, net: true })
  })
  it('enabled does not turn net on; net config does not turn enabled on', () => {
    expect(resolveHeadlessInstrument(cfgOf({ enabled: true })).net).toBe(false)
    const r = resolveHeadlessInstrument(cfgOf({ net: { fixtures: [] } }))
    expect(r.enabled).toBe(false)
    expect(r.net).toBe(true)
  })
  it('opts.instrument forces enabled for one run, over enabled:false', () => {
    expect(resolveHeadlessInstrument(cfgOf({ enabled: false }), { instrument: true }).enabled).toBe(true)
    expect(resolveHeadlessInstrument(cfgOf({ enabled: false })).enabled).toBe(false)
  })
  it('exclude (canonical and the instrumentExclude alias) validates and merges in the loader', () => {
    expect(resolveHeadlessInstrument(cfgOf({ exclude: ['a/**'] })).enabled).toBe(false)
    expect(cfgOf({ exclude: ['a/**'] }, { instrumentExclude: ['b/**'] }).instrument.exclude).toEqual(['a/**', 'b/**'])
  })
  it('state false and not enabled never errors', () => {
    expect(resolveHeadlessInstrument(cfgOf({ state: false })).state).toBe(false)
  })
})

describe('resolveHeadlessInstrument: invalid', () => {
  it('instrument not an object', () => {
    expect(msg(cfgOf('yes'))).toBe('instrument must be an object (got "yes")')
    expect(msg(cfgOf([1]))).toBe('instrument must be an object (got [1])')
    expect(msg(cfgOf(null))).toBe('instrument must be an object (got null)')
    expect(msg({ rootDir: tmp, instrument: 'yes' })).toBe('instrument must be an object (got "yes")') // hand-built, no raw copy
  })
  it('enabled not boolean', () => {
    expect(msg(cfgOf({ enabled: 'true' }))).toBe('instrument.enabled must be true or false (got "true")')
    expect(msg(cfgOf({ enabled: 1 }))).toBe('instrument.enabled must be true or false (got 1)')
  })
  it('state wrong type', () => {
    expect(msg(cfgOf({ state: 'on' }))).toBe('instrument.state must be true, false or an object (got "on")')
    expect(msg(cfgOf({ state: [] }))).toBe('instrument.state must be true, false or an object (got [])')
    expect(msg(cfgOf({ state: null }))).toBe('instrument.state must be true, false or an object (got null)')
  })
  it('state object invalid reuses the build validation message', () => {
    expect(msg(cfgOf({ state: { redact: 'x' } }))).toBe('instrument.state.redact must be an object')
    expect(msg(cfgOf({ state: { callable: [1] } }))).toBe('instrument.state.callable must be an array of strings')
  })
  it('exclude not an array of strings', () => {
    expect(msg(cfgOf({ exclude: 'source/**' }))).toBe('instrument.exclude must be an array of glob strings')
    expect(msg(cfgOf({ exclude: ['a', 2] }))).toBe('instrument.exclude must be an array of glob strings')
  })
  it('exclude string is caught even when the instrumentExclude alias adds entries', () => {
    expect(msg(cfgOf({ exclude: 'source/**' }, { instrumentExclude: ['b/**'] }))).toBe('instrument.exclude must be an array of glob strings')
  })
  it('loadConfig never throws for bad values; only resolveHeadlessInstrument does (D6)', () => {
    for (const inst of [{ enabled: 'x' }, { state: 'x' }, { exclude: 'x' }, { state: { redact: 'x' } }, 'yes', null, [1]]) {
      const cfg = cfgOf(inst)
      expect(() => resolveHeadlessInstrument(cfg, { instrument: true })).toThrow(InstrumentConfigError)
    }
  })
  it('a bad block does not throw when the run is not enabled: it returns a warning', () => {
    for (const [inst, text] of [[{ enabled: 'x' }, 'instrument.enabled must be true or false (got "x")'], [{ state: 'x' }, 'instrument.state must be true, false or an object (got "x")'], [{ exclude: 'x' }, 'instrument.exclude must be an array of glob strings'], ['yes', 'instrument must be an object (got "yes")']]) {
      const r = resolveHeadlessInstrument(cfgOf(inst), {})
      expect(r).toMatchObject({ enabled: false, state: false, warning: text })
    }
    expect(resolveHeadlessInstrument(cfgOf({ enabled: false, state: false }), {}).warning).toBeUndefined()
  })
  it('the raw block is not enumerable on the loaded config', () => {
    expect(Object.keys(cfgOf({ enabled: true }))).not.toContain('_rawInstrument')
  })
  it('enabled with state false and no net: nothing to instrument', () => {
    const m = 'instrument.enabled is on but state is false and the run does not use net: nothing to instrument (net counts as used when a spec calls BTNet_* outside an @ignore suite, or instrument.net is set)'
    expect(msg(cfgOf({ enabled: true, state: false }))).toBe(m)
    expect(msg(cfgOf({ state: false }), { instrument: true })).toBe(m)
  })
})
