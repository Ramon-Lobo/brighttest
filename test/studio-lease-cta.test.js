import { describe, it, expect } from 'vitest'

const load = () => import('../lib/studio/web/src/lib/leasecta.js')

describe('Studio lease call to action', () => {
  it('says "back" only after Studio lost the device', async () => {
    const { ctaLabel } = await load()
    expect(ctaLabel(true)).toBe('Take the device back')
    expect(ctaLabel(false)).toBe('Take the device')
  })
  it('numbers the queue position and falls back when the queue is empty', async () => {
    const { queuedText } = await load()
    expect(queuedText({ queue: [{ agent: 'a' }, { agent: 'studio' }] })).toBe('Waiting, you are #2')
    expect(queuedText({ queue: [] })).toBe('Waiting for the device')
    expect(queuedText(null)).toBe('Waiting for the device')
  })
  it('formats how long the holder has had the device', async () => {
    const { formatAge } = await load()
    expect(formatAge(45000)).toBe('45s')
    expect(formatAge(125000)).toBe('2m 05s')
    expect(formatAge(3780000)).toBe('1h 03m')
    expect(formatAge(-5)).toBe('0s')
  })
  it('names who holds the device, the purpose and how long', async () => {
    const { heldText } = await load()
    const l = { lease: { holder: { agent: 'e2e-run#1', purpose: 'e2e run', since: 1000, mine: false } } }
    expect(heldText(l, 126000)).toBe('e2e-run#1 has the device (e2e run), held for 2m 05s')
    expect(heldText({ lease: { holder: { agent: 'a', purpose: '', since: new Date(1000).toISOString() } } }, 61000)).toBe('a has the device, held for 1m 00s')
    expect(heldText({ lease: { text: 'All 2 pool devices are busy', pool: true } })).toBe('All 2 pool devices are busy')
    expect(heldText({ error: 'x' })).toBe('x')
  })
})
