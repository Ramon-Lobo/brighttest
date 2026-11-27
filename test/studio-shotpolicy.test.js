import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const load = () => import('../lib/studio/web/src/lib/treepolicy.js')

describe('screenshot policy (on demand)', () => {
  it('takes the first shot at once', async () => {
    const { shotDecision } = await load()
    expect(shotDecision({ now: 100, lastShotAt: 0 })).toMatchObject({ take: true, reason: 'first' })
  })

  it('takes a shot after a key press once the screen settled', async () => {
    const { shotDecision, PRESS_SETTLE_MS } = await load()
    const base = { lastShotAt: 10_000, dirtyAt: 12_000 }
    const early = shotDecision({ ...base, now: 12_000 + 10 })
    expect(early.take).toBe(false)
    expect(early.waitMs).toBe(PRESS_SETTLE_MS - 10)
    expect(shotDecision({ ...base, now: 12_000 + PRESS_SETTLE_MS })).toMatchObject({ take: true, reason: 'change' })
  })

  it('never takes two shots closer than the minimum gap', async () => {
    const { shotDecision, MIN_GAP_MS } = await load()
    const d = shotDecision({ now: 10_100, lastShotAt: 10_000, dirtyAt: 10_050 })
    expect(d.take).toBe(false)
    expect(d.waitMs).toBe(10_000 + MIN_GAP_MS - 10_100)
  })

  it('takes a shot every idleMs when nothing happens', async () => {
    const { shotDecision, IDLE_MS } = await load()
    expect(IDLE_MS).toBe(5000)
    expect(shotDecision({ now: 14_999, lastShotAt: 10_000 })).toMatchObject({ take: false, reason: 'idle', waitMs: 1 })
    expect(shotDecision({ now: 15_000, lastShotAt: 10_000 })).toMatchObject({ take: true, reason: 'idle' })
    expect(shotDecision({ now: 10_500, lastShotAt: 10_000, idleMs: 400 }).take).toBe(true)
  })

  it('a burst of presses is one wait, but a change is never held back past MAX_DEFER_MS', async () => {
    const { shotDecision, MAX_DEFER_MS } = await load()
    // newest press just happened, oldest change is MAX_DEFER_MS old: shoot anyway
    expect(shotDecision({ now: 20_000, lastShotAt: 10_000, dirtyAt: 19_950, dirtySince: 20_000 - MAX_DEFER_MS }).take).toBe(true)
    expect(shotDecision({ now: 20_000, lastShotAt: 10_000, dirtyAt: 19_950, dirtySince: 19_000 }).take).toBe(false)
  })

  it('the refresh button always takes one', async () => {
    const { shotDecision } = await load()
    expect(shotDecision({ now: 10_001, lastShotAt: 10_000, forced: true })).toMatchObject({ take: true, reason: 'refresh' })
  })

  it('simulated clock: at least one shot per idleMs, and one soon after each press', async () => {
    const { shotDecision } = await load()
    const idleMs = 5000
    let lastShotAt = 0, dirtyAt = null
    const shots = []
    const presses = [7_000, 7_100, 20_000]
    for (let now = 0; now <= 40_000; now += 100) {
      if (presses.includes(now)) dirtyAt = now
      if (shotDecision({ now, lastShotAt, dirtyAt, idleMs }).take) { shots.push(now); lastShotAt = now; dirtyAt = null }
    }
    for (let i = 1; i < shots.length; i++) expect(shots[i] - shots[i - 1]).toBeLessThanOrEqual(idleMs)
    expect(shots.find((t) => t >= 20_000)).toBeLessThanOrEqual(20_000 + 1100)
    expect(shots.find((t) => t > 7_100)).toBeLessThanOrEqual(7_100 + 1100)
  })

  it('treeSignature changes with focus, text and position only', async () => {
    const { treeSignature } = await load()
    const n = (o = {}) => ({ path: '0/1', id: 'a', text: 'x', focused: false, vis: { x: 1, y: 2, w: 3, h: 4 }, ...o })
    const base = treeSignature([n()])
    expect(treeSignature([n()])).toBe(base)
    expect(treeSignature([n({ focused: true })])).not.toBe(base)
    expect(treeSignature([n({ text: 'y' })])).not.toBe(base)
    expect(treeSignature([n({ vis: { x: 9, y: 2, w: 3, h: 4 } })])).not.toBe(base)
    expect(treeSignature([n(), n({ path: '0/2' })])).not.toBe(base)
    expect(treeSignature(null)).toBe('')
  })

  it('formats the shot age', async () => {
    const { formatShotAge } = await load()
    expect(formatShotAge(null)).toBe('')
    expect(formatShotAge(400)).toBe('just now')
    expect(formatShotAge(3400)).toBe('3 s ago')
    expect(formatShotAge(125_000)).toBe('2 min ago')
  })
})

describe('screenshot policy wiring', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib/studio/web/src', f), 'utf8')
  it('App uses the policy instead of a fixed shot timer and wires key presses and the tree', () => {
    const app = src('App.svelte')
    expect(app).toMatch(/shotDecision\(/)
    expect(app).toMatch(/treeSignature\(d\.nodes\)/)
    expect(app).toMatch(/function onRemote\(\) \{ markDirty\(\)/)
    expect(app).not.toMatch(/setTimeout\(grabShot/)
    expect(app).toMatch(/<Stage \{shotSrc\} \{shotAt\} onrefresh=\{refreshShot\}/)
  })
  it('Stage has the refresh button and the shot age', () => {
    const st = src('lib/Stage.svelte')
    expect(st).toMatch(/data-testid="monitor-refresh"/)
    expect(st).toMatch(/data-testid="monitor-shot-age"/)
  })
})
