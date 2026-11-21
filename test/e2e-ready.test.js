import { describe, it, expect } from 'vitest'
import { waitForReady, resolveConstants, READY_DEFAULTS } from '../lib/e2e/ready.js'
import { createDevice } from '../lib/e2e/ecp.js'

const FAST = { intervalMs: 1, homeGraceMs: 40, timeoutMs: 400, sgnodesTimeoutMs: 50 }
const wrap = (inner) => `<sgnodes><All_Nodes node-count="1"><Default/>${inner}</All_Nodes><status>OK</status></sgnodes>`
const tree = (body) => wrap(`<Scene name="s">${body}</Scene>`)
const okTree = tree('<Label name="title" text="Hi" focused="true" bounds="{0,0,10,10}"/>')
const failed = '<sgnodes><status>FAILED</status><error>Plugin boom</error></sgnodes>'
const DEV = { id: 'dev', home: false }
const HOME = { id: null, home: true }

// Scripted device: activeApp / sgnodes responses are consumed in order; the last one repeats.
function fake({ apps = [DEV], trees = [okTree] } = {}) {
  let a = 0, t = 0
  const seen = { timeouts: [] }
  return {
    seen,
    activeApp: async () => { const v = apps[Math.min(a++, apps.length - 1)]; if (v instanceof Error) throw v; return v },
    ecpGet: async (p, timeoutMs) => {
      seen.timeouts.push(timeoutMs)
      const v = trees[Math.min(t++, trees.length - 1)]
      if (v instanceof Error) throw v
      return { status: 200, text: v }
    },
  }
}

describe('waitForReady', () => {
  it('ready after two identical polls, with a short sgnodes client timeout', async () => {
    const d = fake()
    const r = await waitForReady(d, { constants: FAST })
    expect(r.tree.roots.length).toBe(1)
    expect(d.seen.timeouts.length).toBe(2)
    expect(d.seen.timeouts.every((x) => x === 50)).toBe(true)
  })

  it('cold-launch stall: FAILED and aborted reads are not-ready, then ready', async () => {
    const abort = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    const d = fake({ trees: [abort, failed, okTree] })
    const r = await waitForReady(d, { constants: FAST })
    expect(r.trace.map((x) => x.reason).join('|')).toMatch(/sgnodes not ready/)
    expect(r.trace.length).toBe(2)
  })

  it('stability resets when the focus signature changes', async () => {
    const other = tree('<Label name="other" focused="true" bounds="{5,5,10,10}"/>')
    const d = fake({ trees: [okTree, other, other] })
    await waitForReady(d, { constants: FAST })
    expect(d.seen.timeouts.length).toBe(3)
  })

  it('Home bounce inside the grace is tolerated and stability restarts', async () => {
    const d = fake({ apps: [HOME, HOME, DEV] })
    const r = await waitForReady(d, { constants: FAST })
    expect(r.trace.filter((x) => /Home/.test(x.reason)).length).toBe(2)
  })

  it('Home past the grace is a failed launch', async () => {
    const d = fake({ apps: [HOME] })
    await expect(waitForReady(d, { constants: FAST })).rejects.toMatchObject({ code: 'READY_HOME' })
  })

  it('osd facade is never ready', async () => {
    const d = fake({ trees: [wrap('<OsdOverlay name="osd"/>')] })
    await expect(waitForReady(d, { constants: { ...FAST, timeoutMs: 60 } })).rejects.toMatchObject({ code: 'READY_TIMEOUT', message: /osd in front/ })
  })

  it('root system dialog is never ready', async () => {
    const d = fake({ trees: [wrap('<SystemDialog name="d"/>')] })
    await expect(waitForReady(d, { constants: { ...FAST, timeoutMs: 60 } })).rejects.toMatchObject({ message: /system-dialog in front/ })
  })

  it('readyNode gates on a selector and is returned', async () => {
    const d = fake({ trees: [okTree, tree('<Label name="late" focused="true" bounds="{0,0,1,1}"/>'), tree('<Label name="late" focused="true" bounds="{0,0,1,1}"/>')] })
    const r = await waitForReady(d, { constants: FAST, readyNode: 'late' })
    expect(r.readyNode).toMatchObject({ id: 'late' })
    await expect(waitForReady(fake(), { constants: { ...FAST, timeoutMs: 40 }, readyNode: 'absent' })).rejects.toMatchObject({ code: 'READY_TIMEOUT' })
  })

  it('maybe-launched: not in front after a 404 launch fails with that note', async () => {
    const d = fake({ apps: [HOME] })
    await expect(waitForReady(d, { constants: FAST, maybeLaunched: true })).rejects.toMatchObject({ message: /404\/5xx after sideload/ })
  })

  it('maybe-launched: a dev channel that is up is ready despite the launch status', async () => {
    await expect(waitForReady(fake(), { constants: FAST, maybeLaunched: true })).resolves.toBeTruthy()
  })

  it('unreadable active-app is not-ready, not an error', async () => {
    const d = fake({ apps: [new Error('active-app HTTP 500'), DEV] })
    const r = await waitForReady(d, { constants: FAST })
    expect(r.trace[0].reason).toMatch(/active-app unreadable/)
  })

  it('Limited mode is rethrown', async () => {
    const d = fake({ trees: ['not allowed in Limited mode'] })
    await expect(waitForReady(d, { constants: FAST })).rejects.toMatchObject({ code: 'LIMITED_MODE' })
  })
})

describe('resolveConstants', () => {
  it('flow config overrides defaults; bad values ignored; explicit overrides win', () => {
    const c = resolveConstants({ readyTimeout: '5000', readyHomeGrace: 'x' }, { intervalMs: 9 })
    expect(c.timeoutMs).toBe(5000)
    expect(c.homeGraceMs).toBe(READY_DEFAULTS.homeGraceMs)
    expect(c.intervalMs).toBe(9)
  })
})

describe('device.launch maybeLaunched', () => {
  it('returns 404/5xx only when maybeLaunched is set', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = async () => ({ status: 404, text: async () => '' })
    try {
      const dev = createDevice({ host: '127.0.0.1' })
      await expect(dev.launch('dev')).rejects.toThrow(/HTTP 404/)
      await expect(dev.launch('dev', {}, { maybeLaunched: true })).resolves.toBe(404)
    } finally { globalThis.fetch = orig }
  })
})
