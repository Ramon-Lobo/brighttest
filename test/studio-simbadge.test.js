import { describe, it, expect } from 'vitest'
import { SIM_STATES, simText, simCls, simPollMs, simTail, mergeDevice, shouldPoll, isSim } from '../lib/studio/web/src/lib/simbadge.js'

const eng = { name: 'brs-node', version: '2.7.1', flavor: 'stock' }
const sim = (state, extra = {}) => ({ connected: true, target: 'simulator', engine: eng, state, ...extra })

describe('simulator badge helpers', () => {
  it('maps all five server states', () => {
    const want = { starting: ['starting', 'wait'], settling: ['settling', 'wait'], running: ['running', 'mine'], 'no-hello': ['no hello from the app', 'other'], exited: ['engine exited', 'other'] }
    expect(Object.keys(SIM_STATES).sort()).toEqual(Object.keys(want).sort())
    for (const [st, [text, cls]] of Object.entries(want)) {
      expect(simText(sim(st))).toBe(`simulator · brs-node@2.7.1 (stock) · ${text}`)
      expect(simCls(sim(st))).toBe(cls)
    }
  })
  it('handles an unknown state, a missing engine and a missing state', () => {
    expect(simText(sim('weird'))).toBe('simulator · brs-node@2.7.1 (stock) · weird')
    expect(simCls(sim('weird'))).toBe('wait')
    expect(simText({ target: 'simulator', state: 'running' })).toBe('simulator · engine · running')
    expect(simText({ target: 'simulator', engine: eng })).toBe('simulator · brs-node@2.7.1 (stock) · starting')
    expect(simText(null)).toBe('simulator · engine · starting')
    expect(simCls(undefined)).toBe('wait')
  })
  it('polls fast while starting and slowly once settled or finished', () => {
    expect(simPollMs(sim('starting'))).toBe(1000)
    expect(simPollMs(sim('settling'))).toBe(1000)
    for (const st of ['running', 'no-hello', 'exited']) expect(simPollMs(sim(st))).toBe(5000)
  })
  it('carries the engine tail only when something went wrong', () => {
    expect(simTail(sim('running', { tail: ['x'] }))).toEqual([])
    expect(simTail(sim('no-hello', { tail: ['x'] }))).toEqual(['x'])
    expect(simTail(sim('exited', { tail: ['y'] }))).toEqual(['y'])
    expect(mergeDevice(null, sim('running', { tail: ['x'] })).tail).toEqual([])
  })
  it('keeps the simulator mode after a failed poll', () => {
    let d = mergeDevice(null, sim('running'))
    expect(isSim(d)).toBe(true)
    d = mergeDevice(d, null)
    expect(isSim(d)).toBe(true)
    expect(d.state).toBe('running')
    expect(shouldPoll(d)).toBe(true)
  })
  it('falls back to no device on a failed poll only when the mode is not simulator', () => {
    expect(mergeDevice(null, null)).toEqual({ connected: false })
    expect(mergeDevice({ connected: true, model: 'Ultra' }, null)).toEqual({ connected: false })
    expect(shouldPoll(null)).toBe(true)
    expect(shouldPoll({ connected: true, model: 'Ultra' })).toBe(false)
  })
})
