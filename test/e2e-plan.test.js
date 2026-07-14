import { describe, it, expect, afterEach } from 'vitest'
import { parseHosts, buildPlan } from '../lib/e2e/run.js'

afterEach(() => { delete process.env.ROKU_HOST })

describe('parseHosts', () => {
  it('splits a comma list, trims, and de-dupes', () => {
    expect(parseHosts({ host: '10.0.0.1, 10.0.0.2 ,10.0.0.1' })).toEqual(['10.0.0.1', '10.0.0.2'])
  })
  it('falls back to ROKU_HOST', () => {
    process.env.ROKU_HOST = 'a,b'
    expect(parseHosts({})).toEqual(['a', 'b'])
  })
  it('returns [] when nothing is set', () => {
    expect(parseHosts({})).toEqual([])
  })
})

describe('buildPlan', () => {
  const files = ['x.e2e.yaml', 'y.e2e.yaml', 'z.e2e.yaml']

  it('one unit per flow when there is no matrix', () => {
    const { units } = buildPlan({ files, hosts: ['h1'] })
    expect(units).toHaveLength(3)
    expect(units.every((u) => u.params === null && u.label === null)).toBe(true)
  })

  it('expands the deep-link matrix: one unit per (flow × contentId)', () => {
    const { units } = buildPlan({ files: ['x.e2e.yaml'], hosts: ['h1'], contentIds: ['c1', 'c2'], mediaType: 'movie' })
    expect(units).toHaveLength(2)
    expect(units[0]).toEqual({ file: 'x.e2e.yaml', params: { contentId: 'c1', mediaType: 'movie' }, label: 'c1' })
    expect(units[1].params).toEqual({ contentId: 'c2', mediaType: 'movie' })
  })

  it('omits mediaType from params when not given', () => {
    const { units } = buildPlan({ files: ['x.e2e.yaml'], hosts: ['h1'], contentIds: ['c1'] })
    expect(units[0].params).toEqual({ contentId: 'c1' })
  })

  it('round-robins units across devices', () => {
    const { byHost } = buildPlan({ files, hosts: ['h1', 'h2'] })
    expect(byHost.get('h1').map((u) => u.file)).toEqual(['x.e2e.yaml', 'z.e2e.yaml'])
    expect(byHost.get('h2').map((u) => u.file)).toEqual(['y.e2e.yaml'])
  })

  it('shards a matrix across devices too', () => {
    const { units, byHost } = buildPlan({ files: ['x.e2e.yaml'], hosts: ['h1', 'h2'], contentIds: ['a', 'b', 'c'] })
    expect(units).toHaveLength(3)
    expect(byHost.get('h1').map((u) => u.label)).toEqual(['a', 'c'])
    expect(byHost.get('h2').map((u) => u.label)).toEqual(['b'])
  })
})
