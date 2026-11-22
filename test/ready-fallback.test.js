import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

// ROB-10: launch readiness reaches the app-ui fallback after consecutive sgnodes failures across polls.
const require = createRequire(import.meta.url)
const { waitForReady } = require('../lib/e2e/ready.js')
const sg = require('../lib/e2e/sgnodes.js')

const FAILED = (err) => `<sgnodes><status>FAILED</status><error>${err}</error></sgnodes>`
const APP_UI = '<app-ui><status>OK</status><topscreen><screen type="SGScreen"><Scene><Label name="t" text="x" focused="true" /></Scene></screen></topscreen></app-ui>'

function fakeDevice(sgText) {
  const calls = []
  return {
    calls,
    activeApp: async () => ({ id: 'dev', home: false }),
    ecpGet: async (p) => {
      calls.push(p)
      return { text: p === '/query/app-ui' ? APP_UI : sgText }
    },
  }
}
const fast = { intervalMs: 1, timeoutMs: 2000 }

describe('waitForReady app-ui fallback (ROB-10)', () => {
  it('takes the fallback once the shared threshold of failed polls is met', async () => {
    const d = fakeDevice(FAILED('Plugin RPC event timed out'))
    const r = await waitForReady(d, { constants: fast })
    expect(r.tree).toMatchObject({ source: 'app-ui', parentLinks: false })
    expect(d.calls.filter((p) => p.startsWith('/query/sgnodes/')).length).toBe(sg.APP_UI_FALLBACK_AFTER + 1) // threshold polls, then one more for the stable read
    expect(r.trace.length).toBe(sg.APP_UI_FALLBACK_AFTER - 1)
  })
  it('does not fall back on CHANNEL_NOT_RUNNING', async () => {
    const d = fakeDevice(FAILED('Channel not running'))
    await expect(waitForReady(d, { constants: { ...fast, timeoutMs: 100 } })).rejects.toMatchObject({ code: 'READY_TIMEOUT' })
    expect(d.calls).not.toContain('/query/app-ui')
  })
  it('does not fall back on LIMITED_MODE and fails fast', async () => {
    const d = fakeDevice('not allowed in Limited mode')
    await expect(waitForReady(d, { constants: fast })).rejects.toMatchObject({ code: 'LIMITED_MODE' })
    expect(d.calls).toEqual(['/query/sgnodes/all'])
  })
})
