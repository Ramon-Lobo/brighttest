import { describe, it, expect, afterEach } from 'vitest'
import { parseHosts, parseTargets, buildPlan } from '../lib/e2e/run.js'

afterEach(() => { delete process.env.ROKU_HOST; delete process.env.ROKU_PASSWORD })

describe('parseHosts', () => {
  it('splits a comma list, trims, and de-dupes', () => {
    expect(parseHosts({ host: '10.0.0.1, 10.0.0.2 ,10.0.0.1' })).toEqual(['10.0.0.1', '10.0.0.2'])
  })
  it('strips inline passwords from the host list', () => {
    expect(parseHosts({ host: '10.0.0.1:Test1234,10.0.0.2:0000' })).toEqual(['10.0.0.1', '10.0.0.2'])
  })
  it('falls back to ROKU_HOST', () => {
    process.env.ROKU_HOST = 'a,b'
    expect(parseHosts({})).toEqual(['a', 'b'])
  })
  it('returns [] when nothing is set', () => {
    expect(parseHosts({})).toEqual([])
  })
})

describe('parseTargets — per-host passwords', () => {
  it('reads an inline password per host (ip:pw)', () => {
    const { hosts, passwords } = parseTargets({ host: '10.0.0.1:Test1234,10.0.0.2:0000' })
    expect(hosts).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(passwords.get('10.0.0.1')).toBe('Test1234')
    expect(passwords.get('10.0.0.2')).toBe('0000')
  })
  it('falls back to --password for a host without an inline one', () => {
    const { passwords } = parseTargets({ host: '10.0.0.1:abc,10.0.0.2', password: 'shared' })
    expect(passwords.get('10.0.0.1')).toBe('abc')   // inline wins
    expect(passwords.get('10.0.0.2')).toBe('shared') // fallback
  })
  it('falls back to ROKU_PASSWORD when no --password', () => {
    process.env.ROKU_PASSWORD = 'envpw'
    const { passwords } = parseTargets({ host: '10.0.0.9' })
    expect(passwords.get('10.0.0.9')).toBe('envpw')
  })
  it('leaves password null when none is available', () => {
    const { passwords } = parseTargets({ host: '10.0.0.1' })
    expect(passwords.get('10.0.0.1')).toBeNull()
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
