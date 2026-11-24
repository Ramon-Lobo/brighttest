import { describe, it, expect, afterEach, vi } from 'vitest'
import { api } from '../lib/studio/web/src/lib/api.js'
import { shortHash, travelOutcome, rowOf } from '../lib/studio/web/src/lib/actionlog.js'

// STA23-F2 route-mock cases: the panel's api calls and message mapping against canned /api/state/actions responses.
const reply = (status, body) => Promise.resolve({ status, ok: status < 300, json: () => Promise.resolve(body) })
afterEach(() => vi.unstubAllGlobals())

describe('action log panel', () => {
  it('lists entries with seq, type and hashes', async () => {
    const f = vi.fn(() => reply(200, { actions: [{ entry: 7, type: 'cart/add', hashBefore: 'aaaaaaaaaaaa', hashAfter: 'bbbbbbbbbbbb', changed: true, snapshot: 'act-7' }, { entry: 8, type: null, hashBefore: null, hashAfter: null, snapshot: null }] }))
    vi.stubGlobal('fetch', f)
    const r = await api.stateActions()
    expect(f.mock.calls[0][0]).toBe('/api/state/actions')
    expect(r.actions.map(rowOf)).toEqual([
      { entry: 7, type: 'cart/add', before: 'aaaaaaaa', after: 'bbbbbbbb', changed: true, snapshot: 'act-7' },
      { entry: 8, type: '(unnamed)', before: '-', after: '-', changed: undefined, snapshot: null },
    ])
    expect(shortHash('')).toBe('-')
  })

  it('travel posts the existing route and shows the 202 note', async () => {
    const note = 'restores the recorded state only; effects of later actions (network, registry, tasks) are not undone'
    const f = vi.fn(() => reply(202, { entry: 7, note }))
    vi.stubGlobal('fetch', f)
    const r = await api.stateActionTravel(7)
    expect(f.mock.calls[0][0]).toBe('/api/state/actions')
    expect(f.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ action: 'travel', entry: 7 })
    expect(travelOutcome(r)).toEqual({ bad: false, text: note })
  })

  it('shows a 404 for an unknown entry as a message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(404, { error: 'no action log entry 99', code: 'NOT_FOUND' })))
    const o = travelOutcome(await api.stateActionTravel(99))
    expect(o.bad).toBe(true)
    expect(o.text).toContain('no action log entry 99')
  })

  it('maps other failures to code: message', () => {
    expect(travelOutcome({ status: 409, code: 'NO_SNAPSHOT', error: 'entry 3 has no recorded snapshot' }).text).toBe('NO_SNAPSHOT: entry 3 has no recorded snapshot')
  })
})

describe('action log poller', () => {
  const tick = () => new Promise((r) => setImmediate(r))
  it('never has two fetches in flight and chains after each settles', async () => {
    const { createPoller } = await import('../lib/studio/web/src/lib/actionlog.js')
    let inflight = 0, max = 0, calls = 0; const resolvers = []; const timers = []
    const p = createPoller(() => { calls++; inflight++; max = Math.max(max, inflight); return new Promise((r) => resolvers.push(() => { inflight--; r({ ok: true }) })) },
      () => {}, { setT: (fn) => { timers.push(fn); return timers.length }, clearT: () => {} })
    p.start(); p.now(); p.now(); await tick()
    expect(calls).toBe(1)
    expect(timers.length).toBe(0)
    resolvers.shift()(); await tick()
    expect(calls).toBe(2) // one queued follow-up, not stacked
    resolvers.shift()(); await tick()
    expect(timers.length).toBe(1) // next one is scheduled only after settle
    expect(max).toBe(1)
    p.stop()
  })
  it('applies a reply and stops cleanly', async () => {
    const { createPoller } = await import('../lib/studio/web/src/lib/actionlog.js')
    const applied = []; const res = []
    const p = createPoller(() => new Promise((r) => res.push(r)), (r) => applied.push(r), { setT: () => 1, clearT: () => {} })
    p.start(); await tick()
    res[0]('a'); await tick()
    expect(applied).toEqual(['a'])
    p.stop(); await tick()
  })
})
