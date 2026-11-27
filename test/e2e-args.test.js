import { describe, it, expect, vi, afterEach } from 'vitest'
import cli from '../bin/cli.js'

const { parseE2eArgs } = cli

describe('parseE2eArgs lease flags and unknown options', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts --expect and --max in space and = forms', () => {
    expect(parseE2eArgs(['run', 'a.e2e.yaml', '--expect', '5m', '--max', '10m'])).toMatchObject({ expect: '5m', max: '10m' })
    expect(parseE2eArgs(['run', 'a.e2e.yaml', '--expect=5m', '--max=10m'])).toMatchObject({ expect: '5m', max: '10m' })
  })

  it('does not turn the --max value into a flow path', () => {
    const o = parseE2eArgs(['run', '--max', '1m', 'a.e2e.yaml'])
    expect(o.max).toBe('1m')
    expect(o.flows).toEqual(['a.e2e.yaml'])
  })

  it('warns on an unknown option, ignores it, and keeps real flow paths', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const o = parseE2eArgs(['run', '--foo', 'a.e2e.yaml', '--bar=1'])
    expect(o.flows).toEqual(['a.e2e.yaml'])
    const msgs = err.mock.calls.map((c) => c[0])
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toContain('unknown option --foo for e2e run; ignored')
    expect(msgs[1]).toContain('unknown option --bar for e2e run; ignored')
  })

  it('does not treat the value of a space-form unknown option as a flow path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseE2eArgs(['run', '--foo', 'bar', 'a.e2e.yaml']).flows).toEqual(['a.e2e.yaml'])
    expect(parseE2eArgs(['run', '--foo', 'bar', '--host', '1.2.3.4', 'a.e2e.yaml'])).toMatchObject({ host: '1.2.3.4', flows: ['a.e2e.yaml'] })
    expect(parseE2eArgs(['run', '--foo=bar', 'a.e2e.yaml']).flows).toEqual(['a.e2e.yaml'])
  })

  it('keeps a flow-looking token after an unknown option', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseE2eArgs(['run', '--foo', 'a.e2e.yaml', 'b.e2e.yaml']).flows).toEqual(['a.e2e.yaml', 'b.e2e.yaml'])
  })

  it('does not warn for known options', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    parseE2eArgs(['run', 'a.e2e.yaml', '--host', '1.2.3.4', '--as', 'x', '--no-lease'])
    expect(err).not.toHaveBeenCalled()
  })
})
