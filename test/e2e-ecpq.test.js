import { describe, it, expect, vi, afterEach } from 'vitest'
import { createQueue, endpointKind, isTransient } from '../lib/e2e/ecpq.js'
import { createDevice } from '../lib/e2e/ecp.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('ecpq: serialization', () => {
  it('runs calls to one host one at a time, in submission order', async () => {
    const q = createQueue({ gaps: {} })
    let inFlight = 0, max = 0
    const order = []
    const task = (i) => async () => { inFlight++; max = Math.max(max, inFlight); await sleep(5); order.push(i); inFlight--; return { status: 200 } }
    await Promise.all(Array.from({ length: 20 }, (_, i) => q.run('h1', 'other', task(i))))
    expect(max).toBe(1)
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('does not serialize different hosts together', async () => {
    const q = createQueue({ gaps: {} })
    let inFlight = 0, max = 0
    const task = async () => { inFlight++; max = Math.max(max, inFlight); await sleep(20); inFlight--; return { status: 200 } }
    await Promise.all([q.run('h1', 'other', task), q.run('h2', 'other', task)])
    expect(max).toBe(2)
  })

  it('keeps the chain alive after a failing call', async () => {
    const q = createQueue({ gaps: {}, retryDelayMs: 0 })
    await expect(q.run('h', 'other', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(q.run('h', 'other', async () => ({ status: 200 }))).resolves.toEqual({ status: 200 })
  })
})

describe('ecpq: end-to-start gaps', () => {
  it('waits the endpoint gap from the end of the previous call to the start of the next', async () => {
    let t = 0
    const waits = []
    const q = createQueue({ now: () => t, sleep: async (ms) => { waits.push(ms); t += ms } })
    const call = (dur) => async () => { t += dur; return { status: 200 } }
    await q.run('h', 'sgnodes', call(50))   // ends at 50
    await q.run('h', 'sgnodes', call(10))   // must start at >= 250
    expect(waits).toEqual([200])
    await q.run('h', 'screenshot', call(1))
    await q.run('h', 'screenshot', call(1))
    expect(waits).toEqual([200, 500])
  })

  it('does not delay an unrelated endpoint kind', async () => {
    let t = 0
    const waits = []
    const q = createQueue({ now: () => t, sleep: async (ms) => { waits.push(ms); t += ms } })
    await q.run('h', 'sgnodes', async () => ({ status: 200 }))
    await q.run('h', 'other', async () => ({ status: 200 }))
    expect(waits).toEqual([])
  })

  it('a failed call does not charge the gap', async () => {
    let t = 0
    const waits = []
    const q = createQueue({ now: () => t, sleep: async (ms) => { waits.push(ms); t += ms }, retryDelayMs: 0 })
    await q.run('h', 'sgnodes', async () => ({ status: 404 }))
    await q.run('h', 'sgnodes', async () => ({ status: 200 }))
    expect(waits).toEqual([])
  })
})

describe('ecpq: one transient retry', () => {
  const run = (results) => {
    const q = createQueue({ gaps: {}, retryDelayMs: 0 })
    let n = 0
    const p = q.run('h', 'other', async () => {
      const r = results[Math.min(n++, results.length - 1)]
      if (r instanceof Error) throw r
      return r
    })
    return p.then((v) => ({ v, attempts: n }), (e) => ({ e, attempts: n }))
  }
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  const reset = new TypeError('fetch failed')

  it('5xx once -> 2 attempts, success', async () => {
    const r = await run([{ status: 500 }, { status: 200 }])
    expect(r.attempts).toBe(2); expect(r.v.status).toBe(200)
  })
  it('5xx always -> 2 attempts, final 5xx returned', async () => {
    const r = await run([{ status: 503 }])
    expect(r.attempts).toBe(2); expect(r.v.status).toBe(503)
  })
  it('"fetch failed" once -> 2 attempts', async () => {
    const r = await run([reset, { status: 200 }])
    expect(r.attempts).toBe(2); expect(r.v.status).toBe(200)
  })
  it('timeout always -> 2 attempts then the error', async () => {
    const r = await run([timeout])
    expect(r.attempts).toBe(2); expect(r.e.name).toBe('TimeoutError')
  })
  it.each([401, 403, 404])('%i -> exactly 1 attempt', async (status) => {
    const r = await run([{ status }])
    expect(r.attempts).toBe(1); expect(r.v.status).toBe(status)
  })
  it('a non-transient thrown error is not retried', async () => {
    const r = await run([new Error('bad input')])
    expect(r.attempts).toBe(1)
  })
  it('isTransient / endpointKind', () => {
    expect(isTransient({ value: { status: 500 } })).toBe(true)
    expect(isTransient({ value: { status: 404 } })).toBe(false)
    expect(endpointKind('/query/sgnodes/all')).toBe('sgnodes')
    expect(endpointKind('/keypress/Home')).toBe('other')
  })
})

describe('ecpq: non-idempotent (POST) retry only when undelivered', () => {
  const post = async (results) => {
    const q = createQueue({ gaps: {}, retryDelayMs: 0 })
    let n = 0
    const p = q.run('h', 'other', async () => {
      const r = results[Math.min(n++, results.length - 1)]
      if (r instanceof Error) throw r
      return r
    }, { idempotent: false })
    return p.then((v) => ({ v, attempts: n }), (e) => ({ e, attempts: n }))
  }
  const failed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'])('%s once -> 2 attempts, success', async (code) => {
    const r = await post([failed(code), { status: 200 }])
    expect(r.attempts).toBe(2); expect(r.v.status).toBe(200)
  })
  it('undelivered always -> 2 attempts then the error', async () => {
    const r = await post([failed('ECONNREFUSED')])
    expect(r.attempts).toBe(2); expect(r.e.message).toBe('fetch failed')
  })
  it('timeout -> 1 attempt', async () => {
    const r = await post([Object.assign(new Error('timed out'), { name: 'TimeoutError' })])
    expect(r.attempts).toBe(1); expect(r.e.name).toBe('TimeoutError')
  })
  it('abort -> 1 attempt', async () => {
    const r = await post([Object.assign(new Error('aborted'), { name: 'AbortError' })])
    expect(r.attempts).toBe(1); expect(r.e.name).toBe('AbortError')
  })
  it('a bare "fetch failed" or a reset after send -> 1 attempt', async () => {
    expect((await post([new TypeError('fetch failed')])).attempts).toBe(1)
    expect((await post([failed('ECONNRESET')])).attempts).toBe(1)
  })
  it.each([500, 503])('HTTP %i response -> 1 attempt, returned', async (status) => {
    const r = await post([{ status }, { status: 200 }])
    expect(r.attempts).toBe(1); expect(r.v.status).toBe(status)
  })
  it('timeout does not retry even though GET-style idempotent calls would', async () => {
    expect(isTransient({ error: Object.assign(new Error('t'), { name: 'TimeoutError' }) })).toBe(true)
    expect(isTransient({ error: Object.assign(new Error('t'), { name: 'TimeoutError' }) }, { idempotent: false })).toBe(false)
  })
})

describe('ecp.js routes through the queue', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('serializes concurrent ecpGet calls per host and retries a 5xx once', async () => {
    let inFlight = 0, max = 0, calls = 0
    vi.stubGlobal('fetch', async () => {
      inFlight++; max = Math.max(max, inFlight); calls++
      await sleep(3)
      inFlight--
      return { status: calls === 1 ? 500 : 200, text: async () => '<ok/>' }
    })
    const dev = createDevice({ host: 'queue-test-host' })
    const rs = await Promise.all(Array.from({ length: 5 }, () => dev.ecpGet('/query/active-app')))
    expect(max).toBe(1)
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(calls).toBe(6) // 5 calls + 1 retry
  })

  it('keypress is not retried on a 5xx, launch is retried after a refused connection', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return { status: 503, text: async () => '' } })
    const dev = createDevice({ host: 'queue-test-post-5xx' })
    await expect(dev.keypress('Home')).rejects.toThrow(/HTTP 503/)
    expect(calls).toBe(1)

    calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return { status: 200, text: async () => '' }
    })
    const dev2 = createDevice({ host: 'queue-test-post-refused' })
    expect(await dev2.launch('dev')).toBe(200)
    expect(calls).toBe(2)
  })
})
