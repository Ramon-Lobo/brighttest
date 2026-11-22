import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'

// ROB-10 hang follow-up (TP-ROB-19 headless rows): a hung or client-timed-out sgnodes read counts as a failure.
const require = createRequire(import.meta.url)
const { createFakeRoku } = require('./fixtures/fake-roku/server.js')
const sg = require('../lib/e2e/sgnodes.js')
const { waitForReady } = require('../lib/e2e/ready.js')
const { createDevice } = require('../lib/e2e/ecp.js')

const APP_UI = '<app-ui><status>OK</status><topscreen><screen type="SGScreen"><Scene><Label name="t" text="x" focused="true" /></Scene></screen></topscreen></app-ui>'
const FAILED = (err) => `<sgnodes><status>FAILED</status><error>${err}</error></sgnodes>`
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

// Device whose sgnodes reads hang (throw the client TimeoutError); `sgText` answers instead when given.
function hangDevice({ sgText = null, appUi = APP_UI } = {}) {
  const calls = []
  return {
    calls,
    activeApp: async () => ({ id: 'dev', home: false }),
    ecpGet: async (p) => {
      calls.push(p)
      if (p === '/query/app-ui') return { text: appUi }
      if (sgText !== null) return { text: sgText }
      throw timeoutErr()
    },
  }
}
const quickOpts = { backoffMs: 1 }

describe('fetchTree counts client timeouts as failures', () => {
  it('hang counted as failure: retries and reaches the threshold before giving up', async () => {
    const d = hangDevice({ appUi: FAILED('x') })
    await expect(sg.fetchTree(d, quickOpts)).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(d.calls.filter((p) => p.startsWith('/query/sgnodes/')).length).toBe(sg.APP_UI_FALLBACK_AFTER)
    expect(d.calls).toContain('/query/app-ui')
  })
  it('threshold reached via hangs takes the app-ui fallback with the shared source tag', async () => {
    const d = hangDevice()
    const t = await sg.fetchTree(d, quickOpts)
    expect(t).toMatchObject({ source: sg.TREE_SOURCE_APP_UI, parentLinks: false })
    expect(d.calls.filter((p) => p.startsWith('/query/sgnodes/')).length).toBe(sg.APP_UI_FALLBACK_AFTER)
  })
  it('mixed hangs and FAILED answers share one counter', async () => {
    let n = 0
    const d = hangDevice()
    const base = d.ecpGet
    d.ecpGet = async (p) => (p === '/query/sgnodes/all' && ++n === 2 ? { text: FAILED('Plugin RPC event timed out') } : base(p))
    const t = await sg.fetchTree(d, quickOpts)
    expect(t.source).toBe('app-ui')
    expect(n).toBe(sg.APP_UI_FALLBACK_AFTER)
  })
  it('non-timeout transport errors are not counted and propagate at once', async () => {
    const d = { ecpGet: async (p) => { if (p === '/query/app-ui') return { text: APP_UI }; throw new Error('fetch failed') } }
    await expect(sg.fetchTree(d, quickOpts)).rejects.toThrow('fetch failed')
  })
  it('excluded errors do not fall back: LIMITED_MODE and CHANNEL_NOT_RUNNING', async () => {
    const lim = hangDevice({ sgText: 'not allowed in Limited mode' })
    await expect(sg.fetchTree(lim, quickOpts)).rejects.toMatchObject({ code: 'LIMITED_MODE' })
    expect(lim.calls).not.toContain('/query/app-ui')
    const nr = hangDevice({ sgText: FAILED('Channel not running') })
    await expect(sg.fetchTree(nr, quickOpts)).rejects.toMatchObject({ code: 'CHANNEL_NOT_RUNNING' })
    expect(nr.calls).not.toContain('/query/app-ui')
  })
  it('success path is unchanged', async () => {
    const d = hangDevice({ sgText: '<sgnodes><All_Nodes node-count="1"><Scene name="s"/></All_Nodes><status>OK</status></sgnodes>' })
    const t = await sg.fetchTree(d, quickOpts)
    expect(t).toMatchObject({ source: 'sgnodes', parentLinks: true })
  })
})

describe('waitForReady with hanging sgnodes', () => {
  it('reaches app-ui after the threshold of timed-out polls', async () => {
    const d = hangDevice()
    const r = await waitForReady(d, { constants: { intervalMs: 1, timeoutMs: 2000 } })
    expect(r.tree).toMatchObject({ source: 'app-ui', parentLinks: false })
    expect(r.trace.length).toBe(sg.APP_UI_FALLBACK_AFTER - 1)
  })
  it('does not fall back on LIMITED_MODE or CHANNEL_NOT_RUNNING', async () => {
    const lim = hangDevice({ sgText: 'not allowed in Limited mode' })
    await expect(waitForReady(lim, { constants: { intervalMs: 1, timeoutMs: 500 } })).rejects.toMatchObject({ code: 'LIMITED_MODE' })
    const nr = hangDevice({ sgText: FAILED('Channel not running') })
    await expect(waitForReady(nr, { constants: { intervalMs: 1, timeoutMs: 100 } })).rejects.toMatchObject({ code: 'READY_TIMEOUT' })
    expect(nr.calls).not.toContain('/query/app-ui')
  })
})

describe('fake sgnodes-hangs scenario (TP-ROB-19 hang row)', () => {
  const stubs = []
  afterEach(async () => { await Promise.all(stubs.splice(0).map((s) => s.stop())) })
  it('waitForReady takes the app-ui tree when sgnodes never answers', async () => {
    const stub = createFakeRoku({ scenario: 'sgnodes-hangs' })
    const a = await stub.start()
    stubs.push(stub)
    const dev = createDevice({ host: '127.0.0.1', ecpPort: a.ecpPort })
    const r = await waitForReady(dev, { appId: 'dev', constants: { intervalMs: 10, timeoutMs: 30000, sgnodesTimeoutMs: 150, homeGraceMs: 5000 } })
    expect(r.tree).toMatchObject({ source: 'app-ui', parentLinks: false })
    expect(stub.log.map((l) => l.endpoint)).toContain('/query/app-ui')
  }, 40000)
})
