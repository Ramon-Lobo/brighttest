import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/feed.js')
const mem = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v) }, removeItem: (k) => { delete m[k] }, m } }

describe('feed CARD_HELD_HINT', () => {
  it('names the way out and the tools it blocks', async () => {
    const { CARD_HELD_HINT } = await load()
    expect(CARD_HELD_HINT).toContain('Device screenshots')
    expect(CARD_HELD_HINT).toContain('ffmpeg')
  })
})

describe('feed autoRect', () => {
  it('uses the whole frame for 16:9 (within 1 percent)', async () => {
    const { autoRect } = await load()
    expect(autoRect(2560, 1440)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(autoRect(1920, 1088)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
  it('centers a 16:9 rect in a 4:3 frame (letterbox) and in an ultrawide frame (pillarbox)', async () => {
    const { autoRect } = await load()
    expect(autoRect(640, 480)).toEqual({ x: 0, y: 0.125, w: 1, h: 0.75 })
    const r = autoRect(2560, 1080)
    expect(r.y).toBe(0)
    expect(r.h).toBe(1)
    expect(r.x * 2 + r.w).toBeCloseTo(1, 5)
    expect(r.w * 2560 / 1080).toBeCloseTo(16 / 9, 3)
  })
  it('falls back to the full frame for a bad size', async () => {
    const { autoRect } = await load()
    expect(autoRect(0, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(autoRect(NaN, 10)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('feed cropTransform', () => {
  it('is the identity-like scale for the full frame', async () => {
    const { cropTransform } = await load()
    expect(cropTransform({ x: 0, y: 0, w: 1, h: 1 })).toBe('scale(1, 1) translate(0%, 0%)')
  })
  it('scales up and shifts for a sub-rect', async () => {
    const { cropTransform } = await load()
    expect(cropTransform({ x: 0, y: 0.125, w: 1, h: 0.75 })).toBe('scale(1, 1.333333) translate(0%, -12.5%)')
    expect(cropTransform({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })).toBe('scale(1.25, 1.25) translate(-10%, -10%)')
  })
  it('ignores a degenerate rect', async () => {
    const { cropTransform } = await load()
    expect(cropTransform({ x: 0, y: 0, w: 0, h: 0 })).toBe('scale(1, 1) translate(0%, 0%)')
    expect(cropTransform(null)).toBe('scale(1, 1) translate(0%, 0%)')
  })
})

describe('feed applyNudge', () => {
  const scene = { w: 1920, h: 1080 }
  it('moves the picture by scene pixels (positive dx shifts the picture right)', async () => {
    const { applyNudge } = await load()
    const r = applyNudge({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, scene, { dx: 96, dy: 54 })
    expect(r.x).toBeCloseTo(0.1 - 0.05 * 0.8, 5)
    expect(r.y).toBeCloseTo(0.1 - 0.05 * 0.8, 5)
    expect(r.w).toBe(0.8)
  })
  it('scales by percent and keeps the rect inside the frame', async () => {
    const { applyNudge } = await load()
    const r = applyNudge({ x: 0.2, y: 0, w: 0.8, h: 1 }, scene, { sw: 10, sh: 10 })
    expect(r.w).toBeCloseTo(0.88, 5)
    expect(r.h).toBe(1)
    expect(r.x + r.w).toBeLessThanOrEqual(1.000001)
  })
  it('clamps at the frame edge and at a minimum size', async () => {
    const { applyNudge } = await load()
    expect(applyNudge({ x: 0, y: 0, w: 1, h: 1 }, scene, { dx: 500 }).x).toBe(0)
    expect(applyNudge({ x: 0, y: 0, w: 0.06, h: 0.06 }, scene, { sw: -90, sh: -90 }).w).toBe(0.05)
  })
  it('uses a default scene when none is known', async () => {
    const { applyNudge } = await load()
    expect(applyNudge({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, null, { dx: 192 }).x).toBeCloseTo(0.45, 5)
  })
})

describe('feed calibration storage', () => {
  it('round-trips under bt.studio.feed.<deviceId>', async () => {
    const { saveCal, loadCal } = await load()
    const s = mem()
    expect(saveCal(s, 'dev1', { label: 'Card', C: { x: 0, y: 0.125, w: 1, h: 0.75 }, auto: true })).toBe(true)
    expect(Object.keys(s.m)).toEqual(['bt.studio.feed.dev1'])
    expect(JSON.parse(s.m['bt.studio.feed.dev1']).v).toBe(1)
    expect(loadCal(s, 'dev1')).toEqual({ v: 1, label: 'Card', C: { x: 0, y: 0.125, w: 1, h: 0.75 }, auto: true })
    expect(loadCal(s, 'other')).toBeNull()
  })
  it('returns null for bad JSON, wrong version, a bad rect or no storage', async () => {
    const { loadCal } = await load()
    expect(loadCal(mem({ 'bt.studio.feed.a': '{nope' }), 'a')).toBeNull()
    expect(loadCal(mem({ 'bt.studio.feed.a': 'null' }), 'a')).toBeNull()
    expect(loadCal(mem({ 'bt.studio.feed.a': JSON.stringify({ v: 2, C: { x: 0, y: 0, w: 1, h: 1 } }) }), 'a')).toBeNull()
    expect(loadCal(mem({ 'bt.studio.feed.a': JSON.stringify({ v: 1, C: { x: 0.5, y: 0, w: 1, h: 1 } }) }), 'a')).toBeNull()
    expect(loadCal(mem({ 'bt.studio.feed.a': JSON.stringify({ v: 1, C: { x: 0, y: 0, w: 'a', h: 1 } }) }), 'a')).toBeNull()
    expect(loadCal(null, 'a')).toBeNull()
  })
  it('does not throw when the storage refuses a write, and refuses a bad rect', async () => {
    const { saveCal } = await load()
    const full = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(saveCal(full, 'a', { C: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false)
    expect(saveCal(mem(), 'a', { C: { x: 0, y: 0, w: 0, h: 1 } })).toBe(false)
    expect(saveCal(null, 'a', { C: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false)
  })
  it('remembers the last feed', async () => {
    const { loadLastFeed, saveLastFeed } = await load()
    const s = mem()
    expect(loadLastFeed(s)).toBeNull()
    saveLastFeed(s, 'dev1'); expect(loadLastFeed(s)).toBe('dev1')
    saveLastFeed(s, null); expect(loadLastFeed(s)).toBeNull()
  })
})

describe('feed friendlyError', () => {
  it('explains a denied camera, a missing device and a busy one', async () => {
    const { friendlyError } = await load()
    expect(friendlyError('NotAllowedError')).toMatch(/denied/i)
    expect(friendlyError('NotFoundError')).toMatch(/not found/i)
    expect(friendlyError('NotReadableError')).toMatch(/in use by another app/i)
  })
  it('names an unknown error and survives no name', async () => {
    const { friendlyError } = await load()
    expect(friendlyError('WeirdError')).toContain('WeirdError')
    expect(friendlyError()).toMatch(/could not open/i)
  })
})

describe('feed overlay age and settling', () => {
  it('formats the age', async () => {
    const { boxAgeText } = await load()
    expect(boxAgeText(300)).toBe('boxes 0.3 s old')
    expect(boxAgeText(0)).toBe('boxes 0.0 s old')
    expect(boxAgeText(12_340)).toBe('boxes 12.3 s old')
    expect(boxAgeText(NaN)).toBe('')
    expect(boxAgeText(-1)).toBe('')
  })
  it('signs the focused set only', async () => {
    const { focusSig } = await load()
    expect(focusSig([{ path: 'a', focused: true }, { path: 'b' }, { path: 'c', focused: true }])).toBe('a|c')
    expect(focusSig(null)).toBe('')
  })
  it('settles after two reads agree, or after the cap', async () => {
    const { settleStep, SETTLE_MAX_MS } = await load()
    let s = { settling: true, prev: null, pressAt: 1000 }
    s = { ...s, ...settleStep(s, 'a', 1100) }; expect(s).toMatchObject({ settling: true, prev: 'a' })
    s = { ...s, ...settleStep(s, 'b', 1400) }; expect(s).toMatchObject({ settling: true, prev: 'b' })
    s = { ...s, ...settleStep(s, 'b', 1700) }; expect(s.settling).toBe(false)
    const slow = { settling: true, prev: 'x', pressAt: 1000 }
    expect(settleStep(slow, 'y', 1000 + SETTLE_MAX_MS).settling).toBe(false)
    expect(settleStep({ settling: false, prev: null }, 'z', 5).prev).toBe('z')
  })
})
